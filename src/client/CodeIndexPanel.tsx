import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CodeIndexStatus, type Project, type Thread } from "./api";

export function CodeIndexPanel({ project, thread, gitVersion, onError }: {
  project: Project;
  thread: Thread | null;
  gitVersion: string;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<CodeIndexStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async (force = false) => {
    const requestId = ++requestRef.current;
    setBusy(true);
    try {
      const threadId = thread?.id ?? "";
      const next = force
        ? await api.post<CodeIndexStatus>(`/api/projects/${project.id}/index/refresh`, { threadId })
        : await api.get<CodeIndexStatus>(`/api/projects/${project.id}/index${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`);
      if (requestId === requestRef.current) setStatus(next);
    } catch (cause) {
      if (requestId === requestRef.current) onError((cause as Error).message);
    } finally {
      if (requestId === requestRef.current) setBusy(false);
    }
  }, [project.id, thread?.id, onError]);

  useEffect(() => {
    setStatus(null);
    void load();
  }, [load, gitVersion]);

  const ready = status?.phase === "ready";
  return (
    <section className="code-index-box" aria-label="Codebase index">
      <div className="code-index-heading">
        <div>
          <span className="eyebrow">Codebase index</span>
          <strong>{busy && !status ? "Indexing…" : ready ? "Ready for Codex" : status?.phase === "failed" ? "Unavailable" : "Loading…"}</strong>
        </div>
        <span className={`index-dot ${ready ? "ready" : status?.phase === "failed" ? "failed" : ""}`} />
      </div>
      {ready ? (
        <p>{status.indexedFiles.toLocaleString()} files · {formatBytes(status.indexedBytes)} · commit {status.revision || "unborn"}</p>
      ) : <p>{status?.message || "Building a private, local search index."}</p>}
      {ready && status.skippedFiles > 0 && <p>{status.skippedFiles.toLocaleString()} large, generated, ignored, or sensitive files skipped.</p>}
      <div className="code-index-actions">
        <span>{status?.updatedAt ? `Updated ${formatTime(status.updatedAt)}` : "Stored outside the app repository"}</span>
        <button className="text-button" type="button" onClick={() => void load(true)} disabled={busy}>{busy ? "Refreshing…" : "Refresh index"}</button>
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
