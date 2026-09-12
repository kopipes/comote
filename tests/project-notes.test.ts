import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectNotesStore } from "../src/server/project-notes.js";

test("project notes persist privately and blank input clears them", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-notes-"));
  const store = new ProjectNotesStore(dataDir);
  await store.init();
  assert.equal(store.get("project-one"), "");
  await store.set("project-one", "  Mobile first. Use SQLite.  ");

  const reloaded = new ProjectNotesStore(dataDir);
  await reloaded.init();
  assert.equal(reloaded.get("project-one"), "Mobile first. Use SQLite.");
  await reloaded.set("project-one", "  ");
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "project-notes.json"), "utf8")), {});
});

test("project notes reject oversized input and corrupt storage", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-notes-corrupt-"));
  const store = new ProjectNotesStore(dataDir);
  await store.init();
  await assert.rejects(store.set("project", "x".repeat(10_001)), /10,000/);
  await writeFile(path.join(dataDir, "project-notes.json"), "{broken");
  await assert.rejects(new ProjectNotesStore(dataDir).init(), /corrupt/);
});

