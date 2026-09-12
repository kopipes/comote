import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withoutComoteEnvironment } from "./child-environment.js";
import type { Project } from "./projects.js";

const execFileAsync = promisify(execFile);
const checkOrder = ["lint", "typecheck", "test", "build"] as const;

export type CheckPhase = "idle" | "running" | "passed" | "failed" | "unavailable";
export type CheckStepPhase = "pending" | "running" | "passed" | "failed";

export interface CheckStep {
  name: string;
  label: string;
  command: string;
  phase: CheckStepPhase;
  output: string;
  durationMs: number;
  exitCode: number | null;
}

export interface CheckStatus {
  phase: CheckPhase;
  steps: CheckStep[];
  startedAt: string;
  finishedAt: string;
  message: string;
  stale: boolean;
}

type StepRunner = (cwd: string, script: string, onOutput: (chunk: string) => void, signal: AbortSignal) => Promise<{ exitCode: number; durationMs: number }>;
type CompletionListener = (project: Project, status: CheckStatus) => void;

interface StoredCheckStatus extends CheckStatus {
  fingerprint: string;
}

export class CheckManager {
  private readonly states = new Map<string, StoredCheckStatus>();
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(
    private readonly onComplete?: CompletionListener,
    private readonly runStep: StepRunner = runNpmScript,
  ) {}

  async status(key: string, cwd: string): Promise<CheckStatus> {
    const current = this.states.get(key);
    if (current) return this.publicStatus(current, cwd);
    const steps = await detectCheckPlan(cwd);
    if (!steps.length) return unavailableStatus();
    return {
      phase: "idle",
      steps: steps.map(pendingStep),
      startedAt: "",
      finishedAt: "",
      message: "Ready to run the project's standard checks.",
      stale: false,
    };
  }

  async start(key: string, project: Project, cwd: string): Promise<CheckStatus> {
    const current = this.states.get(key);
    if (current?.phase === "running") throw new Error("Project checks are already running.");
    const scripts = await detectCheckPlan(cwd);
    if (!scripts.length) return unavailableStatus();
    const state: StoredCheckStatus = {
      phase: "running",
      steps: scripts.map(pendingStep),
      startedAt: new Date().toISOString(),
      finishedAt: "",
      message: "Running project checks…",
      stale: false,
      fingerprint: "",
    };
    this.states.set(key, state);
    const controller = new AbortController();
    this.activeControllers.set(key, controller);
    void this.finish(key, project, cwd, state, controller.signal);
    return stripFingerprint(state);
  }

  stop(): void {
    for (const controller of this.activeControllers.values()) controller.abort();
    this.activeControllers.clear();
  }

  private async finish(key: string, project: Project, cwd: string, state: StoredCheckStatus, signal: AbortSignal): Promise<void> {
    let passed = true;
    try {
      for (const step of state.steps) {
        step.phase = "running";
        try {
          const result = await this.runStep(cwd, step.name, (chunk) => {
            step.output = trimOutput(`${step.output}${stripAnsi(chunk)}`);
          }, signal);
          step.exitCode = result.exitCode;
          step.durationMs = result.durationMs;
          step.phase = result.exitCode === 0 ? "passed" : "failed";
          if (result.exitCode !== 0) passed = false;
        } catch (cause) {
          passed = false;
          step.phase = "failed";
          step.exitCode = null;
          step.output = trimOutput(`${step.output}\n${(cause as Error).message}`.trim());
        }
      }
      state.fingerprint = await sourceFingerprint(cwd);
      state.phase = passed ? "passed" : "failed";
      state.message = passed ? "All available checks passed." : "One or more checks failed.";
    } catch (cause) {
      state.phase = "failed";
      state.message = (cause as Error).message;
    } finally {
      this.activeControllers.delete(key);
      state.finishedAt = new Date().toISOString();
      this.onComplete?.(project, stripFingerprint(state));
    }
  }

