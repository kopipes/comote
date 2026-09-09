import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { withoutComoteEnvironment } from "./child-environment.js";
import type { Project } from "./projects.js";

const execFileAsync = promisify(execFile);

export interface WorktreeRecord {
  threadId: string;
  projectId: string;
  path: string;
  branch: string;
  baseBranch: string;
  createdAt: string;
}

export interface PreparedWorktree extends Omit<WorktreeRecord, "threadId"> {}

export interface ThreadWorkspace {
  path: string;
  writableRoots: string[];
  isolated: boolean;
  branch?: string;
  baseBranch?: string;
}

export class WorktreeManager {
  private readonly root: string;
  private readonly stateFile: string;
  private rootRealPath = "";
  private records = new Map<string, WorktreeRecord>();
  private saveChain = Promise.resolve();

  constructor(dataDir: string) {
    this.root = path.resolve(dataDir, "worktrees");
    this.stateFile = path.resolve(dataDir, "worktrees.json");
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.rootRealPath = await realpath(this.root);
    const content = await readFile(this.stateFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!content) return;
    const records = JSON.parse(content) as WorktreeRecord[];
    for (const record of records) {
      if (record.threadId && this.isManagedPath(record.path)) this.records.set(record.threadId, record);
    }
  }

  async prepare(project: Project): Promise<PreparedWorktree> {
    const identifier = randomUUID();
    const short = identifier.slice(0, 8);
    const branch = `comote/task-${short}`;
    const projectRoot = path.join(this.rootRealPath || this.root, project.name);
    const worktreePath = path.join(projectRoot, identifier);
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    const baseBranch = await git(project.path, ["branch", "--show-current"]);
    if (!baseBranch) throw new Error("Canonical workspace must be on a branch before starting an isolated task.");
    await git(project.path, ["worktree", "add", "-b", branch, worktreePath, "HEAD"], 60_000);
    return {
      projectId: project.id,
      path: worktreePath,
      branch,
      baseBranch,
      createdAt: new Date().toISOString(),
    };
  }

  async attach(prepared: PreparedWorktree, threadId: string): Promise<WorktreeRecord> {
    const record: WorktreeRecord = { ...prepared, threadId };
    this.records.set(threadId, record);
    try {
      await this.persist();
    } catch (error) {
      this.records.delete(threadId);
      throw error;
    }
    return record;
  }

  async attachContinuation(project: Project, sourceThreadId: string, nextThreadId: string): Promise<WorktreeRecord> {
    if (!nextThreadId || this.records.has(nextThreadId)) throw new Error("Invalid continuation session id.");
    const source = this.recordForThread(project, sourceThreadId);
    if (!source) throw new Error("Only an isolated task session can continue in a fresh session.");
    await this.validateRecordPath(source);
    const record: WorktreeRecord = {
      ...source,
      threadId: nextThreadId,
      createdAt: new Date().toISOString(),
    };
    this.records.set(nextThreadId, record);
    try {
      await this.persist();
    } catch (error) {
      this.records.delete(nextThreadId);
      throw error;
    }
    return { ...record };
  }

  async detach(threadId: string): Promise<void> {
    if (!this.records.delete(threadId)) return;
    await this.persist();
  }

  async abort(project: Project, prepared: PreparedWorktree): Promise<void> {
    await git(project.path, ["worktree", "remove", "--force", prepared.path]).catch(() => undefined);
    await git(project.path, ["branch", "-D", prepared.branch]).catch(() => undefined);
  }

  async forThread(project: Project, threadId?: string): Promise<ThreadWorkspace> {
    const record = threadId ? this.records.get(threadId) : undefined;
    if (!record) return this.mainWorkspace(project);
    if (record.projectId !== project.id || !this.isManagedPath(record.path)) {
      throw new Error("Thread does not belong to this project.");
    }
    const info = await stat(record.path).catch(() => null);
    if (!info?.isDirectory()) throw new Error("Task worktree is no longer available.");
    const resolved = await realpath(record.path);
    if (!this.isManagedPath(resolved)) throw new Error("Task worktree is outside the managed root.");
    return {
      path: resolved,
      writableRoots: [resolved, path.join(project.path, ".git")],
      isolated: true,
      branch: record.branch,
      baseBranch: record.baseBranch,
    };
  }

