import assert from "node:assert/strict";
import test from "node:test";
import { buildApprovalResponse, buildCodexRequest, createCodexEnvironment } from "../src/server/codex-client.js";

test("Codex receives its own environment without Comote secrets", () => {
  assert.deepEqual(createCodexEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/coder",
    OPENAI_API_KEY: "needed-by-codex",
    COMOTE_PASSWORD_HASH: "private-to-comote",
    COMOTE_DEPLOY_SOCKET: "/run/comote-deploy.sock",
  }), {
    PATH: "/usr/bin",
    HOME: "/home/coder",
    OPENAI_API_KEY: "needed-by-codex",
  });
});

test("parameterless Codex methods omit params for older app-server versions", () => {
  assert.deepEqual(buildCodexRequest("account/rateLimits/read", 7), {
    method: "account/rateLimits/read",
    id: 7,
  });
  assert.deepEqual(buildCodexRequest("thread/read", 8, { threadId: "thread-one" }), {
    method: "thread/read",
    id: 8,
    params: { threadId: "thread-one" },
  });
});

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
