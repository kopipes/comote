import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../src/server/session-store.js";

test("sessions persist hashed tokens and sanitized device names", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "comote-session-"));
  const store = new SessionStore(directory, 30);
  await store.init();
  const { token, session } = await store.create("My <Phone>");

  assert.equal(session.deviceName, "My Phone");
  const lastSeenAt = session.lastSeenAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await store.get(token) !== null, true);
  assert.equal(session.lastSeenAt, lastSeenAt, "recent activity should not cause another disk write");
  const file = await readFile(path.join(directory, "sessions.json"), "utf8");
  assert.equal(file.includes(token), false);

  await store.revoke(token);
  assert.equal(await store.get(token), null);
});
