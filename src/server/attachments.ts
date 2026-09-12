import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const maximumFileSize = 10 * 1024 * 1024;
const maximumSessionSize = 25 * 1024 * 1024;
const maximumFilesPerMessage = 5;
const allowedExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf",
  ".txt", ".md", ".markdown", ".csv", ".json", ".yaml", ".yml", ".xml",
  ".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".html", ".sql",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".php", ".sh",
]);
const attachmentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface Attachment {
  id: string;
  name: string;
  size: number;
}

export interface ResolvedAttachment extends Attachment {
  path: string;
}

export class AttachmentStore {
  private readonly root: string;
  private rootRealPath = "";

  constructor(dataDir: string) {
    this.root = path.resolve(dataDir, "attachments");
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.rootRealPath = await realpath(this.root);
  }

  async save(projectId: string, threadId: string, filename: unknown, content: Buffer): Promise<Attachment> {
    const name = validateFilename(filename);
    if (!content.length || content.length > maximumFileSize) {
      throw new Error("Attachment must be between 1 byte and 10 MB.");
    }
    const directory = (await this.directory(projectId, threadId, true))!;
    const entries = await readdir(directory);
    let totalSize = 0;
    for (const entry of entries) totalSize += (await stat(path.join(directory, entry))).size;
    if (totalSize + content.length > maximumSessionSize) {
      throw new Error("Session attachments cannot exceed 25 MB in total.");
    }
    const id = randomUUID();
    await writeFile(path.join(directory, `${id}--${name}`), content, { flag: "wx", mode: 0o600 });
    return { id, name, size: content.length };
  }

  async resolve(projectId: string, threadId: string, input: unknown): Promise<ResolvedAttachment[]> {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > maximumFilesPerMessage || input.some((id) => typeof id !== "string" || !attachmentIdPattern.test(id))) {
      throw new Error("Invalid attachments. Choose up to 5 uploaded files.");
    }
    const ids = [...new Set(input as string[])];
    if (ids.length !== input.length) throw new Error("Invalid attachments. Duplicate files are not allowed.");
    const directory = await this.directory(projectId, threadId, false);
    const entries = directory ? await readdir(directory) : [];
    return Promise.all(ids.map(async (id) => {
      const matches = entries.filter((entry) => entry.startsWith(`${id}--`));
      if (matches.length !== 1) throw new Error("Attachment not found for this session.");
      const filePath = path.join(directory!, matches[0]);
      const resolved = await realpath(filePath);
      if (path.dirname(resolved) !== directory) throw new Error("Invalid attachment path.");
      const info = await stat(resolved);
      if (!info.isFile()) throw new Error("Invalid attachment file.");
      return { id, name: matches[0].slice(id.length + 2), size: info.size, path: resolved };
    }));
  }

  async remove(projectId: string, threadId: string, attachmentId: string): Promise<void> {
    const [attachment] = await this.resolve(projectId, threadId, [attachmentId]);
    await unlink(attachment.path);
  }

  async removeThread(projectId: string, threadId: string): Promise<void> {
    const directory = await this.directory(projectId, threadId, false);
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  private async directory(projectId: string, threadId: string, create: boolean): Promise<string | null> {
    if (!projectId || !threadId) throw new Error("Invalid attachment owner.");
    const projectKey = digest(projectId);
    const threadKey = digest(threadId);
    const directory = path.join(this.rootRealPath || this.root, projectKey, threadKey);
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const resolved = await realpath(directory).catch((error: NodeJS.ErrnoException) => {
      if (!create && error.code === "ENOENT") return "";
      throw error;
    });
    if (!resolved) return null;
    const expectedParent = path.join(this.rootRealPath || this.root, projectKey);
    if (path.dirname(resolved) !== expectedParent) throw new Error("Invalid attachment directory.");
    return resolved;
  }
}

export function validateFilename(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid attachment filename.");
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).normalize("NFKC").trim();
  } catch {
    throw new Error("Invalid attachment filename.");
  }
  if (!decoded || decoded.length > 120 || decoded !== path.basename(decoded) || decoded.includes("\0")) {
    throw new Error("Invalid attachment filename.");
  }
  const extension = path.extname(decoded).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error("Unsupported attachment type. Use an image, PDF, text, data, or source-code file.");
  }
  const safe = decoded.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^\.+/, "").trim();
  if (!safe) throw new Error("Invalid attachment filename.");
  return safe.slice(0, 100);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