  private async publicStatus(state: StoredCheckStatus, cwd: string): Promise<CheckStatus> {
    if (state.phase === "running" || !state.fingerprint) return stripFingerprint(state);
    const fingerprint = await sourceFingerprint(cwd).catch(() => "");
    return { ...stripFingerprint(state), stale: !fingerprint || fingerprint !== state.fingerprint };
  }
}

export async function detectCheckPlan(cwd: string): Promise<string[]> {
  const packagePath = path.join(cwd, "package.json");
  const info = await stat(packagePath).catch(() => null);
  if (!info?.isFile() || info.size > 1_000_000) return [];
  let parsed: { scripts?: Record<string, unknown> };
  try {
    parsed = JSON.parse(await readFile(packagePath, "utf8"));
  } catch {
    return [];
  }
  const scripts = parsed.scripts ?? {};
  const selected = checkOrder.filter((name) => typeof scripts[name] === "string" && scripts[name]!.trim());
  if (selected.length) return [...selected];
  return typeof scripts.check === "string" && scripts.check.trim() ? ["check"] : [];
}

function pendingStep(name: string): CheckStep {
  return {
    name,
    label: name === "typecheck" ? "Typecheck" : `${name[0].toUpperCase()}${name.slice(1)}`,
    command: `npm run ${name}`,
    phase: "pending",
    output: "",
    durationMs: 0,
    exitCode: null,
  };
}

function unavailableStatus(): CheckStatus {
  return {
    phase: "unavailable",
    steps: [],
    startedAt: "",
    finishedAt: "",
    message: "No standard Node checks were found. Add a lint, typecheck, test, build, or check script to package.json.",
    stale: false,
  };
}

function stripFingerprint(state: StoredCheckStatus): CheckStatus {
  return {
    phase: state.phase,
    steps: state.steps.map((step) => ({ ...step })),
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    message: state.message,
    stale: state.stale,
  };
}

async function runNpmScript(cwd: string, script: string, onOutput: (chunk: string) => void, signal: AbortSignal): Promise<{ exitCode: number; durationMs: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", script], {
      cwd,
      detached: true,
      env: withoutComoteEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let completed = false;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (completed) return;
      completed = true;
      stopProcessGroup(child.pid);
      finish();
      reject(new Error(`${script} stopped because Comote is shutting down.`));
    };
    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      stopProcessGroup(child.pid);
      finish();
      reject(new Error(`${script} timed out after 10 minutes.`));
    }, 10 * 60_000);
    timer.unref();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => onOutput(String(chunk)));
    child.stderr.on("data", (chunk) => onOutput(String(chunk)));
    child.once("error", (error) => {
      completed = true;
      finish();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (completed) return;
      completed = true;
      finish();
      if (signal) onOutput(`\nProcess stopped by ${signal}.\n`);
      resolve({ exitCode: code ?? 1, durationMs: Date.now() - started });
    });
  });
}

async function sourceFingerprint(cwd: string): Promise<string> {
  const options = {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    env: withoutComoteEnvironment(process.env),
  };
  const [status, diff, head] = await Promise.all([
    execFileAsync("git", ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"], options).then((value) => value.stdout),
    execFileAsync("git", ["-C", cwd, "diff", "--no-ext-diff", "--binary", "HEAD", "--", "."], options).then((value) => value.stdout).catch(() => ""),
    execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"], options).then((value) => value.stdout.trim()).catch(() => "unborn"),
  ]);
  const untrackedMetadata: string[] = [];
  for (const entry of status.split("\0")) {
    if (!entry.startsWith("?? ")) continue;
    const relative = entry.slice(3);
    const info = await stat(path.join(cwd, relative)).catch(() => null);
    untrackedMetadata.push(`${relative}:${info?.size ?? -1}:${info?.mtimeMs ?? -1}`);
  }
  return createHash("sha256")
    .update(head).update("\0")
    .update(status).update("\0")
    .update(diff).update("\0")
    .update(untrackedMetadata.join("\0"))
    .digest("hex");
}

function trimOutput(value: string): string {
  return value.slice(-80_000);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function stopProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
  }
}
