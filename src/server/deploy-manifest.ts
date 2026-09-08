import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export interface DeployManifest {
  version: 1;
  runtime: "node";
  install: string[];
  build: string[];
  start: string[];
  migrate: string[];
  staticDir: string;
  healthPath: string;
  healthTimeoutSeconds: number;
  services: {
    sqlite: boolean;
    postgres: boolean;
    mysql: boolean;
    redis: boolean;
  };
  requiredSecrets: string[];
  persistentPaths: string[];
  env: Record<string, string>;
  configured: boolean;
}

interface PackageInfo {
  scripts?: Record<string, string>;
}

const environmentName = /^[A-Z_][A-Z0-9_]{0,63}$/;
const reservedEnvironment = new Set([
  "PORT", "HOST", "NODE_ENV", "HOME", "PATH", "DATABASE_URL", "PGHOST", "PGPORT",
  "PGDATABASE", "PGUSER", "PGPASSWORD", "POSTGRES_URL", "MYSQL_URL", "MYSQL_HOST",
  "MYSQL_PORT", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD", "SQLITE_PATH", "REDIS_URL",
  "REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD", "COMOTE_DATA_DIR", "COMOTE_RELEASE_ID",
]);

export async function readDeployManifest(root: string, packageInfo?: PackageInfo): Promise<DeployManifest> {
  const info = packageInfo ?? await readPackageInfo(root);
  const manifestPath = path.join(root, "comote.deploy.json");
  const manifestFile = await lstat(manifestPath).catch(() => null);
  if (!manifestFile) return legacyManifest(info);
  if (!manifestFile.isFile() || manifestFile.size > 100_000) throw new Error("comote.deploy.json must be a regular file smaller than 100 KB.");

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("comote.deploy.json is not valid JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("comote.deploy.json must contain an object.");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) throw new Error("comote.deploy.json version must be 1.");
  if (value.runtime !== undefined && value.runtime !== "node") throw new Error("Only the node runtime is currently supported.");

  const services = objectOrEmpty(value.services, "services");
  const env = objectOrEmpty(value.env, "env");
  const publicEnvironment: Record<string, string> = {};
  for (const [name, item] of Object.entries(env)) {
    validateEnvironmentName(name);
    if (reservedEnvironment.has(name)) throw new Error(`${name} is managed by Comote and cannot be set in env.`);
    if (typeof item !== "string" || item.length > 8_192 || item.includes("\0") || item.includes("\n") || item.includes("\r")) {
      throw new Error(`Environment value ${name} must be a single-line string up to 8 KB.`);
    }
    publicEnvironment[name] = item;
  }

  const staticDir = optionalRelativePath(value.staticDir, "staticDir");
  const start = optionalCommand(value.start, "start") ?? (info.scripts?.start ? ["npm", "start"] : []);
  if (!staticDir && start.length === 0) {
    throw new Error("Deployment needs either staticDir or a start command.");
  }
  const healthPath = optionalString(value.healthPath, "healthPath") ?? "";
  if (healthPath && (!healthPath.startsWith("/") || healthPath.length > 200 || /[\r\n]/.test(healthPath))) {
    throw new Error("healthPath must be an absolute HTTP path up to 200 characters.");
  }
  const timeout = value.healthTimeoutSeconds ?? 60;
  if (!Number.isInteger(timeout) || Number(timeout) < 5 || Number(timeout) > 300) {
    throw new Error("healthTimeoutSeconds must be an integer from 5 to 300.");
  }
  const requiredSecrets = optionalStringArray(value.requiredSecrets, "requiredSecrets");
  for (const name of requiredSecrets) {
    validateEnvironmentName(name);
    if (reservedEnvironment.has(name)) throw new Error(`${name} is managed by Comote and cannot be a required secret.`);
    if (Object.hasOwn(publicEnvironment, name)) throw new Error(`${name} cannot be both a public env value and a secret.`);
  }
  const persistentPaths = optionalStringArray(value.persistentPaths, "persistentPaths").map((item) => optionalRelativePath(item, "persistentPaths item"));
  for (const item of persistentPaths) {
    if (["node_modules", "package.json", "package-lock.json", "comote.deploy.json"].includes(item) || item.startsWith("node_modules/")) {
      throw new Error(`${item} cannot be configured as a persistent path.`);
    }
  }

  const databaseServices = [services.sqlite, services.postgres, services.mysql].filter((item) => item === true).length;
  if (databaseServices > 1) throw new Error("Choose only one primary database: sqlite, postgres, or mysql.");

  return {
    version: 1,
    runtime: "node",
    install: optionalCommand(value.install, "install") ?? ["npm", "ci", "--include=dev", "--no-audit", "--no-fund"],
    build: optionalCommand(value.build, "build") ?? (info.scripts?.build ? ["npm", "run", "build"] : []),
    start,
    migrate: optionalCommand(value.migrate, "migrate") ?? [],
    staticDir,
    healthPath,
    healthTimeoutSeconds: Number(timeout),
    services: {
      sqlite: optionalBoolean(services.sqlite, "services.sqlite"),
      postgres: optionalBoolean(services.postgres, "services.postgres"),
      mysql: optionalBoolean(services.mysql, "services.mysql"),
      redis: optionalBoolean(services.redis, "services.redis"),
    },
    requiredSecrets: [...new Set(requiredSecrets)].sort(),
    persistentPaths: [...new Set(persistentPaths)].sort(),
    env: publicEnvironment,
    configured: true,
  };
}

export function validateSecretInput(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Secrets must be an object.");
  const result: Record<string, string> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50) throw new Error("At most 50 secrets can be saved per application.");
  for (const [name, secret] of entries) {
    validateEnvironmentName(name);
    if (reservedEnvironment.has(name)) throw new Error(`${name} is managed by Comote and cannot be saved as a secret.`);
    if (typeof secret !== "string" || secret.length < 1 || secret.length > 8_192 || secret.includes("\0") || secret.includes("\n") || secret.includes("\r")) {
      throw new Error(`Secret ${name} must be a non-empty, single-line value up to 8 KB.`);
    }
    result[name] = secret;
  }
  return result;
}

