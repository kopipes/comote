import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadModelStore } from "../src/server/thread-models.js";

test("thread model choices persist and Auto removes an override", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-models-"));
  const store = new ThreadModelStore(dataDir);
  await store.init();
  await store.set("thread-two", "gpt-fast");
  await store.set("thread-one", "gpt-deep");

  const reloaded = new ThreadModelStore(dataDir);
  await reloaded.init();
  assert.equal(reloaded.get("thread-one"), "gpt-deep");
  assert.equal(reloaded.get("thread-two"), "gpt-fast");
  assert.equal(reloaded.get("unknown"), "");

  await reloaded.set("thread-one", "");
  const saved = JSON.parse(await readFile(path.join(dataDir, "thread-models.json"), "utf8"));
  assert.deepEqual(saved, { "thread-two": "gpt-fast" });
});

test("removing an unknown thread does not create a state file", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-models-"));
  const store = new ThreadModelStore(dataDir);
  await store.init();
  await store.remove("unknown");
  await assert.rejects(readFile(path.join(dataDir, "thread-models.json")), { code: "ENOENT" });
});
