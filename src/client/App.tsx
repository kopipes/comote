import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { api, type AccountUsage, type AccountUsageWindow, type Attachment, type CodexModel, type DeploymentState, type GitState, type LiveEvent, type NotificationPreferences, type PreviewState, type Project, type Session, type Thread, type ThreadContextUsage, type ThreadItem } from "./api";
import { CheckPanel } from "./CheckPanel";
import { CodeIndexPanel } from "./CodeIndexPanel";
import { Composer, draftStorageKey } from "./Composer";
import { buildConversationTimeline, retainPendingApprovals, type ActivityItem, type Approval, type ChatMessage } from "./conversation";
import { gitWorkflowState, type WorkflowStep } from "./git-workflow";
import { applyTheme, readThemePreference, resolveTheme, saveThemePreference, type ThemePreference } from "./theme";

type AuthState = Session | null | undefined;

export default function App() {
  const [session, setSession] = useState<AuthState>(undefined);
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);

  useEffect(() => {
    saveThemePreference(theme);
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme("system");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);

  useEffect(() => {
    api.get<Session>("/api/session")
      .then((value) => {
        api.setCsrf(value.csrf);
        setSession(value);
      })
      .catch(() => setSession(null));
  }, []);

  if (session === undefined) return <Splash />;
  if (session === null) return <Login theme={theme} onThemeChange={setTheme} onAuthenticated={setSession} />;
  return <Workspace session={session} theme={theme} onThemeChange={setTheme} onLoggedOut={() => setSession(null)} />;
}

function Splash() {
  return (
    <main className="center-screen">
      <Brand />
      <div className="loader" aria-label="Loading" />
    </main>
  );
}

function Login({ theme, onThemeChange, onAuthenticated }: { theme: ThemePreference; onThemeChange: (theme: ThemePreference) => void; onAuthenticated: (session: Session) => void }) {
  const [mode, setMode] = useState<"otp" | "password">("otp");
  const [otpConfig, setOtpConfig] = useState<{ otpEnabled: boolean } | null>(null);
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState(detectDeviceName());
  const [canResend, setCanResend] = useState(false);
  const [resendDelay, setResendDelay] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<{ otpEnabled: boolean }>("/api/login/config")
      .then((config) => {
        setOtpConfig(config);
        if (!config.otpEnabled) setMode("password");
      })
      .catch(() => {
        setOtpConfig({ otpEnabled: false });
        setMode("password");
      });
  }, []);

  useEffect(() => {
    if (!challengeId) return;
    setCanResend(false);
    const timer = window.setTimeout(() => setCanResend(true), resendDelay * 1_000);
    return () => window.clearTimeout(timer);
  }, [challengeId, resendDelay]);

  function authenticated(session: Session) {
    api.setCsrf(session.csrf);
    onAuthenticated(session);
  }

  async function requestOtp(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const challenge = await api.post<{ challengeId: string; expiresAt: string; resendAfterSeconds: number }>("/api/login/otp/request", { deviceName });
      setChallengeId(challenge.challengeId);
      setResendDelay(challenge.resendAfterSeconds);
      setCode("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      authenticated(await api.post<Session>("/api/login/otp/verify", { challengeId, code }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      authenticated(await api.post<Session>("/api/login", { password, deviceName }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <ThemeButton theme={theme} onThemeChange={onThemeChange} className="login-theme-button" />
      <section className="login-copy">
        <Brand large />
        <h1>Your development machine, wherever you are.</h1>
        <p>Talk to Codex in natural language. Review every change. Keep one continuous workspace across phone and laptop.</p>
        <div className="trust-row">
          <span>Private network</span>
          <span>Approval first</span>
          <span>No exposed terminal</span>
        </div>
      </section>
      <section className="login-card">
        <p className="eyebrow">Private access</p>
        <h2>{mode === "password" ? "Use your password" : challengeId ? "Enter your code" : "Sign in with Ping"}</h2>
        <p className="muted">{mode === "password"
          ? "Use the existing Comote password. Ping will notify you after a successful login."
          : challengeId
            ? "We sent a one-time code to Ping."
            : "Receive a one-time code in Ping!"}</p>

        {mode === "otp" && !challengeId && (
          <form onSubmit={requestOtp}>
            <label>
              Device label
              <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={40} autoComplete="nickname" autoFocus />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button className="primary full" disabled={busy || !otpConfig?.otpEnabled}>{busy ? "Sending…" : otpConfig === null ? "Loading Ping…" : "Send OTP to Ping"}</button>
          </form>
        )}

        {mode === "otp" && challengeId && (
          <form onSubmit={verifyOtp}>
            <label>
              6-digit OTP
              <input className="otp-input" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus />
            </label>
            <p className="field-help">The code expires in 5 minutes and works only once.</p>
            {error && <p className="form-error">{error}</p>}
            <button className="primary full" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Verify and open Comote"}</button>
            <button className="text-button login-switch" type="button" disabled={busy || !canResend} onClick={() => void requestOtp()}>{canResend ? "Send a new code" : `You can resend after ${resendDelay} seconds`}</button>
          </form>
        )}

        {mode === "password" && (
          <form onSubmit={submitPassword}>
            <label>
              Device label
              <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={40} autoComplete="nickname" />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button className="primary full" disabled={busy || password.length < 1}>{busy ? "Signing in…" : "Open Comote"}</button>
          </form>
        )}

        {otpConfig?.otpEnabled && (
          <button className="text-button login-switch login-method-switch" type="button" disabled={busy} onClick={() => {
            setMode((current) => current === "otp" ? "password" : "otp");
            setError("");
          }}>{mode === "otp" ? "Use password instead" : "Use Ping OTP instead"}</button>
        )}
        <p className="secure-note"><span className="status-dot" /> Protected by Tailscale and an encrypted session.</p>
      </section>
    </main>
  );
}

