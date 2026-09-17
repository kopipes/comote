type JsonObject = Record<string, unknown>;

export interface AccountUsageWindow {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AccountUsage {
  ordinaryUsageAllowed: boolean | null;
  fiveHour: AccountUsageWindow | null;
  weekly: AccountUsageWindow | null;
  updatedAt: string;
}

export function parseAccountUsage(value: unknown, now = new Date()): AccountUsage {
  const response = asObject(value);
  const snapshots = asObject(response.rateLimitsByLimitId);
  const preferred = asObject(snapshots.codex);
  const fallback = Object.values(snapshots).map(asObject).find((entry) => entry.limitId === "codex");
  const rateLimits = Object.keys(preferred).length ? preferred : fallback ?? asObject(response.rateLimits);
  const primary = parseWindow(rateLimits.primary);
  const secondary = parseWindow(rateLimits.secondary);
  const windows = [primary, secondary].filter((entry): entry is AccountUsageWindow => Boolean(entry));

  return {
    ordinaryUsageAllowed: typeof response.ordinaryUsageAllowed === "boolean" ? response.ordinaryUsageAllowed : null,
    fiveHour: windows.find((entry) => entry.windowDurationMins === 300) ?? primary,
    weekly: windows.find((entry) => entry.windowDurationMins === 10_080) ?? secondary,
    updatedAt: now.toISOString(),
  };
}

function parseWindow(value: unknown): AccountUsageWindow | null {
  const window = asObject(value);
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return null;
  const usedPercent = Math.min(100, Math.max(0, Math.round(window.usedPercent)));
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins: finiteNumber(window.windowDurationMins),
    resetsAt: finiteNumber(window.resetsAt),
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
