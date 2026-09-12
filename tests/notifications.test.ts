import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EventHub } from "../src/server/event-hub.js";
import { NotificationSettingsStore } from "../src/server/notification-settings.js";
import { NotificationService } from "../src/server/notifications.js";
import { PingClient } from "../src/server/ping.js";

test("tracked Codex turns send short Ping notices for approval and completion", async () => {
  const payloads: Array<Record<string, string>> = [];
  const request = (async (_url: string | URL | Request, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const ping = new PingClient("https://chat.example/notify", "secret", "bob@example.com", request);
  const settings = new NotificationSettingsStore(await mkdtemp(path.join(tmpdir(), "comote-notify-service-")));
  await settings.init();
  const events = new EventHub();
  const notifications = new NotificationService(ping, settings, events);
  notifications.trackTurn("thread-1", "Demo <unsafe>");

  events.publish("thread-1", "approval", { requestId: "approval-1", command: "secret command" });
  events.publish("thread-1", "status", { method: "turn/completed", turn: { status: "completed" } });
  await waitFor(() => payloads.length === 2);
  assert.match(payloads[0].title, /approval/);
  assert.doesNotMatch(payloads[0].text, /secret command/);
  assert.match(payloads[1].title, /finished/);
  assert.match(payloads[1].text, /Demo unsafe/);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for notifications.");
}
