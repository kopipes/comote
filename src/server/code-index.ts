import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { withoutComoteEnvironment } from "./child-environment.js";

const execFileAsync = promisify(execFile);
const maxFiles = 5_000;
const maxFileBytes = 256 * 1024;
const maxIndexedBytes = 40 * 1024 * 1024;

const ignoredDirectories = new Set([
  ".git", ".svn", ".hg", ".idea", ".vscode", ".cache", ".next", ".nuxt", ".output",
  ".turbo", ".venv", "venv", "node_modules", "vendor", "dist", "build", "coverage", "target",
  "bin", "obj", "pods", "__pycache__",
]);
const allowedExtensions = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".dart", ".ex", ".exs", ".go", ".graphql", ".gql",
  ".h", ".hpp", ".html", ".java", ".js", ".jsx", ".json", ".kt", ".kts", ".lua", ".md",
  ".php", ".prisma", ".proto", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".svelte",
  ".swift", ".toml", ".ts", ".tsx", ".vue", ".xml", ".yaml", ".yml",
]);
const allowedNames = new Set([
  "dockerfile", "makefile", "procfile", "gemfile", "rakefile", "justfile", "caddyfile",
  ".gitignore", ".dockerignore", ".editorconfig",
]);
const ignoredNames = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "composer.lock", "cargo.lock", "poetry.lock", "uv.lock", "go.sum", "credentials.json", "secrets.json",
  "secrets.yaml", "secrets.yml", "secrets.toml",
]);
const ignoredExtensions = new Set([
  ".db", ".sqlite", ".sqlite3", ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore",
]);
const queryStopWords = new Set([
  "a", "an", "and", "app", "atau", "buat", "code", "coding", "dalam", "dan", "dengan", "di", "do",
  "for", "from", "ini", "is", "it", "ke", "make", "mau", "of", "on", "please", "project", "saya",
  "the", "this", "to", "tolong", "untuk", "with", "yang",
]);

interface FileSnapshot {
  path: string;
  absolutePath: string;
  mtimeMs: number;
  size: number;
}

interface IndexedMetadata {
  kind: string;
  symbols: string;
  imports: string;
  routes: string;
  schema: string;
  config: string;
}

interface DocumentRow {
  path: string;
  mtime_ms: number;
  size: number;
}

interface MetaRow {
  value: string;
}

interface SearchRow {
  path: string;
  kind: string;
  symbols: string;
  imports: string;
  routes: string;
  schema: string;
  config: string;
}

export interface CodeIndexStatus {
  phase: "ready" | "failed";
  fresh: boolean;
  indexedFiles: number;
  indexedBytes: number;
  skippedFiles: number;
  revision: string;
  updatedAt: string;
  message: string;
}

export interface CodeIndexMatch {
  path: string;
  kind: string;
  symbols: string[];
  imports: string[];
  routes: string[];
  schema: string[];
  config: string[];
}

export class CodeIndexManager {
  private readonly root: string;
  private readonly active = new Map<string, Promise<CodeIndexStatus>>();

  constructor(dataDir: string) {
    this.root = path.resolve(dataDir, "code-index");
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  async refresh(workspacePath: string, force = false): Promise<CodeIndexStatus> {
    const key = workspaceKey(workspacePath);
    const running = this.active.get(key);
    if (running) return running;
    const operation = this.update(workspacePath, key, force)
      .catch((error: Error) => ({
        phase: "failed" as const,
        fresh: false,
        indexedFiles: 0,
        indexedBytes: 0,
        skippedFiles: 0,
        revision: "",
        updatedAt: "",
        message: `Index unavailable: ${error.message}`,
      }))
      .finally(() => this.active.delete(key));
    this.active.set(key, operation);
    return operation;
  }

  async search(workspacePath: string, query: string, limit = 10): Promise<{ status: CodeIndexStatus; matches: CodeIndexMatch[] }> {
    const status = await this.refresh(workspacePath);
    const terms = searchTerms(query);
    if (status.phase !== "ready" || terms.length === 0) return { status, matches: [] };
    const database = this.open(workspaceKey(workspacePath));
    try {
      const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" OR ");
      const rows = database.prepare(`
        SELECT d.path, d.kind, d.symbols, d.imports, d.routes, d.schema, d.config
        FROM documents_fts f
        JOIN documents d ON d.path = f.path
        WHERE documents_fts MATCH ?
        ORDER BY
          CASE WHEN d.kind = 'md' THEN 2 WHEN d.path LIKE 'test/%' OR d.path LIKE 'tests/%' THEN 1 ELSE 0 END,
          bm25(documents_fts, 5.0, 1.0, 8.0, 3.0, 7.0, 7.0, 5.0),
          length(d.path)
        LIMIT ?
      `).all(expression, Math.max(1, Math.min(limit, 12))) as unknown as SearchRow[];
      return {
        status,
        matches: rows.map((row) => ({
          path: row.path,
          kind: row.kind,
          symbols: splitMetadata(row.symbols),
          imports: splitMetadata(row.imports),
          routes: splitMetadata(row.routes),
          schema: splitMetadata(row.schema),
          config: splitMetadata(row.config),
        })),
      };
    } finally {
      database.close();
    }
  }

