import { useCallback, useEffect, useState } from "react";
import { api, type CheckState, type Project, type Thread } from "./api";

export function CheckPanel({ project, thread, gitVersion, agentBusy, onAskCodex, onError }: {
  project: Project;
  thread: Thread | null;
  gitVersion: string;
  agentBusy: boolean;
  onAskCodex: (text: string) => Promise<boolean>;
  onError: (message: string) => void;
}) {
  const [checks, setChecks] = useState<CheckState | null>(null);
  const [busy, setBusy] = useState(false);
  const query = thread ? `?threadId=${encodeURIComponent(thread.id)}` : "";

  const refresh = useCallback(async () => {
    try {
      setChecks(await api.get<CheckState>(`/api/projects/${project.id}/checks${query}`));
    } catch (cause) {
      onError((cause as Error).message);
    }
  }, [project.id, query, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh, gitVersion]);

  useEffect(() => {
    if (checks?.phase !== "running") return;
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(timer);
  }, [checks?.phase, refresh]);

  async function runChecks() {
    setBusy(true);
    try {
      setChecks(await api.post<CheckState>(`/api/projects/${project.id}/checks/start`, { threadId: thread?.id ?? "" }));
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function askCodexToFix() {
    if (!checks) return;
    setBusy(true);
    try {
      await onAskCodex(buildFixPrompt(checks));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`checks-box ${checks?.phase ?? "loading"}`}>
      <div className="checks-heading">
        <div><span className="eyebrow">Project checks</span><strong>{checkLabel(checks)}</strong></div>
        {checks && checks.phase !== "unavailable" && <button className="text-button" onClick={runChecks} disabled={busy || agentBusy || checks.phase === "running"}>{checks.phase === "idle" ? "Run" : "Run again"}</button>}
      </div>
      {checks?.stale && <p className="check-warning">Code changed after these checks. Run them again before merging or deploying.</p>}
      {checks?.steps.map((step) => (
        <details className={`check-step ${step.phase}`} key={step.name} open={step.phase === "failed"}>
          <summary><span>{stepIcon(step.phase)}</span><strong>{step.label}</strong><small>{step.phase}{step.durationMs ? ` · ${formatDuration(step.durationMs)}` : ""}</small></summary>
          {step.output && <pre>{step.output}</pre>}
        </details>
      ))}
      {checks && checks.steps.length === 0 && <p>{checks.message}</p>}
      {checks?.phase === "failed" && <button className="secondary full" onClick={askCodexToFix} disabled={busy || agentBusy || !thread}>Fix with Codex</button>}
      {!thread && checks?.phase === "failed" && <p>Select a session to send the failure to Codex.</p>}
    </section>
  );
}

export function buildFixPrompt(checks: CheckState): string {
  const failures = checks.steps.filter((step) => step.phase === "failed").map((step) => [
    `### ${step.command}`,
    step.output.slice(-5_000) || `Exited with code ${step.exitCode ?? "unknown"}.`,
  ].join("\n")).join("\n\n").slice(-14_000);
  return [
    "The project's automated checks failed. Investigate the root cause, make the smallest correct fix, and rerun the relevant checks.",
    "Do not bypass, disable, or weaken the checks merely to make them pass.",
    "",
    failures,
  ].join("\n");
}

function checkLabel(checks: CheckState | null): string {
  if (!checks) return "Loading…";
  if (checks.stale) return "Needs rerun";
  if (checks.phase === "running") return "Running…";
  if (checks.phase === "passed") return "All passed";
  if (checks.phase === "failed") return "Needs attention";
  if (checks.phase === "unavailable") return "Not configured";
  return "Not run yet";
}

function stepIcon(phase: string): string {
  if (phase === "passed") return "✓";
  if (phase === "failed") return "×";
  if (phase === "running") return "…";
  return "○";
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}
