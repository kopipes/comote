import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AttachmentStore, validateFilename } from "../src/server/attachments.js";

test("attachments are isolated by project and session and can be removed", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-attachments-"));
  const store = new AttachmentStore(dataDir);
  await store.init();
  const saved = await store.save("project-one", "thread-one", encodeURIComponent("mobile screenshot.png"), Buffer.from("image"));
  assert.equal(saved.name, "mobile screenshot.png");
  assert.equal(saved.size, 5);

  const [resolved] = await store.resolve("project-one", "thread-one", [saved.id]);
  assert.equal(resolved.name, saved.name);
  assert.equal((await stat(resolved.path)).mode & 0o777, 0o600);
  await assert.rejects(store.resolve("project-one", "thread-two", [saved.id]), /not found/);

  await store.remove("project-one", "thread-one", saved.id);
  await assert.rejects(store.resolve("project-one", "thread-one", [saved.id]), /not found/);
});

test("attachment validation rejects traversal, executables, duplicate ids, and large files", async () => {
  assert.throws(() => validateFilename(encodeURIComponent("../secret.txt")), /Invalid/);
  assert.throws(() => validateFilename("payload.exe"), /Unsupported/);
  assert.throws(() => validateFilename("%ZZ.png"), /Invalid/);
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-attachments-limits-"));
  const store = new AttachmentStore(dataDir);
  await store.init();
  await assert.rejects(store.save("project", "thread", "empty.txt", Buffer.alloc(0)), /between 1 byte/);
  await assert.rejects(store.save("project", "thread", "large.txt", Buffer.alloc(10 * 1024 * 1024 + 1)), /10 MB/);
  const saved = await store.save("project", "thread", "ok.md", Buffer.from("safe"));
  await assert.rejects(store.resolve("project", "thread", [saved.id, saved.id]), /Duplicate/);
});

test("removing a session clears only its attachment directory", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-attachments-cleanup-"));
  const store = new AttachmentStore(dataDir);
  await store.init();
  const first = await store.save("project", "thread-one", "first.txt", Buffer.from("one"));
  const second = await store.save("project", "thread-two", "second.txt", Buffer.from("two"));
  await store.removeThread("project", "thread-one");
  await assert.rejects(store.resolve("project", "thread-one", [first.id]), /not found/);
  assert.equal((await store.resolve("project", "thread-two", [second.id]))[0].name, "second.txt");
});