  private async update(workspacePath: string, key: string, force: boolean): Promise<CodeIndexStatus> {
    const scan = await scanWorkspace(workspacePath);
    const database = this.open(key);
    try {
      const previousFingerprint = readMeta(database, "fingerprint");
      if (!force && previousFingerprint === scan.fingerprint) return statusFromDatabase(database, true, "Index is up to date.");

      const rows = database.prepare("SELECT path, mtime_ms, size FROM documents").all() as unknown as DocumentRow[];
      const previous = new Map(rows.map((row) => [row.path, row]));
      const currentPaths = new Set(scan.files.map((file) => file.path));
      const changed = force
        ? scan.files
        : scan.files.filter((file) => {
          const row = previous.get(file.path);
          return !row || row.mtime_ms !== file.mtimeMs || row.size !== file.size;
        });
      const removed = rows.filter((row) => !currentPaths.has(row.path));

      database.exec("BEGIN IMMEDIATE");
      try {
        const deleteDocument = database.prepare("DELETE FROM documents WHERE path = ?");
        const deleteSearch = database.prepare("DELETE FROM documents_fts WHERE path = ?");
        const upsert = database.prepare(`
          INSERT INTO documents(path, mtime_ms, size, kind, symbols, imports, routes, schema, config, content)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            mtime_ms = excluded.mtime_ms, size = excluded.size, kind = excluded.kind,
            symbols = excluded.symbols, imports = excluded.imports, routes = excluded.routes,
            schema = excluded.schema, config = excluded.config, content = excluded.content
        `);
        const insertSearch = database.prepare(`
          INSERT INTO documents_fts(path, content, symbols, imports, routes, schema, config)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of removed) {
          deleteSearch.run(row.path);
          deleteDocument.run(row.path);
        }
        let binarySkipped = 0;
        for (const file of changed) {
          const content = await readFile(file.absolutePath, "utf8");
          deleteSearch.run(file.path);
          deleteDocument.run(file.path);
          if (content.includes("\0")) {
            binarySkipped += 1;
            continue;
          }
          const metadata = extractMetadata(file.path, content);
          upsert.run(file.path, file.mtimeMs, file.size, metadata.kind, metadata.symbols, metadata.imports, metadata.routes, metadata.schema, metadata.config, content);
          insertSearch.run(file.path, content, metadata.symbols, metadata.imports, metadata.routes, metadata.schema, metadata.config);
        }
        const updatedAt = new Date().toISOString();
        writeMeta(database, "fingerprint", scan.fingerprint);
        writeMeta(database, "skippedFiles", String(scan.skippedFiles + binarySkipped));
        writeMeta(database, "revision", scan.revision);
        writeMeta(database, "updatedAt", updatedAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return statusFromDatabase(database, true, `${changed.length} file${changed.length === 1 ? "" : "s"} updated, ${removed.length} removed.`);
    } finally {
      database.close();
      await chmod(this.databasePath(key), 0o600).catch(() => undefined);
    }
  }

  private open(key: string): Database.Database {
    const database = new Database(this.databasePath(key));
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS documents (
        path TEXT PRIMARY KEY,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        kind TEXT NOT NULL,
        symbols TEXT NOT NULL,
        imports TEXT NOT NULL,
        routes TEXT NOT NULL,
        schema TEXT NOT NULL,
        config TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        path, content, symbols, imports, routes, schema, config,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    return database;
  }

  private databasePath(key: string): string {
    return path.join(this.root, `${key}.sqlite`);
  }
}

async function scanWorkspace(workspacePath: string): Promise<{
  files: FileSnapshot[];
  fingerprint: string;
  skippedFiles: number;
  revision: string;
}> {
  const [fileOutput, revision] = await Promise.all([
    git(workspacePath, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], 20 * 1024 * 1024),
    git(workspacePath, ["rev-parse", "--short=12", "HEAD"]).catch(() => "unborn"),
  ]);
  const candidates = fileOutput.split("\0").filter(Boolean);
  const files: FileSnapshot[] = [];
  let indexedBytes = 0;
  let skippedFiles = 0;
  for (const relativePath of candidates) {
    if (!isIndexablePath(relativePath) || files.length >= maxFiles) {
      skippedFiles += 1;
      continue;
    }
    const absolutePath = path.resolve(workspacePath, relativePath);
    if (!absolutePath.startsWith(`${path.resolve(workspacePath)}${path.sep}`)) {
      skippedFiles += 1;
      continue;
    }
    const info = await lstat(absolutePath).catch(() => null);
    if (!info?.isFile() || info.size > maxFileBytes || indexedBytes + info.size > maxIndexedBytes) {
      skippedFiles += 1;
      continue;
    }
    files.push({ path: relativePath.replaceAll(path.sep, "/"), absolutePath, mtimeMs: info.mtimeMs, size: info.size });
    indexedBytes += info.size;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const fingerprint = createHash("sha256")
    .update(files.map((file) => `${file.path}\0${file.mtimeMs}\0${file.size}`).join("\n"))
    .digest("hex");
  return { files, fingerprint, skippedFiles, revision: revision.trim() || "unborn" };
}

function isIndexablePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
  const parts = normalized.toLowerCase().split("/");
  if (parts.some((part) => ignoredDirectories.has(part))) return false;
  if (parts.some((part) => part === ".ssh" || part === ".aws" || part === ".gnupg")) return false;
  const name = parts.at(-1) ?? "";
  if (name.startsWith(".env") || ignoredNames.has(name) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(name)) return false;
  const extension = path.extname(name);
  if (ignoredExtensions.has(extension)) return false;
  return allowedNames.has(name) || allowedExtensions.has(extension);
}

function extractMetadata(filePath: string, content: string): IndexedMetadata {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const kind = extension || path.basename(filePath).toLowerCase();
  const symbols = collect(content, [
    /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|trait|struct)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:def|class|module)\s+([A-Za-z_][\w]*)/g,
    /\b(?:func|fn)\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/g,
    /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  ]);
  const importPatterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  if (extension === "py") importPatterns.push(/^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm);
  const imports = collect(content, importPatterns);
  const routes = collect(content, [
    /\b(?:app|router|server)\.(get|post|put|patch|delete|options|head)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    /@(?:Get|Post|Put|Patch|Delete|RequestMapping)\s*\(\s*["']([^"']+)["']/g,
  ], (match) => match[2] ? `${match[1].toUpperCase()} ${match[2]}` : match[1]);
  const schemaPatterns = [
    /\b(?:interface|type|class)\s+([A-Za-z_][\w]*(?:Schema|Model|Entity|Record|Row|Dto))/g,
  ];
  if (extension === "prisma") schemaPatterns.push(/\b(?:model|type|enum)\s+([A-Za-z_][\w]*)/gi);
  if (extension === "sql") schemaPatterns.push(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z_][\w.]*)/gi);
  if (extension === "proto") schemaPatterns.push(/\b(?:message|enum|service)\s+([A-Za-z_][\w]*)/gi);
  const schema = collect(content, schemaPatterns);
  const config = extractConfigKeys(filePath, content);
  return {
    kind,
    symbols: symbols.join("\n"),
    imports: imports.join("\n"),
    routes: routes.join("\n"),
    schema: schema.join("\n"),
    config: config.join("\n"),
  };
}

function collect(content: string, patterns: RegExp[], value = (match: RegExpExecArray) => match[1]): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(content); match && found.size < 80; match = pattern.exec(content)) {
      const candidate = value(match)?.trim();
      if (candidate && candidate.length <= 160) found.add(candidate);
    }
  }
  return [...found];
}

function extractConfigKeys(filePath: string, content: string): string[] {
  const name = path.basename(filePath).toLowerCase();
  if (path.extname(name) !== ".json") return isConfigPath(filePath) ? [name] : [];
  try {
    const value = JSON.parse(content) as unknown;
    if (!value || Array.isArray(value) || typeof value !== "object") return [];
    return Object.keys(value).filter((key) => /^[A-Za-z0-9_.-]{1,80}$/.test(key)).slice(0, 80);
  } catch {
    return [];
  }
}

function isConfigPath(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return name.includes("config") || allowedNames.has(name) || /^(tsconfig|vite\.config|next\.config|nuxt\.config|eslint\.config)/.test(name);
}

function searchTerms(query: string): string[] {
  const expanded = query.replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase();
  const tokens = expanded.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return [...new Set(tokens.filter((token) => !queryStopWords.has(token)))].slice(0, 12);
}

function splitMetadata(value: string): string[] {
  return value ? value.split("\n").filter(Boolean).slice(0, 12) : [];
}

function workspaceKey(workspacePath: string): string {
  return createHash("sha256").update(path.resolve(workspacePath)).digest("hex").slice(0, 32);
}

function statusFromDatabase(database: Database.Database, fresh: boolean, message: string): CodeIndexStatus {
  const totals = database.prepare("SELECT count(*) AS count, coalesce(sum(size), 0) AS bytes FROM documents").get() as { count?: number | bigint; bytes?: number | bigint } | undefined;
  return {
    phase: "ready",
    fresh,
    indexedFiles: Number(totals?.count ?? 0),
    indexedBytes: Number(totals?.bytes ?? 0),
    skippedFiles: Number(readMeta(database, "skippedFiles") || 0),
    revision: readMeta(database, "revision"),
    updatedAt: readMeta(database, "updatedAt"),
    message,
  };
}

function readMeta(database: Database.Database, key: string): string {
  const row = database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as MetaRow | undefined;
  return row?.value ?? "";
}

function writeMeta(database: Database.Database, key: string, value: string): void {
  database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

async function git(cwd: string, args: string[], maxBuffer = 1024 * 1024): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: 30_000,
      maxBuffer,
      encoding: "utf8",
      env: { ...withoutComoteEnvironment(process.env), GIT_TERMINAL_PROMPT: "0" },
    });
    return result.stdout;
  } catch (cause) {
    const error = cause as Error & { stderr?: string };
    throw new Error(error.stderr?.trim() || error.message);
  }
}
