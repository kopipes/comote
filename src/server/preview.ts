import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { readFile, stat } from "node:fs/promises";
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
}

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
  private lastFailure: (Omit<ActivePreview, "child" | "ready"> & { error: string }) | null = null;
  private operation = Promise.resolve();

  constructor(private readonly port: number, private readonly publicUrl: string) {}

  status(project: Project, threadId: string): PreviewStatus {
    const active = this.active;
    const selected = Boolean(active && active.projectId === project.id && active.threadId === threadId);
    const failed = !selected && this.lastFailure?.projectId === project.id && this.lastFailure.threadId === threadId
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
      const launch = await detectPreviewLaunch(workspace.path, this.port);
      const child = spawn(launch.executable, launch.args, {
        cwd: workspace.path,
        detached: true,
        env: createPreviewEnvironment(this.port),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const active: ActivePreview = {
        projectId: project.id,
        threadId,
        cwd: workspace.path,
        command: launch.display,
        child,
        logs: "",
        startedAt: new Date().toISOString(),
        ready: false,
      };
      this.active = active;
      const append = (chunk: Buffer) => {
        active.logs = `${active.logs}${stripAnsi(String(chunk))}`.slice(-40_000);
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.once("error", (error) => append(Buffer.from(`\n${error.message}\n`)));
      child.once("exit", () => {
        if (this.active?.child === child) this.active = null;
      });

      try {
        await waitUntilReady(this.port, child, 30_000);
        active.ready = true;
        this.lastFailure = null;
        return this.status(project, threadId);
      } catch (error) {
        const logs = active.logs.trim();
        const message = `${(error as Error).message}${logs ? ` Last output: ${logs.slice(-1_000)}` : ""}`;
        this.lastFailure = {
          projectId: active.projectId,
          threadId: active.threadId,
          cwd: active.cwd,
          command: active.command,
          logs,
          startedAt: active.startedAt,
          error: message,
        };
        await this.stopActive();
        throw new Error(message);
      }
    });
  }

  stop(): Promise<void> {
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
    ? ["--", "--host", "127.0.0.1", "--port", String(port)]
    : packages.next || parsed.scripts?.[script]?.includes("next")
      ? ["--", "-H", "127.0.0.1", "-p", String(port)]
      : [];
  const args = ["run", script, ...extra];
  return { executable: "npm", args, display: `npm ${args.join(" ")}` };
}

export function createPreviewEnvironment(port: number): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  env.HOST = "127.0.0.1";
  env.HOSTNAME = "127.0.0.1";
  env.PORT = String(port);
  env.BROWSER = "none";
  env.NODE_ENV = "development";
  return env;
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
