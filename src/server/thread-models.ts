import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class ThreadModelStore {
  private readonly stateFile: string;
  private readonly models = new Map<string, string>();
  private saveChain = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.resolve(dataDir, "thread-models.json");
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const content = await readFile(this.stateFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!content) return;
    const saved = JSON.parse(content) as Record<string, unknown>;
    for (const [threadId, model] of Object.entries(saved)) {
      if (threadId && typeof model === "string" && model) this.models.set(threadId, model);
    }
  }

  get(threadId: string): string {
    return this.models.get(threadId) ?? "";
  }

  async set(threadId: string, model: string): Promise<void> {
    if (model) this.models.set(threadId, model);
    else this.models.delete(threadId);
    await this.persist();
  }

  async remove(threadId: string): Promise<void> {
    if (!this.models.delete(threadId)) return;
    await this.persist();
  }

  private persist(): Promise<void> {
    const save = async () => {
      const temporary = `${this.stateFile}.${process.pid}.tmp`;
      const payload = Object.fromEntries([...this.models].sort(([left], [right]) => left.localeCompare(right)));
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.stateFile);
    };
    this.saveChain = this.saveChain.then(save, save);
    return this.saveChain;
  }
}
