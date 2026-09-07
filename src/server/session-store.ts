import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashToken } from "./password.js";

export interface SessionRecord {
  tokenHash: string;
  csrf: string;
  deviceName: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface SessionFile {
  sessions: SessionRecord[];
}

export class SessionStore {
  private readonly filePath: string;
  private sessions = new Map<string, SessionRecord>();
  private saveChain = Promise.resolve();

  constructor(dataDir: string, private readonly sessionDays: number) {
    this.filePath = path.join(dataDir, "sessions.json");
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as SessionFile;
      for (const session of parsed.sessions ?? []) this.sessions.set(session.tokenHash, session);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.cleanup();
  }

  async create(deviceName: string): Promise<{ token: string; session: SessionRecord }> {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const session: SessionRecord = {
      tokenHash: hashToken(token),
      csrf: randomBytes(24).toString("base64url"),
      deviceName: sanitizeDeviceName(deviceName),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.sessionDays * 86_400_000).toISOString(),
    };
    this.sessions.set(session.tokenHash, session);
    await this.save();
    return { token, session };
  }

  async get(token: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(hashToken(token));
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
    session.lastSeenAt = new Date().toISOString();
    void this.save();
    return session;
  }

  async revoke(token: string): Promise<void> {
    this.sessions.delete(hashToken(token));
    await this.save();
  }

  async revokeAllExcept(token: string): Promise<void> {
    const keep = hashToken(token);
    for (const key of this.sessions.keys()) {
      if (key !== keep) this.sessions.delete(key);
    }
    await this.save();
  }

  csrfMatches(session: SessionRecord, supplied: string): boolean {
    const expected = Buffer.from(session.csrf);
    const actual = Buffer.from(supplied);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= now) this.sessions.delete(key);
    }
    await this.save();
  }

  private save(): Promise<void> {
    this.saveChain = this.saveChain.then(async () => {
      const tempPath = `${this.filePath}.tmp`;
      const payload = JSON.stringify({ sessions: [...this.sessions.values()] }, null, 2);
      await writeFile(tempPath, payload, { mode: 0o600 });
      await rename(tempPath, this.filePath);
    });
    return this.saveChain;
  }
}

function sanitizeDeviceName(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9 _.-]/g, "").slice(0, 40);
  return cleaned || "Unknown device";
}
