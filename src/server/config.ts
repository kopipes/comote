import path from "node:path";

export interface ComoteConfig {
  host: string;
  port: number;
  dataDir: string;
  projectsRoot: string;
  passwordHash: string;
  cookieSecure: boolean;
  sessionDays: number;
  idleMinutes: number;
  codexBin: string;
  previewPort: number;
  previewUrl: string;
  deployDomain: string;
  deploySocket: string;
  production: boolean;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ComoteConfig {
  const production = env.NODE_ENV === "production";
  const passwordHash = env.COMOTE_PASSWORD_HASH ?? "";
  if (production && !passwordHash) {
    throw new Error("COMOTE_PASSWORD_HASH is required in production.");
  }

  return {
    host: env.COMOTE_HOST ?? "127.0.0.1",
    port: positiveNumber(env.COMOTE_PORT, production ? 4173 : 4174),
    dataDir: path.resolve(env.COMOTE_DATA_DIR ?? "./data"),
    projectsRoot: path.resolve(env.COMOTE_PROJECTS_ROOT ?? "./projects"),
    passwordHash,
    cookieSecure: env.COMOTE_COOKIE_SECURE
      ? env.COMOTE_COOKIE_SECURE === "true"
      : production,
    sessionDays: positiveNumber(env.COMOTE_SESSION_DAYS, 30),
    idleMinutes: positiveNumber(env.COMOTE_IDLE_MINUTES, 30),
    codexBin: env.COMOTE_CODEX_BIN ?? "codex",
    previewPort: positiveNumber(env.COMOTE_PREVIEW_PORT, 4180),
    previewUrl: env.COMOTE_PREVIEW_URL ?? "",
    deployDomain: env.COMOTE_DEPLOY_DOMAIN?.trim().toLowerCase() ?? "",
    deploySocket: env.COMOTE_DEPLOY_SOCKET ?? "/run/comote-deploy.sock",
    production,
  };
}
