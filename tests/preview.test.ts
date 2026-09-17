import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPreviewEnvironment, detectPreviewLaunch, PreviewManager } from "../src/server/preview.js";

test("preview launch detects a dev script and does not pass Comote secrets", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "comote-preview-"));
  await mkdir(path.join(cwd, "node_modules"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "latest" } }));
  const launch = await detectPreviewLaunch(cwd, 4180);
  assert.equal(launch.executable, "npm");
  assert.deepEqual(launch.args, ["run", "dev", "--", "--host", "127.0.0.1", "--port", "4180", "--strictPort"]);

  const originalSecret = process.env.COMOTE_PASSWORD_HASH;
  process.env.COMOTE_PASSWORD_HASH = "must-not-leak";
  try {
    const environment = createPreviewEnvironment(4180, "https://comote-vps.tailb6b750.ts.net:8443/");
    assert.equal(environment.COMOTE_PASSWORD_HASH, undefined);
    assert.equal(environment.HOST, "127.0.0.1");
    assert.equal(environment.PORT, "4180");
    assert.equal(environment.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS, "comote-vps.tailb6b750.ts.net");
  } finally {
    if (originalSecret === undefined) delete process.env.COMOTE_PASSWORD_HASH;
    else process.env.COMOTE_PASSWORD_HASH = originalSecret;
  }
});

test("preview environment ignores invalid or non-HTTP public URLs", () => {
  assert.equal(createPreviewEnvironment(4180, "not a URL").__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS, undefined);
  assert.equal(createPreviewEnvironment(4180, "file:///tmp/preview").__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS, undefined);
});

test("a failed preview keeps its diagnostic state for Fix with Codex", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "comote-preview-failure-"));
  await mkdir(path.join(cwd, "node_modules"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({
    scripts: { dev: "node -e \"console.error('preview failed safely'); process.exit(1)\"" },
  }));
  const project = { id: "preview-project", name: "preview-project", path: cwd };
  const manager = new PreviewManager(49_997, "https://preview.example.test");
  await assert.rejects(
    manager.start(project, "preview-thread", { path: cwd, writableRoots: [cwd], isolated: false }),
    /Preview process exited/,
  );
  const status = manager.status(project, "preview-thread");
  assert.equal(status.running, false);
  assert.match(status.error, /Preview process exited/);
  assert.match(status.logs, /preview failed safely/);
});
