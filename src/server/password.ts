import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error("Password must contain at least 12 characters.");
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltText, keyText] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !keyText) return false;

  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(keyText, "base64url");
    const actual = (await scrypt(password, salt, expected.length)) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export class PasswordStore {
  private readonly filePath: string;
  private passwordHash = "";

  constructor(dataDir: string, private readonly initialHash: string) {
    this.filePath = path.join(dataDir, "password-hash");
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.passwordHash = (await readFile(this.filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    })).trim();
    if (!this.passwordHash) {
      if (!this.initialHash) throw new Error("An initial password hash is required.");
      this.passwordHash = this.initialHash;
      await this.save();
    }
  }

  async verify(password: string): Promise<boolean> {
    return verifyPassword(password, this.passwordHash);
  }

  async change(currentPassword: string, newPassword: string): Promise<void> {
    if (!await this.verify(currentPassword)) throw new Error("Current password is incorrect.");
    if (currentPassword === newPassword) throw new Error("New password must be different from the current password.");
    this.passwordHash = await hashPassword(newPassword);
    await this.save();
  }

  private async save(): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${this.passwordHash}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
