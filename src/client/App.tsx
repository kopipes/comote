import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, type GitState, type LiveEvent, type Project, type Session, type Thread, type ThreadItem } from "./api";

type AuthState = Session | null | undefined;

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  phase?: string;
}

interface ActivityItem {
  id: string;
  kind: "command" | "files";
  title: string;
  detail: string;
  status: string;
}

interface Approval {
  requestId: string;
  reason: string;
  command?: string;
  cwd?: string;
}

export default function App() {
  const [session, setSession] = useState<AuthState>(undefined);

  useEffect(() => {
    api.get<Session>("/api/session")
      .then((value) => {
        api.setCsrf(value.csrf);
        setSession(value);
      })
      .catch(() => setSession(null));
  }, []);

  if (session === undefined) return <Splash />;
  if (session === null) return <Login onAuthenticated={setSession} />;
  return <Workspace session={session} onLoggedOut={() => setSession(null)} />;
}

function Splash() {
  return (
    <main className="center-screen">
      <Brand />
      <div className="loader" aria-label="Loading" />
    </main>
  );
}

function Login({ onAuthenticated }: { onAuthenticated: (session: Session) => void }) {
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState(detectDeviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await api.post<Session>("/api/login", { password, deviceName });
      api.setCsrf(session.csrf);
      onAuthenticated(session);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
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
        <h2>Welcome back</h2>
        <p className="muted">Sign in to wake your Comote workspace.</p>
        <form onSubmit={submit}>
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
        <p className="secure-note"><span className="status-dot" /> Protected by Tailscale and an encrypted session.</p>
      </section>
    </main>
  );
}