  recordForThread(project: Project, threadId: string): WorktreeRecord | null {
    const record = this.records.get(threadId);
    if (!record) return null;
    if (record.projectId !== project.id || !this.isManagedPath(record.path)) {
      throw new Error("Thread does not belong to this project.");
    }
    return { ...record };
  }

  async assertRemovable(project: Project, threadId: string): Promise<void> {
    const record = this.recordForThread(project, threadId);
    if (!record) return;
    await this.validateRecordPath(record);
    if (this.sharedRecords(record).length > 0) return;

    const status = await git(record.path, ["status", "--porcelain"]);
    if (status) {
      throw new Error("Session has uncommitted project changes. Commit or discard them before deleting it.");
    }

    const merged = await gitSucceeds(project.path, ["merge-base", "--is-ancestor", record.branch, record.baseBranch]);
    if (!merged) {
      throw new Error("Session has commits that are not merged into its base branch. Merge it before deleting it.");
    }
  }

  async remove(project: Project, threadId: string): Promise<void> {
    const record = this.recordForThread(project, threadId);
    if (!record) return;
    await this.assertRemovable(project, threadId);
    if (this.sharedRecords(record).length > 0) {
      this.records.delete(threadId);
      await this.persist();
      return;
    }
    await git(project.path, ["worktree", "remove", record.path], 60_000);
    await git(project.path, ["branch", "-D", record.branch]);
    this.records.delete(threadId);
    await this.persist();
  }

  pathsForProject(project: Project): string[] {
    const paths = new Set([project.path]);
    for (const record of this.records.values()) {
      if (record.projectId === project.id && this.isManagedPath(record.path)) paths.add(record.path);
    }
    return [...paths];
  }

  assertRestorable(project: Project, threadId: string, activeThreadIds: Set<string>): void {
    const record = this.recordForThread(project, threadId);
    if (record && this.sharedRecords(record).some((candidate) => activeThreadIds.has(candidate.threadId))) {
      throw new Error("Another active session is using this task worktree. Archive or delete it before restoring this one.");
    }
  }

  belongsToProject(project: Project, threadId: string, cwd?: unknown): boolean {
    const record = this.records.get(threadId);
    if (record) return record.projectId === project.id && (!cwd || path.resolve(String(cwd)) === path.resolve(record.path));
    return typeof cwd === "string" && path.resolve(cwd) === project.path;
  }

  private mainWorkspace(project: Project): ThreadWorkspace {
    return {
      path: project.path,
      writableRoots: [project.path],
      isolated: false,
    };
  }

  private async validateRecordPath(record: WorktreeRecord): Promise<string> {
    const info = await stat(record.path).catch(() => null);
    if (!info?.isDirectory()) throw new Error("Task worktree is no longer available.");
    const resolved = await realpath(record.path);
    if (!this.isManagedPath(resolved)) throw new Error("Task worktree is outside the managed root.");
    return resolved;
  }

  private isManagedPath(value: string): boolean {
    const resolved = path.resolve(value);
    const managedRoot = this.rootRealPath || this.root;
    return resolved.startsWith(`${managedRoot}${path.sep}`);
  }

  private sharedRecords(record: WorktreeRecord): WorktreeRecord[] {
    const target = path.resolve(record.path);
    return [...this.records.values()].filter((candidate) => (
      candidate.threadId !== record.threadId
      && candidate.projectId === record.projectId
      && path.resolve(candidate.path) === target
    ));
  }

  private persist(): Promise<void> {
    const save = async () => {
      const temporary = `${this.stateFile}.${process.pid}.tmp`;
      const records = [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.stateFile);
    };
    this.saveChain = this.saveChain.then(save, save);
    return this.saveChain;
  }
}

async function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout,
    maxBuffer: 1024 * 1024,
    env: { ...withoutComoteEnvironment(process.env), GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch (error) {
    const exitCode = (error as NodeJS.ErrnoException & { code?: number }).code;
    if (exitCode === 1) return false;
    throw error;
  }
}
