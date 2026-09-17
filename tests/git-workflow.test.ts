import assert from "node:assert/strict";
import test from "node:test";
import type { GitState } from "../src/client/api.js";
import { gitWorkflowState } from "../src/client/git-workflow.js";

const cleanMergedPushed: GitState = {
  branch: "task/example",
  revision: "abc123",
  status: "",
  diff: "",
  tracking: { upstream: "origin/task/example", ahead: 0, behind: 0 },
  isolated: true,
  baseBranch: "main",
  unmergedCommits: 0,
  base: {
    branch: "main",
    revision: "def456",
    dirty: false,
    tracking: { upstream: "origin/main", ahead: 0, behind: 0 },
  },
};

test("Git workflow marks a fully synchronized task as complete", () => {
  const state = gitWorkflowState(cleanMergedPushed);
  assert.equal(state.commit.phase, "complete");
  assert.equal(state.merge?.phase, "complete");
  assert.equal(state.pushMain.phase, "complete");
  assert.equal(state.pushTask.phase, "complete");
});

test("Git workflow requires commit, then merge, then main push", () => {
  const dirty = gitWorkflowState({ ...cleanMergedPushed, status: " M app.ts", unmergedCommits: 1 });
  assert.equal(dirty.commit.phase, "pending");
  assert.equal(dirty.merge?.phase, "blocked");
  assert.equal(dirty.pushMain.phase, "blocked");

  const committed = gitWorkflowState({ ...cleanMergedPushed, unmergedCommits: 2 });
  assert.equal(committed.commit.phase, "complete");
  assert.equal(committed.merge?.phase, "pending");
  assert.equal(committed.pushMain.phase, "blocked");

  const merged = gitWorkflowState({
    ...cleanMergedPushed,
    base: { ...cleanMergedPushed.base, tracking: { upstream: "origin/main", ahead: 2, behind: 0 } },
  });
  assert.equal(merged.merge?.phase, "complete");
  assert.equal(merged.pushMain.phase, "pending");
});

test("Git workflow blocks a push when the branch is behind GitHub", () => {
  const state = gitWorkflowState({
    ...cleanMergedPushed,
    base: { ...cleanMergedPushed.base, tracking: { upstream: "origin/main", ahead: 1, behind: 1 } },
  });
  assert.equal(state.pushMain.phase, "blocked");
  assert.match(state.pushMain.detail, /behind GitHub/);
});
