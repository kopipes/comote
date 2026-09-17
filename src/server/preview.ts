import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Project } from "./projects.js";
import type { ThreadWorkspace } from "./worktrees.js";

interface ActivePreview {
  projectId: string;
  threadId: string;
  cwd: string;
  command: string;
  child: ChildProcess;
  logs: string;
  startedAt: string;
  ready: boolean;
  recoveryAttempts: number;
}

type FailedPreview = Omit<ActivePreview, "child" | "ready"> & { error: string };

export interface PreviewStatus {
  running: boolean;
  selected: boolean;
  ready: boolean;
  url: string;
  command: string;
  logs: string;
  startedAt: string;
  error: string;
}

export class PreviewManager {
  private active: ActivePreview | null = null;
  private lastFailure: FailedPreview | null = null;
  private operation = Promise.resolve();

  constructor(private readonly port: number, private readonly publicUrl: string, private readonly stateFile = "") {}

  restore(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.stateFile || this.active) return;
      const saved = await this.readSavedPreview();
      if (!saved) return;
      await this.launch(saved.projectId, saved.threadId, saved.cwd, 0);
    });
  }

  status(project: Project, threadId: string): PreviewStatus {
    return this.publicStatus(project.id, threadId);
  }

  inspect(project: Project, threadId: string): Promise<PreviewStatus> {
    return this.exclusive(async () => {
      const active = this.active;
      if (active && active.projectId === project.id && active.threadId === threadId && active.ready) {
        if (await previewResponding(this.port)) return this.publicStatus(project.id, threadId);
        const failure = failedPreview(active, "Preview stopped responding after it started.");
        await this.stopActive();
        this.lastFailure = failure;
      }

      const failed = this.lastFailure;
      if (!this.active && failed?.projectId === project.id && failed.threadId === threadId && failed.recoveryAttempts < 1) {
        try {
          return await this.launch(failed.projectId, failed.threadId, failed.cwd, failed.recoveryAttempts + 1);
        } catch {
          return this.publicStatus(project.id, threadId);
        }
      }
      return this.publicStatus(project.id, threadId);
    });
  }

  private publicStatus(projectId: string, threadId: string): PreviewStatus {
    const active = this.active;
    const selected = Boolean(active && active.projectId === projectId && active.threadId === threadId);
    const failed = !selected && this.lastFailure?.projectId === projectId && this.lastFailure.threadId === threadId
      ? this.lastFailure
      : null;
    return {
      running: Boolean(active),
      selected,
      ready: Boolean(active?.ready),
      url: this.publicUrl,
      command: selected ? active!.command : failed?.command ?? "",
      logs: selected ? active!.logs : failed?.logs ?? "",
      startedAt: selected ? active!.startedAt : failed?.startedAt ?? "",
      error: failed?.error ?? "",
    };
  }

  start(project: Project, threadId: string, workspace: ThreadWorkspace): Promise<PreviewStatus> {
    return this.exclusive(async () => {
      await this.stopActive();
      await this.forgetPreview();
      return this.launch(project.id, threadId, workspace.path, 0);
    });
  }

  private async launch(projectId: string, threadId: string, cwd: string, recoveryAttempts: number): Promise<PreviewStatus> {
    const launch = await detectPreviewLaunch(cwd, this.port);
    const child = spawn(launch.executable, launch.args, {
      cwd,
      detached: true,
      env: createPreviewEnvironment(this.port, this.publicUrl),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const active: ActivePreview = {
      projectId,
      threadId,
      cwd,
      command: launch.display,
      child,
      logs: "",
      startedAt: new Date().toISOString(),
      ready: false,
      recoveryAttempts,
    };
    this.active = active;
    const append = (chunk: Buffer) => {
      active.logs = `${active.logs}${stripAnsi(String(chunk))}`.slice(-40_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => append(Buffer.from(`\n${error.message}\n`)));
    child.once("exit", (code, signal) => {
      if (this.active?.child !== child) return;
      const reason = `Preview process stopped unexpectedly${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`;
      this.lastFailure = failedPreview(active, reason);
      this.active = null;
    });

    try {
      await waitUntilReady(this.port, child, 30_000);
      active.ready = true;
      this.lastFailure = null;
      await this.rememberPreview(active).catch((error: Error) => append(Buffer.from(`\nCould not persist preview state: ${error.message}\n`)));
      return this.publicStatus(projectId, threadId);
    } catch (error) {
      const logs = active.logs.trim();
      const message = `${(error as Error).message}${logs ? ` Last output: ${logs.slice(-1_000)}` : ""}`;
      this.lastFailure = failedPreview(active, message);
      await this.stopActive();
      throw new Error(message);
    }
  }

  stop(): Promise<void> {
    return this.exclusive(async () => {
      await this.stopActive();
      await this.forgetPreview();
    });
  }

  shutdown(): Promise<void> {
    return this.exclusive(() => this.stopActive());
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async stopActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = null;
    if (active.child.exitCode !== null || !active.child.pid) return;
    signalGroup(active.child.pid, "SIGTERM");
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => active.child.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!exited) signalGroup(active.child.pid, "SIGKILL");
  }

  private async rememberPreview(active: ActivePreview): Promise<void> {
    if (!this.stateFile) return;
    await mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ projectId: active.projectId, threadId: active.threadId, cwd: active.cwd }), { mode: 0o600 });
    await rename(temporary, this.stateFile);
  }

  private async forgetPreview(): Promise<void> {
    if (!this.stateFile) return;
    await unlink(this.stateFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async readSavedPreview(): Promise<{ projectId: string; threadId: string; cwd: string } | null> {
    const raw = await readFile(this.stateFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.projectId !== "string" || !value.projectId || typeof value.threadId !== "string" || !value.threadId || typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)) {
      throw new Error("Saved preview state is invalid.");
    }
    return { projectId: value.projectId, threadId: value.threadId, cwd: value.cwd };
  }
}

