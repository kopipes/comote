import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { gitStatus, gitUnmergedCommitCount, parseDivergence } from "../src/server/git.js";

const execFileAsync = promisify(execFile);

test("Git workflow status distinguishes committed, merged, and pushed states", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "comote-git-state-"));
  const repository = path.join(root, "repository");
  const remote = path.join(root, "remote.git");
  try {
    await run(root, ["init", "--bare", remote]);
    await run(root, ["init", "-b", "main", repository]);
    await run(repository, ["config", "user.name", "Comote Test"]);
    await run(repository, ["config", "user.email", "comote@example.test"]);
    await writeFile(path.join(repository, "app.txt"), "initial\n");
    await run(repository, ["add", "app.txt"]);
    await run(repository, ["commit", "-m", "initial"]);
    await run(repository, ["remote", "add", "origin", remote]);
    await run(repository, ["push", "-u", "origin", "main"]);

    const pushed = await gitStatus(repository);
    assert.equal(pushed.status, "");
    assert.deepEqual(pushed.tracking, { upstream: "origin/main", ahead: 0, behind: 0 });

    await run(repository, ["switch", "-c", "task/test"]);
    await writeFile(path.join(repository, "app.txt"), "changed\n");
    assert.match((await gitStatus(repository)).status, /app\.txt/);
    await run(repository, ["add", "app.txt"]);
    await run(repository, ["commit", "-m", "change"]);
    assert.equal(await gitUnmergedCommitCount(repository, "main"), 1);
    assert.equal((await gitStatus(repository)).tracking.upstream, "");

    await run(repository, ["switch", "main"]);
    await run(repository, ["merge", "--no-ff", "task/test", "-m", "merge task"]);
    assert.equal(await gitUnmergedCommitCount(repository, "main"), 0);
    assert.equal((await gitStatus(repository)).tracking.ahead, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git divergence parsing is defensive", () => {
  assert.deepEqual(parseDivergence("origin/main", "2\t3"), { upstream: "origin/main", behind: 2, ahead: 3 });
  assert.deepEqual(parseDivergence("origin/main", "invalid"), { upstream: "origin/main", behind: 0, ahead: 0 });
});

async function run(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
