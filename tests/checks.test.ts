import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CheckManager, detectCheckPlan } from "../src/server/checks.js";
import type { Project } from "../src/server/projects.js";

const execFileAsync = promisify(execFile);

test("check plan uses the standard package scripts in a stable order", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "comote-check-plan-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { build: "build", test: "test", lint: "lint", dev: "dev" } }));
  assert.deepEqual(await detectCheckPlan(cwd), ["lint", "test", "build"]);
});

test("check plan falls back to a composite check script", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "comote-check-fallback-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { check: "verify", dev: "dev" } }));
  assert.deepEqual(await detectCheckPlan(cwd), ["check"]);
});

test("check manager runs only detected standard script names and records failures", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "comote-check-run-"));
  await execFileAsync("git", ["init", "-b", "main", cwd]);
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { lint: "lint", test: "test" } }));
  const project: Project = { id: "demo", name: "demo", path: cwd };
  const completed: string[] = [];
  const manager = new CheckManager(
    (_project, status) => completed.push(status.phase),
    async (_cwd, script, onOutput) => {
      onOutput(`${script} output\n`);
      return { exitCode: script === "test" ? 1 : 0, durationMs: 12 };
    },
  );

  assert.equal((await manager.start("demo:task", project, cwd)).phase, "running");
  await waitFor(async () => (await manager.status("demo:task", cwd)).phase !== "running");
  const result = await manager.status("demo:task", cwd);
  assert.equal(result.phase, "failed");
  assert.deepEqual(result.steps.map((step) => step.command), ["npm run lint", "npm run test"]);
  assert.match(result.steps[1].output, /test output/);
  assert.deepEqual(completed, ["failed"]);
  await writeFile(path.join(cwd, "changed-after-check.txt"), "new work");
  assert.equal((await manager.status("demo:task", cwd)).stale, true);
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for checks.");
}
