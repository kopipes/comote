import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountUsage } from "../src/server/account-usage.js";

test("Codex account usage exposes the five-hour and weekly windows", () => {
  assert.deepEqual(parseAccountUsage({
    ordinaryUsageAllowed: true,
    rateLimits: {
      primary: { usedPercent: 87, windowDurationMins: 300, resetsAt: 1_789_662_051 },
      secondary: { usedPercent: 28, windowDurationMins: 10_080, resetsAt: 1_790_230_146 },
    },
  }, new Date("2026-09-17T12:00:00.000Z")), {
    ordinaryUsageAllowed: true,
    fiveHour: { usedPercent: 87, remainingPercent: 13, windowDurationMins: 300, resetsAt: 1_789_662_051 },
    weekly: { usedPercent: 28, remainingPercent: 72, windowDurationMins: 10_080, resetsAt: 1_790_230_146 },
    updatedAt: "2026-09-17T12:00:00.000Z",
  });
});

test("multi-bucket Codex usage is preferred and percentages are bounded", () => {
  const usage = parseAccountUsage({
    ordinaryUsageAllowed: false,
    rateLimits: {},
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 103.2, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: -2, windowDurationMins: 10_080, resetsAt: 123 },
      },
    },
  });

  assert.equal(usage.ordinaryUsageAllowed, false);
  assert.equal(usage.fiveHour?.remainingPercent, 0);
  assert.equal(usage.weekly?.remainingPercent, 100);
});
