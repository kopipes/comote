import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const maximumNoteLength = 10_000;

export class ProjectNotesStore {
  private readonly stateFile: string;
  private readonly notes = new Map<string, string>();
  private saveChain = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.resolve(dataDir, "project-notes.json");
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const content = await readFile(this.stateFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!content) return;
    let saved: unknown;
    try {
      saved = JSON.parse(content);
    } catch {
      throw new Error("Project notes are corrupt; refusing to replace them.");
    }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
      throw new Error("Project notes are corrupt; refusing to replace them.");
    }
    for (const [projectId, note] of Object.entries(saved)) {
      if (projectId && typeof note === "string" && note.length <= maximumNoteLength && note.trim()) {
        this.notes.set(projectId, note.trim());
      }
    }
  }

  get(projectId: string): string {
    return this.notes.get(projectId) ?? "";
  }

  async set(projectId: string, value: unknown): Promise<string> {
    if (typeof value !== "string") throw new Error("Invalid project notes.");
    const note = value.trim();
    if (note.length > maximumNoteLength) throw new Error("Project notes must be 10,000 characters or fewer.");
    if (note) this.notes.set(projectId, note);
    else this.notes.delete(projectId);
    await this.persist();
    return note;
  }

  private persist(): Promise<void> {
    const save = async () => {
      const temporary = `${this.stateFile}.${process.pid}.tmp`;
      const payload = Object.fromEntries([...this.notes].sort(([left], [right]) => left.localeCompare(right)));
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.stateFile);
    };
    this.saveChain = this.saveChain.then(save, save);
    return this.saveChain;
  }
}

