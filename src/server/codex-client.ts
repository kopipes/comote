import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { ComoteConfig } from "./config.js";
import { EventHub } from "./event-hub.js";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ApprovalRequest {
  rpcId: string | number;
  method: string;
  params: JsonObject;
}

export class CodexClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private approvals = new Map<string, ApprovalRequest>();
  private loadedThreads = new Set<string>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ComoteConfig,
    readonly events: EventHub,
  ) {}

  async listThreads(cwd: string): Promise<JsonObject[]> {
    const result = await this.request<{ data?: JsonObject[] }>("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["appServer", "cli", "vscode"],
      cwd,
    });
    return result.data ?? [];
  }

  async startThread(cwd: string): Promise<JsonObject> {
    const result = await this.request<{ thread: JsonObject }>("thread/start", {
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
      serviceName: "comote",
    });
    const id = String(result.thread.id);
    this.loadedThreads.add(id);
    return result.thread;
  }

  async readThread(threadId: string): Promise<JsonObject> {
    const result = await this.request<{ thread: JsonObject }>("thread/read", {
      threadId,
      includeTurns: true,
    });
    return result.thread;
  }

  async startTurn(threadId: string, cwd: string, text: string, deviceName: string): Promise<JsonObject> {
    await this.ensureThreadLoaded(threadId, cwd);
    const result = await this.request<{ turn: JsonObject }>("turn/start", {
      threadId,
      cwd,
      input: [{ type: "text", text }],
    });
    this.events.publish(threadId, "request_origin", { deviceName });
    return result.turn;
  }

  async interrupt(threadId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId });
  }

  async resolveApproval(
    externalId: string,
    threadId: string,
    decision: "accept" | "decline" | "cancel",
  ): Promise<void> {
    const approval = this.approvals.get(externalId);
    if (!approval) throw new Error("Approval request is no longer pending.");
    if (extractThreadId(approval.params) !== threadId) throw new Error("Approval does not belong to this thread.");
    if (!this.process?.stdin.writable) throw new Error("Codex is not running.");

    const result = approval.method === "item/permissions/requestApproval"
      ? { permissions: {}, scope: "turn" }
      : { decision };
    this.write({ id: approval.rpcId, result });
    this.approvals.delete(externalId);
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.process?.kill("SIGTERM");
    this.process = null;
    this.starting = null;
    this.loadedThreads.clear();
    this.approvals.clear();
  }

  private async ensureThreadLoaded(threadId: string, cwd: string): Promise<void> {
    if (this.loadedThreads.has(threadId)) return;
    await this.request("thread/resume", {
      threadId,
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
    });
    this.loadedThreads.add(threadId);
  }

  private async ensureStarted(): Promise<void> {
    this.touch();
    if (this.process) return;
    if (this.starting) return this.starting;

    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn(this.config.codexBin, ["app-server"], {
        cwd: this.config.projectsRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process = child;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => this.onLine(line));
      child.stderr.on("data", (chunk) => {
        const message = String(chunk).trim();
        if (message) console.error(`[codex] ${message}`);
      });
      child.once("error", (error) => {
        this.failAll(error);
        this.process = null;
        this.starting = null;
        reject(error);
      });
      child.once("exit", (code, signal) => {
        this.failAll(new Error(`Codex stopped (${signal ?? code ?? "unknown"}).`));
        this.process = null;
        this.starting = null;
        this.loadedThreads.clear();
      });

      this.rawRequest("initialize", {
        clientInfo: { name: "comote", title: "Comote", version: "0.1.0" },
      })
        .then(() => {
          this.write({ method: "initialized", params: {} });
          resolve();
        })
        .catch(reject);
    });

    try {
      await this.starting;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  private async request<T = JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
    await this.ensureStarted();
    this.touch();
    return this.rawRequest<T>(method, params);
  }

  private rawRequest<T = JsonObject>(method: string, params: JsonObject): Promise<T> {
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.write({ method, id, params });
    });
  }

  private write(message: JsonObject): void {
    if (!this.process?.stdin.writable) throw new Error("Codex process is unavailable.");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      console.error("Ignored invalid JSON from Codex app-server.");
      return;
    }

    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(extractError(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") this.onServerMessage(message);
  }

  private onServerMessage(message: JsonObject): void {
    const method = String(message.method);
    const params = (message.params ?? {}) as JsonObject;
    const threadId = extractThreadId(params);

    if ((typeof message.id === "number" || typeof message.id === "string") && method.includes("request")) {
      const externalId = randomUUID();
      this.approvals.set(externalId, { rpcId: message.id, method, params });
      if (threadId) {
        this.events.publish(threadId, "approval", {
          requestId: externalId,
          method,
          reason: params.reason ?? "Codex needs your approval.",
          command: params.command ?? null,
          cwd: params.cwd ?? null,
        });
      }
      return;
    }

    if (!threadId) return;
    if (method === "item/agentMessage/delta") {
      this.events.publish(threadId, "assistant_delta", {
        itemId: params.itemId,
        text: params.delta ?? "",
      });
    } else if (method === "item/started" || method === "item/completed") {
      this.events.publish(threadId, method === "item/started" ? "item_started" : "item_completed", {
        item: params.item,
      });
    } else if (method === "turn/started" || method === "turn/completed" || method === "thread/status/changed") {
      this.events.publish(threadId, "status", { method, ...params });
    } else if (method === "turn/diff/updated") {
      this.events.publish(threadId, "diff_updated", params);
    } else if (method === "error") {
      this.events.publish(threadId, "error", { message: extractError(params.error ?? params) });
    }
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.config.idleMinutes * 60_000);
    this.idleTimer.unref();
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function extractThreadId(params: JsonObject): string {
  if (typeof params.threadId === "string") return params.threadId;
  const thread = params.thread as JsonObject | undefined;
  if (typeof thread?.id === "string") return thread.id;
  const turn = params.turn as JsonObject | undefined;
  if (typeof turn?.threadId === "string") return turn.threadId;
  return "";
}

function extractError(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) return String((value as JsonObject).message);
  return "Unknown Codex error.";
}
