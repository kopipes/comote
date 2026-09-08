import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gitMergeTask } from "../src/server/git.js";
import { ProjectRegistry } from "../src/server/projects.js";
import { WorktreeManager } from "../src/server/worktrees.js";

const execFileAsync = promisify(execFile);

test("each attached task receives a persistent isolated Git worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "comote-projects-"));
  const data = await mkdtemp(path.join(tmpdir(), "comote-data-"));
  const registry = new ProjectRegistry(root);
  const manager = new WorktreeManager(data);
  await Promise.all([registry.init(), manager.init()]);
  const project = await registry.create("isolated-app");

  const first = await manager.prepare(project);
  const second = await manager.prepare(project);
  await Promise.all([
    manager.attach(first, "thread-one"),
    manager.attach(second, "thread-two"),
  ]);

  const one = await manager.forThread(project, "thread-one");
  const two = await manager.forThread(project, "thread-two");
  assert.equal(one.isolated, true);
  assert.equal(two.isolated, true);
  assert.notEqual(one.path, two.path);
  assert.notEqual(one.branch, two.branch);
  assert.ok((await stat(path.join(one.path, ".git"))).isFile());
  assert.deepEqual(one.writableRoots, [one.path, path.join(project.path, ".git")]);

  const reloaded = new WorktreeManager(data);
  await reloaded.init();
  assert.equal((await reloaded.forThread(project, "thread-one")).path, one.path);
  assert.ok(reloaded.belongsToProject(project, "thread-one", one.path));
  assert.ok(!reloaded.belongsToProject(project, "thread-one", two.path));
});

test("legacy threads without a mapping continue in the canonical workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "comote-projects-"));
  const data = await mkdtemp(path.join(tmpdir(), "comote-data-"));
  const registry = new ProjectRegistry(root);
  const manager = new WorktreeManager(data);
  await Promise.all([registry.init(), manager.init()]);
  const project = await registry.create("legacy-app");
  const workspace = await manager.forThread(project, "legacy-thread");
  assert.equal(workspace.path, project.path);
  assert.equal(workspace.isolated, false);
});

test("a clean session without unmerged commits can remove its worktree and branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "comote-projects-"));
  const data = await mkdtemp(path.join(tmpdir(), "comote-data-"));
  const registry = new ProjectRegistry(root);
  const manager = new WorktreeManager(data);
  await Promise.all([registry.init(), manager.init()]);
  const project = await registry.create("remove-session-app");
  const record = await manager.attach(await manager.prepare(project), "removable-thread");

  await manager.remove(project, "removable-thread");

  await assert.rejects(stat(record.path), { code: "ENOENT" });
  assert.equal(manager.recordForThread(project, "removable-thread"), null);
  const { stdout } = await execFileAsync("git", ["-C", project.path, "branch", "--list", record.branch]);
  assert.equal(stdout.trim(), "");
});

test("session removal refuses uncommitted and unmerged work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "comote-projects-"));
  const data = await mkdtemp(path.join(tmpdir(), "comote-data-"));
  const registry = new ProjectRegistry(root);
  const manager = new WorktreeManager(data);
  await Promise.all([registry.init(), manager.init()]);
  const project = await registry.create("protected-session-app");
  const dirty = await manager.attach(await manager.prepare(project), "dirty-thread");
  await writeFile(path.join(dirty.path, "unsaved.txt"), "not committed\n");
  await assert.rejects(manager.remove(project, "dirty-thread"), /uncommitted project changes/);
  assert.ok((await stat(dirty.path)).isDirectory());

  const unmerged = await manager.attach(await manager.prepare(project), "unmerged-thread");
  await writeFile(path.join(unmerged.path, "feature.txt"), "committed only on task\n");
  await execFileAsync("git", ["-C", unmerged.path, "add", "feature.txt"]);
  await execFileAsync("git", ["-C", unmerged.path, "commit", "-m", "feat: task-only change"]);
  await assert.rejects(manager.remove(project, "unmerged-thread"), /commits that are not merged/);
  assert.ok((await stat(unmerged.path)).isDirectory());
});

test("a clean task branch merges into the canonical branch with provenance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "comote-projects-"));
  const data = await mkdtemp(path.join(tmpdir(), "comote-data-"));
  const registry = new ProjectRegistry(root);
  const manager = new WorktreeManager(data);
  await Promise.all([registry.init(), manager.init()]);
  const project = await registry.create("merge-app");
  const prepared = await manager.prepare(project);
  const record = await manager.attach(prepared, "merge-thread");

  await writeFile(path.join(record.path, "feature.txt"), "isolated change\n");
  await execFileAsync("git", ["-C", record.path, "add", "feature.txt"]);
  await execFileAsync("git", ["-C", record.path, "commit", "-m", "feat: isolated change"]);
  const sha = await gitMergeTask(project.path, record.path, record.baseBranch, record.branch, "Mobile", record.threadId);

  assert.match(sha, /^[0-9a-f]+$/);
  assert.equal(await readFile(path.join(project.path, "feature.txt"), "utf8"), "isolated change\n");
  const { stdout } = await execFileAsync("git", ["-C", project.path, "log", "-1", "--format=%B"]);
  assert.match(stdout, /Requested-From: Mobile/);
  assert.match(stdout, /Comote-Session: merge-thread/);
});
