import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationTimeline, type ActivityItem, type Approval, type ChatMessage } from "../src/client/conversation.js";

test("conversation timeline keeps chat, activity, and approval events in chronological order", () => {
  const messages: ChatMessage[] = [
    { id: "message-1", role: "assistant", text: "First update", order: 1 },
    { id: "message-2", role: "assistant", text: "Later update", order: 6 },
  ];
  const activities: ActivityItem[] = [
    { id: "activity-1", kind: "command", title: "pwd", detail: "", status: "completed", order: 2 },
    { id: "activity-2", kind: "files", title: "1 file change", detail: "", status: "completed", order: 3 },
  ];
  const approvals: Approval[] = [
    { requestId: "approval-1", reason: "Allow command?", order: 4 },
    { requestId: "approval-2", reason: "Allow network?", order: 5 },
  ];

  const timeline = buildConversationTimeline(messages, activities, approvals);

  assert.deepEqual(timeline.map((block) => block.kind), [
    "message",
    "activity-group",
    "approval-group",
    "message",
  ]);
  assert.equal(timeline[1]?.kind === "activity-group" && timeline[1].activities.length, 2);
  assert.equal(timeline[2]?.kind === "approval-group" && timeline[2].approvals.length, 2);
});

test("conversation timeline only groups adjacent operational items", () => {
  const timeline = buildConversationTimeline(
    [{ id: "message", role: "user", text: "Continue", order: 2 }],
    [
      { id: "activity-1", kind: "command", title: "first", detail: "", status: "completed", order: 1 },
      { id: "activity-2", kind: "command", title: "second", detail: "", status: "completed", order: 3 },
    ],
    [],
  );

  assert.deepEqual(timeline.map((block) => block.kind), ["activity-group", "message", "activity-group"]);
  assert.equal(timeline[0]?.kind === "activity-group" && timeline[0].activities.length, 1);
  assert.equal(timeline[2]?.kind === "activity-group" && timeline[2].activities.length, 1);
});
