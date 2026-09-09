import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { withoutComoteEnvironment } from "./child-environment.js";
import type { ComoteConfig } from "./config.js";
import { EventHub } from "./event-hub.js";
import { parseThreadContextUsage, type ThreadUsageStore } from "./thread-usage.js";

type JsonObject = Record<string, unknown>;

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
}

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

interface OperationWaiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface TurnWaiter extends OperationWaiter<string> {
  agentText: string;
}

export class CodexClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private approvals = new Map<string, ApprovalRequest>();
  private loadedThreads = new Set<string>();
  private compactionWaiters = new Map<string, OperationWaiter<void>>();
  private turnWaiters = new Map<string, TurnWaiter>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ComoteConfig,
    readonly events: EventHub,
    private readonly usage?: ThreadUsageStore,
  ) {}

  async listThreads(cwd?: string | string[], archived = false): Promise<JsonObject[]> {
    const result = await this.request<{ data?: JsonObject[] }>("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived,
      sourceKinds: ["appServer", "cli", "vscode"],
      ...(cwd ? { cwd } : {}),
    });
    return result.data ?? [];
  }

  async listModels(): Promise<CodexModel[]> {
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const result: { data?: JsonObject[]; nextCursor?: string | null } = await this.request("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      for (const candidate of result.data ?? []) {
        const model = parseModel(candidate);
        if (model) models.push(model);
      }
      cursor = result.nextCursor ?? null;
    } while (cursor);
    return [...new Map(models.map((model) => [model.model, model])).values()];
  }

  async startThread(cwd: string): Promise<JsonObject> {
    const result = await this.request<{ thread: JsonObject }>("thread/start", {
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceName: "comote",
    });
    const id = String(result.thread.id);
    this.loadedThreads.add(id);
    return result.thread;
  }

  async readThread(threadId: string, includeTurns = true): Promise<JsonObject> {
    const result = await this.request<{ thread: JsonObject }>("thread/read", {
      threadId,
      includeTurns,
    });
    return result.thread;
  }

  async startTurn(threadId: string, cwd: string, text: string, deviceName: string, writableRoots: string[] = [cwd], model = ""): Promise<JsonObject> {
    await this.ensureThreadLoaded(threadId, cwd);
    const result = await this.request<{ turn: JsonObject }>("turn/start", {
      threadId,
      cwd,
      input: [{ type: "text", text }],
      ...(model ? { model } : {}),
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots,
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    this.events.publish(threadId, "request_origin", { deviceName });
    return result.turn;
  }

  async interrupt(threadId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId });
  }

  async compactThread(threadId: string, waitForCompletion = false): Promise<void> {
    if (!waitForCompletion) {
      await this.request("thread/compact/start", { threadId });
      return;
    }
    if (this.compactionWaiters.has(threadId) || this.turnWaiters.has(threadId)) {
      throw new Error("A session operation is already in progress.");
    }
    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.compactionWaiters.delete(threadId);
        reject(new Error("Session compaction timed out."));
      }, 5 * 60_000);
      this.compactionWaiters.set(threadId, { resolve, reject, timer });
    });
    try {
      await this.request("thread/compact/start", { threadId });
    } catch (error) {
      this.rejectCompaction(threadId, error as Error);
      throw error;
    }
    await completion;
  }

  async summarizeThread(
    threadId: string,
    cwd: string,
    deviceName: string,
    writableRoots: string[],
    model = "",
  ): Promise<string> {
    if (this.turnWaiters.has(threadId) || this.compactionWaiters.has(threadId)) {
      throw new Error("A session operation is already in progress.");
    }
    const completion = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(threadId);
        reject(new Error("Session handoff summary timed out."));
      }, 5 * 60_000);
      this.turnWaiters.set(threadId, { resolve, reject, timer, agentText: "" });
    });
    const prompt = [
      "Prepare a concise handoff summary for a fresh Codex session that will continue in this exact Git worktree.",
      "Use only the conversation context you already have. Do not call tools, run commands, edit files, commit, or push.",
      "Include: objective, important decisions and constraints, completed work, current implementation state, pending work, verification already performed, known risks, and the single best next action.",
      "Mention important file paths when they are known. Return only the handoff summary in clear Markdown, under 1,200 words.",
    ].join("\n");
    try {
      await this.startTurn(threadId, cwd, prompt, deviceName, writableRoots, model);
    } catch (error) {
      this.rejectTurnWaiter(threadId, error as Error);
      throw error;
    }
    return completion;
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.request("thread/name/set", { threadId, name });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request("thread/archive", { threadId });
    this.loadedThreads.delete(threadId);
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await this.request("thread/unarchive", { threadId });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.request("thread/delete", { threadId });
    this.loadedThreads.delete(threadId);
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

    const result = buildApprovalResponse(approval.method, approval.params, decision);
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
    this.failOperations(new Error("Codex stopped."));
  }

  private async ensureThreadLoaded(threadId: string, cwd: string): Promise<void> {
    if (this.loadedThreads.has(threadId)) return;
    await this.request("thread/resume", {
      threadId,
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
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
        env: createCodexEnvironment(process.env),
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
        const error = new Error(`Codex stopped (${signal ?? code ?? "unknown"}).`);
        this.failAll(error);
        this.failOperations(error);
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
        const networkContext = params.networkApprovalContext as JsonObject | undefined;
        this.events.publish(threadId, "approval", {
          requestId: externalId,
          method,
          reason: params.reason ?? "Codex needs your approval.",
          command: params.command ?? null,
          cwd: params.cwd ?? null,
          host: networkContext?.host ?? null,
          protocol: networkContext?.protocol ?? null,
          permissions: params.permissions ?? null,
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
      const item = (params.item ?? {}) as JsonObject;
      if (method === "item/completed" && item.type === "contextCompaction") {
        const compaction = this.compactionWaiters.get(threadId);
        if (compaction) {
          clearTimeout(compaction.timer);
          this.compactionWaiters.delete(threadId);
          compaction.resolve();
        }
      }
      if (method === "item/completed" && item.type === "agentMessage") {
        const waiter = this.turnWaiters.get(threadId);
        if (waiter && typeof item.text === "string") waiter.agentText = item.text;
      }
      this.events.publish(threadId, method === "item/started" ? "item_started" : "item_completed", {
        item: params.item,
      });
    } else if (method === "turn/started" || method === "turn/completed" || method === "thread/status/changed") {
      this.events.publish(threadId, "status", { method, ...params });
      if (method === "turn/completed") this.completeSessionOperation(threadId, params);
    } else if (method === "thread/tokenUsage/updated") {
      const parsed = parseThreadContextUsage(params);
      if (parsed) {
        this.events.publish(threadId, "context_usage", { usage: parsed });
        void this.usage?.set(threadId, parsed).catch((error: Error) => {
          console.error(`Could not persist Codex context usage: ${error.message}`);
        });
      }
    } else if (method === "turn/diff/updated") {
      this.events.publish(threadId, "diff_updated", params);
    } else if (method === "error") {
      const error = new Error(extractError(params.error ?? params));
      this.rejectCompaction(threadId, error);
      this.rejectTurnWaiter(threadId, error);
      this.events.publish(threadId, "error", { message: error.message });
    }
  }

  private completeSessionOperation(threadId: string, params: JsonObject): void {
    const turn = (params.turn ?? {}) as JsonObject;
    const status = typeof turn.status === "string" ? turn.status : "completed";
    const failed = status !== "completed";
    const error = failed
      ? new Error(extractError((turn.error as JsonObject | undefined) ?? `Session operation ${status}.`))
      : null;

    const waiter = this.turnWaiters.get(threadId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.turnWaiters.delete(threadId);
    if (error) waiter.reject(error);
    else if (!waiter.agentText.trim()) waiter.reject(new Error("Codex returned an empty handoff summary."));
    else waiter.resolve(waiter.agentText.trim());
  }

  private rejectCompaction(threadId: string, error: Error): void {
    const waiter = this.compactionWaiters.get(threadId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.compactionWaiters.delete(threadId);
    waiter.reject(error);
  }

  private rejectTurnWaiter(threadId: string, error: Error): void {
    const waiter = this.turnWaiters.get(threadId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.turnWaiters.delete(threadId);
    waiter.reject(error);
  }

  private failOperations(error: Error): void {
    for (const [threadId] of this.compactionWaiters) this.rejectCompaction(threadId, error);
    for (const [threadId] of this.turnWaiters) this.rejectTurnWaiter(threadId, error);
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

function parseModel(value: JsonObject): CodexModel | null {
  if (typeof value.id !== "string" || typeof value.model !== "string" || typeof value.displayName !== "string") return null;
  const efforts = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const option = entry as JsonObject;
      if (typeof option.reasoningEffort !== "string") return [];
      return [{
        reasoningEffort: option.reasoningEffort,
        description: typeof option.description === "string" ? option.description : "",
      }];
    })
    : [];
  return {
    id: value.id,
    model: value.model,
    displayName: value.displayName,
    description: typeof value.description === "string" ? value.description : "",
    isDefault: value.isDefault === true,
    defaultReasoningEffort: typeof value.defaultReasoningEffort === "string" ? value.defaultReasoningEffort : "",
    supportedReasoningEfforts: efforts,
  };
}

export function createCodexEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withoutComoteEnvironment(environment);
}

export function buildApprovalResponse(
  method: string,
  params: JsonObject,
  decision: "accept" | "decline" | "cancel",
): JsonObject {
  if (method !== "item/permissions/requestApproval") return { decision };
  const granted: JsonObject = {};
  if (decision === "accept") {
    const requested = (params.permissions ?? {}) as JsonObject;
    if (requested.network != null) granted.network = requested.network;
    if (requested.fileSystem != null) granted.fileSystem = requested.fileSystem;
  }
  return { permissions: granted, scope: "turn" };
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
