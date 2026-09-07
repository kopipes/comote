import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPreviewEnvironment, detectPreviewLaunch } from "../src/server/preview.js";

test("preview launch detects a dev script and does not pass Comote secrets", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "comote-preview-"));
  await mkdir(path.join(cwd, "node_modules"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "latest" } }));
  const launch = await detectPreviewLaunch(cwd, 4180);
  assert.equal(launch.executable, "npm");
  assert.deepEqual(launch.args, ["run", "dev", "--", "--host", "127.0.0.1", "--port", "4180"]);

  const originalSecret = process.env.COMOTE_PASSWORD_HASH;
  process.env.COMOTE_PASSWORD_HASH = "must-not-leak";
  try {
    const environment = createPreviewEnvironment(4180);
    assert.equal(environment.COMOTE_PASSWORD_HASH, undefined);
    assert.equal(environment.HOST, "127.0.0.1");
    assert.equal(environment.PORT, "4180");
  } finally {
    if (originalSecret === undefined) delete process.env.COMOTE_PASSWORD_HASH;
    else process.env.COMOTE_PASSWORD_HASH = originalSecret;
  }
});
