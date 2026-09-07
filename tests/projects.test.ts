import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGithubRepository, ProjectRegistry, validateProjectName } from "../src/server/projects.js";

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

test("project registry creates a new main-branch Git workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "comote-projects-"));
  const registry = new ProjectRegistry(root);
  await registry.init();

  const project = await registry.create("new-app");
  assert.equal(project.name, "new-app");
  assert.ok(await stat(path.join(project.path, ".git")));
  await assert.rejects(() => registry.create("new-app"), /already exists/);
});

test("project names cannot escape or impersonate Git metadata", () => {
  assert.equal(validateProjectName("my-app_2"), "my-app_2");
  for (const value of ["../escape", ".hidden", "repo.git", "two words", ""]) {
    assert.throws(() => validateProjectName(value), /Invalid project name/);
  }
});

test("GitHub imports accept only canonical HTTPS repository URLs", () => {
  assert.deepEqual(parseGithubRepository("https://github.com/kopipes/comote"), {
    url: "https://github.com/kopipes/comote.git",
    name: "comote",
  });
  assert.deepEqual(parseGithubRepository("https://github.com/kopipes/comote.git"), {
    url: "https://github.com/kopipes/comote.git",
    name: "comote",
  });
  for (const value of [
    "git@github.com:kopipes/comote.git",
    "https://example.com/kopipes/comote",
    "https://token@github.com/kopipes/comote",
    "https://github.com/kopipes/comote/issues",
  ]) {
    assert.throws(() => parseGithubRepository(value), /Invalid GitHub/);
  }
});
