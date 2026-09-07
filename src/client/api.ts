export interface Session {
  authenticated: true;
  csrf: string;
  deviceName: string;
  expiresAt: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
}

export interface Thread {
  id: string;
  name?: string | null;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
  turns?: Array<{ items?: ThreadItem[] }>;
  status?: { type?: string; activeFlags?: string[] };
}

export interface ThreadItem {
  id: string;
  type: string;
  text?: string;
  phase?: string;
  content?: Array<{ type: string; text?: string }>;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string;
  changes?: Array<{ path: string; kind: string; diff?: string }>;
}

export interface GitState {
  branch: string;
  status: string;
  diff: string;
}

export interface LiveEvent {
  id: string;
  threadId: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export class ApiClient {
  constructor(private csrf = "") {}

  setCsrf(value: string): void {
    this.csrf = value;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-comote-csrf": this.csrf,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, credentials: "same-origin" });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error ?? `Request failed (${response.status}).`);
    return payload as T;
  }
}

export const api = new ApiClient();
