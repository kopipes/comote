import { execFile } from "node:child_process";
import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface Project {
  id: string;
  name: string;
  path: string;
}

export class ProjectRegistry {
  private rootRealPath = "";
  private creating = new Set<string>();

  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    const info = await stat(this.root).catch(() => null);
    if (!info?.isDirectory()) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(this.root, { recursive: true, mode: 0o750 });
    }
    this.rootRealPath = await realpath(this.root);
  }

  async list(): Promise<Project[]> {
    const entries = await readdir(this.rootRealPath, { withFileTypes: true });
    const projects: Project[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const projectPath = path.join(this.rootRealPath, entry.name);
      const git = await stat(path.join(projectPath, ".git")).catch(() => null);
      if (!git) continue;
      projects.push({ id: encodeId(entry.name), name: entry.name, path: projectPath });
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Project> {
    const name = decodeId(id);
    if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
      throw new Error("Invalid project id.");
    }
    const resolved = await realpath(path.join(this.rootRealPath, name));
    if (path.dirname(resolved) !== this.rootRealPath) throw new Error("Project is outside the allowed root.");
    const git = await stat(path.join(resolved, ".git")).catch(() => null);
    if (!git) throw new Error("Project is not a Git workspace.");
    return { id, name, path: resolved };
  }

  async create(nameInput: string): Promise<Project> {
    const name = validateProjectName(nameInput);
    return this.withNewProject(name, async (projectPath) => {
      await mkdir(projectPath, { mode: 0o750 });
      await runGit(this.rootRealPath, ["init", "-b", "main", projectPath]);
      await configureIdentity(projectPath);
      await ensureInitialCommit(projectPath);
    });
  }

  async importGithub(repositoryUrlInput: string, nameInput?: string): Promise<Project> {
    const repository = parseGithubRepository(repositoryUrlInput);
    const name = validateProjectName(nameInput?.trim() || repository.name);
    return this.withNewProject(name, async (projectPath) => {
      await runGit(this.rootRealPath, ["clone", "--origin", "origin", repository.url, projectPath], 120_000);
      await configureIdentity(projectPath);
      await ensureInitialCommit(projectPath);
    });
  }

  async settings(id: string): Promise<{ branch: string; remoteUrl: string }> {
    const project = await this.get(id);
    const branch = await runGit(project.path, ["branch", "--show-current"]);
    const remoteUrl = await runGit(project.path, ["remote", "get-url", "origin"]).catch(() => "");
    return { branch: branch || "main", remoteUrl };
  }

  async setGithubRemote(id: string, repositoryUrlInput: string): Promise<{ branch: string; remoteUrl: string }> {
    const project = await this.get(id);
    const repository = parseGithubRepository(repositoryUrlInput);
    const exists = await runGit(project.path, ["remote", "get-url", "origin"]).then(() => true).catch(() => false);
    await runGit(project.path, exists
      ? ["remote", "set-url", "origin", repository.url]
      : ["remote", "add", "origin", repository.url]);
    return this.settings(id);
  }

  private async withNewProject(name: string, operation: (projectPath: string) => Promise<void>): Promise<Project> {
    if (!this.rootRealPath) throw new Error("Project registry is not initialized.");
    if (this.creating.has(name)) throw new Error("Project creation is already in progress.");
    const projectPath = path.join(this.rootRealPath, name);
    if (await stat(projectPath).catch(() => null)) throw new Error(`Project '${name}' already exists.`);

    this.creating.add(name);
    try {
      await operation(projectPath);
      return { id: encodeId(name), name, path: await realpath(projectPath) };
    } catch (error) {
      await rm(projectPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      this.creating.delete(name);
    }
  }
}

export function validateProjectName(value: string): string {
  const name = value.trim();
  if (!projectNamePattern.test(name) || name === "." || name === ".." || name.endsWith(".git")) {
    throw new Error("Invalid project name. Use 1–64 letters, numbers, dots, dashes, or underscores.");
  }
  return name;
}

export function parseGithubRepository(value: string): { url: string; name: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Invalid GitHub URL.");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid GitHub URL. Use https://github.com/owner/repository.");
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(parts[0])) {
    throw new Error("Invalid GitHub URL. Use https://github.com/owner/repository.");
  }
  const repositoryName = parts[1].replace(/\.git$/i, "");
  if (!projectNamePattern.test(repositoryName)) throw new Error("Invalid GitHub repository name.");
  return { url: `https://github.com/${parts[0]}/${repositoryName}.git`, name: repositoryName };
}

async function configureIdentity(projectPath: string): Promise<void> {
  await runGit(projectPath, ["config", "user.name", "Comote"]);
  await runGit(projectPath, ["config", "user.email", "comote@localhost"]);
}

async function ensureInitialCommit(projectPath: string): Promise<void> {
  try {
    await runGit(projectPath, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    await runGit(projectPath, ["commit", "--allow-empty", "-m", "chore: initialize project"]);
  }
}

async function runGit(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return result.stdout.trim();
  } catch (cause) {
    const error = cause as Error & { stderr?: string };
    const detail = error.stderr?.trim().split("\n").slice(-2).join(" ") || error.message;
    throw new Error(`Git operation failed: ${detail}`);
  }
}

function encodeId(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function decodeId(value: string): string {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return "";
  }
}
