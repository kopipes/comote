import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CodeIndexManager } from "../src/server/code-index.js";

const execFileAsync = promisify(execFile);

test("codebase index searches metadata and source while excluding dependencies and secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "comote-index-"));
  const workspace = path.join(root, "project");
  const data = path.join(root, "data");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "node_modules", "unsafe"), { recursive: true });
  await writeFile(path.join(workspace, "src", "auth.ts"), `
    import { Router } from "express";
    export class LoginService {}
    const router = Router();
    router.post("/api/login", handleLogin);
  `);
  await writeFile(path.join(workspace, ".env"), "SUPER_PRIVATE_TOKEN=private-token-987\n");
  await writeFile(path.join(workspace, "node_modules", "unsafe", "index.js"), "const dependencySecret = 'dependency-only-456';\n");
  await execFileAsync("git", ["init", "-b", "main", workspace]);

  const index = new CodeIndexManager(data);
  await index.init();
  try {
    const first = await index.search(workspace, "fix the login route");
    assert.equal(first.status.phase, "ready");
    assert.equal(first.status.indexedFiles, 1);
    assert.equal(first.matches[0]?.path, "src/auth.ts");
    assert.deepEqual(first.matches[0]?.routes, ["POST /api/login"]);
    assert.deepEqual(first.matches[0]?.symbols, ["LoginService"]);

    const secret = await index.search(workspace, "private-token-987 dependency-only-456");
    assert.deepEqual(secret.matches, []);

    await writeFile(path.join(workspace, "src", "auth.ts"), `
      export function verifyOneTimeCode() { return true; }
    `);
    const updated = await index.search(workspace, "verify one time code");
    assert.equal(updated.matches[0]?.path, "src/auth.ts");
    assert.ok(updated.matches[0]?.symbols.includes("verifyOneTimeCode"));

    await rm(path.join(workspace, "src", "auth.ts"));
    const removed = await index.search(workspace, "verifyOneTimeCode");
    assert.deepEqual(removed.matches, []);
    assert.equal(removed.status.indexedFiles, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
