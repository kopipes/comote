import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { CodexClient } from "./codex-client.js";
import { DeploymentManager } from "./deployment.js";
import { EventHub } from "./event-hub.js";
import { gitCommit, gitMergeTask, gitPush, gitStatus } from "./git.js";
import { PasswordStore } from "./password.js";
import { OtpStore } from "./otp.js";
import { PingClient } from "./ping.js";
import { PreviewManager } from "./preview.js";
import { ProjectRegistry, type Project } from "./projects.js";
import { SessionStore, type SessionRecord } from "./session-store.js";
import { WorktreeManager, type ThreadWorkspace } from "./worktrees.js";
import { ThreadModelStore } from "./thread-models.js";

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
const otp = new OtpStore();
const ping = new PingClient(config.pingWebhookUrl, config.pingWebhookToken, config.otpEmail);
const projects = new ProjectRegistry(config.projectsRoot);
const worktrees = new WorktreeManager(config.dataDir);
const previews = new PreviewManager(config.previewPort, config.previewUrl);
const deployments = new DeploymentManager(config.dataDir, config.deployDomain, config.deploySocket);
const events = new EventHub();
const codex = new CodexClient(config, events);
const threadModels = new ThreadModelStore(config.dataDir);
const loginAttempts = new Map<string, { count: number; blockedUntil: number }>();
const mergingProjects = new Set<string>();

await Promise.all([sessions.init(), passwords.init(), projects.init(), worktrees.init(), deployments.init(), threadModels.init()]);

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

app.get("/api/login/config", (_request, response) => {
  response.json({ otpEnabled: ping.enabled, destination: ping.enabled ? ping.maskedDestination : "" });
});

app.post("/api/login/otp/request", async (request, response) => {
  if (!ping.enabled) throw new Error("Ping OTP is not configured.");
  const deviceName = typeof request.body?.deviceName === "string" ? request.body.deviceName : "Unknown device";
  const challenge = otp.create(clientIp(request), deviceName);
  try {
    await ping.sendOtp(challenge.code, deviceName);
  } catch (error) {
    otp.discard(challenge.challengeId);
    throw error;
  }
  response.status(202).json({
    challengeId: challenge.challengeId,
    expiresAt: challenge.expiresAt,
    resendAfterSeconds: challenge.resendAfterSeconds,
  });
});

app.post("/api/login/otp/verify", async (request, response) => {
  if (!ping.enabled) throw new Error("Ping OTP is not configured.");
  const challengeId = typeof request.body?.challengeId === "string" ? request.body.challengeId : "";
  const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
  const verified = otp.verify(challengeId, code, clientIp(request));
  const { token, session } = await sessions.create(verified.deviceName);
  setSessionCookie(response, token);
  response.json(sessionPayload(session));
});

