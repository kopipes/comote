import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
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
import { readDeployManifest, validateSecretInput, validateSecretNames, type DeployManifest } from "./deploy-manifest.js";

const execFileAsync = promisify(execFile);

interface DeployRequest {
  action: "deploy" | "rollback" | "configure";
  projectName: string;
  sourcePath: string;
  slug: string;
  secrets?: Record<string, string>;
  removeSecrets?: string[];
}

interface ReleaseRecord {
  id: string;
  sha: string;
  kind: "static" | "node";
  port: number;
  start: string[];
  healthPath: string;
  healthTimeoutSeconds: number;
  services: DeployManifest["services"];
  requiredSecrets: string[];
  persistentPaths: string[];
  createdAt: string;
}

interface ResourceRecord {
  postgres?: { database: string; user: string };
  mysql?: { database: string; user: string };
  redis?: { port: number };
}

interface AppRecord {
  projectName: string;
  sourcePath: string;
  domain: string;
  current: string;
  previous: string;
  releases: ReleaseRecord[];
  resources: ResourceRecord;
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
    if (request.action === "deploy") return await deploy(config, request);
    if (request.action === "rollback") return await rollback(config, request);
    return await configure(config, request);
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

async function configure(config: HelperConfig, request: DeployRequest): Promise<Record<string, unknown>> {
  const sourcePath = await validateSource(config, request);
  const state = await readState(config);
  const existing = state.apps[request.slug];
  if (existing && existing.sourcePath !== sourcePath) throw new Error(`The deployment name '${request.slug}' belongs to another project.`);
  const manifest = await readDeployManifest(sourcePath);
  const currentSecrets = await readSecrets(request.slug);
  const updates = validateSecretInput(request.secrets ?? {});
  const removals = validateSecretNames(request.removeSecrets ?? []);
  for (const name of removals) delete currentSecrets[name];
  Object.assign(currentSecrets, updates);
  await writeSecrets(request.slug, currentSecrets);
  if (!existing) {
    state.apps[request.slug] = {
      projectName: request.projectName,
      sourcePath,
      domain: `${request.slug}.${config.domainSuffix}`,
      current: "",
      previous: "",
      releases: [],
      resources: {},
    };
    await writeState(config, state);
  }
  appendLog("Production secrets updated. Values are write-only and were not returned.");
  return {
    ok: true,
    secretNames: Object.keys(currentSecrets).sort(),
    services: manifest.services,
    requiredSecrets: manifest.requiredSecrets,
    logs: logLines.join("\n"),
  };
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
  await ensurePersistentDirectories(appRoot, appUser);
  await mkdir(releasePath, { recursive: true, mode: 0o755 });
  let activated = false;

  try {
    await extractGitArchive(sourcePath, sha, releasePath);
    await recursivelyOwn(releasePath, appUser);
    await chmod(releasePath, 0o755);
    const packageInfo = await readPackage(releasePath);
    const manifest = await readDeployManifest(releasePath, packageInfo);
    const secrets = await readSecrets(request.slug);
    const missingSecrets = manifest.requiredSecrets.filter((name) => !Object.hasOwn(secrets, name));
    if (missingSecrets.length) throw new Error(`Missing required production secrets: ${missingSecrets.join(", ")}.`);

    const resources = await provisionResources(config, request.slug, appRoot, appUser, manifest, state, existing?.resources ?? {});
    const reserved: AppRecord = existing
      ? { ...existing, resources }
      : { projectName: request.projectName, sourcePath, domain, current: "", previous: "", releases: [], resources };
    state.apps[request.slug] = reserved;
    await writeState(config, state);

    let port = manifest.start.length ? existing?.releases.find((release) => release.kind === "node")?.port || await allocatePort(config, state) : 0;
    await writeRuntimeEnvironment(request.slug, appRoot, releaseId, port, manifest, resources, secrets);
    await runAs(appUser, releasePath, manifest.install[0], manifest.install.slice(1));
    if (manifest.build.length) await runDeploymentJob(request.slug, appUser, releasePath, appRoot, manifest.build);
    await installPersistentPaths(releasePath, appRoot, appUser, manifest.persistentPaths);

    let kind: "static" | "node";
    const staticRoot = manifest.staticDir ? await resolveStaticRoot(releasePath, manifest.staticDir) : "";
    if (staticRoot && await isFile(path.join(staticRoot, "index.html"))) {
      kind = "static";
      port = 0;
      appendLog(`Detected a static production build in ${manifest.staticDir}/.`);
    } else if (manifest.configured && manifest.staticDir) {
      throw new Error(`Static build did not create ${manifest.staticDir}/index.html.`);
    } else if (manifest.start.length) {
      kind = "node";
      appendLog(`Detected a Node service on internal port ${port}.`);
    } else {
      throw new Error("Deployment needs a static index.html or a configured start command.");
    }

    await writeRuntimeEnvironment(request.slug, appRoot, releaseId, port, manifest, resources, secrets);
    if (manifest.migrate.length) {
      await backupDatabasesBeforeMigration(request.slug, appRoot, manifest, resources);
      appendLog(`Running database migration: ${manifest.migrate.join(" ")}`);
      await runDeploymentJob(request.slug, appUser, releasePath, appRoot, manifest.migrate);
      appendLog("Database migration completed.");
    }
    if (kind === "static") {
      await rm(path.join(releasePath, "node_modules"), { recursive: true, force: true });
      await run("chmod", ["-R", "a+rX", staticRoot]);
    } else {
      await runAs(appUser, releasePath, "npm", ["prune", "--omit=dev", "--no-audit", "--no-fund"]);
    }

    const release: ReleaseRecord = {
      id: releaseId,
      sha,
      kind,
      port,
      start: manifest.start,
      healthPath: manifest.healthPath,
      healthTimeoutSeconds: manifest.healthTimeoutSeconds,
      services: manifest.services,
      requiredSecrets: manifest.requiredSecrets,
      persistentPaths: manifest.persistentPaths,
      createdAt: new Date().toISOString(),
    };
    await ensureCertificate(config, domain);
    const previousTarget = await readlink(path.join(appRoot, "current")).catch(() => "");
    const previousId = previousTarget ? path.basename(previousTarget) : "";
    await activateRelease(appRoot, releasePath);
    try {
      await activateRuntime(config, request.slug, appUser, release);
      await installNginx(config, request.slug, domain, kind, port, staticRoot, true);
      activated = true;
    } catch (cause) {
      let restored = false;
      if (previousId) {
        const oldRelease = existing?.releases.find((release) => release.id === previousId);
        if (oldRelease) {
          const oldReleasePath = path.join(appRoot, "releases", previousId);
          const oldManifest = await readDeployManifest(oldReleasePath);
          await activateRelease(appRoot, oldReleasePath);
          await writeRuntimeEnvironment(request.slug, appRoot, oldRelease.id, oldRelease.port, oldManifest, resources, secrets);
          await activateRuntime(config, request.slug, appUser, oldRelease);
          const oldStaticRoot = oldRelease.kind === "static" ? await resolveStaticRoot(oldReleasePath, oldManifest.staticDir || "dist") : "";
          await installNginx(config, request.slug, domain, oldRelease.kind, oldRelease.port, oldStaticRoot, true);
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
      resources,
    };
    await writeState(config, state);
    await pruneReleases(appRoot, releases, protectedReleases);
    appendLog(`Production is live at https://${domain}.`);
    return await response(state.apps[request.slug], request.slug);
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
  const targetManifest = await readDeployManifest(releasePath);
  const targetSecrets = await readSecrets(request.slug);
  await writeRuntimeEnvironment(request.slug, appRoot, target.id, target.port, targetManifest, app.resources ?? {}, targetSecrets);
  await activateRelease(appRoot, releasePath);
  try {
    await activateRuntime(config, request.slug, `comote-${request.slug}`, target);
    const targetStaticRoot = target.kind === "static" ? await resolveStaticRoot(releasePath, targetManifest.staticDir || "dist") : "";
    await installNginx(config, request.slug, app.domain, target.kind, target.port, targetStaticRoot, true);
  } catch (cause) {
    const current = app.releases.find((release) => release.id === oldCurrent);
    if (current) {
      const currentPath = path.join(appRoot, "releases", current.id);
      const currentManifest = await readDeployManifest(currentPath);
      await writeRuntimeEnvironment(request.slug, appRoot, current.id, current.port, currentManifest, app.resources ?? {}, targetSecrets);
      await activateRelease(appRoot, currentPath);
      await activateRuntime(config, request.slug, `comote-${request.slug}`, current);
      const currentStaticRoot = current.kind === "static" ? await resolveStaticRoot(currentPath, currentManifest.staticDir || "dist") : "";
      await installNginx(config, request.slug, app.domain, current.kind, current.port, currentStaticRoot, true);
    }
    throw cause;
  }
  app.current = target.id;
  app.previous = oldCurrent;
  await writeState(config, state);
  appendLog(`Rolled back production to ${target.id}.`);
  return await response(app, request.slug);
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

async function ensurePersistentDirectories(appRoot: string, user: string): Promise<void> {
  for (const directory of ["shared", "shared/data", "shared/cache", "shared/logs", "shared/redis", "shared/db-backups", "shared/home", "shared/mounts"]) {
    await mkdir(path.join(appRoot, directory), { recursive: true, mode: 0o700 });
  }
  await run("chown", ["-R", `${user}:${user}`, path.join(appRoot, "shared")]);
  await run("chmod", ["700", path.join(appRoot, "shared")]);
}

async function installPersistentPaths(releasePath: string, appRoot: string, user: string, paths: string[]): Promise<void> {
  for (const relative of paths) {
    const target = safeReleasePath(releasePath, relative);
    await assertNoSymlinkPath(releasePath, target);
    const persistent = path.join(appRoot, "shared", "mounts", relative);
    await mkdir(path.dirname(persistent), { recursive: true, mode: 0o700 });
    if (!await lstat(persistent).catch(() => null)) {
      const targetInfo = await lstat(target).catch(() => null);
      if (targetInfo) await rename(target, persistent);
      else await mkdir(persistent, { recursive: true, mode: 0o700 });
    } else {
      await rm(target, { recursive: true, force: true });
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await symlink(persistent, target);
    await run("chown", ["-R", `${user}:${user}`, persistent]);
  }
}

async function assertNoSymlinkPath(root: string, target: string): Promise<void> {
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (info?.isSymbolicLink()) throw new Error("Persistent paths cannot contain symbolic links from the repository.");
  }
}

interface InternalCredentials {
  postgresPassword?: string;
  mysqlPassword?: string;
  redisPassword?: string;
}

async function provisionResources(
  config: HelperConfig,
  slug: string,
  appRoot: string,
  appUser: string,
  manifest: DeployManifest,
  state: DeployState,
  existing: ResourceRecord,
): Promise<ResourceRecord> {
  const resources: ResourceRecord = { ...existing };
  const credentials = await readInternalCredentials(slug);
  if (manifest.services.postgres) {
    const database = `comote_${slug.replaceAll("-", "_")}`;
    const user = database;
    credentials.postgresPassword ||= randomBytes(24).toString("hex");
    await ensurePostgresDatabase(database, user, credentials.postgresPassword);
    resources.postgres = { database, user };
    appendLog(`PostgreSQL database ${database} is ready.`);
  }
  if (manifest.services.mysql) {
    const database = `comote_${slug.replaceAll("-", "_")}`;
    const user = database;
    credentials.mysqlPassword ||= randomBytes(24).toString("hex");
    await ensureMysqlDatabase(database, user, credentials.mysqlPassword);
    resources.mysql = { database, user };
    appendLog(`MySQL database ${database} is ready.`);
  }
  if (manifest.services.redis) {
    const port = resources.redis?.port ?? await allocateResourcePort(state, 5300, 5399);
    credentials.redisPassword ||= randomBytes(24).toString("hex");
    resources.redis = { port };
    await installRedisConfig(slug, appRoot, appUser, port, credentials.redisPassword);
    appendLog(`Private Redis service is ready on internal port ${port}.`);
  }
  await writeInternalCredentials(slug, credentials);
  return resources;
}

async function ensurePostgresDatabase(database: string, user: string, password: string): Promise<void> {
  if (!await executableExists("/usr/bin/psql")) throw new Error("PostgreSQL runtime is not installed on this VPS.");
  const roleExists = (await run("runuser", ["-u", "postgres", "--", "psql", "--dbname=postgres", "--tuples-only", "--no-align", "--command", `SELECT 1 FROM pg_roles WHERE rolname='${user}'`])).stdout.trim() === "1";
  if (!roleExists) await runHidden("runuser", ["-u", "postgres", "--", "psql", "--dbname=postgres", "--set=ON_ERROR_STOP=1", "--command", `CREATE ROLE ${user} LOGIN PASSWORD '${password}'`], "Creating an isolated PostgreSQL role.");
  else await runHidden("runuser", ["-u", "postgres", "--", "psql", "--dbname=postgres", "--set=ON_ERROR_STOP=1", "--command", `ALTER ROLE ${user} PASSWORD '${password}'`], "Refreshing the PostgreSQL application credential.");
  const databaseExists = (await run("runuser", ["-u", "postgres", "--", "psql", "--dbname=postgres", "--tuples-only", "--no-align", "--command", `SELECT 1 FROM pg_database WHERE datname='${database}'`])).stdout.trim() === "1";
  if (!databaseExists) await run("runuser", ["-u", "postgres", "--", "createdb", "--owner", user, database]);
}

async function ensureMysqlDatabase(database: string, user: string, password: string): Promise<void> {
  if (!await executableExists("/usr/bin/mysql")) throw new Error("MySQL runtime is not installed on this VPS.");
  const sql = [
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE USER IF NOT EXISTS '${user}'@'127.0.0.1' IDENTIFIED BY '${password}'`,
    `ALTER USER '${user}'@'127.0.0.1' IDENTIFIED BY '${password}'`,
    `GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${user}'@'127.0.0.1'`,
    "FLUSH PRIVILEGES",
  ].join("; ");
  await runHidden("mysql", ["--protocol=socket", "--user=root", `--execute=${sql}`], "Creating an isolated MySQL database and user.");
}

async function installRedisConfig(slug: string, appRoot: string, appUser: string, port: number, password: string): Promise<void> {
  if (!await executableExists("/usr/bin/redis-server")) throw new Error("Redis runtime is not installed on this VPS.");
  const passwd = (await run("getent", ["passwd", appUser])).stdout.trim().split(":");
  const gid = Number(passwd[3]);
  const configPath = path.join("/etc/comote/apps", `${slug}.redis.conf`);
  const content = [
    "bind 127.0.0.1", "protected-mode yes", `port ${port}`, "daemonize no", "supervised no",
    `dir ${path.join(appRoot, "shared", "redis")}`, "dbfilename dump.rdb", "appendonly yes",
    "appendfsync everysec", `requirepass ${password}`, "rename-command CONFIG \"\"", "",
  ].join("\n");
  await atomicWrite(configPath, content, 0o640);
  await chown(configPath, 0, gid);
  await run("systemctl", ["daemon-reload"]);
  await run("systemctl", ["enable", "--now", `comote-redis@${slug}.service`]);
  await run("systemctl", ["restart", `comote-redis@${slug}.service`]);
  await waitForPort(port, 30_000);
}

async function writeRuntimeEnvironment(
  slug: string,
  appRoot: string,
  releaseId: string,
  port: number,
  manifest: DeployManifest,
  resources: ResourceRecord,
  secrets: Record<string, string>,
): Promise<void> {
  const credentials = await readInternalCredentials(slug);
  const dataDir = path.join(appRoot, "shared", "data");
  const environment: Record<string, string> = {
    HOME: path.join(appRoot, "shared", "home"),
    HOST: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "production",
    COMOTE_DATA_DIR: dataDir,
    COMOTE_CACHE_DIR: path.join(appRoot, "shared", "cache"),
    COMOTE_RELEASE_ID: releaseId,
    ...manifest.env,
  };
  if (manifest.services.sqlite) {
    environment.SQLITE_PATH = path.join(dataDir, "app.db");
    environment.DATABASE_URL = `file:${environment.SQLITE_PATH}`;
  }
  if (manifest.services.postgres && resources.postgres && credentials.postgresPassword) {
    const resource = resources.postgres;
    const url = `postgresql://${resource.user}:${encodeURIComponent(credentials.postgresPassword)}@127.0.0.1:5432/${resource.database}`;
    Object.assign(environment, { DATABASE_URL: url, POSTGRES_URL: url, PGHOST: "127.0.0.1", PGPORT: "5432", PGDATABASE: resource.database, PGUSER: resource.user, PGPASSWORD: credentials.postgresPassword });
  }
  if (manifest.services.mysql && resources.mysql && credentials.mysqlPassword) {
    const resource = resources.mysql;
    const url = `mysql://${resource.user}:${encodeURIComponent(credentials.mysqlPassword)}@127.0.0.1:3306/${resource.database}`;
    Object.assign(environment, { DATABASE_URL: url, MYSQL_URL: url, MYSQL_HOST: "127.0.0.1", MYSQL_PORT: "3306", MYSQL_DATABASE: resource.database, MYSQL_USER: resource.user, MYSQL_PASSWORD: credentials.mysqlPassword });
  }
  if (manifest.services.redis && resources.redis && credentials.redisPassword) {
    const url = `redis://:${encodeURIComponent(credentials.redisPassword)}@127.0.0.1:${resources.redis.port}`;
    Object.assign(environment, { REDIS_URL: url, REDIS_HOST: "127.0.0.1", REDIS_PORT: String(resources.redis.port), REDIS_PASSWORD: credentials.redisPassword });
  }
  Object.assign(environment, secrets);
  const content = Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${quoteEnvironment(value)}`).join("\n");
  await mkdir("/etc/comote/apps", { recursive: true, mode: 0o711 });
  await chmod("/etc/comote/apps", 0o711);
  await atomicWrite(path.join("/etc/comote/apps", `${slug}.env`), `${content}\n`, 0o600);
}

async function runDeploymentJob(slug: string, user: string, releasePath: string, appRoot: string, command: string[]): Promise<void> {
  const unit = `comote-job-${slug}-${process.pid}-${Date.now()}`;
  await run("systemd-run", [
    "--quiet", "--wait", "--collect", "--pipe", `--unit=${unit}`, `--uid=${user}`, `--gid=${user}`,
    `--working-directory=${releasePath}`, `--property=EnvironmentFile=/etc/comote/apps/${slug}.env`,
    "--property=NoNewPrivileges=yes", "--property=PrivateTmp=yes", "--property=PrivateDevices=yes",
    "--property=ProtectSystem=strict", "--property=ProtectHome=yes",
    `--property=ReadWritePaths=${releasePath} ${path.join(appRoot, "shared")}`,
    "--property=RestrictSUIDSGID=yes", "--", ...command,
  ]);
}

async function backupDatabasesBeforeMigration(slug: string, appRoot: string, manifest: DeployManifest, resources: ResourceRecord): Promise<void> {
  const destination = path.join(appRoot, "shared", "db-backups", `pre-migrate-${compactTimestamp()}`);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await run("chown", [`comote-${slug}:comote-${slug}`, destination]);
  let created = false;
  if (manifest.services.sqlite) {
    const databasePath = path.join(appRoot, "shared", "data", "app.db");
    if (await isFile(databasePath)) {
      await run("runuser", ["-u", `comote-${slug}`, "--", "sqlite3", databasePath, `.backup '${path.join(destination, "sqlite.db")}'`]);
      created = true;
    }
  }
  if (resources.postgres) {
    const temporary = path.join("/var/lib/comote-deploy", `.postgres-${slug}-${process.pid}.dump`);
    await writeFile(temporary, "", { mode: 0o600 });
    const postgresPasswd = (await run("getent", ["passwd", "postgres"])).stdout.trim().split(":");
    await chown(temporary, Number(postgresPasswd[2]), Number(postgresPasswd[3]));
    try {
      await run("runuser", ["-u", "postgres", "--", "pg_dump", "--format=custom", `--file=${temporary}`, resources.postgres.database]);
      await rename(temporary, path.join(destination, "postgres.dump"));
      created = true;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  if (resources.mysql) {
    await runHidden("mysqldump", ["--protocol=socket", "--user=root", "--single-transaction", "--routines", "--events", `--result-file=${path.join(destination, "mysql.sql")}`, resources.mysql.database], "Creating a pre-migration MySQL backup.");
    created = true;
  }
  if (!created) await rm(destination, { recursive: true, force: true });
  else {
    await run("chown", ["-R", `comote-${slug}:comote-${slug}`, destination]);
    appendLog("Created a pre-migration database backup.");
  }
}

async function allocateResourcePort(state: DeployState, start: number, end: number): Promise<number> {
  const used = new Set(Object.values(state.apps).map((app) => app.resources?.redis?.port).filter((port): port is number => Boolean(port)));
  for (let port = start; port <= end; port += 1) if (!used.has(port) && await portAvailable(port)) return port;
  throw new Error("No private Redis port is available.");
}

async function readSecrets(slug: string): Promise<Record<string, string>> {
  return readFile(path.join("/etc/comote/secrets", `${slug}.json`), "utf8").then((value) => JSON.parse(value) as Record<string, string>).catch(() => ({}));
}

async function writeSecrets(slug: string, secrets: Record<string, string>): Promise<void> {
  await mkdir("/etc/comote/secrets", { recursive: true, mode: 0o700 });
  await atomicWrite(path.join("/etc/comote/secrets", `${slug}.json`), `${JSON.stringify(secrets)}\n`, 0o600);
}

async function readInternalCredentials(slug: string): Promise<InternalCredentials> {
  return readFile(path.join("/etc/comote/resources", `${slug}.json`), "utf8").then((value) => JSON.parse(value) as InternalCredentials).catch(() => ({}));
}

async function writeInternalCredentials(slug: string, credentials: InternalCredentials): Promise<void> {
  await mkdir("/etc/comote/resources", { recursive: true, mode: 0o700 });
  await atomicWrite(path.join("/etc/comote/resources", `${slug}.json`), `${JSON.stringify(credentials)}\n`, 0o600);
}

function quoteEnvironment(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function safeReleasePath(releasePath: string, relative: string): string {
  const target = path.resolve(releasePath, relative);
  if (target !== releasePath && !target.startsWith(`${releasePath}${path.sep}`)) throw new Error("Deployment path escapes its release.");
  return target;
}

async function resolveStaticRoot(releasePath: string, relative: string): Promise<string> {
  const target = safeReleasePath(releasePath, relative);
  const resolved = await realpath(target).catch(() => target);
  if (resolved !== releasePath && !resolved.startsWith(`${releasePath}${path.sep}`)) throw new Error("Static output must stay inside its release.");
  return resolved;
}

async function executableExists(target: string): Promise<boolean> {
  return Boolean(await lstat(target).catch(() => null));
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

async function activateRuntime(config: HelperConfig, slug: string, user: string, release: ReleaseRecord): Promise<void> {
  const service = `comote-app@${slug}.service`;
  if (release.kind === "static") {
    await run("systemctl", ["disable", "--now", service], true);
    return;
  }
  await mkdir("/etc/comote/apps", { recursive: true, mode: 0o711 });
  const command = release.start?.length ? release.start : ["npm", "start"];
  await atomicWrite(path.join("/etc/comote/apps", `${slug}.command.json`), `${JSON.stringify(command)}\n`, 0o644);
  await run("systemctl", ["daemon-reload"]);
  await run("systemctl", ["enable", "--now", service]);
  await run("systemctl", ["restart", service]);
  if (release.healthPath) await waitForHttp(release.port, release.healthPath, (release.healthTimeoutSeconds || 60) * 1_000);
  else await waitForPort(release.port, (release.healthTimeoutSeconds || 60) * 1_000);
  appendLog(`Service ${service} is healthy as ${user}.`);
}

async function waitForPort(port: number, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!await portAvailable(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Production service did not listen on port ${port} before the health timeout.`);
}

async function waitForHttp(port: number, requestPath: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const healthy = await new Promise<boolean>((resolve) => {
      const request = http.get({ host: "127.0.0.1", port, path: requestPath, timeout: 2_000 }, (response) => {
        response.resume();
        resolve(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 400));
      });
      request.on("error", () => resolve(false));
      request.on("timeout", () => { request.destroy(); resolve(false); });
    });
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Production health check ${requestPath} did not pass before the timeout.`);
}

async function installNginx(
  config: HelperConfig,
  slug: string,
  domain: string,
  kind: "static" | "node" | "pending",
  port: number,
  staticRoot: string,
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
    staticRoot: kind === "static" ? staticRoot : undefined,
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
  const state = await readFile(config.statePath, "utf8")
    .then((value) => JSON.parse(value) as DeployState)
    .catch(() => ({ nextPort: config.portStart, apps: {} }));
  for (const app of Object.values(state.apps)) {
    app.resources ??= {};
    app.current ??= "";
    app.previous ??= "";
    app.releases ??= [];
    app.releases = app.releases.map((release) => ({
      ...release,
      start: release.start?.length ? release.start : ["npm", "start"],
      healthPath: release.healthPath ?? "",
      healthTimeoutSeconds: release.healthTimeoutSeconds || 60,
      services: release.services ?? { sqlite: false, postgres: false, mysql: false, redis: false },
      requiredSecrets: release.requiredSecrets ?? [],
      persistentPaths: release.persistentPaths ?? [],
    }));
  }
  return state;
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

async function response(app: AppRecord, slug: string): Promise<Record<string, unknown>> {
  const current = app.releases.find((release) => release.id === app.current);
  const secrets = await readSecrets(slug);
  return {
    ok: true,
    release: app.current,
    previousRelease: app.previous,
    kind: current?.kind ?? "",
    services: current?.services ?? { sqlite: false, postgres: false, mysql: false, redis: false },
    requiredSecrets: current?.requiredSecrets ?? [],
    secretNames: Object.keys(secrets).sort(),
    logs: logLines.join("\n").slice(-100_000),
  };
}

function parseRequest(input: unknown): DeployRequest {
  if (!input || typeof input !== "object") throw new Error("Invalid deployment request.");
  const candidate = input as Partial<DeployRequest>;
  if (candidate.action !== "deploy" && candidate.action !== "rollback" && candidate.action !== "configure") throw new Error("Invalid deployment action.");
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

async function runHidden(command: string, args: string[], description: string): Promise<void> {
  appendLog(description);
  try {
    const result = await execFileAsync(command, args, {
      timeout: 10 * 60_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
    });
    const combined = `${result.stdout}${result.stderr}`.trim();
    if (combined) appendLog(combined.slice(-20_000));
  } catch (cause) {
    const error = cause as Error & { stdout?: string; stderr?: string };
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message;
    throw new Error(`${description} failed: ${detail.split("\n").slice(-4).join(" ")}`);
  }
}

function redactArgument(value: string): string {
  return value.includes("=") && /token|secret|password|key|url|credential/i.test(value.split("=", 1)[0]) ? "[redacted]" : value;
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
