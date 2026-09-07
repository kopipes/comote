import { execFile } from "node:child_process";
import { createConnection, isIP } from "node:net";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateDeploymentSlug } from "./deployment.js";

const execFileAsync = promisify(execFile);

interface DeployRequest {
  action: "deploy" | "rollback";
  projectName: string;
  sourcePath: string;
  slug: string;
}

interface ReleaseRecord {
  id: string;
  sha: string;
  kind: "static" | "node";
  port: number;
  createdAt: string;
}

interface AppRecord {
  projectName: string;
  sourcePath: string;
  domain: string;
  current: string;
  previous: string;
  releases: ReleaseRecord[];
}

interface DeployState {
  nextPort: number;
  apps: Record<string, AppRecord>;
}

interface HelperConfig {
  domainSuffix: string;
  bindAddress: string;
  projectsRoot: string;
  deployRoot: string;
  statePath: string;
  nginxAvailable: string;
  nginxEnabled: string;
  letsEncryptWebroot: string;
  portStart: number;
  portEnd: number;
}

const logLines: string[] = [];

export async function handleDeployRequest(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  logLines.length = 0;
  const config = loadHelperConfig(env);
  const request = parseRequest(input);
  const lock = "/run/comote-deploy.lock";
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another deployment is already running.");
    throw cause;
  }
  try {
    return request.action === "deploy"
      ? await deploy(config, request)
      : await rollback(config, request);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export function renderNginxConfig(options: {
  bindAddress: string;
  domain: string;
  kind: "static" | "node" | "pending";
  port?: number;
  staticRoot?: string;
  tls: boolean;
  webroot: string;
}): string {
  const listener = options.tls
    ? `listen ${options.bindAddress}:443 ssl http2;\n    ssl_certificate /etc/letsencrypt/live/${options.domain}/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/${options.domain}/privkey.pem;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    server_tokens off;`
    : `listen ${options.bindAddress}:80;`;
  const body = options.kind === "node"
    ? `location / {\n        proxy_pass http://127.0.0.1:${options.port};\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection \"upgrade\";\n    }`
    : options.kind === "static"
      ? `root ${options.staticRoot};\n    location / {\n        try_files $uri $uri/ /index.html;\n    }`
      : "location / { return 503; }";
  const tlsServer = `server {\n    ${listener}\n    server_name ${options.domain};\n\n    add_header X-Content-Type-Options nosniff always;\n    add_header Referrer-Policy strict-origin-when-cross-origin always;\n\n    location ^~ /.well-known/acme-challenge/ {\n        root ${options.webroot};\n    }\n\n    ${body}\n}\n`;
  if (!options.tls) return tlsServer;
  return `server {\n    listen ${options.bindAddress}:80;\n    server_name ${options.domain};\n    location ^~ /.well-known/acme-challenge/ { root ${options.webroot}; }\n    location / { return 301 https://$host$request_uri; }\n}\n\n${tlsServer}`;
}

async function deploy(config: HelperConfig, request: DeployRequest): Promise<Record<string, unknown>> {
  const sourcePath = await validateSource(config, request);
  const state = await readState(config);
  const existing = state.apps[request.slug];
  if (existing && existing.sourcePath !== sourcePath) {
    throw new Error(`The deployment name '${request.slug}' belongs to another project.`);
  }

  const status = await run("git", ["-c", `safe.directory=${sourcePath}`, "-C", sourcePath, "status", "--porcelain"]);
  if (status.stdout.trim()) throw new Error("Canonical branch is not clean. Commit or remove its changes before deploying.");
  const sha = (await run("git", ["-c", `safe.directory=${sourcePath}`, "-C", sourcePath, "rev-parse", "HEAD"])).stdout.trim();
  const branch = (await run("git", ["-c", `safe.directory=${sourcePath}`, "-C", sourcePath, "branch", "--show-current"])).stdout.trim();
  if (!branch) throw new Error("Canonical repository is in detached HEAD state.");
  appendLog(`Deploying ${request.projectName}@${sha.slice(0, 8)} from ${branch}.`);

  const domain = `${request.slug}.${config.domainSuffix}`;
  const appRoot = path.join(config.deployRoot, request.slug);
  const releaseId = `${sha.slice(0, 12)}-${compactTimestamp()}`;
  const releasePath = path.join(appRoot, "releases", releaseId);
  const appUser = `comote-${request.slug}`;
  await ensureAppUser(appUser, appRoot);
  await mkdir(releasePath, { recursive: true, mode: 0o755 });
  let activated = false;

  try {
    await extractGitArchive(sourcePath, sha, releasePath);
    await recursivelyOwn(releasePath, appUser);
    await chmod(releasePath, 0o755);
    const packageInfo = await readPackage(releasePath);
    await runAs(appUser, releasePath, "npm", ["ci", "--include=dev", "--no-audit", "--no-fund"]);
    if (packageInfo.scripts?.build) await runAs(appUser, releasePath, "npm", ["run", "build"]);

    let kind: "static" | "node";
    let port = 0;
    if (await isFile(path.join(releasePath, "dist", "index.html"))) {
      kind = "static";
      await rm(path.join(releasePath, "node_modules"), { recursive: true, force: true });
      await run("chmod", ["-R", "a+rX", path.join(releasePath, "dist")]);
      appendLog("Detected a static production build in dist/.");
    } else if (packageInfo.scripts?.start) {
      kind = "node";
      await runAs(appUser, releasePath, "npm", ["prune", "--omit=dev", "--no-audit", "--no-fund"]);
      port = existing?.releases.find((release) => release.kind === "node")?.port || await allocatePort(config, state);
      appendLog(`Detected a Node service on internal port ${port}.`);
    } else {
      throw new Error("Deployment supports npm projects that build dist/index.html or provide an npm start script.");
    }

    await ensureCertificate(config, domain);
    const previousTarget = await readlink(path.join(appRoot, "current")).catch(() => "");
    const previousId = previousTarget ? path.basename(previousTarget) : "";
    await activateRelease(appRoot, releasePath);
    try {
      await activateRuntime(config, request.slug, appUser, kind, port);
      await installNginx(config, request.slug, domain, kind, port, releasePath, true);
      activated = true;
    } catch (cause) {
      let restored = false;
      if (previousId) {
        const oldRelease = existing?.releases.find((release) => release.id === previousId);
        if (oldRelease) {
          await activateRelease(appRoot, path.join(appRoot, "releases", previousId));
          await activateRuntime(config, request.slug, appUser, oldRelease.kind, oldRelease.port);
          await installNginx(config, request.slug, domain, oldRelease.kind, oldRelease.port, path.join(appRoot, "releases", previousId), true);
          restored = true;
          appendLog("Activation failed; the previous production release was restored.");
        }
      }
      if (!restored) {
        await rm(path.join(appRoot, "current"), { force: true });
        await run("systemctl", ["disable", "--now", `comote-app@${request.slug}.service`], true);
      }
      throw cause;
    }

    const release: ReleaseRecord = { id: releaseId, sha, kind, port, createdAt: new Date().toISOString() };
    const releases = [release, ...(existing?.releases ?? []).filter((item) => item.id !== releaseId)];
    const protectedReleases = new Set([releaseId, existing?.current ?? ""]);
    const retainedReleases = releases.filter((item, index) => index < 4 || protectedReleases.has(item.id));
    state.apps[request.slug] = {
      projectName: request.projectName,
      sourcePath,
      domain,
      current: releaseId,
      previous: existing?.current ?? "",
      releases: retainedReleases,
    };
    await writeState(config, state);
    await pruneReleases(appRoot, releases, protectedReleases);
    appendLog(`Production is live at https://${domain}.`);
    return response(state.apps[request.slug]);
  } catch (cause) {
    if (!activated) await rm(releasePath, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

async function rollback(config: HelperConfig, request: DeployRequest): Promise<Record<string, unknown>> {
  const sourcePath = await validateSource(config, request);
  const state = await readState(config);
  const app = state.apps[request.slug];
  if (!app || app.sourcePath !== sourcePath) throw new Error("This project has no deployment under that name.");
  if (!app.previous) throw new Error("No previous production release is available.");
  const target = app.releases.find((release) => release.id === app.previous);
  if (!target) throw new Error("The previous production release is missing.");
  const appRoot = path.join(config.deployRoot, request.slug);
  const releasePath = path.join(appRoot, "releases", target.id);
  if (!await isDirectory(releasePath)) throw new Error("The previous production release directory is missing.");

  const oldCurrent = app.current;
  await activateRelease(appRoot, releasePath);
  try {
    await activateRuntime(config, request.slug, `comote-${request.slug}`, target.kind, target.port);
    await installNginx(config, request.slug, app.domain, target.kind, target.port, releasePath, true);
  } catch (cause) {
    const current = app.releases.find((release) => release.id === oldCurrent);
    if (current) {
      const currentPath = path.join(appRoot, "releases", current.id);
      await activateRelease(appRoot, currentPath);
      await activateRuntime(config, request.slug, `comote-${request.slug}`, current.kind, current.port);
      await installNginx(config, request.slug, app.domain, current.kind, current.port, currentPath, true);
    }
    throw cause;
  }
  app.current = target.id;
  app.previous = oldCurrent;
  await writeState(config, state);
  appendLog(`Rolled back production to ${target.id}.`);
  return response(app);
}

async function validateSource(config: HelperConfig, request: DeployRequest): Promise<string> {
  if (!request.projectName || path.basename(request.sourcePath) !== request.projectName) throw new Error("Invalid project identity.");
  const sourcePath = await realpath(request.sourcePath);
  const projectsRoot = await realpath(config.projectsRoot);
  if (path.dirname(sourcePath) !== projectsRoot) throw new Error("Project is outside the deployment source root.");
  if (path.basename(sourcePath) === "comote") throw new Error("Comote itself cannot be deployed as a public production app.");
  if (!await isDirectory(path.join(sourcePath, ".git"))) throw new Error("Deployment source is not a canonical Git repository.");
  return sourcePath;
}

async function ensureAppUser(user: string, appRoot: string): Promise<void> {
  const exists = await run("getent", ["passwd", user], true);
  if (exists.code !== 0) {
    await run("useradd", ["--system", "--home-dir", appRoot, "--no-create-home", "--shell", "/usr/sbin/nologin", user]);
  }
  const passwd = (await run("getent", ["passwd", user])).stdout.trim().split(":");
  const uid = Number(passwd[2]);
  const gid = Number(passwd[3]);
  const releasesRoot = path.join(appRoot, "releases");
  await mkdir(releasesRoot, { recursive: true, mode: 0o755 });
  await mkdir(path.join(appRoot, ".home", ".npm"), { recursive: true, mode: 0o700 });
  await chown(appRoot, uid, gid);
  await chown(path.join(appRoot, ".home"), uid, gid);
  await chown(path.join(appRoot, ".home", ".npm"), uid, gid);
  await chmod(appRoot, 0o755);
  await chmod(releasesRoot, 0o755);
}

async function extractGitArchive(sourcePath: string, sha: string, releasePath: string): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "comote-deploy-"));
  const archive = path.join(temporary, "source.tar");
  try {
    await run("git", ["-c", `safe.directory=${sourcePath}`, "-C", sourcePath, "archive", "--format=tar", `--output=${archive}`, sha]);
    await run("tar", ["--extract", `--file=${archive}`, `--directory=${releasePath}`, "--no-same-owner"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function recursivelyOwn(target: string, user: string): Promise<void> {
  await run("chown", ["-R", `${user}:${user}`, target]);
}

async function readPackage(releasePath: string): Promise<{ scripts?: Record<string, string> }> {
  const packagePath = path.join(releasePath, "package.json");
  const info = await lstat(packagePath).catch(() => null);
  if (!info?.isFile() || info.size > 1_000_000) throw new Error("Deployment currently requires a regular package.json file.");
  if (!await isFile(path.join(releasePath, "package-lock.json"))) throw new Error("Deployment requires package-lock.json for reproducible npm installs.");
  try {
    return JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string> };
  } catch {
    throw new Error("package.json is not valid JSON.");
  }
}

async function runAs(user: string, cwd: string, command: string, args: string[]): Promise<void> {
  const appRoot = path.dirname(path.dirname(cwd));
  const environment = [
    `HOME=${path.join(appRoot, ".home")}`,
    `npm_config_cache=${path.join(appRoot, ".home", ".npm")}`,
    "NODE_ENV=production",
    "PATH=/usr/local/bin:/usr/bin:/bin",
  ];
  await run("runuser", ["-u", user, "--", "env", `--chdir=${cwd}`, ...environment, command, ...args]);
}

async function allocatePort(config: HelperConfig, state: DeployState): Promise<number> {
  const used = new Set(Object.values(state.apps).flatMap((app) => app.releases.map((release) => release.port).filter(Boolean)));
  for (let offset = 0; offset <= config.portEnd - config.portStart; offset += 1) {
    const candidate = config.portStart + ((state.nextPort - config.portStart + offset) % (config.portEnd - config.portStart + 1));
    if (!used.has(candidate) && await portAvailable(candidate)) {
      state.nextPort = candidate === config.portEnd ? config.portStart : candidate + 1;
      return candidate;
    }
  }
  throw new Error("No internal deployment port is available.");
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(true));
    socket.setTimeout(1_000, () => { socket.destroy(); resolve(false); });
  });
}

async function ensureCertificate(config: HelperConfig, domain: string): Promise<void> {
  if (await fileExists(path.join("/etc/letsencrypt/live", domain, "fullchain.pem"))) return;
  appendLog(`Requesting a TLS certificate for ${domain}.`);
  await installNginx(config, domain.split(".")[0], domain, "pending", 0, "", false);
  await run("certbot", [
    "certonly", "--webroot", "--webroot-path", config.letsEncryptWebroot,
    "--domain", domain, "--non-interactive", "--agree-tos",
    "--register-unsafely-without-email", "--keep-until-expiring",
  ]);
}

async function activateRelease(appRoot: string, releasePath: string): Promise<void> {
  const temporary = path.join(appRoot, `.current-${process.pid}`);
  await rm(temporary, { force: true });
  await symlink(releasePath, temporary);
  await rename(temporary, path.join(appRoot, "current"));
}

async function activateRuntime(config: HelperConfig, slug: string, user: string, kind: "static" | "node", port: number): Promise<void> {
  const service = `comote-app@${slug}.service`;
  if (kind === "static") {
    await run("systemctl", ["disable", "--now", service], true);
    return;
  }
  await mkdir("/etc/comote/apps", { recursive: true, mode: 0o700 });
  await atomicWrite(path.join("/etc/comote/apps", `${slug}.env`), `PORT=${port}\nHOST=127.0.0.1\nNODE_ENV=production\n`, 0o600);
  await run("systemctl", ["daemon-reload"]);
  await run("systemctl", ["enable", "--now", service]);
  await run("systemctl", ["restart", service]);
  await waitForPort(port, 30_000);
  appendLog(`Service ${service} is healthy as ${user}.`);
}

async function waitForPort(port: number, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!await portAvailable(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Production service did not listen on port ${port} within 30 seconds.`);
}

async function installNginx(
  config: HelperConfig,
  slug: string,
  domain: string,
  kind: "static" | "node" | "pending",
  port: number,
  releasePath: string,
  tls: boolean,
): Promise<void> {
  await mkdir(config.letsEncryptWebroot, { recursive: true, mode: 0o755 });
  const available = path.join(config.nginxAvailable, `comote-${slug}`);
  const enabled = path.join(config.nginxEnabled, `comote-${slug}`);
  const content = renderNginxConfig({
    bindAddress: config.bindAddress,
    domain,
    kind,
    port,
    staticRoot: kind === "static" ? path.join(releasePath, "dist") : undefined,
    tls,
    webroot: config.letsEncryptWebroot,
  });
  await atomicWrite(available, content, 0o644);
  if (!await lstat(enabled).catch(() => null)) await symlink(available, enabled);
  await run("nginx", ["-t"]);
  await run("systemctl", ["enable", "--now", "nginx"]);
  await run("systemctl", ["reload", "nginx"]);
}

async function pruneReleases(appRoot: string, releases: ReleaseRecord[], protectedIds: Set<string>): Promise<void> {
  for (const release of releases.slice(4)) {
    if (!protectedIds.has(release.id)) await rm(path.join(appRoot, "releases", release.id), { recursive: true, force: true });
  }
}

async function readState(config: HelperConfig): Promise<DeployState> {
  return readFile(config.statePath, "utf8")
    .then((value) => JSON.parse(value) as DeployState)
    .catch(() => ({ nextPort: config.portStart, apps: {} }));
}

async function writeState(config: HelperConfig, state: DeployState): Promise<void> {
  await mkdir(path.dirname(config.statePath), { recursive: true, mode: 0o700 });
  await atomicWrite(config.statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

async function atomicWrite(target: string, content: string, mode: number): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, { mode });
  await rename(temporary, target);
  await chmod(target, mode);
}

function response(app: AppRecord): Record<string, unknown> {
  const current = app.releases.find((release) => release.id === app.current);
  return {
    ok: true,
    release: app.current,
    previousRelease: app.previous,
    kind: current?.kind ?? "",
    logs: logLines.join("\n").slice(-100_000),
  };
}

function parseRequest(input: unknown): DeployRequest {
  if (!input || typeof input !== "object") throw new Error("Invalid deployment request.");
  const candidate = input as Partial<DeployRequest>;
  if (candidate.action !== "deploy" && candidate.action !== "rollback") throw new Error("Invalid deployment action.");
  if (typeof candidate.projectName !== "string" || typeof candidate.sourcePath !== "string" || typeof candidate.slug !== "string") {
    throw new Error("Invalid deployment request fields.");
  }
  return { ...candidate, slug: validateDeploymentSlug(candidate.slug) } as DeployRequest;
}

function loadHelperConfig(env: NodeJS.ProcessEnv): HelperConfig {
  const domainSuffix = env.COMOTE_DEPLOY_DOMAIN?.trim().toLowerCase() ?? "";
  const bindAddress = env.COMOTE_DEPLOY_BIND_ADDRESS?.trim() ?? "";
  if (!isValidDomain(domainSuffix) || isIP(bindAddress) !== 4) {
    throw new Error("Deployment helper configuration is invalid.");
  }
  return {
    domainSuffix,
    bindAddress,
    projectsRoot: path.resolve(env.COMOTE_PROJECTS_ROOT ?? "/home/coder/projects"),
    deployRoot: "/srv/comote-apps",
    statePath: "/var/lib/comote-deploy/apps.json",
    nginxAvailable: "/etc/nginx/sites-available",
    nginxEnabled: "/etc/nginx/sites-enabled",
    letsEncryptWebroot: "/var/lib/letsencrypt",
    portStart: 5200,
    portEnd: 5299,
  };
}

function isValidDomain(value: string): boolean {
  return value.length <= 253 && value.split(".").length >= 2 && value.split(".").every((label) => (
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

async function run(command: string, args: string[], allowFailure = false, cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  appendLog(`$ ${command} ${args.map(redactArgument).join(" ")}`);
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      timeout: 10 * 60_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
    });
    const combined = `${result.stdout}${result.stderr}`.trim();
    if (combined) appendLog(combined.slice(-20_000));
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (cause) {
    const error = cause as Error & { stdout?: string; stderr?: string; code?: number };
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message;
    if (detail) appendLog(detail.slice(-20_000));
    if (allowFailure) return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: Number(error.code) || 1 };
    throw new Error(`${command} failed: ${detail.split("\n").slice(-4).join(" ")}`);
  }
}

function redactArgument(value: string): string {
  return value.includes("=") && /token|secret|password|key/i.test(value.split("=", 1)[0]) ? "[redacted]" : value;
}

function appendLog(value: string): void {
  logLines.push(value);
  while (logLines.join("\n").length > 100_000) logLines.shift();
}

function compactTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function isFile(target: string): Promise<boolean> {
  return Boolean((await lstat(target).catch(() => null))?.isFile());
}

async function isDirectory(target: string): Promise<boolean> {
  return Boolean((await lstat(target).catch(() => null))?.isDirectory());
}

async function fileExists(target: string): Promise<boolean> {
  return Boolean((await stat(target).catch(() => null))?.isFile());
}

async function main(): Promise<void> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  try {
    const result = await handleDeployRequest(JSON.parse(input));
    process.stdout.write(JSON.stringify(result));
  } catch (cause) {
    process.stdout.write(JSON.stringify({ ok: false, error: (cause as Error).message, logs: logLines.join("\n").slice(-100_000) }));
  }
}

if (process.argv[1]?.endsWith(`${path.sep}${path.basename(fileURLToPath(import.meta.url))}`)) {
  void main();
}
