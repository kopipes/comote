import assert from "node:assert/strict";
import test from "node:test";
import { PingClient } from "../src/server/ping.js";

test("Ping sends an OTP only to the configured user without exposing its token in the payload", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    requestedInit = init;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const client = new PingClient("https://chat.example/api/webhook/notify", "test-secret", "bob@example.com", request);

  await client.sendOtp("123456", "Phone <unsafe>");

  assert.equal(client.enabled, true);
  assert.equal(requestedUrl, "https://chat.example/api/webhook/notify");
  assert.equal(new Headers(requestedInit?.headers).get("authorization"), "Bearer test-secret");
  const payload = JSON.parse(String(requestedInit?.body));
  assert.equal(payload.userEmail, "bob@example.com");
  assert.match(payload.text, /123456/);
  assert.match(payload.text, /Phone unsafe/);
  assert.equal(JSON.stringify(payload).includes("test-secret"), false);
});

test("Ping delivery errors are normalized without returning webhook details", async () => {
  const request = (async () => new Response(null, { status: 401 })) as typeof fetch;
  const client = new PingClient("https://chat.example/api/webhook/notify", "test-secret", "bob@example.com", request);
  await assert.rejects(client.sendOtp("123456", "Laptop"), /delivery failed \(401\)/);
});

test("Ping status notices use the fixed recipient and do not include the webhook token", async () => {
  let payload: Record<string, string> = {};
  const request = (async (_url: string | URL | Request, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const client = new PingClient("https://chat.example/api/webhook/notify", "test-secret", "bob@example.com", request);
  await client.sendNotice("Codex finished", "Demo is ready.");
  assert.equal(payload.userEmail, "bob@example.com");
  assert.equal(payload.title, "Codex finished");
  assert.equal(JSON.stringify(payload).includes("test-secret"), false);
});
