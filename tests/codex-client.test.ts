import assert from "node:assert/strict";
import test from "node:test";
import { buildApprovalResponse } from "../src/server/codex-client.js";

test("command and file approvals return Codex decision payloads", () => {
  assert.deepEqual(buildApprovalResponse("item/commandExecution/requestApproval", {}, "accept"), { decision: "accept" });
  assert.deepEqual(buildApprovalResponse("item/fileChange/requestApproval", {}, "decline"), { decision: "decline" });
});

test("permission approval grants only the requested subset for one turn", () => {
  const permissions = {
    network: { enabled: true, domains: ["github.com"] },
    fileSystem: { read: ["/tmp/input"], write: ["/tmp/output"] },
  };
  assert.deepEqual(buildApprovalResponse("item/permissions/requestApproval", { permissions }, "accept"), {
    permissions,
    scope: "turn",
  });
  assert.deepEqual(buildApprovalResponse("item/permissions/requestApproval", { permissions }, "decline"), {
    permissions: {},
    scope: "turn",
  });
});

test("permission approval ignores fields that were not requested", () => {
  assert.deepEqual(buildApprovalResponse("item/permissions/requestApproval", {
    permissions: { network: { domains: ["example.com"] }, unexpected: "ignored" },
  }, "accept"), {
    permissions: { network: { domains: ["example.com"] } },
    scope: "turn",
  });
});
