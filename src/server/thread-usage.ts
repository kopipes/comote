import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, unknown>;

export interface ThreadContextUsage {
  usedTokens: number;
  contextWindow: number;
  percentage: number;
  cumulativeTokens: number;
  updatedAt: string;
}

export class ThreadUsageStore {
  private readonly stateFile: string;
  private readonly usage = new Map<string, ThreadContextUsage>();
  private saveChain = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.resolve(dataDir, "thread-usage.json");
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const content = await readFile(this.stateFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!content) return;
    const saved = JSON.parse(content) as Record<string, unknown>;
    for (const [threadId, value] of Object.entries(saved)) {
      const parsed = parseSavedUsage(value);
      if (threadId && parsed) this.usage.set(threadId, parsed);
    }
  }

  get(threadId: string): ThreadContextUsage | null {
    const value = this.usage.get(threadId);
    return value ? { ...value } : null;
  }

  async set(threadId: string, value: ThreadContextUsage): Promise<void> {
    this.usage.set(threadId, { ...value });
    await this.persist();
  }

  async remove(threadId: string): Promise<void> {
    if (!this.usage.delete(threadId)) return;
    await this.persist();
  }

  private persist(): Promise<void> {
    const save = async () => {
      const temporary = `${this.stateFile}.${process.pid}.tmp`;
      const payload = Object.fromEntries([...this.usage].sort(([left], [right]) => left.localeCompare(right)));
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.stateFile);
    };
    this.saveChain = this.saveChain.then(save, save);
    return this.saveChain;
  }
}

export function parseThreadContextUsage(params: JsonObject, now = new Date()): ThreadContextUsage | null {
  const tokenUsage = objectValue(params.tokenUsage);
  const last = objectValue(tokenUsage?.last);
  const total = objectValue(tokenUsage?.total);
  const usedTokens = finiteNonNegative(last?.totalTokens);
  const contextWindow = finitePositive(tokenUsage?.modelContextWindow);
  if (usedTokens === null || contextWindow === null) return null;
  const cumulativeTokens = finiteNonNegative(total?.totalTokens) ?? usedTokens;
  return {
    usedTokens,
    contextWindow,
    percentage: Math.min(100, Math.max(0, Math.round((usedTokens / contextWindow) * 100))),
    cumulativeTokens,
    updatedAt: now.toISOString(),
  };
}

function parseSavedUsage(value: unknown): ThreadContextUsage | null {
  const saved = objectValue(value);
  const usedTokens = finiteNonNegative(saved?.usedTokens);
  const contextWindow = finitePositive(saved?.contextWindow);
  const percentage = finiteNonNegative(saved?.percentage);
  const cumulativeTokens = finiteNonNegative(saved?.cumulativeTokens);
  if (usedTokens === null || contextWindow === null || percentage === null || cumulativeTokens === null || typeof saved?.updatedAt !== "string") return null;
  return {
    usedTokens,
    contextWindow,
    percentage: Math.min(100, percentage),
    cumulativeTokens,
    updatedAt: saved.updatedAt,
  };
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" ? value as JsonObject : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