function Workspace({ session, onLoggedOut }: { session: Session; onLoggedOut: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [git, setGit] = useState<GitState | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState("");
  const [mobilePanel, setMobilePanel] = useState<"projects" | "chat" | "changes">("chat");
  const streamRef = useRef<EventSource | null>(null);
  const gitRequestRef = useRef(0);

  useEffect(() => {
    api.get<{ projects: Project[] }>("/api/projects")
      .then(({ projects }) => {
        setProjects(projects);
        if (projects[0]) setProject(projects[0]);
      })
      .catch((cause) => setError((cause as Error).message));
  }, []);

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
    setError("");
    api.get<{ threads: Thread[] }>(`/api/projects/${project.id}/threads`)
      .then(({ threads }) => setThreads(threads))
      .catch((cause) => setError((cause as Error).message));
  }, [project?.id]);

  useEffect(() => {
    void refreshGit();
  }, [refreshGit]);

  useEffect(() => {
    streamRef.current?.close();
    if (!project || !thread) return;
    const stream = new EventSource(`/api/projects/${project.id}/threads/${thread.id}/events`);
    streamRef.current = stream;
    stream.onmessage = (event) => applyLiveEvent(JSON.parse(event.data) as LiveEvent);
    stream.onerror = () => setError("Live connection interrupted. Comote will reconnect automatically.");
    return () => stream.close();
  }, [project, thread?.id]);

  function applyLiveEvent(event: LiveEvent) {
    if (event.type === "assistant_delta") {
      const id = String(event.payload.itemId ?? "assistant-live");
      const delta = String(event.payload.text ?? "");
      setMessages((current) => upsertDelta(current, id, delta));
    } else if (event.type === "item_started" || event.type === "item_completed") {
      const item = event.payload.item as ThreadItem | undefined;
      if (!item) return;
      if (item.type === "agentMessage" && event.type === "item_completed") {
        setMessages((current) => upsertMessage(current, { id: item.id, role: "assistant", text: item.text ?? "", phase: item.phase }));
      }
      if (item.type === "commandExecution" || item.type === "fileChange") {
        setActivities((current) => upsertActivity(current, item));
        if (event.type === "item_completed") void refreshGit();
      }
    } else if (event.type === "approval") {
      setApprovals((current) => [...current.filter((item) => item.requestId !== event.payload.requestId), {
        requestId: String(event.payload.requestId),
        reason: String(event.payload.reason ?? "Codex needs approval."),
        command: event.payload.command ? String(event.payload.command) : undefined,
        cwd: event.payload.cwd ? String(event.payload.cwd) : undefined,
      }]);
    } else if (event.type === "status") {
      const method = String(event.payload.method ?? "");
      if (method === "turn/started") setRunning(true);
      if (method === "turn/completed") {
        setRunning(false);
        void refreshGit();
      }
    } else if (event.type === "error") {
      setRunning(false);
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
      setMobilePanel("chat");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(text: string) {
    if (!project || !thread) return;
    const optimisticId = `local-${Date.now()}`;
    setMessages((current) => [...current, { id: optimisticId, role: "user", text }]);
    setRunning(true);
    setError("");
    try {
      await api.post(`/api/projects/${project.id}/threads/${thread.id}/messages`, { text });
    } catch (cause) {
      setRunning(false);
      setError((cause as Error).message);
    }
  }

  async function decide(approval: Approval, decision: "accept" | "decline") {
    if (!project || !thread) return;
    try {
      await api.post(`/api/projects/${project.id}/threads/${thread.id}/approvals/${approval.requestId}`, { decision });
      setApprovals((current) => current.filter((item) => item.requestId !== approval.requestId));
    } catch (cause) {
      setError((cause as Error).message);
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
    setAddingProject(false);
    setMobilePanel("chat");
  }

  return (
    <div className="app-shell" data-panel={mobilePanel}>
      <header className="topbar">
        <Brand />
        <div className="topbar-meta">
          <span className="private-badge"><span className="status-dot" /> Private</span>
          <span className="device-name">{session.deviceName}</span>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings">⚙</button>
          <button className="icon-button" onClick={logout} title="Sign out" aria-label="Sign out">↗</button>
        </div>
      </header>

      <aside className="projects-pane">
        <div className="pane-heading">
          <span>Projects <span className="count">{projects.length}</span></span>
          <button className="new-button" onClick={() => setAddingProject(true)}>＋ Add</button>
        </div>
        <div className="project-list">
          {projects.map((item) => (
            <button key={item.id} className={`project-row ${project?.id === item.id ? "active" : ""}`} onClick={() => setProject(item)}>
              <span className="project-avatar">{item.name.slice(0, 2).toUpperCase()}</span>
              <span><strong>{item.name}</strong><small>VPS workspace</small></span>
            </button>
          ))}
          {!projects.length && <EmptySmall text="No Git projects found in the workspace root." />}
        </div>
      </aside>

      <aside className="threads-pane">
        <div className="pane-heading">
          <span>{project?.name ?? "Sessions"}</span>
          <button className="new-button" onClick={newThread} disabled={!project || busy}>＋ New</button>
        </div>
        <div className="thread-list">
          {threads.map((item) => (
            <button key={item.id} className={`thread-row ${thread?.id === item.id ? "active" : ""}`} onClick={() => selectThread(item)}>
              <strong>{item.name || item.preview || "New session"}</strong>
              <small>{formatRelative(item.updatedAt ?? item.createdAt)}</small>
            </button>
          ))}
          {project && !threads.length && <EmptySmall text="Start a session and describe what you want to build." />}
        </div>
      </aside>

      <main className="conversation-pane">
        {error && <button className="error-banner" onClick={() => setError("")}>{error}<span>×</span></button>}
        {!thread ? (
          <EmptyWorkspace hasProject={Boolean(project)} onNew={newThread} onAdd={() => setAddingProject(true)} />
        ) : (
          <>
            <div className="conversation-header">
              <div><p className="eyebrow">{project?.name}</p><h2>{thread.name || thread.preview || "New session"}</h2></div>
              <div className="run-states">
                {git?.isolated && <span className="task-state">Isolated task</span>}
                <span className={`run-state ${running ? "running" : ""}`}>{running ? "Codex is working" : "Ready"}</span>
              </div>
            </div>
            <div className="message-scroll">
              {messages.length === 0 && <StarterCards onChoose={sendMessage} />}
              {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
              {activities.map((activity) => <ActivityCard key={activity.id} activity={activity} />)}
              {approvals.map((approval) => <ApprovalCard key={approval.requestId} approval={approval} onDecision={decide} />)}
              {running && <div className="thinking"><span /><span /><span /> Codex is working</div>}
            </div>
            <Composer disabled={running} onSend={sendMessage} />
          </>
        )}
      </main>

      <aside className="changes-pane">
        <ChangesPanel project={project} thread={thread} git={git} onRefresh={() => refreshGit()} onError={setError} />
      </aside>

      <nav className="mobile-nav">
        <button className={mobilePanel === "projects" ? "active" : ""} onClick={() => setMobilePanel("projects")}>Projects</button>
        <button className={mobilePanel === "chat" ? "active" : ""} onClick={() => setMobilePanel("chat")}>Chat</button>
        <button className={mobilePanel === "changes" ? "active" : ""} onClick={() => setMobilePanel("changes")}>Changes</button>
      </nav>

      {addingProject && <AddProjectDialog onClose={() => setAddingProject(false)} onCreated={projectAdded} />}
      {settingsOpen && <SettingsDialog project={project} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function Brand({ large = false }: { large?: boolean }) {
  return <div className={`brand ${large ? "large" : ""}`}><span className="brand-mark">C</span><span>comote</span></div>;
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

function SettingsDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
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

  const busy = passwordBusy || projectBusy;

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="dialog-header">
          <div><p className="eyebrow">Security</p><h2 id="settings-title">Settings</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>
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

function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value || disabled) return;
    setText("");
    onSend(value);
  }
  return (
    <form className="composer" onSubmit={submit}>
      <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Describe what you want to build…" rows={1} disabled={disabled} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} />
      <button className="send-button" disabled={disabled || !text.trim()} aria-label="Send">↑</button>
      <small>Enter to send · Shift + Enter for a new line</small>
    </form>
  );
}

function ChangesPanel({ project, thread, git, onRefresh, onError }: { project: Project | null; thread: Thread | null; git: GitState | null; onRefresh: () => Promise<void>; onError: (message: string) => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const changedFiles = useMemo(() => git?.status.split("\n").filter(Boolean) ?? [], [git?.status]);

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
          <div className="commit-box">
            <label>Commit message<textarea rows={3} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe this change" /></label>
            <button className="primary full" onClick={commit} disabled={busy || !changedFiles.length || !message.trim()}>{busy ? "Working…" : "Commit with device note"}</button>
            {git?.isolated && <button className="secondary full" onClick={merge} disabled={busy || Boolean(changedFiles.length)}>Merge into {git.baseBranch ?? "main"}</button>}
            {git?.isolated && <button className="secondary full" onClick={pushCanonical} disabled={busy}>Push {git.baseBranch ?? "main"}</button>}
            <button className="secondary full" onClick={push} disabled={busy}>{git?.isolated ? "Push task branch" : "Push branch"}</button>
          </div>
        </>
      )}
    </div>
  );
}

function EmptySmall({ text }: { text: string }) {
  return <p className="empty-small">{text}</p>;
}

function extractHistory(thread: Thread): { messages: ChatMessage[]; activities: ActivityItem[] } {
  const messages: ChatMessage[] = [];
  const activities: ActivityItem[] = [];
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = (item.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
        messages.push({ id: item.id, role: "user", text });
      } else if (item.type === "agentMessage") {
        messages.push({ id: item.id, role: "assistant", text: item.text ?? "", phase: item.phase });
      } else if (item.type === "commandExecution" || item.type === "fileChange") {
        activities.push(activityFromItem(item));
      }
    }
  }
  return { messages, activities };
}

function upsertDelta(messages: ChatMessage[], id: string, delta: string): ChatMessage[] {
  const existing = messages.find((message) => message.id === id);
  if (!existing) return [...messages, { id, role: "assistant", text: delta }];
  return messages.map((message) => message.id === id ? { ...message, text: message.text + delta } : message);
}

function upsertMessage(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  return messages.some((message) => message.id === next.id)
    ? messages.map((message) => message.id === next.id ? next : message)
    : [...messages, next];
}

function upsertActivity(items: ActivityItem[], item: ThreadItem): ActivityItem[] {
  const activity = activityFromItem(item);
  return items.some((current) => current.id === activity.id)
    ? items.map((current) => current.id === activity.id ? activity : current)
    : [...items, activity];
}

function activityFromItem(item: ThreadItem): ActivityItem {
  if (item.type === "commandExecution") {
    return { id: item.id, kind: "command", title: item.command || "Command", detail: item.aggregatedOutput ?? "", status: item.status ?? "running" };
  }
  const paths = (item.changes ?? []).map((change) => `${change.kind}  ${change.path}`).join("\n");
  return { id: item.id, kind: "files", title: `${item.changes?.length ?? 0} file changes`, detail: paths, status: item.status ?? "running" };
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
