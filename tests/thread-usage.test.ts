import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThreadContextUsage, ThreadUsageStore } from "../src/server/thread-usage.js";

test("Codex token usage becomes a bounded context percentage", () => {
  assert.deepEqual(parseThreadContextUsage({
    tokenUsage: {
      last: { totalTokens: 81_250 },
      total: { totalTokens: 220_000 },
      modelContextWindow: 100_000,
    },
  }, new Date("2026-09-10T00:00:00.000Z")), {
    usedTokens: 81_250,
    contextWindow: 100_000,
    percentage: 81,
    cumulativeTokens: 220_000,
    updatedAt: "2026-09-10T00:00:00.000Z",
  });

  assert.equal(parseThreadContextUsage({ tokenUsage: { last: {}, total: {}, modelContextWindow: null } }), null);
});

test("thread context usage survives a Comote restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-usage-"));
  const store = new ThreadUsageStore(dataDir);
  await store.init();
  await store.set("thread-one", {
    usedTokens: 45_000,
    contextWindow: 100_000,
    percentage: 45,
    cumulativeTokens: 90_000,
    updatedAt: "2026-09-10T00:00:00.000Z",
  });

  const reloaded = new ThreadUsageStore(dataDir);
  await reloaded.init();
  assert.equal(reloaded.get("thread-one")?.percentage, 45);
  await reloaded.remove("thread-one");
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "thread-usage.json"), "utf8")), {});
});