function Workspace({ session, theme, onThemeChange, onLoggedOut }: { session: Session; theme: ThemePreference; onThemeChange: (theme: ThemePreference) => void; onLoggedOut: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelBusy, setModelBusy] = useState(false);
  const [contextUsage, setContextUsage] = useState<ThreadContextUsage | null>(null);
  const [accountUsage, setAccountUsage] = useState<AccountUsage | null>(null);
  const [accountUsageUnavailable, setAccountUsageUnavailable] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [continuityNotice, setContinuityNotice] = useState("");
  const [git, setGit] = useState<GitState | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [managingSession, setManagingSession] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState("");
  const [mobilePanel, setMobilePanel] = useState<"projects" | "chat" | "changes">("chat");
  const [desktopNavigationView, setDesktopNavigationView] = useState<"projects" | "threads">("projects");
  const [connectionState, setConnectionState] = useState<"idle" | "connecting" | "connected" | "reconnecting">("idle");
  const streamRef = useRef<EventSource | null>(null);
  const seenEventIdsRef = useRef(new Set<string>());
  const gitRequestRef = useRef(0);
  const modelRequestRef = useRef(0);
  const feedOrderRef = useRef(0);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const followConversationRef = useRef(true);

  const conversationTimeline = useMemo(
    () => buildConversationTimeline(messages, activities, approvals),
    [messages, activities, approvals],
  );

  useEffect(() => {
    if (!followConversationRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const container = messageScrollRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversationTimeline, running]);

  function nextFeedOrder(): number {
    feedOrderRef.current += 1;
    return feedOrderRef.current;
  }

  function chooseProject(selected: Project) {
    setProject(selected);
    setDesktopNavigationView("threads");
  }

  function trackConversationScroll() {
    const container = messageScrollRef.current;
    if (!container) return;
    followConversationRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  }

  useEffect(() => {
    api.get<{ projects: Project[] }>("/api/projects")
      .then(({ projects }) => {
        setProjects(projects);
        if (projects[0]) setProject(projects[0]);
      })
      .catch((cause) => setError((cause as Error).message));
  }, []);

  useEffect(() => {
    api.get<{ models: CodexModel[] }>("/api/models")
      .then(({ models }) => setModels(models))
      .catch((cause) => setError((cause as Error).message))
      .finally(() => setModelsLoading(false));
  }, []);

  const refreshAccountUsage = useCallback(async () => {
    try {
      const { usage } = await api.get<{ usage: AccountUsage }>("/api/usage");
      setAccountUsage(usage);
      setAccountUsageUnavailable(false);
    } catch {
      setAccountUsageUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void refreshAccountUsage();
    const timer = window.setInterval(() => void refreshAccountUsage(), 60_000);
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void refreshAccountUsage();
    };
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [refreshAccountUsage]);

  const refreshGit = useCallback(async () => {
    const requestId = ++gitRequestRef.current;
    if (!project) {
      setGit(null);
      return;
    }
    try {
      const query = thread ? `?threadId=${encodeURIComponent(thread.id)}` : "";
      const next = await api.get<GitState>(`/api/projects/${project.id}/git${query}`);
      if (requestId === gitRequestRef.current) setGit(next);
    } catch (cause) {
      if (requestId === gitRequestRef.current) setError((cause as Error).message);
    }
  }, [project, thread]);

  useEffect(() => {
    if (!project) return;
    setThread(null);
    setMessages([]);
    setActivities([]);
    setApprovals([]);
    feedOrderRef.current = 0;
    followConversationRef.current = true;
    setContextUsage(null);
    setCompacting(false);
    setContinuityNotice("");
    setRunning(false);
    setError("");
    const query = showArchived ? "?archived=true" : "";
    api.get<{ threads: Thread[] }>(`/api/projects/${project.id}/threads${query}`)
      .then(({ threads }) => setThreads(threads))
      .catch((cause) => setError((cause as Error).message));
  }, [project?.id, showArchived]);

  useEffect(() => {
    const requestId = ++modelRequestRef.current;
    setSelectedModel("");
    if (!project || !thread) return;
    setModelBusy(true);
    api.get<{ model: string }>(`/api/projects/${project.id}/threads/${thread.id}/model`)
      .then(({ model }) => {
        if (requestId === modelRequestRef.current) setSelectedModel(model);
      })
      .catch((cause) => {
        if (requestId === modelRequestRef.current) setError((cause as Error).message);
      })
      .finally(() => {
        if (requestId === modelRequestRef.current) setModelBusy(false);
      });
  }, [project?.id, thread?.id]);

  useEffect(() => {
    setContextUsage(null);
    if (!project || !thread) return;
    let current = true;
    api.get<{ usage: ThreadContextUsage | null }>(`/api/projects/${project.id}/threads/${thread.id}/context`)
      .then(({ usage }) => {
        if (current) setContextUsage(usage);
      })
      .catch((cause) => {
        if (current) setError((cause as Error).message);
      });
    return () => { current = false; };
  }, [project?.id, thread?.id]);

  useEffect(() => {
    void refreshGit();
  }, [refreshGit]);

  useEffect(() => {
    streamRef.current?.close();
    seenEventIdsRef.current.clear();
    if (!project || !thread) {
      setConnectionState("idle");
      return;
    }
    setConnectionState("connecting");
    const stream = new EventSource(`/api/projects/${project.id}/threads/${thread.id}/events`);
    streamRef.current = stream;
    stream.onopen = () => setConnectionState("connected");
    stream.onmessage = (event) => {
      const parsed = JSON.parse(event.data) as LiveEvent;
      if (seenEventIdsRef.current.has(parsed.id)) return;
      seenEventIdsRef.current.add(parsed.id);
      applyLiveEvent(parsed);
    };
    stream.onerror = () => setConnectionState("reconnecting");
    return () => stream.close();
  }, [project, thread?.id]);

  function applyLiveEvent(event: LiveEvent) {
    if (event.type === "assistant_delta") {
      const id = String(event.payload.itemId ?? "assistant-live");
      const delta = String(event.payload.text ?? "");
      const order = nextFeedOrder();
      setMessages((current) => upsertDelta(current, id, delta, order));
    } else if (event.type === "item_started" || event.type === "item_completed") {
      const item = event.payload.item as ThreadItem | undefined;
      if (!item) return;
      if (item.type === "contextCompaction") {
        setCompacting(event.type === "item_started");
        if (event.type === "item_completed") setContinuityNotice("Session context compacted successfully. You can continue in the same session.");
      }
      if (item.type === "agentMessage" && event.type === "item_completed") {
        const order = nextFeedOrder();
        setMessages((current) => upsertMessage(current, { id: item.id, role: "assistant", text: item.text ?? "", phase: item.phase, order }));
      }
      if (item.type === "commandExecution" || item.type === "fileChange") {
        const order = nextFeedOrder();
        setActivities((current) => upsertActivity(current, item, order));
        if (event.type === "item_completed") void refreshGit();
      }
    } else if (event.type === "approval") {
      const order = nextFeedOrder();
      setApprovals((current) => {
        const requestId = String(event.payload.requestId);
        const existing = current.find((item) => item.requestId === requestId);
        return [...current.filter((item) => item.requestId !== requestId), {
          requestId,
          reason: String(event.payload.reason ?? "Codex needs approval."),
          command: event.payload.command ? String(event.payload.command) : undefined,
          cwd: event.payload.cwd ? String(event.payload.cwd) : undefined,
          order: existing?.order ?? order,
        }];
      });
    } else if (event.type === "approval_resolved") {
      const requestId = String(event.payload.requestId ?? "");
      setApprovals((current) => current.filter((item) => item.requestId !== requestId));
    } else if (event.type === "approval_sync") {
      const requestIds = Array.isArray(event.payload.requestIds)
        ? event.payload.requestIds.filter((value): value is string => typeof value === "string")
        : [];
      setApprovals((current) => retainPendingApprovals(current, requestIds));
      setError((current) => current === "Approval request is no longer pending." ? "" : current);
    } else if (event.type === "status") {
      const method = String(event.payload.method ?? "");
      if (method === "turn/started") setRunning(true);
      if (method === "turn/completed") {
        setRunning(false);
        setCompacting(false);
        void refreshGit();
        void refreshAccountUsage();
      }
    } else if (event.type === "context_usage") {
      const usage = event.payload.usage as ThreadContextUsage | undefined;
      if (usage) setContextUsage(usage);
    } else if (event.type === "error") {
      setRunning(false);
      setCompacting(false);
      setError(String(event.payload.message ?? "Codex encountered an error."));
    }
  }

  async function selectThread(selected: Thread) {
    if (!project) return;
    setBusy(true);
    setError("");
    try {
      const { thread } = await api.get<{ thread: Thread }>(`/api/projects/${project.id}/threads/${selected.id}`);
      setThread(thread);
      const extracted = extractHistory(thread);
      setMessages(extracted.messages);
      setActivities(extracted.activities);
      setApprovals([]);
      feedOrderRef.current = extracted.lastOrder;
      followConversationRef.current = true;
      setContextUsage(null);
      setCompacting(false);
      setContinuityNotice("");
      setRunning(thread.status?.type === "active");
      setMobilePanel("chat");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function newThread() {
    if (!project) return;
    setBusy(true);
    setError("");
    try {
      const { thread } = await api.post<{ thread: Thread }>(`/api/projects/${project.id}/threads`);
      setThreads((current) => [thread, ...current]);
      setThread(thread);
      setMessages([]);
      setActivities([]);
      setApprovals([]);
      feedOrderRef.current = 0;
      followConversationRef.current = true;
      setContextUsage(null);
      setCompacting(false);
      setContinuityNotice("");
      setRunning(false);
      setMobilePanel("chat");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(text: string, attachments: Attachment[] = []): Promise<boolean> {
    if (!project || !thread) return false;
    const optimisticId = `local-${Date.now()}`;
    const displayText = attachments.length ? `${text}\n\nAttached: ${attachments.map((attachment) => attachment.name).join(", ")}` : text;
    followConversationRef.current = true;
    const order = nextFeedOrder();
    setMessages((current) => [...current, { id: optimisticId, role: "user", text: displayText, order }]);
    setRunning(true);
    setError("");
    try {
      await api.post(`/api/projects/${project.id}/threads/${thread.id}/messages`, { text, attachments: attachments.map((attachment) => attachment.id) });
      return true;
    } catch (cause) {
      setRunning(false);
      setError((cause as Error).message);
      return false;
    }
  }

  async function askCodexFromChanges(text: string): Promise<boolean> {
    const sent = await sendMessage(text);
    if (sent) setMobilePanel("chat");
    return sent;
  }

  async function chooseModel(model: string) {
    if (!project || !thread) return;
    const previous = selectedModel;
    setSelectedModel(model);
    setModelBusy(true);
    setError("");
    try {
      const saved = await api.post<{ model: string }>(`/api/projects/${project.id}/threads/${thread.id}/model`, { model });
      setSelectedModel(saved.model);
    } catch (cause) {
      setSelectedModel(previous);
      setError((cause as Error).message);
    } finally {
      setModelBusy(false);
    }
  }

  async function decide(approval: Approval, decision: "accept" | "decline") {
    if (!project || !thread) return;
    try {
      await api.post(`/api/projects/${project.id}/threads/${thread.id}/approvals/${approval.requestId}`, { decision });
      setApprovals((current) => current.filter((item) => item.requestId !== approval.requestId));
    } catch (cause) {
      const message = (cause as Error).message;
      if (message === "Approval request is no longer pending.") {
        setApprovals((current) => current.filter((item) => item.requestId !== approval.requestId));
        setContinuityNotice("That approval had expired and was removed. Pending approvals are now synchronized with Codex.");
      } else {
        setError(message);
      }
    }
  }

  async function logout() {
    await api.post("/api/logout");
    streamRef.current?.close();
    onLoggedOut();
  }

  function projectAdded(next: Project) {
    setProjects((current) => [...current.filter((item) => item.id !== next.id), next]
      .sort((a, b) => a.name.localeCompare(b.name)));
    setProject(next);
    setDesktopNavigationView("threads");
    setAddingProject(false);
    setMobilePanel("chat");
  }

  function sessionRemoved(threadId: string) {
    streamRef.current?.close();
    setThreads((current) => current.filter((item) => item.id !== threadId));
    setThread(null);
    setMessages([]);
    setActivities([]);
    setApprovals([]);
    feedOrderRef.current = 0;
    followConversationRef.current = true;
    setContextUsage(null);
    setCompacting(false);
    setContinuityNotice("");
    setRunning(false);
    setGit(null);
    setManagingSession(false);
  }

  function sessionCompacted() {
    setManagingSession(false);
    setCompacting(false);
    setRunning(false);
    setContinuityNotice("Session context compacted successfully. You can continue in the same session.");
  }

  function sessionContinued(next: Thread) {
    const previousId = thread?.id;
    streamRef.current?.close();
    setThreads((current) => [next, ...current.filter((item) => item.id !== previousId && item.id !== next.id)]);
    setThread(next);
    setMessages([]);
    setActivities([]);
    setApprovals([]);
    feedOrderRef.current = 0;
    followConversationRef.current = true;
    setContextUsage(null);
    setCompacting(false);
    setContinuityNotice("Handoff complete. This fresh session is using the same task branch and files.");
    setRunning(true);
    setManagingSession(false);
    setMobilePanel("chat");
  }

  return (
    <div className="app-shell" data-panel={mobilePanel} data-navigation={desktopNavigationView}>
      <header className="topbar">
        <Brand />
        <div className="topbar-meta">
          <span className="private-badge"><span className="status-dot" /> Private</span>
          <span className="device-name">{session.deviceName}</span>
          <a className="icon-button" href="https://guide.apps.devop.my.id/" target="_blank" rel="noreferrer" title="Guide" aria-label="Open Comote guide">?</a>
          <ThemeButton theme={theme} onThemeChange={onThemeChange} />
          <button className="icon-button" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings">⚙</button>
          <button className="icon-button" onClick={logout} title="Sign out" aria-label="Sign out">↗</button>
        </div>
      </header>

      <aside className="desktop-navigation-pane">
        {desktopNavigationView === "projects" ? (
          <>
            <div className="pane-heading">
              <span>Projects <span className="count">{projects.length}</span></span>
              <button className="new-button" onClick={() => setAddingProject(true)}>＋ Add</button>
            </div>
            <div className="project-list">
              {projects.map((item) => (
                <button key={item.id} className={`project-row ${project?.id === item.id ? "active" : ""}`} onClick={() => chooseProject(item)}>
                  <span className="project-avatar">{item.name.slice(0, 2).toUpperCase()}</span>
                  <span><strong>{item.name}</strong><small>VPS workspace</small></span>
                </button>
              ))}
              {!projects.length && <EmptySmall text="No Git projects found in the workspace root." />}
            </div>
          </>
        ) : (
          <>
            <div className="pane-heading navigation-thread-heading">
              <button className="navigation-back" onClick={() => setDesktopNavigationView("projects")} aria-label="Back to projects">←</button>
              <span>{showArchived ? "Archived" : project?.name ?? "Sessions"}</span>
              <div className="pane-actions">
                <button className="text-button" onClick={() => setShowArchived((current) => !current)} disabled={!project || busy}>{showArchived ? "Active" : "Archived"}</button>
                {!showArchived && <button className="new-button" onClick={newThread} disabled={!project || busy}>＋ New</button>}
              </div>
            </div>
            <div className="thread-list">
              {threads.map((item) => (
                <button key={item.id} className={`thread-row ${thread?.id === item.id ? "active" : ""}`} onClick={() => selectThread(item)}>
                  <strong>{item.name || item.preview || "New session"}</strong>
                  <small>{formatRelative(item.updatedAt ?? item.createdAt)}</small>
                </button>
              ))}
              {project && !threads.length && <EmptySmall text={showArchived ? "No archived sessions." : "Start a session and describe what you want to build."} />}
            </div>
          </>
        )}
      </aside>

      <aside className="projects-pane">
        <div className="pane-heading">
          <span>Projects <span className="count">{projects.length}</span></span>
          <button className="new-button" onClick={() => setAddingProject(true)}>＋ Add</button>
        </div>
        <div className="project-list">
          {projects.map((item) => (
            <button key={item.id} className={`project-row ${project?.id === item.id ? "active" : ""}`} onClick={() => chooseProject(item)}>
              <span className="project-avatar">{item.name.slice(0, 2).toUpperCase()}</span>
              <span><strong>{item.name}</strong><small>VPS workspace</small></span>
            </button>
          ))}
          {!projects.length && <EmptySmall text="No Git projects found in the workspace root." />}
        </div>
      </aside>

      <aside className="threads-pane">
        <div className="pane-heading navigation-thread-heading">
          <button className="navigation-back" onClick={() => setDesktopNavigationView("projects")} aria-label="Back to projects">←</button>
          <span>{showArchived ? "Archived" : project?.name ?? "Sessions"}</span>
          <div className="pane-actions">
            <button className="text-button" onClick={() => setShowArchived((current) => !current)} disabled={!project || busy}>{showArchived ? "Active" : "Archived"}</button>
            {!showArchived && <button className="new-button" onClick={newThread} disabled={!project || busy}>＋ New</button>}
          </div>
        </div>
        <div className="thread-list">
          {threads.map((item) => (
            <button key={item.id} className={`thread-row ${thread?.id === item.id ? "active" : ""}`} onClick={() => selectThread(item)}>
              <strong>{item.name || item.preview || "New session"}</strong>
              <small>{formatRelative(item.updatedAt ?? item.createdAt)}</small>
            </button>
          ))}
          {project && !threads.length && <EmptySmall text={showArchived ? "No archived sessions." : "Start a session and describe what you want to build."} />}
        </div>
      </aside>

      <main className="conversation-pane">
        {error && <button className="error-banner" onClick={() => setError("")}>{error}<span>×</span></button>}
        {!thread ? (
          <EmptyWorkspace hasProject={Boolean(project)} onNew={newThread} onAdd={() => setAddingProject(true)} />
        ) : (
          <>
            <div className="conversation-header">
              <div className="conversation-title"><p className="eyebrow">{project?.name}</p><h2>{thread.name || thread.preview || "New session"}</h2></div>
              <div className="header-controls">
                <div className="run-states">
                  <span className="task-state" title={git?.isolated ? "This session works in a separate Git task branch." : "This session works on the main project branch."}>Branch: {git ? git.isolated ? "task" : "main" : "…"}</span>
                  {connectionState === "reconnecting" && <span className="connection-state">Reconnecting…</span>}
                  <ContextMeter usage={contextUsage} disabled={running || busy} onClick={() => setManagingSession(true)} />
                  <span className={`run-state ${running ? "running" : ""}`}>Codex: {compacting ? "Compacting" : running ? "Working" : "Ready"}</span>
                  <button className="icon-button session-menu-button" onClick={() => setManagingSession(true)} disabled={running || busy} title="Session options" aria-label="Session options">•••</button>
                </div>
                <AccountUsageStrip usage={accountUsage} unavailable={accountUsageUnavailable} />
              </div>
            </div>
            <div className="message-scroll" ref={messageScrollRef} onScroll={trackConversationScroll}>
              {showArchived && <div className="history-notice">This session is archived. Restore it from the session menu before continuing.</div>}
              {continuityNotice && <button className="history-notice continuity-notice" onClick={() => setContinuityNotice("")}>{continuityNotice}<span aria-hidden="true">×</span></button>}
              {thread.historyUnavailable && <div className="history-notice">This session can continue, but its earlier messages cannot be displayed by the current Codex server.</div>}
              {messages.length === 0 && !thread.historyUnavailable && !showArchived && <StarterCards onChoose={sendMessage} />}
              {conversationTimeline.map((block) => {
                if (block.kind === "message") return <MessageBubble key={`message-${block.message.id}`} message={block.message} />;
                if (block.kind === "activity-group") {
                  return block.activities.length === 1
                    ? <ActivityCard key={`activity-${block.activities[0].id}`} activity={block.activities[0]} />
                    : <ActivityGroup key={`activities-${block.activities[0].id}`} activities={block.activities} />;
                }
                return block.approvals.length === 1
                  ? <ApprovalCard key={`approval-${block.approvals[0].requestId}`} approval={block.approvals[0]} onDecision={decide} />
                  : <ApprovalGroup key={`approvals-${block.approvals[0].requestId}`} approvals={block.approvals} onDecision={decide} />;
              })}
              {running && <div className="thinking"><span /><span /><span /> Codex is working</div>}
            </div>
            {!showArchived && <Composer key={draftStorageKey(project!.id, thread.id)} projectId={project!.id} threadId={thread.id} draftKey={draftStorageKey(project!.id, thread.id)} disabled={running} onSend={sendMessage} onError={setError} models={models} selectedModel={selectedModel} modelBusy={modelsLoading || modelBusy} onModelChange={chooseModel} />}
          </>
        )}
      </main>

      <aside className="changes-pane">
        <ChangesPanel project={project} thread={thread} git={git} agentBusy={running} onAskCodex={askCodexFromChanges} onRefresh={() => refreshGit()} onError={setError} />
      </aside>

      <nav className="mobile-nav">
        <button type="button" className={mobilePanel === "projects" ? "active" : ""} aria-current={mobilePanel === "projects" ? "page" : undefined} onClick={() => { setDesktopNavigationView("projects"); setMobilePanel("projects"); }}><span aria-hidden="true">▦</span><strong>Projects</strong></button>
        <button type="button" className={mobilePanel === "chat" ? "active" : ""} aria-current={mobilePanel === "chat" ? "page" : undefined} onClick={() => setMobilePanel("chat")}><span aria-hidden="true">✦</span><strong>Chat</strong></button>
        <button type="button" className={mobilePanel === "changes" ? "active" : ""} aria-current={mobilePanel === "changes" ? "page" : undefined} onClick={() => setMobilePanel("changes")}><span aria-hidden="true">±</span><strong>Changes</strong></button>
      </nav>

      {addingProject && <AddProjectDialog onClose={() => setAddingProject(false)} onCreated={projectAdded} />}
      {settingsOpen && <SettingsDialog project={project} theme={theme} onThemeChange={onThemeChange} onClose={() => setSettingsOpen(false)} />}
      {managingSession && project && thread && (
        <SessionDialog
          project={project}
          thread={thread}
          archived={showArchived}
          contextUsage={contextUsage}
          onClose={() => setManagingSession(false)}
          onRemoved={() => sessionRemoved(thread.id)}
          onCompact={sessionCompacted}
          onHandoff={sessionContinued}
        />
      )}
    </div>
  );
}

function SessionDialog({ project, thread, archived, contextUsage, onClose, onRemoved, onCompact, onHandoff }: { project: Project; thread: Thread; archived: boolean; contextUsage: ThreadContextUsage | null; onClose: () => void; onRemoved: () => void; onCompact: () => void; onHandoff: (thread: Thread) => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<"" | "archive" | "restore" | "delete" | "compact" | "handoff">("");
  const [error, setError] = useState("");
  const title = thread.name || thread.preview || "New session";

  async function archiveSession() {
    setBusy(true);
    setAction("archive");
    setError("");
    try {
      await api.post(`/api/projects/${project.id}/threads/${thread.id}/archive`);
      onRemoved();
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  async function restoreSession() {
    setBusy(true);
    setAction("restore");
    setError("");
    try {
      await api.post(`/api/projects/${project.id}/threads/${thread.id}/unarchive`);
      onRemoved();
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  async function deleteSession() {
    setBusy(true);
    setAction("delete");
    setError("");
    try {
      await api.post(`/api/projects/${project.id}/threads/${thread.id}/delete`);
      onRemoved();
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  async function compactSession() {
    setBusy(true);
    setAction("compact");
    setError("");
    try {
      await api.post(`/api/projects/${project.id}/threads/${thread.id}/compact`);
      onCompact();
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
      setAction("");
    }
  }

  async function continueSession() {
    setBusy(true);
    setAction("handoff");
    setError("");
    try {
      const result = await api.post<{ thread: Thread; summary: string }>(`/api/projects/${project.id}/threads/${thread.id}/continue`);
      onHandoff(result.thread);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
      setAction("");
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="dialog session-dialog" role="dialog" aria-modal="true" aria-labelledby="session-options-title">
        <div className="dialog-header">
          <div><p className="eyebrow">{confirmDelete ? "Permanent action" : "Session"}</p><h2 id="session-options-title">{confirmDelete ? "Delete session?" : title}</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>
        {confirmDelete ? (
          <>
            <p className="dialog-copy">This permanently deletes the Codex conversation and its isolated task workspace. Comote will refuse if there are uncommitted changes or commits that have not been merged.</p>
            {error && <p className="form-error">{error}</p>}
            <div className="dialog-actions">
              <button className="secondary" type="button" onClick={() => { setConfirmDelete(false); setError(""); }} disabled={busy}>Back</button>
              <button className="danger-button" type="button" onClick={deleteSession} disabled={busy}>{action === "delete" ? "Deleting…" : "Delete permanently"}</button>
            </div>
          </>
        ) : (
          <>
            <div className="session-option-list">
              {archived ? (
                <button type="button" onClick={restoreSession} disabled={busy}>
                  <strong>{action === "restore" ? "Restoring…" : "Restore session"}</strong>
                  <span>Return it to the active session list and continue working.</span>
                </button>
              ) : (
                <>
                  <div className={`context-card ${contextTone(contextUsage)}`}>
                    <div><strong>Context usage</strong><span>{contextUsage ? `${contextUsage.percentage}%` : "Waiting for usage data"}</span></div>
                    <div className="context-track" aria-hidden="true"><span style={{ width: `${contextUsage?.percentage ?? 0}%` }} /></div>
                    <small>{contextGuidance(contextUsage)}</small>
                  </div>
                  <button type="button" onClick={compactSession} disabled={busy}>
                    <strong>{action === "compact" ? "Compacting session…" : "Compact current session"}</strong>
                    <span>Compress older context and keep working in this same session, branch, and files.</span>
                  </button>
                  <button type="button" onClick={continueSession} disabled={busy}>
                    <strong>{action === "handoff" ? "Preparing summary and fresh session…" : "Continue in fresh session"}</strong>
                    <span>Create a summary, move to a clean conversation, and keep the exact same task worktree. The old session is archived.</span>
                  </button>
                  <button type="button" onClick={archiveSession} disabled={busy}>
                    <strong>{action === "archive" ? "Archiving…" : "Archive session"}</strong>
                    <span>Hide it from the session list while preserving the conversation and project workspace.</span>
                  </button>
                </>
              )}
              <button className="danger-option" type="button" onClick={() => setConfirmDelete(true)} disabled={busy}>
                <strong>Delete permanently</strong>
                <span>Remove the conversation and its task workspace after a Git safety check.</span>
              </button>
            </div>
            {error && <p className="form-error">{error}</p>}
            <div className="dialog-actions"><button className="secondary" type="button" onClick={onClose} disabled={busy}>Close</button></div>
          </>
        )}
      </section>
    </div>
  );
}

function ContextMeter({ usage, disabled, onClick }: { usage: ThreadContextUsage | null; disabled: boolean; onClick: () => void }) {
  const label = usage ? `Context ${usage.percentage}%` : "Context —";
  return (
    <button className={`context-meter ${contextTone(usage)}`} type="button" disabled={disabled} onClick={onClick} title={`${contextGuidance(usage)} Open session continuity options.`} aria-label={`${label}. ${contextGuidance(usage)}`}>
      <span className="context-meter-ring" style={{ "--context-progress": `${usage?.percentage ?? 0}%` } as CSSProperties} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function AccountUsageStrip({ usage, unavailable }: { usage: AccountUsage | null; unavailable: boolean }) {
  if (!usage || (!usage.fiveHour && !usage.weekly)) {
    const status = unavailable ? "Usage unavailable · retrying" : "Loading usage…";
    return (
      <div className="usage-limits" aria-label="Codex account usage limits">
        <UsageLimitPlaceholder label="5-hour" status={status} />
        <UsageLimitPlaceholder label="Weekly" status={status} />
      </div>
    );
  }
  return (
    <div className="usage-limits" aria-label="Codex account usage limits">
      {usage.ordinaryUsageAllowed === false && <strong className="usage-limit-alert">Usage limit reached</strong>}
      {usage.fiveHour && <UsageLimitCard label="5-hour" window={usage.fiveHour} />}
      {usage.weekly && <UsageLimitCard label="Weekly" window={usage.weekly} />}
    </div>
  );
}

function UsageLimitPlaceholder({ label, status }: { label: string; status: string }) {
  return <div className="usage-limit unknown"><strong>{label}</strong><span>{status}</span></div>;
}

function UsageLimitCard({ label, window }: { label: string; window: AccountUsageWindow }) {
  const tone = window.remainingPercent <= 10 ? "critical" : window.remainingPercent <= 25 ? "watch" : "safe";
  return (
    <div className={`usage-limit ${tone}`} title={`${label} Codex allowance: ${window.remainingPercent}% remaining. ${formatUsageReset(window.resetsAt)}.`}>
      <strong>{label} · {window.remainingPercent}% left</strong>
      <span>{formatUsageReset(window.resetsAt)}</span>
    </div>
  );
}

function formatUsageReset(resetsAt: number | null): string {
  if (!resetsAt) return "Reset time unavailable";
  const date = new Date(resetsAt * 1_000);
  const remainingMinutes = Math.ceil((date.getTime() - Date.now()) / 60_000);
  if (!Number.isFinite(remainingMinutes)) return "Reset time unavailable";
  if (remainingMinutes <= 0) return "Resetting now";
  if (remainingMinutes < 24 * 60) {
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    return `Resets in ${hours ? `${hours}h ` : ""}${minutes}m`;
  }
  return `Resets ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(date)}`;
}

function contextTone(usage: ThreadContextUsage | null): "unknown" | "safe" | "watch" | "high" {
  if (!usage) return "unknown";
  if (usage.percentage >= 85) return "high";
  if (usage.percentage >= 70) return "watch";
  return "safe";
}

function contextGuidance(usage: ThreadContextUsage | null): string {
  if (!usage) return "Usage appears after Codex completes a turn.";
  if (usage.percentage >= 85) return "Context is high. Compact now or continue in a fresh session.";
  if (usage.percentage >= 70) return "Context is growing. Consider compacting after the next milestone.";
  return "Context has comfortable room remaining.";
}

function Brand({ large = false }: { large?: boolean }) {
  return <div className={`brand ${large ? "large" : ""}`}><span className="brand-mark">C</span><span>comote</span></div>;
}

function ThemeButton({ theme, onThemeChange, className = "" }: { theme: ThemePreference; onThemeChange: (theme: ThemePreference) => void; className?: string }) {
  const [prefersDark, setPrefersDark] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setPrefersDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const isLight = resolveTheme(theme, prefersDark) === "light";
  return (
    <button className={`icon-button theme-button ${className}`.trim()} type="button" onClick={() => onThemeChange(isLight ? "dark" : "light")} title={isLight ? "Use dark theme" : "Use light theme"} aria-label={isLight ? "Use dark theme" : "Use light theme"}>
      <span aria-hidden="true">{isLight ? "☾" : "☀"}</span>
    </button>
  );
}

function EmptyWorkspace({ hasProject, onNew, onAdd }: { hasProject: boolean; onNew: () => void; onAdd: () => void }) {
  return (
    <div className="empty-workspace">
      <span className="empty-orbit">C</span>
      <p className="eyebrow">Secure coding, from anywhere</p>
      <h2>{hasProject ? "What should we build next?" : "Add your first Git project"}</h2>
      <p>{hasProject ? "Start a continuous Codex session. You can leave on your phone and continue later from your laptop." : "Comote only exposes repositories registered under its protected VPS workspace."}</p>
      <button className="primary" onClick={hasProject ? onNew : onAdd}>{hasProject ? "Start a new session" : "Add project"}</button>
    </div>
  );
}

function AddProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [mode, setMode] = useState<"create" | "import">("import");
  const [name, setName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = mode === "create"
        ? { mode, name }
        : { mode, name, repositoryUrl };
      const { project } = await api.post<{ project: Project }>("/api/projects", payload);
      onCreated(project);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-project-title">
        <div className="dialog-header">
          <div><p className="eyebrow">VPS workspace</p><h2 id="add-project-title">Add project</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>
        <div className="mode-tabs" role="tablist" aria-label="Project source">
          <button type="button" role="tab" aria-selected={mode === "import"} className={mode === "import" ? "active" : ""} onClick={() => { setMode("import"); setError(""); }}>Import GitHub</button>
          <button type="button" role="tab" aria-selected={mode === "create"} className={mode === "create" ? "active" : ""} onClick={() => { setMode("create"); setError(""); }}>Create new</button>
        </div>
        <form onSubmit={submit}>
          {mode === "import" ? (
            <>
              <label>
                GitHub repository URL
                <input type="url" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/project" required autoFocus />
              </label>
              <label>
                Project name <span className="optional">optional</span>
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Uses the repository name" maxLength={64} />
              </label>
              <p className="field-help">Public repositories import immediately. Private repositories require GitHub access configured on this VPS.</p>
            </>
          ) : (
            <label>
              Project name
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="my-new-app" maxLength={64} required autoFocus />
            </label>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="dialog-actions">
            <button className="secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary" disabled={busy || (mode === "create" ? !name.trim() : !repositoryUrl.trim())}>{busy ? (mode === "import" ? "Importing…" : "Creating…") : (mode === "import" ? "Import project" : "Create project")}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function SettingsDialog({ project, theme, onThemeChange, onClose }: { project: Project | null; theme: ThemePreference; onThemeChange: (theme: ThemePreference) => void; onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [projectBranch, setProjectBranch] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState("");
  const [projectSuccess, setProjectSuccess] = useState("");
  const [notes, setNotes] = useState("");
  const [notesBusy, setNotesBusy] = useState(false);
  const [notesError, setNotesError] = useState("");
  const [notesSuccess, setNotesSuccess] = useState("");
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences | null>(null);
  const [notificationBusy, setNotificationBusy] = useState(true);
  const [notificationError, setNotificationError] = useState("");
  const [notificationSuccess, setNotificationSuccess] = useState("");

  useEffect(() => {
    api.get<{ enabled: boolean; preferences: NotificationPreferences }>("/api/notifications")
      .then((result) => {
        setNotificationsEnabled(result.enabled);
        setNotificationPreferences(result.preferences);
      })
      .catch((cause) => setNotificationError((cause as Error).message))
      .finally(() => setNotificationBusy(false));
  }, []);

  useEffect(() => {
    if (!project) return;
    setProjectBusy(true);
    setProjectError("");
    api.get<{ branch: string; remoteUrl: string }>(`/api/projects/${project.id}/settings`)
      .then((settings) => {
        setRemoteUrl(settings.remoteUrl);
        setProjectBranch(settings.branch);
      })
      .catch((cause) => setProjectError((cause as Error).message))
      .finally(() => setProjectBusy(false));
    setNotesBusy(true);
    setNotesError("");
    setNotesSuccess("");
    api.get<{ notes: string }>(`/api/projects/${project.id}/notes`)
      .then((result) => setNotes(result.notes))
      .catch((cause) => setNotesError((cause as Error).message))
      .finally(() => setNotesBusy(false));
  }, [project]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmation) {
      setError("New passwords do not match.");
      return;
    }
    setPasswordBusy(true);
    setError("");
    setSuccess("");
    try {
      await api.post("/api/password", { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setSuccess("Password changed. Sessions on other devices were signed out.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPasswordBusy(false);
    }
  }

  async function saveRemote(event: FormEvent) {
    event.preventDefault();
    if (!project) return;
    setProjectBusy(true);
    setProjectError("");
    setProjectSuccess("");
    try {
      const settings = await api.post<{ branch: string; remoteUrl: string }>(`/api/projects/${project.id}/settings/remote`, { repositoryUrl: remoteUrl });
      setRemoteUrl(settings.remoteUrl);
      setProjectBranch(settings.branch);
      setProjectSuccess("GitHub remote saved for this project.");
    } catch (cause) {
      setProjectError((cause as Error).message);
    } finally {
      setProjectBusy(false);
    }
  }

  async function saveNotifications(event: FormEvent) {
    event.preventDefault();
    if (!notificationPreferences) return;
    setNotificationBusy(true);
    setNotificationError("");
    setNotificationSuccess("");
    try {
      const result = await api.post<{ enabled: boolean; preferences: NotificationPreferences }>("/api/notifications", { preferences: notificationPreferences });
      setNotificationsEnabled(result.enabled);
      setNotificationPreferences(result.preferences);
      setNotificationSuccess("Ping notification preferences saved.");
    } catch (cause) {
      setNotificationError((cause as Error).message);
    } finally {
      setNotificationBusy(false);
    }
  }

  async function saveNotes(event: FormEvent) {
    event.preventDefault();
    if (!project) return;
    setNotesBusy(true);
    setNotesError("");
    setNotesSuccess("");
    try {
      const result = await api.post<{ notes: string }>(`/api/projects/${project.id}/notes`, { notes });
      setNotes(result.notes);
      setNotesSuccess(result.notes ? "Project notes saved." : "Project notes cleared.");
    } catch (cause) {
      setNotesError((cause as Error).message);
    } finally {
      setNotesBusy(false);
    }
  }

  const busy = passwordBusy || projectBusy || notificationBusy || notesBusy;

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="dialog-header">
          <div><p className="eyebrow">Preferences</p><h2 id="settings-title">Settings</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>
        <section className="settings-form appearance-section" aria-labelledby="appearance-title">
          <h3 id="appearance-title">Appearance</h3>
          <p className="field-help">Light uses a warm neutral background instead of pure white.</p>
          <div className="mode-tabs theme-tabs" role="group" aria-label="Color theme">
            {(["system", "light", "dark"] as const).map((option) => (
              <button key={option} type="button" className={theme === option ? "active" : ""} aria-pressed={theme === option} onClick={() => onThemeChange(option)}>
                {option[0].toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
        </section>
        <form className="settings-form settings-section" onSubmit={saveNotifications}>
          <h3>Ping notifications</h3>
          <p className="field-help">Receive short status notices only. Logs, prompts, code, and secrets are never included.</p>
          {notificationPreferences && (
            <div className="notification-options">
              <NotificationToggle label="Codex finished a task" checked={notificationPreferences.turnComplete} disabled={!notificationsEnabled || notificationBusy} onChange={(checked) => setNotificationPreferences({ ...notificationPreferences, turnComplete: checked })} />
              <NotificationToggle label="Codex needs approval" checked={notificationPreferences.approvalRequired} disabled={!notificationsEnabled || notificationBusy} onChange={(checked) => setNotificationPreferences({ ...notificationPreferences, approvalRequired: checked })} />
              <NotificationToggle label="Project checks failed" checked={notificationPreferences.checkFailed} disabled={!notificationsEnabled || notificationBusy} onChange={(checked) => setNotificationPreferences({ ...notificationPreferences, checkFailed: checked })} />
              <NotificationToggle label="Deploy or rollback finished" checked={notificationPreferences.deploymentResult} disabled={!notificationsEnabled || notificationBusy} onChange={(checked) => setNotificationPreferences({ ...notificationPreferences, deploymentResult: checked })} />
            </div>
          )}
          {!notificationsEnabled && !notificationBusy && <p className="field-help">Ping is not configured on this server.</p>}
          {notificationError && <p className="form-error">{notificationError}</p>}
          {notificationSuccess && <p className="form-success">{notificationSuccess}</p>}
          <div className="dialog-actions"><button className="primary" disabled={!notificationsEnabled || notificationBusy || !notificationPreferences}>{notificationBusy ? "Saving…" : "Save notifications"}</button></div>
        </form>
        <form className="settings-form" onSubmit={submit}>
          <h3>Change password</h3>
          <p className="field-help">Use at least 12 characters. Your current device stays signed in.</p>
          <label>Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
          <label>New password<input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={12} required /></label>
          <label>Confirm new password<input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={12} required /></label>
          {error && <p className="form-error">{error}</p>}
          {success && <p className="form-success">{success}</p>}
          <div className="dialog-actions">
            <button className="secondary" type="button" onClick={onClose} disabled={busy}>Close</button>
            <button className="primary" disabled={passwordBusy || !currentPassword || newPassword.length < 12 || !confirmation}>{passwordBusy ? "Saving…" : "Change password"}</button>
          </div>
        </form>
        <form className="settings-form settings-section" onSubmit={saveNotes}>
          <h3>Project notes</h3>
          {project ? (
            <>
              <p className="field-help">Persistent goals, conventions, and constraints for {project.name}. Comote privately supplies these notes to Codex; they are not added to the app repository.</p>
              <div className="built-in-note"><strong>Safe VPS deploy · always active</strong><span>Before VPS changes, Codex must inventory services, ports, process managers/containers, proxy, disk, and memory; isolate the app; protect existing processes; and prepare health checks, backup, and rollback.</span></div>
              <label>Instructions and context<textarea rows={6} maxLength={10_000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Example: Use Indonesian copy, mobile-first layout, and SQLite for local data." /></label>
              <p className="field-help">{notes.length.toLocaleString()} / 10,000 characters</p>
              {notesError && <p className="form-error">{notesError}</p>}
              {notesSuccess && <p className="form-success">{notesSuccess}</p>}
              <div className="dialog-actions"><button className="primary" disabled={notesBusy}>{notesBusy ? "Saving…" : "Save project notes"}</button></div>
            </>
          ) : <p className="field-help">Select a project to add persistent notes.</p>}
        </form>
        <form className="settings-form settings-section" onSubmit={saveRemote}>
          <h3>Project Git remote</h3>
          {project ? (
            <>
              <p className="field-help">Project: {project.name}{projectBranch ? ` · branch ${projectBranch}` : ""}. Public GitHub URLs work now; private access can be connected later.</p>
              <label>GitHub repository URL<input type="url" value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="https://github.com/owner/project" required /></label>
              {projectError && <p className="form-error">{projectError}</p>}
              {projectSuccess && <p className="form-success">{projectSuccess}</p>}
              <div className="dialog-actions">
                <button className="primary" disabled={projectBusy || !remoteUrl.trim()}>{projectBusy ? "Saving…" : "Save remote"}</button>
              </div>
            </>
          ) : <p className="field-help">Select a project to configure its Git remote.</p>}
        </form>
      </section>
    </div>
  );
}

function NotificationToggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <label className="notification-toggle"><span>{label}</span><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /></label>;
}

function StarterCards({ onChoose }: { onChoose: (text: string) => void }) {
  const prompts = [
    "Explain this project and suggest the next useful improvement.",
    "Run the tests and investigate anything that fails.",
    "Review the current code for security and reliability issues.",
  ];
  return <div className="starter-grid">{prompts.map((prompt) => <button key={prompt} onClick={() => onChoose(prompt)}>{prompt}<span>→</span></button>)}</div>;
}

function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-label">{message.role === "user" ? "You" : message.phase === "commentary" ? "Codex update" : "Codex"}</div>
      <div className="message-text">{message.text}</div>
    </article>
  );
}

function ActivityCard({ activity }: { activity: ActivityItem }) {
  return (
    <details className="activity-card">
      <summary><span className={`activity-icon ${activity.kind}`}>{activity.kind === "command" ? "›_" : "±"}</span><span><strong>{activity.title}</strong><small>{activity.status}</small></span><span className="chevron">⌄</span></summary>
      {activity.detail && <pre>{activity.detail}</pre>}
    </details>
  );
}

function ActivityGroup({ activities }: { activities: ActivityItem[] }) {
  const [open, setOpen] = useState(activities.some((activity) => activity.status === "running"));
  const failed = activities.filter((activity) => activity.status === "failed").length;
  const running = activities.filter((activity) => activity.status === "running").length;
  const summary = running
    ? `${running} running`
    : failed
      ? `${failed} failed`
      : "Completed";

  useEffect(() => {
    if (activities.some((activity) => activity.status === "running")) setOpen(true);
  }, [activities]);

  return (
    <details className="activity-group" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span><strong>{activities.length} tool actions</strong><small>{summary}</small></span>
        <span className="chevron">⌄</span>
      </summary>
      <div className="activity-group-items">
        {activities.map((activity) => <ActivityCard key={activity.id} activity={activity} />)}
      </div>
    </details>
  );
}

function ApprovalCard({ approval, onDecision }: { approval: Approval; onDecision: (approval: Approval, decision: "accept" | "decline") => void }) {
  return (
    <section className="approval-card">
      <p className="eyebrow">Approval required</p>
      <h3>{approval.reason}</h3>
      {approval.command && <code>{approval.command}</code>}
      <div className="approval-actions">
        <button className="secondary" onClick={() => onDecision(approval, "decline")}>Decline</button>
        <button className="primary" onClick={() => onDecision(approval, "accept")}>Allow once</button>
      </div>
    </section>
  );
}

function ApprovalGroup({ approvals, onDecision }: { approvals: Approval[]; onDecision: (approval: Approval, decision: "accept" | "decline") => void }) {
  const [open, setOpen] = useState(true);
  return (
    <details className="approval-group" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span><strong>{approvals.length} approvals required</strong><small>Review each request</small></span>
        <span className="chevron">⌄</span>
      </summary>
      <div className="approval-group-items">
        {approvals.map((approval) => <ApprovalCard key={approval.requestId} approval={approval} onDecision={onDecision} />)}
      </div>
    </details>
  );
}

function WorkflowIndicator({ label, step }: { label: string; step: WorkflowStep }) {
  return (
    <div className={`workflow-indicator ${step.phase}`} title={step.detail}>
      <span aria-hidden="true">{step.phase === "complete" ? "✓" : step.phase === "pending" ? "•" : "–"}</span>
      <strong>{label}</strong>
      <small>{step.detail}</small>
    </div>
  );
}

function ChangesPanel({ project, thread, git, agentBusy, onAskCodex, onRefresh, onError }: { project: Project | null; thread: Thread | null; git: GitState | null; agentBusy: boolean; onAskCodex: (text: string) => Promise<boolean>; onRefresh: () => Promise<void>; onError: (message: string) => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [deployment, setDeployment] = useState<DeploymentState | null>(null);
  const [deploySlug, setDeploySlug] = useState("");
  const [secretDraft, setSecretDraft] = useState("");
  const changedFiles = useMemo(() => git?.status.split("\n").filter(Boolean) ?? [], [git?.status]);
  const workflow = useMemo(() => gitWorkflowState(git), [git]);

  const refreshPreview = useCallback(async () => {
    if (!project) {
      setPreview(null);
      return;
    }
    const query = thread ? `?threadId=${encodeURIComponent(thread.id)}` : "";
    try {
      setPreview(await api.get<PreviewState>(`/api/projects/${project.id}/preview${query}`));
    } catch (cause) {
      onError((cause as Error).message);
    }
  }, [project, thread, onError]);

  useEffect(() => {
    void refreshPreview();
  }, [refreshPreview]);

  const refreshDeployment = useCallback(async () => {
    if (!project) {
      setDeployment(null);
      return;
    }
    try {
      const next = await api.get<DeploymentState>(`/api/projects/${project.id}/deployment`);
      setDeployment(next);
      setDeploySlug(next.slug || slugify(project.name));
    } catch (cause) {
      onError((cause as Error).message);
    }
  }, [project, onError]);

  useEffect(() => {
    setDeployment(null);
    setDeploySlug(project ? slugify(project.name) : "");
    setSecretDraft("");
    void refreshDeployment();
  }, [project?.id, refreshDeployment]);

  useEffect(() => {
    if (deployment?.phase !== "deploying" && deployment?.phase !== "rolling_back") return;
    const timer = window.setInterval(() => void refreshDeployment(), 2_000);
    return () => window.clearInterval(timer);
  }, [deployment?.phase, refreshDeployment]);

  async function commit() {
    if (!project || !message.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${project.id}/git/commit`, { message, threadId: thread?.id ?? "manual" });
      setMessage("");
      await onRefresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function push() {
    if (!project || !window.confirm(`Push ${git?.branch ?? "the current branch"} to its configured remote?`)) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${project.id}/git/push`, { threadId: thread?.id });
      await onRefresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pushCanonical() {
    if (!project || !git?.isolated || !window.confirm(`Push ${git.baseBranch ?? "the canonical branch"} to its configured remote?`)) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${project.id}/git/push`, {});
      await onRefresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function merge() {
    if (!project || !thread || !git?.isolated || !window.confirm(`Merge ${git.branch} into ${git.baseBranch ?? "the canonical branch"}?`)) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${project.id}/git/merge`, { threadId: thread.id });
      await onRefresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function startPreview() {
    if (!project || !thread) return;
    if (preview?.running && !window.confirm("Stop the current preview and start this task instead?")) return;
    setBusy(true);
    try {
      setPreview(await api.post<PreviewState>(`/api/projects/${project.id}/preview/start`, { threadId: thread.id }));
    } catch (cause) {
      onError((cause as Error).message);
      await refreshPreview();
    } finally {
      setBusy(false);
    }
  }

  async function stopPreview() {
    if (!project) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${project.id}/preview/stop`);
      await refreshPreview();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deployProduction() {
    if (!project || !deploySlug.trim()) return;
    const domain = `${deploySlug.trim().toLowerCase()}.${deployment?.domainSuffix || "apps.devop.my.id"}`;
    if (!window.confirm(`Deploy the clean canonical branch to https://${domain}?`)) return;
    setBusy(true);
    try {
      setDeployment(await api.post<DeploymentState>(`/api/projects/${project.id}/deployment/start`, { slug: deploySlug }));
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveProductionSecrets() {
    if (!project || !deploySlug || !secretDraft.trim()) return;
    setBusy(true);
    try {
      const secrets = parseSecretDraft(secretDraft);
      setDeployment(await api.post<DeploymentState>(`/api/projects/${project.id}/deployment/secrets`, { slug: deploySlug, secrets, removeSecrets: [] }));
      setSecretDraft("");
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeProductionSecret(name: string) {
    if (!project || !deployment?.slug || !window.confirm(`Remove production secret ${name}?`)) return;
    setBusy(true);
    try {
      setDeployment(await api.post<DeploymentState>(`/api/projects/${project.id}/deployment/secrets`, { slug: deployment.slug, secrets: {}, removeSecrets: [name] }));
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function rollbackProduction() {
    if (!project || !deployment?.previousRelease || !window.confirm(`Roll back ${deployment.domain} to its previous release?`)) return;
    setBusy(true);
    try {
      setDeployment(await api.post<DeploymentState>(`/api/projects/${project.id}/deployment/rollback`));
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function fixOperationalLogs(kind: "preview" | "deployment", logs: string) {
    if (!thread || !logs) return;
    setBusy(true);
    try {
      await onAskCodex(buildOperationalFixPrompt(kind, logs));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="changes-content">
      <div className="pane-heading"><span>Changes</span><button className="text-button" onClick={() => onRefresh()} disabled={!project}>Refresh</button></div>
      {!project ? <EmptySmall text="Select a project to inspect its changes." /> : (
        <>
          <div className="branch-row"><span>⑂</span><strong>{git?.branch ?? "Loading…"}</strong><span>{changedFiles.length} changed</span></div>
          <div className="file-list">
            {changedFiles.map((line) => <div className="file-row" key={line}><span>{line.slice(0, 2).trim() || "M"}</span><code>{line.slice(3)}</code></div>)}
            {!changedFiles.length && <EmptySmall text="Working tree is clean." />}
          </div>
          {git?.diff && <details className="diff-block"><summary>View diff</summary><pre>{git.diff}</pre></details>}
          <CodeIndexPanel project={project} thread={thread} gitVersion={`${git?.revision ?? ""}\n${git?.status ?? ""}\n${git?.diff ?? ""}`} onError={onError} />
          <CheckPanel project={project} thread={thread} gitVersion={`${git?.revision ?? ""}\n${git?.status ?? ""}\n${git?.diff ?? ""}`} agentBusy={agentBusy} onAskCodex={onAskCodex} onError={onError} />
          <div className="commit-box">
            <div className="git-workflow" aria-label="Git workflow status">
              <WorkflowIndicator label="Commit" step={workflow.commit} />
              {git?.isolated && <WorkflowIndicator label={`Merge ${git.baseBranch ?? "main"}`} step={workflow.merge!} />}
              <WorkflowIndicator label={`Push ${git?.isolated ? git.baseBranch ?? "main" : git?.branch ?? "branch"}`} step={workflow.pushMain} />
            </div>
            <label>Commit message<textarea rows={3} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe this change" /></label>
            <button className={`primary full ${workflow.commit.phase === "complete" ? "workflow-complete-button" : ""}`} onClick={commit} disabled={busy || workflow.commit.phase !== "pending" || !message.trim()}>{busy ? "Working…" : workflow.commit.phase === "complete" ? "✓ Changes committed" : "Commit with device note"}</button>
            {git?.isolated && <button className={`secondary full ${workflow.merge?.phase === "complete" ? "workflow-complete-button" : ""}`} onClick={merge} disabled={busy || workflow.merge?.phase !== "pending"}>{workflow.merge?.phase === "complete" ? `✓ Merged into ${git.baseBranch ?? "main"}` : `Merge into ${git.baseBranch ?? "main"}`}</button>}
            {git?.isolated && <button className={`secondary full ${workflow.pushMain.phase === "complete" ? "workflow-complete-button" : ""}`} onClick={pushCanonical} disabled={busy || workflow.pushMain.phase !== "pending"}>{workflow.pushMain.phase === "complete" ? `✓ ${git.baseBranch ?? "main"} pushed to GitHub` : workflow.pushMain.phase === "blocked" ? workflow.pushMain.detail : `Push ${git.baseBranch ?? "main"}${git.base.tracking.ahead ? ` (${git.base.tracking.ahead})` : ""}`}</button>}
            <button className={`secondary full ${workflow.pushTask.phase === "complete" ? "workflow-complete-button" : ""}`} onClick={push} disabled={busy || workflow.pushTask.phase !== "pending"}>{workflow.pushTask.phase === "complete" ? `✓ ${git?.isolated ? "Task branch" : "Branch"} pushed` : workflow.pushTask.phase === "blocked" ? workflow.pushTask.detail : `${git?.isolated ? "Push task branch (optional)" : "Push branch"}${git?.tracking.ahead ? ` (${git.tracking.ahead})` : ""}`}</button>
          </div>
          <div className="preview-box">
            <div><span className="eyebrow">Private preview</span><strong>{preview?.selected ? "This task is live" : preview?.error ? "Last preview failed" : preview?.running ? "Another task is live" : "Not running"}</strong></div>
            {preview?.selected ? (
              <div className="preview-actions">
                <a className="primary" href={preview.url} target="_blank" rel="noreferrer">Open preview</a>
                <button className="secondary" onClick={stopPreview} disabled={busy}>Stop</button>
              </div>
            ) : <button className="secondary full" onClick={startPreview} disabled={busy || !thread}>{preview?.running ? "Replace with this task" : "Start preview"}</button>}
            {preview?.command && <code>{preview.command}</code>}
            {preview?.logs && <details open={Boolean(preview.error)}><summary>Preview logs</summary><pre>{preview.logs}</pre></details>}
            {preview?.error && <button className="secondary full" onClick={() => void fixOperationalLogs("preview", `${preview.error}\n${preview.logs}`)} disabled={busy || agentBusy || !thread}>Fix preview with Codex</button>}
            {!thread && <p>Select a task before starting its preview.</p>}
          </div>
          <div className="deployment-box">
            <div className="deployment-heading">
              <div><span className="eyebrow">Production</span><strong>{deploymentLabel(deployment)}</strong></div>
              {deployment?.phase === "deployed" && <span className="production-dot" />}
            </div>
            {deployment?.enabled ? (
              <>
                <label>Subdomain<input value={deploySlug} onChange={(event) => setDeploySlug(slugify(event.target.value))} maxLength={24} placeholder="my-app" disabled={Boolean(deployment.release)} /></label>
                <p>{deploySlug || "name"}.{deployment.domainSuffix} · deploys the clean canonical branch</p>
                <div className="deployment-capabilities">
                  {activeServices(deployment).map((service) => <span key={service}>{service}</span>)}
                  {!activeServices(deployment).length && <span>no managed database</span>}
                </div>
                {!deployment.manifestConfigured && <p>Basic auto-detection is active. Ask Codex to configure SQLite, PostgreSQL, MySQL, Redis, migrations, or health checks.</p>}
                {deployment.configurationError && <p className="deployment-warning">Configuration error: {deployment.configurationError}</p>}
                <details className="deployment-settings" open={Boolean(deployment.missingSecrets.length)}>
                  <summary>Environment secrets</summary>
                  <p>Values are write-only. Add one <code>NAME=value</code> per line.</p>
                  <textarea rows={3} value={secretDraft} onChange={(event) => setSecretDraft(event.target.value)} placeholder="SESSION_SECRET=…" autoComplete="off" spellCheck={false} />
                  <button className="secondary full" onClick={saveProductionSecrets} disabled={busy || !secretDraft.trim() || !deploySlug}>Save secrets</button>
                  {deployment.secretNames.length > 0 && <div className="secret-list">{deployment.secretNames.map((name) => <button type="button" key={name} onClick={() => removeProductionSecret(name)} title="Remove secret">{name} ×</button>)}</div>}
                  {deployment.missingSecrets.length > 0 && <p className="deployment-warning">Required before deploy: {deployment.missingSecrets.join(", ")}</p>}
                </details>
                <button className="primary full" onClick={deployProduction} disabled={busy || !deploySlug || Boolean(deployment.configurationError) || deployment.missingSecrets.length > 0 || deployment.phase === "deploying" || deployment.phase === "rolling_back"}>
                  {deployment.phase === "deploying" ? "Deploying…" : deployment.phase === "rolling_back" ? "Rolling back…" : "Deploy production"}
                </button>
                {deployment.release && <a className="secondary full production-link" href={deployment.url} target="_blank" rel="noreferrer">Open production</a>}
                {deployment.previousRelease && <button className="text-button" onClick={rollbackProduction} disabled={busy || deployment.phase !== "deployed"}>Rollback previous release</button>}
                {deployment.release && <code>{deployment.kind} · {deployment.release}</code>}
                {deployment.logs && <details open={deployment.phase === "failed"}><summary>Deployment logs</summary><pre>{deployment.logs}</pre></details>}
                {deployment.phase === "failed" && deployment.logs && <button className="secondary full" onClick={() => void fixOperationalLogs("deployment", deployment.logs)} disabled={busy || agentBusy || !thread}>Fix deploy with Codex</button>}
              </>
            ) : <p>{deployment?.disabledReason || "Production deployment is not configured on this server."}</p>}
          </div>
        </>
      )}
    </div>
  );
}

function deploymentLabel(deployment: DeploymentState | null): string {
  if (!deployment) return "Loading…";
  if (deployment.phase === "deploying") return "Deploying canonical branch";
  if (deployment.phase === "rolling_back") return "Rolling back";
  if (deployment.phase === "deployed") return "Live";
  if (deployment.phase === "failed") return "Last deployment failed";
  return "Not deployed";
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/g, "");
}

function activeServices(deployment: DeploymentState): string[] {
  return Object.entries(deployment.services).filter(([, enabled]) => enabled).map(([name]) => name);
}

function parseSecretDraft(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of value.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Secret line must use NAME=value: ${line}`);
    const name = line.slice(0, separator).trim();
    const secret = line.slice(separator + 1);
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name) || !secret) throw new Error(`Invalid production secret: ${name || line}`);
    result[name] = secret;
  }
  return result;
}

export function buildOperationalFixPrompt(kind: "preview" | "deployment", logs: string): string {
  const redacted = redactOperationalLogs(logs).slice(-14_000);
  const label = kind === "preview" ? "private preview" : "production deployment";
  return [
    `Investigate and fix the ${label} failure shown below.`,
    "Inspect the project and relevant configuration, make the smallest safe code/config changes, and run the appropriate checks. Do not weaken tests or security controls.",
    kind === "deployment" ? "Follow Comote's safe VPS deployment rule: protect unrelated apps and processes, avoid port/service conflicts, and preserve rollback." : "Do not start or stop unrelated server processes.",
    "",
    `## Redacted ${label} logs`,
    redacted || "No log output was captured.",
  ].join("\n");
}

function redactOperationalLogs(value: string): string {
  return value
    .replace(/\b(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/\b([A-Z_][A-Z0-9_]{1,63}\s*=\s*)[^\s]+/g, "$1[REDACTED]")
    .replace(/(https?:\/\/[^\s:/]+:)[^@\s]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:ghp|github_pat|sk|xox[baprs])[-_A-Za-z0-9]{12,}\b/g, "[REDACTED_TOKEN]");
}

function EmptySmall({ text }: { text: string }) {
  return <p className="empty-small">{text}</p>;
}

function extractHistory(thread: Thread): { messages: ChatMessage[]; activities: ActivityItem[]; lastOrder: number } {
  const messages: ChatMessage[] = [];
  const activities: ActivityItem[] = [];
  let order = 0;
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = (item.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
        messages.push({ id: item.id, role: "user", text: stripComoteContext(text), order: ++order });
      } else if (item.type === "agentMessage") {
        messages.push({ id: item.id, role: "assistant", text: item.text ?? "", phase: item.phase, order: ++order });
      } else if (item.type === "commandExecution" || item.type === "fileChange") {
        activities.push(activityFromItem(item, ++order));
      }
    }
  }
  return { messages, activities, lastOrder: order };
}

function stripComoteContext(text: string): string {
  const marker = "\n\n<comote-private-context>";
  const index = text.lastIndexOf(marker);
  if (index < 0 || !text.slice(index).includes("</comote-private-context>")) return text;
  return text.slice(0, index);
}

function upsertDelta(messages: ChatMessage[], id: string, delta: string, order: number): ChatMessage[] {
  const existing = messages.find((message) => message.id === id);
  if (!existing) return [...messages, { id, role: "assistant", text: delta, order }];
  return messages.map((message) => message.id === id ? { ...message, text: message.text + delta } : message);
}

function upsertMessage(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  return messages.some((message) => message.id === next.id)
    ? messages.map((message) => message.id === next.id ? { ...next, order: message.order } : message)
    : [...messages, next];
}

function upsertActivity(items: ActivityItem[], item: ThreadItem, order: number): ActivityItem[] {
  const activity = activityFromItem(item, order);
  return items.some((current) => current.id === activity.id)
    ? items.map((current) => current.id === activity.id ? { ...activity, order: current.order } : current)
    : [...items, activity];
}

function activityFromItem(item: ThreadItem, order: number): ActivityItem {
  if (item.type === "commandExecution") {
    return { id: item.id, kind: "command", title: item.command || "Command", detail: item.aggregatedOutput ?? "", status: item.status ?? "running", order };
  }
  const paths = (item.changes ?? []).map((change) => `${change.kind}  ${change.path}`).join("\n");
  return { id: item.id, kind: "files", title: `${item.changes?.length ?? 0} file changes`, detail: paths, status: item.status ?? "running", order };
}

function detectDeviceName(): string {
  return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? "Mobile" : "Laptop";
}

function formatRelative(timestamp?: number): string {
  if (!timestamp) return "Recent";
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  const minutes = Math.max(0, Math.round((Date.now() - milliseconds) / 60_000));
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
