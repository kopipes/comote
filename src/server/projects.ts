import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface Project {
  id: string;
  name: string;
  path: string;
}

export class ProjectRegistry {
  private rootRealPath = "";

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
