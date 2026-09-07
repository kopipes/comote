import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectRegistry } from "../src/server/projects.js";

test("project registry exposes only Git workspaces directly below its root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "comote-projects-"));
  await mkdir(path.join(root, "valid", ".git"), { recursive: true });
  await mkdir(path.join(root, "not-git"));
  await writeFile(path.join(root, "README"), "ignored");

  const registry = new ProjectRegistry(root);
  await registry.init();
  const projects = await registry.list();
  assert.deepEqual(projects.map((project) => project.name), ["valid"]);
  assert.equal((await registry.get(projects[0].id)).path, await realpath(path.join(root, "valid")));
});

test("project registry rejects symlinks that escape the root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "comote-projects-"));
  const outside = await mkdtemp(path.join(tmpdir(), "comote-outside-"));
  await mkdir(path.join(outside, ".git"));
  await symlink(outside, path.join(root, "escape"));

  const registry = new ProjectRegistry(root);
  await registry.init();
  await assert.rejects(() => registry.get(Buffer.from("escape").toString("base64url")), /outside/);
});
