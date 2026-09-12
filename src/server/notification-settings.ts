import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface NotificationPreferences {
  turnComplete: boolean;
  approvalRequired: boolean;
  checkFailed: boolean;
  deploymentResult: boolean;
}

export const defaultNotificationPreferences: NotificationPreferences = {
  turnComplete: true,
  approvalRequired: true,
  checkFailed: true,
  deploymentResult: true,
};

export class NotificationSettingsStore {
  private readonly filePath: string;
  private preferences = { ...defaultNotificationPreferences };

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "notification-settings.json");
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const content = await readFile(this.filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!content) return;
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error("Notification settings are corrupt; refusing to replace them.");
    }
    this.preferences = parseNotificationPreferences(value);
  }

  get(): NotificationPreferences {
    return { ...this.preferences };
  }

  async set(value: unknown): Promise<NotificationPreferences> {
    this.preferences = parseNotificationPreferences(value);
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.preferences, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
    return this.get();
  }
}

export function parseNotificationPreferences(value: unknown): NotificationPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid notification preferences.");
  }
  const input = value as Record<string, unknown>;
  const parsed = { ...defaultNotificationPreferences };
  for (const key of Object.keys(parsed) as Array<keyof NotificationPreferences>) {
    if (typeof input[key] !== "boolean") throw new Error(`Notification preference ${key} must be true or false.`);
    parsed[key] = input[key];
  }
  return parsed;
}
