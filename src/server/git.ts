import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withoutComoteEnvironment } from "./child-environment.js";

const execFileAsync = promisify(execFile);

export interface GitTrackingState {
  upstream: string;
  ahead: number;
  behind: number;
}

export interface GitRepositoryState {
  branch: string;
  revision: string;
  status: string;
  diff: string;
  tracking: GitTrackingState;
}

async function git(cwd: string, args: string[], extraEnvironment: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...withoutComoteEnvironment(process.env), ...extraEnvironment, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}

export async function gitStatus(cwd: string): Promise<GitRepositoryState> {
  const [branch, revision, status, diff, upstream] = await Promise.all([
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["rev-parse", "--short=12", "HEAD"]).catch(() => "unborn"),
    git(cwd, ["status", "--short"]),
    git(cwd, ["diff", "--no-ext-diff", "--", "."]),
    git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => ""),
  ]);
  const tracking = upstream
    ? parseDivergence(upstream, await git(cwd, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]))
    : { upstream: "", ahead: 0, behind: 0 };
  return { branch: branch || "detached", revision, status, diff: diff.slice(0, 500_000), tracking };
}

export async function gitUnmergedCommitCount(cwd: string, baseBranch: string): Promise<number> {
  const value = await git(cwd, ["rev-list", "--count", `${baseBranch}..HEAD`]);
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export function parseDivergence(upstream: string, value: string): GitTrackingState {
  const [behindValue = "0", aheadValue = "0"] = value.trim().split(/\s+/);
  const behind = Number.parseInt(behindValue, 10);
  const ahead = Number.parseInt(aheadValue, 10);
  return {
    upstream,
    behind: Number.isFinite(behind) && behind > 0 ? behind : 0,
    ahead: Number.isFinite(ahead) && ahead > 0 ? ahead : 0,
  };
}

export async function gitCommit(
  cwd: string,
  message: string,
  deviceName: string,
  sessionId: string,
): Promise<string> {
  const cleanMessage = message.trim();
  if (!cleanMessage || cleanMessage.length > 500) throw new Error("Commit message must be 1–500 characters.");
  await git(cwd, ["add", "-A"]);
  const trailers = [
    `Requested-From: ${deviceName}`,
    "Developed-On: cloudeka48",
    "Assisted-By: Codex",
    `Comote-Session: ${sessionId}`,
  ].join("\n");
  await git(cwd, ["commit", "-m", cleanMessage, "-m", trailers]);
  return git(cwd, ["rev-parse", "--short", "HEAD"]);
}

export async function gitPush(cwd: string, extraEnvironment: NodeJS.ProcessEnv = {}): Promise<string> {
  const hasUpstream = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    .then(() => true)
    .catch(() => false);
  return git(cwd, hasUpstream ? ["push"] : ["push", "-u", "origin", "HEAD"], extraEnvironment);
}

export async function gitMergeTask(
  projectPath: string,
  worktreePath: string,
  expectedBaseBranch: string,
  expectedTaskBranch: string,
  deviceName: string,
  sessionId: string,
): Promise<string> {
  const [projectStatus, taskStatus, baseBranch, taskBranch] = await Promise.all([
    git(projectPath, ["status", "--short"]),
    git(worktreePath, ["status", "--short"]),
    git(projectPath, ["branch", "--show-current"]),
    git(worktreePath, ["branch", "--show-current"]),
  ]);
  if (projectStatus) throw new Error("Canonical workspace has uncommitted changes. Commit or discard them before merging a task.");
  if (taskStatus) throw new Error("Task worktree has uncommitted changes. Commit them before merging.");
  if (baseBranch !== expectedBaseBranch || taskBranch !== expectedTaskBranch) {
    throw new Error("Task or canonical branch changed unexpectedly. Refresh before merging.");
  }

  await git(projectPath, ["merge-tree", "--write-tree", baseBranch, taskBranch]).catch(() => {
    throw new Error("Task branch conflicts with the canonical branch. Ask Codex to resolve the conflicts in the task first.");
  });
  const trailers = [
    `Requested-From: ${deviceName}`,
    "Developed-On: cloudeka48",
    "Assisted-By: Codex",
    `Comote-Session: ${sessionId}`,
  ].join("\n");
  await git(projectPath, ["merge", "--no-ff", taskBranch, "-m", `merge: ${taskBranch}`, "-m", trailers]);
  return git(projectPath, ["rev-parse", "--short", "HEAD"]);
}
