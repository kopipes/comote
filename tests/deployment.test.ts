import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { renderNginxConfig } from "../src/server/deploy-helper.js";
import { DeploymentManager, validateDeploymentSlug } from "../src/server/deployment.js";
import type { Project } from "../src/server/projects.js";

test("deployment names are normalized and cannot escape a subdomain", () => {
  assert.equal(validateDeploymentSlug("My-App"), "my-app");
  for (const value of ["", "-bad", "bad-", "two--bad", "a.b", "../../etc", "a".repeat(25)]) {
    assert.throws(() => validateDeploymentSlug(value), /Invalid deployment name/);
  }
});

test("nginx production config binds only the selected interface", () => {
  const config = renderNginxConfig({
    bindAddress: "10.0.3.25",
    domain: "demo.apps.example.com",
    kind: "static",
    staticRoot: "/srv/comote-apps/demo/releases/release/dist",
    tls: true,
    webroot: "/var/lib/letsencrypt",
  });
  assert.match(config, /listen 10\.0\.3\.25:443 ssl http2/);
  assert.match(config, /server_name demo\.apps\.example\.com/);
  assert.match(config, /try_files \$uri \$uri\/ \/index\.html/);
  assert.doesNotMatch(config, /listen 443/);
});

test("deployment manager records deploys and rollbacks without blocking the API", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-deployment-"));
  const project: Project = { id: "demo", name: "demo", path: "/projects/demo" };
  let deployed = 0;
  const manager = new DeploymentManager(dataDir, "apps.example.com", "/unused", async (request) => {
    if (request.action === "rollback") return { ok: true, release: "r1", previousRelease: "r2", kind: "static", logs: "rolled back" };
    deployed += 1;
    return deployed === 1
      ? { ok: true, release: "r1", previousRelease: "", kind: "static", logs: "first" }
      : { ok: true, release: "r2", previousRelease: "r1", kind: "static", logs: "second" };
  });
  await manager.init();

  assert.equal(manager.start(project, "Demo").phase, "deploying");
  await waitFor(() => manager.status(project).phase === "deployed");
  assert.equal(manager.status(project).release, "r1");

  manager.start(project, "demo");
  await waitFor(() => manager.status(project).release === "r2");
  assert.equal(manager.status(project).previousRelease, "r1");

  assert.equal(manager.rollback(project).phase, "rolling_back");
  await waitFor(() => manager.status(project).release === "r1");
  assert.equal(manager.status(project).previousRelease, "r2");
});

test("deployment remains disabled when no production domain is configured", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-deployment-disabled-"));
  const manager = new DeploymentManager(dataDir, "", "/unused");
  const project: Project = { id: "demo", name: "demo", path: "/projects/demo" };
  await manager.init();
  assert.equal(manager.status(project).enabled, false);
  assert.throws(() => manager.start(project, "demo"), /not configured/);
});

test("the Comote workspace cannot be published through its own deployment broker", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-deployment-self-"));
  const manager = new DeploymentManager(dataDir, "apps.example.com", "/unused");
  const project: Project = { id: "comote", name: "comote", path: "/projects/comote" };
  await manager.init();
  assert.equal(manager.status(project).enabled, false);
  assert.match(manager.status(project).disabledReason, /stays private/);
  assert.throws(() => manager.start(project, "comote"), /stays private/);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for deployment state.");
}
