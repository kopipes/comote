import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { CodexClient } from "./codex-client.js";
import { EventHub } from "./event-hub.js";
import { gitCommit, gitMergeTask, gitPush, gitStatus } from "./git.js";
import { PasswordStore } from "./password.js";
import { ProjectRegistry, type Project } from "./projects.js";
import { SessionStore, type SessionRecord } from "./session-store.js";
import { WorktreeManager, type ThreadWorkspace } from "./worktrees.js";

declare global {
  namespace Express {
    interface Request {
      comoteSession?: SessionRecord;
      comoteToken?: string;
    }
  }
}

const config = loadConfig();
const sessions = new SessionStore(config.dataDir, config.sessionDays);
const passwords = new PasswordStore(config.dataDir, config.passwordHash);
const projects = new ProjectRegistry(config.projectsRoot);
const worktrees = new WorktreeManager(config.dataDir);
const events = new EventHub();
const codex = new CodexClient(config, events);
const loginAttempts = new Map<string, { count: number; blockedUntil: number }>();
const mergingProjects = new Set<string>();

await Promise.all([sessions.init(), passwords.init(), projects.init(), worktrees.init()]);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "comote" });
});

app.post("/api/login", async (request, response) => {
  const ip = request.ip || request.socket.remoteAddress || "unknown";
  const state = loginAttempts.get(ip);
  if (state && state.blockedUntil > Date.now()) {
    response.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }

  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const deviceName = typeof request.body?.deviceName === "string" ? request.body.deviceName : "Unknown device";
  const valid = await passwords.verify(password);
  if (!valid) {
    const count = (state?.count ?? 0) + 1;
    loginAttempts.set(ip, {
      count,
      blockedUntil: count >= 5 ? Date.now() + 15 * 60_000 : 0,
    });
    response.status(401).json({ error: "Password is incorrect." });
    return;
  }

  loginAttempts.delete(ip);
  const { token, session } = await sessions.create(deviceName);
  setSessionCookie(response, token);
  response.json(sessionPayload(session));
});

app.use("/api", authenticate);

app.get("/api/session", (request, response) => {
  response.json(sessionPayload(request.comoteSession!));
});

app.post("/api/logout", requireCsrf, async (request, response) => {
  await sessions.revoke(request.comoteToken!);
  clearSessionCookie(response);
  response.status(204).end();
});

app.post("/api/password", requireCsrf, async (request, response) => {
  const currentPassword = typeof request.body?.currentPassword === "string" ? request.body.currentPassword : "";
  const newPassword = typeof request.body?.newPassword === "string" ? request.body.newPassword : "";
  await passwords.change(currentPassword, newPassword);
  await sessions.revokeAllExcept(request.comoteToken!);
  response.status(204).end();
});

app.get("/api/projects", async (_request, response) => {
  response.json({ projects: await projects.list() });
});

app.post("/api/projects", requireCsrf, async (request, response) => {
  const mode = String(request.body?.mode ?? "");
  const name = typeof request.body?.name === "string" ? request.body.name : "";
  if (mode === "create") {
    response.status(201).json({ project: await projects.create(name) });
    return;
  }
  if (mode === "import") {
    const repositoryUrl = typeof request.body?.repositoryUrl === "string" ? request.body.repositoryUrl : "";
    response.status(201).json({ project: await projects.importGithub(repositoryUrl, name) });
    return;
  }
  response.status(400).json({ error: "Mode must be create or import." });
});

app.get("/api/projects/:projectId/settings", async (request, response) => {
  response.json(await projects.settings(param(request, "projectId")));
});

app.post("/api/projects/:projectId/settings/remote", requireCsrf, async (request, response) => {
  const repositoryUrl = typeof request.body?.repositoryUrl === "string" ? request.body.repositoryUrl : "";
  response.json(await projects.setGithubRemote(param(request, "projectId"), repositoryUrl));
});

app.get("/api/projects/:projectId/threads", async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threads = (await codex.listThreads(worktrees.pathsForProject(project)))
    .filter((thread) => worktrees.belongsToProject(project, String(thread.id ?? ""), thread.cwd));
  response.json({ threads });
});

app.post("/api/projects/:projectId/threads", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const prepared = await worktrees.prepare(project);
  try {
    const thread = await codex.startThread(prepared.path);
    const threadId = typeof thread.id === "string" ? thread.id : "";
    if (!threadId) throw new Error("Invalid thread returned by Codex.");
    await worktrees.attach(prepared, threadId);
    response.status(201).json({ thread });
  } catch (error) {
    await worktrees.abort(project, prepared);
    throw error;
  }
});

app.get("/api/projects/:projectId/threads/:threadId", async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const { thread } = await resolveThread(project, param(request, "threadId"), true);
  response.json({ thread });
});

app.post("/api/projects/:projectId/threads/:threadId/messages", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = param(request, "threadId");
  const { workspace } = await resolveThread(project, threadId);
  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
  if (!text || text.length > 20_000) {
    response.status(400).json({ error: "Message must be 1–20,000 characters." });
    return;
  }
  const turn = await codex.startTurn(
    threadId,
    workspace.path,
    text,
    request.comoteSession!.deviceName,
    workspace.writableRoots,
  );
  response.status(202).json({ turn });
});

app.post("/api/projects/:projectId/threads/:threadId/interrupt", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = param(request, "threadId");
  await resolveThread(project, threadId);
  await codex.interrupt(threadId);
  response.status(204).end();
});