export function validateSecretNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error("Invalid secret removal list.");
  return [...new Set(value.map((name) => {
    if (typeof name !== "string") throw new Error("Invalid secret name.");
    validateEnvironmentName(name);
    return name;
  }))];
}

function legacyManifest(info: PackageInfo): DeployManifest {
  return {
    version: 1,
    runtime: "node",
    install: ["npm", "ci", "--include=dev", "--no-audit", "--no-fund"],
    build: info.scripts?.build ? ["npm", "run", "build"] : [],
    start: info.scripts?.start ? ["npm", "start"] : [],
    migrate: [],
    staticDir: "dist",
    healthPath: "",
    healthTimeoutSeconds: 60,
    services: { sqlite: false, postgres: false, mysql: false, redis: false },
    requiredSecrets: [],
    persistentPaths: [],
    env: {},
    configured: false,
  };
}

async function readPackageInfo(root: string): Promise<PackageInfo> {
  try {
    return JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as PackageInfo;
  } catch {
    return {};
  }
}

function optionalCommand(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 2_000 || item.includes("\0"))) {
    throw new Error(`${name} must be a non-empty command array.`);
  }
  return value as string[];
}

function optionalStringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be a string array.`);
  return value as string[];
}

function optionalRelativePath(value: unknown, name: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || !value || value.length > 200 || value.includes("\\") || path.isAbsolute(value) || value.split("/").includes("..")) {
    throw new Error(`${name} must be a safe relative path.`);
  }
  const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === ".") throw new Error(`${name} must be a safe relative path.`);
  return normalized;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function objectOrEmpty(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function validateEnvironmentName(name: string): void {
  if (!environmentName.test(name)) throw new Error(`Invalid environment name: ${name}. Use uppercase letters, numbers, and underscores.`);
}
