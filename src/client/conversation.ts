export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  phase?: string;
  order: number;
}

export interface ActivityItem {
  id: string;
  kind: "command" | "files";
  title: string;
  detail: string;
  status: string;
  order: number;
}

export interface Approval {
  requestId: string;
  reason: string;
  command?: string;
  cwd?: string;
  order: number;
}

export type ConversationBlock =
  | { kind: "message"; message: ChatMessage }
  | { kind: "activity-group"; activities: ActivityItem[] }
  | { kind: "approval-group"; approvals: Approval[] };

type ConversationEntry =
  | { kind: "message"; value: ChatMessage }
  | { kind: "activity"; value: ActivityItem }
  | { kind: "approval"; value: Approval };

export function buildConversationTimeline(
  messages: ChatMessage[],
  activities: ActivityItem[],
  approvals: Approval[],
): ConversationBlock[] {
  const entries: ConversationEntry[] = [
    ...messages.map((value): ConversationEntry => ({ kind: "message", value })),
    ...activities.map((value): ConversationEntry => ({ kind: "activity", value })),
    ...approvals.map((value): ConversationEntry => ({ kind: "approval", value })),
  ].sort((left, right) => left.value.order - right.value.order);

  const blocks: ConversationBlock[] = [];
  for (const entry of entries) {
    const previous = blocks.at(-1);
    if (entry.kind === "activity") {
      if (previous?.kind === "activity-group") previous.activities.push(entry.value);
      else blocks.push({ kind: "activity-group", activities: [entry.value] });
      continue;
    }
    if (entry.kind === "approval") {
      if (previous?.kind === "approval-group") previous.approvals.push(entry.value);
      else blocks.push({ kind: "approval-group", approvals: [entry.value] });
      continue;
    }
    blocks.push({ kind: "message", message: entry.value });
  }
  return blocks;
}

export function retainPendingApprovals(approvals: Approval[], requestIds: string[]): Approval[] {
  const pending = new Set(requestIds);
  return approvals.filter((approval) => pending.has(approval.requestId));
}