app.post("/api/login", async (request, response) => {
  const ip = clientIp(request);
  let state = loginAttempts.get(ip);
  if (state && state.blockedUntil > Date.now()) {
    response.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }
  if (state?.blockedUntil) {
    loginAttempts.delete(ip);
    state = undefined;
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
  if (ping.enabled) {
    void ping.notifyPasswordLogin(session.deviceName)
      .catch((error: Error) => console.error(`Could not send Ping password-login notice: ${error.message}`));
  }
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

app.get("/api/models", async (_request, response) => {
  response.json({ models: await codex.listModels() });
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
  const archived = queryString(request, "archived") === "true";
  const threads = (await codex.listThreads(worktrees.pathsForProject(project), archived))
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

app.get("/api/projects/:projectId/threads/:threadId/model", async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = param(request, "threadId");
  await resolveThread(project, threadId);
  response.json({ model: threadModels.get(threadId) });
});

app.post("/api/projects/:projectId/threads/:threadId/model", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = param(request, "threadId");
  await resolveThread(project, threadId);
  const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
  if (model) {
    const available = await codex.listModels();
    if (!available.some((candidate) => candidate.model === model)) {
      response.status(400).json({ error: "Invalid or unavailable Codex model." });
      return;
    }
  }
  await threadModels.set(threadId, model);
  response.json({ model });
});

app.post("/api/projects/:projectId/threads/:threadId/archive", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = param(request, "threadId");
  await resolveThread(project, threadId);
  await codex.archiveThread(threadId);
  response.status(204).end();
});

app.post("/api/projects/:projectId/threads/:threadId/unarchive", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = param(request, "threadId");
  await resolveThread(project, threadId);
  await codex.unarchiveThread(threadId);
  response.status(204).end();
});

app.post("/api/projects/:projectId/threads/:threadId/delete", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = param(request, "threadId");
  await resolveThread(project, threadId);
  await worktrees.assertRemovable(project, threadId);
  if (previews.status(project, threadId).selected) await previews.stop();
  await codex.deleteThread(threadId);
  await worktrees.remove(project, threadId);
  await threadModels.remove(threadId);
  response.status(204).end();
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
    threadModels.get(threadId),
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

app.get("/api/projects/:projectId/preview", async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const threadId = queryString(request, "threadId");
  if (threadId) await resolveThread(project, threadId);
  response.json(previews.status(project, threadId));
});

app.post("/api/projects/:projectId/preview/start", requireCsrf, async (request, response) => {
  if (!config.previewUrl) throw new Error("Preview is not configured on this server.");
  const project = await projects.get(param(request, "projectId"));
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  if (!threadId) throw new Error("Invalid thread id.");
  const { workspace } = await resolveThread(project, threadId);
  response.json(await previews.start(project, threadId, workspace));
});

app.post("/api/projects/:projectId/preview/stop", requireCsrf, async (request, response) => {
  await projects.get(param(request, "projectId"));
  await previews.stop();
  response.status(204).end();
});

app.get("/api/projects/:projectId/deployment", async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  response.json(await deployments.describe(project));
});

app.post("/api/projects/:projectId/deployment/secrets", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const slug = typeof request.body?.slug === "string" ? request.body.slug : "";
  response.json(await deployments.configure(project, slug, request.body?.secrets, request.body?.removeSecrets));
});

app.post("/api/projects/:projectId/deployment/start", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  const slug = typeof request.body?.slug === "string" ? request.body.slug : "";
  response.status(202).json(deployments.start(project, slug));
});

app.post("/api/projects/:projectId/deployment/rollback", requireCsrf, async (request, response) => {
  const project = await projects.get(param(request, "projectId"));
  response.status(202).json(deployments.rollback(project));
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
  const status = errorStatus(message);
  if (status >= 500) console.error(error);
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

function clientIp(request: Request): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

function errorStatus(message: string): number {
  if (message.includes("not found")) return 404;
  if (message.includes("already exists") || message.includes("already in progress")) return 409;
  if (message === "OTP is invalid or expired." || message === "Current password is incorrect.") return 401;
  if (message.startsWith("Wait before requesting another OTP") || message.startsWith("OTP requests are temporarily limited")) return 429;
  if (message.startsWith("Ping OTP is not configured") || message.startsWith("Preview is not configured") || message.startsWith("Production deployment is not configured")) return 503;
  if (message.startsWith("Ping OTP delivery") || message.startsWith("Preview process exited") || message.startsWith("Preview did not become ready") || message.startsWith("Git operation failed")) return 502;
  if (message.startsWith("A deployment is already in progress") || message.startsWith("Canonical workspace") || message.startsWith("Task worktree") || message.startsWith("Task or canonical") || message.startsWith("Session has")) return 409;
  if (message.startsWith("Invalid") || message.startsWith("Password must") || message.startsWith("New password must") || message.startsWith("Commit message must") || message.startsWith("Only an isolated") || message.startsWith("No previous production") || message.startsWith("Preview currently supports") || message.startsWith("Dependencies are not installed") || message.startsWith("No dev or start script") || message.startsWith("Missing required production secrets") || message.includes("comote.deploy.json") || message.startsWith("Deployment needs")) return 400;
  return 500;
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
    if (includeTurns && error.message.includes("list_turns is not supported yet")) {
      return { ...await codex.readThread(threadId, false), historyUnavailable: true };
    }
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
  void previews.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