app.get("/api/projects/:projectId/threads/:threadId/events", async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = param(request, "threadId");
  await resolveThread(project, threadId);
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();

  for (const event of events.recent(threadId)) writeSse(response, event);
  const unsubscribe = events.subscribe(threadId, (event) => writeSse(response, event));
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.post("/api/projects/:projectId/threads/:threadId/approvals/:requestId", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = param(request, "threadId");
  await resolveThread(project, threadId);
  const allowed = new Set(["accept", "decline", "cancel"]);
  const decision = String(request.body?.decision);
  if (!allowed.has(decision)) {
    response.status(400).json({ error: "Invalid approval decision." });
    return;
  }
  await codex.resolveApproval(
    param(request, "requestId"),
    threadId,
    decision as "accept" | "decline" | "cancel",
  );
  response.status(204).end();
});

app.get("/api/projects/:projectId/git", async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = queryString(request, "threadId");
  const workspace = threadId ? (await resolveThread(project, threadId)).workspace : await worktrees.forThread(project);
  response.json({ ...await gitStatus(workspace.path), isolated: workspace.isolated, baseBranch: workspace.baseBranch });
});

app.post("/api/projects/:projectId/git/commit", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  const workspace = threadId ? (await resolveThread(project, threadId)).workspace : await worktrees.forThread(project);
  const sha = await gitCommit(
    workspace.path,
    String(request.body?.message ?? ""),
    request.comoteSession!.deviceName,
    threadId || "manual",
  );
  response.status(201).json({ sha });
});

app.post("/api/projects/:projectId/git/push", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  const workspace = threadId ? (await resolveThread(project, threadId)).workspace : await worktrees.forThread(project);
  response.json({ output: await gitPush(workspace.path) });
});

app.post("/api/projects/:projectId/git/merge", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  if (!threadId) throw new Error("Invalid thread id.");
  const { workspace } = await resolveThread(project, threadId);
  const record = worktrees.recordForThread(project, threadId);
  if (!record || !workspace.isolated) throw new Error("Only an isolated task can be merged.");
  if (mergingProjects.has(project.id)) throw new Error("A merge is already in progress for this project.");
  mergingProjects.add(project.id);
  try {
    const sha = await gitMergeTask(
      project.path,
      workspace.path,
      record.baseBranch,
      record.branch,
      request.comoteSession!.deviceName,
      threadId,
    );
    response.json({ sha, branch: record.baseBranch });
  } finally {
    mergingProjects.delete(project.id);
  }
});

if (config.production) {
  const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client");
  app.use(express.static(clientDir, {
    fallthrough: true,
    maxAge: "1y",
    immutable: true,
    setHeaders(response, filePath) {
      if (!filePath.includes(`${path.sep}assets${path.sep}`)) response.setHeader("Cache-Control", "no-cache");
    },
  }));
  app.use((request, response, next) => {
    if (request.method === "GET" && request.accepts("html")) {
      response.sendFile(path.join(clientDir, "index.html"), { headers: { "Cache-Control": "no-cache" } });
      return;
    }
    next();
  });
}

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected error.";
  console.error(error);
  const status = message.includes("not found") ? 404
    : message.includes("already exists") || message.includes("already in progress") ? 409
      : message === "Current password is incorrect." ? 401
        : message.startsWith("Invalid") || message.startsWith("Password must") || message.startsWith("New password must") || message.startsWith("Commit message must") || message.startsWith("Only an isolated") ? 400
          : message.startsWith("Canonical workspace") || message.startsWith("Task worktree") || message.startsWith("Task or canonical") ? 409
        : message.startsWith("Git operation failed") ? 502
          : 500;
  response.status(status).json({ error: message });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Comote listening on http://${config.host}:${config.port}`);
});

function sessionPayload(session: SessionRecord) {
  return {
    authenticated: true,
    csrf: session.csrf,
    deviceName: session.deviceName,
    expiresAt: session.expiresAt,
  };
}

async function authenticate(request: Request, response: Response, next: NextFunction): Promise<void> {
  const token = parseCookies(request.headers.cookie ?? "").comote_session;
  const session = token ? await sessions.get(token) : null;
  if (!token || !session) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }
  request.comoteSession = session;
  request.comoteToken = token;
  next();
}

function requireCsrf(request: Request, response: Response, next: NextFunction): void {
  const supplied = String(request.headers["x-comote-csrf"] ?? "");
  if (!sessions.csrfMatches(request.comoteSession!, supplied)) {
    response.status(403).json({ error: "Invalid CSRF token." });
    return;
  }
  next();
}

function parseCookies(value: string): Record<string, string> {
  return Object.fromEntries(value.split(";").map((item) => {
    const index = item.indexOf("=");
    if (index < 0) return ["", ""];
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1))];
  }).filter(([key]) => key));
}

function param(request: Request, key: string): string {
  const value = request.params[key];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function queryString(request: Request, key: string): string {
  const value = request.query[key];
  return typeof value === "string" ? value : "";
}

function setSessionCookie(response: Response, token: string): void {
  response.cookie("comote_session", token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "strict",
    path: "/",
    maxAge: config.sessionDays * 86_400_000,
  });
}

function clearSessionCookie(response: Response): void {
  response.clearCookie("comote_session", {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "strict",
    path: "/",
  });
}

async function resolveThread(project: Project, threadId: string, includeTurns = false): Promise<{ thread: Record<string, unknown>; workspace: ThreadWorkspace }> {
  const thread = await codex.readThread(threadId, includeTurns).catch(async (error: Error) => {
    if (includeTurns && error.message.includes("not materialized yet")) return codex.readThread(threadId, false);
    throw error;
  });
  if (!worktrees.belongsToProject(project, threadId, thread.cwd)) throw new Error("Thread does not belong to this project.");
  return { thread, workspace: await worktrees.forThread(project, threadId) };
}

function writeSse(response: Response, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function shutdown(): void {
  codex.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
