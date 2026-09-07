import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], extraEnvironment: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, ...extraEnvironment, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}

export async function gitStatus(cwd: string): Promise<{ branch: string; status: string; diff: string }> {
  const [branch, status, diff] = await Promise.all([
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["status", "--short"]),
    git(cwd, ["diff", "--no-ext-diff", "--", "."]),
  ]);
  return { branch: branch || "detached", status, diff: diff.slice(0, 500_000) };
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
