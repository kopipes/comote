import type { GitState, GitTrackingState } from "./api";

export type WorkflowPhase = "complete" | "pending" | "blocked";

export interface WorkflowStep {
  phase: WorkflowPhase;
  detail: string;
}

export interface GitWorkflow {
  commit: WorkflowStep;
  merge?: WorkflowStep;
  pushMain: WorkflowStep;
  pushTask: WorkflowStep;
}

export function gitWorkflowState(git: GitState | null): GitWorkflow {
  if (!git) {
    const loading = { phase: "blocked", detail: "Loading Git status" } as const;
    return { commit: loading, merge: loading, pushMain: loading, pushTask: loading };
  }

  const dirty = Boolean(git.status);
  const commit: WorkflowStep = dirty
    ? { phase: "pending", detail: "Uncommitted changes" }
    : { phase: "complete", detail: "Working tree is clean" };
  const merge = git.isolated
    ? dirty
      ? { phase: "blocked", detail: "Commit changes first" } as const
      : git.unmergedCommits > 0
        ? { phase: "pending", detail: commitCount(git.unmergedCommits, "not in main") } as const
      : { phase: "complete", detail: "Task is included in main" } as const
    : undefined;
  const baseTracking = git.isolated ? git.base.tracking : git.tracking;
  const baseDirty = git.isolated ? git.base.dirty : dirty;
  const pushMain = baseDirty
    ? { phase: "blocked", detail: "Main has uncommitted changes" } as const
    : git.isolated && (dirty || git.unmergedCommits > 0)
      ? { phase: "blocked", detail: dirty ? "Commit and merge first" : "Merge task first" } as const
      : trackingState(baseTracking, "Main");
  const pushTask = dirty
    ? { phase: "blocked", detail: "Commit changes first" } as const
    : trackingState(git.tracking, git.isolated ? "Task branch" : "Branch");

  return { commit, merge, pushMain, pushTask };
}

function trackingState(tracking: GitTrackingState, label: string): WorkflowStep {
  if (tracking.behind > 0) {
    return { phase: "blocked", detail: commitCount(tracking.behind, "behind GitHub") };
  }
  if (!tracking.upstream) return { phase: "pending", detail: `${label} has not been pushed` };
  if (tracking.ahead > 0) return { phase: "pending", detail: commitCount(tracking.ahead, "to push") };
  return { phase: "complete", detail: `${label} matches GitHub` };
}

function commitCount(count: number, suffix: string): string {
  return `${count} commit${count === 1 ? "" : "s"} ${suffix}`;
}
