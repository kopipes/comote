import type { DeploymentStatus } from "./deployment.js";
import type { ComoteEvent, EventHub } from "./event-hub.js";
import type { NotificationSettingsStore } from "./notification-settings.js";
import type { PingClient } from "./ping.js";

interface ActiveTurn {
  projectName: string;
}

export class NotificationService {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly notifiedApprovals = new Set<string>();

  constructor(
    private readonly ping: PingClient,
    private readonly settings: NotificationSettingsStore,
    events: EventHub,
  ) {
    events.subscribeAll((event) => this.handleEvent(event));
  }

  trackTurn(threadId: string, projectName: string): void {
    this.activeTurns.set(threadId, { projectName: safeLabel(projectName) });
  }

  cancelTurn(threadId: string): void {
    this.activeTurns.delete(threadId);
  }

  checkFinished(projectName: string, passed: boolean): void {
    if (passed || !this.settings.get().checkFailed) return;
    this.send("Project checks failed", `${safeLabel(projectName)} needs attention. Open Comote to review the failed check and ask Codex to fix it.`);
  }

  deploymentFinished(projectName: string, state: DeploymentStatus, action: "deploy" | "rollback"): void {
    if (!this.settings.get().deploymentResult) return;
    const operation = action === "rollback" ? "Rollback" : "Deployment";
    const succeeded = state.phase === "deployed";
    this.send(
      `${operation} ${succeeded ? "completed" : "failed"}`,
      `${safeLabel(projectName)}: ${succeeded ? state.url || "production is ready" : "open Comote to review the deployment logs"}.`,
    );
  }

  private handleEvent(event: ComoteEvent): void {
    const active = this.activeTurns.get(event.threadId);
    if (!active) return;
    if (event.type === "approval") {
      const approvalId = String(event.payload.requestId ?? "");
      if (!approvalId || this.notifiedApprovals.has(approvalId) || !this.settings.get().approvalRequired) return;
      if (this.notifiedApprovals.size >= 1_000) this.notifiedApprovals.clear();
      this.notifiedApprovals.add(approvalId);
      this.send("Codex needs approval", `${active.projectName} is waiting for your approval in Comote.`);
      return;
    }
    if (event.type !== "status" || event.payload.method !== "turn/completed") return;
    this.activeTurns.delete(event.threadId);
    if (!this.settings.get().turnComplete) return;
    const turn = event.payload.turn as Record<string, unknown> | undefined;
    const succeeded = !turn?.status || turn.status === "completed";
    this.send(
      `Codex ${succeeded ? "finished" : "stopped with an error"}`,
      `${active.projectName}: ${succeeded ? "your coding task is ready to review" : "open Comote to review the error"}.`,
    );
  }

  private send(title: string, text: string): void {
    if (!this.ping.enabled) return;
    void this.ping.sendNotice(title, text)
      .catch((error: Error) => console.error(`Could not send Ping notification: ${error.message}`));
  }
}

function safeLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9 _.-]/g, "").trim().slice(0, 80) || "Project";
}
