import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NotificationSettingsStore, defaultNotificationPreferences, parseNotificationPreferences } from "../src/server/notification-settings.js";

test("notification settings persist complete boolean preferences", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-notifications-"));
  const store = new NotificationSettingsStore(dataDir);
  await store.init();
  assert.deepEqual(store.get(), defaultNotificationPreferences);
  const saved = await store.set({ turnComplete: false, approvalRequired: true, checkFailed: false, deploymentResult: true });
  assert.equal(saved.turnComplete, false);
  const persisted = JSON.parse(await readFile(path.join(dataDir, "notification-settings.json"), "utf8"));
  assert.deepEqual(persisted, saved);
});

test("notification settings reject incomplete or corrupt values", async () => {
  assert.throws(() => parseNotificationPreferences({ turnComplete: true }), /approvalRequired/);
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-notifications-corrupt-"));
  await writeFile(path.join(dataDir, "notification-settings.json"), "{broken");
  await assert.rejects(new NotificationSettingsStore(dataDir).init(), /corrupt/);
});