export async function detectPreviewLaunch(cwd: string, port: number): Promise<{ executable: string; args: string[]; display: string }> {
  const packagePath = path.join(cwd, "package.json");
  const packageInfo = await stat(packagePath).catch(() => null);
  if (!packageInfo?.isFile()) throw new Error("Preview currently supports Node projects with a package.json file.");
  if (!await stat(path.join(cwd, "node_modules")).catch(() => null)) {
    throw new Error("Dependencies are not installed. Ask Codex to install the project dependencies first.");
  }
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const script = parsed.scripts?.dev ? "dev" : parsed.scripts?.start ? "start" : "";
  if (!script) throw new Error("No dev or start script was found in package.json.");
  const packages = { ...parsed.dependencies, ...parsed.devDependencies };
  const extra = packages.vite || parsed.scripts?.[script]?.includes("vite")
    ? ["--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"]
    : packages.next || parsed.scripts?.[script]?.includes("next")
      ? ["--", "-H", "127.0.0.1", "-p", String(port)]
      : [];
  const args = ["run", script, ...extra];
  return { executable: "npm", args, display: `npm ${args.join(" ")}` };
}

export function createPreviewEnvironment(port: number, publicUrl = ""): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  env.HOST = "127.0.0.1";
  env.HOSTNAME = "127.0.0.1";
  env.PORT = String(port);
  env.BROWSER = "none";
  env.NODE_ENV = "development";
  const publicHost = previewHostname(publicUrl);
  if (publicHost) env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = publicHost;
  return env;
}

function previewHostname(publicUrl: string): string {
  try {
    const url = new URL(publicUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.hostname : "";
  } catch {
    return "";
  }
}

function waitUntilReady(port: number, child: ChildProcess, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const probe = () => {
      if (child.exitCode !== null) {
        reject(new Error(`Preview process exited with code ${child.exitCode}.`));
        return;
      }
      const check = request({ hostname: "127.0.0.1", port, path: "/", method: "GET", timeout: 1_000 }, (response) => {
        response.resume();
        resolve();
      });
      check.once("timeout", () => check.destroy());
      check.once("error", () => {
        if (Date.now() >= deadline) reject(new Error("Preview did not become ready within 30 seconds."));
        else setTimeout(probe, 300);
      });
      check.end();
    };
    probe();
  });
}

function previewResponding(port: number, timeout = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const check = request({ hostname: "127.0.0.1", port, path: "/", method: "GET", timeout }, (response) => {
      response.resume();
      resolve(true);
    });
    check.once("timeout", () => {
      check.destroy();
      resolve(false);
    });
    check.once("error", () => resolve(false));
    check.end();
  });
}

function failedPreview(active: ActivePreview, error: string): FailedPreview {
  return {
    projectId: active.projectId,
    threadId: active.threadId,
    cwd: active.cwd,
    command: active.command,
    logs: active.logs.trim(),
    startedAt: active.startedAt,
    recoveryAttempts: active.recoveryAttempts,
    error,
  };
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already stopped */ }
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
