import net from "node:net";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Project } from "./projects.js";

export type DeploymentPhase = "idle" | "deploying" | "deployed" | "rolling_back" | "failed";

export interface DeploymentStatus {
  enabled: boolean;
  domainSuffix: string;
  disabledReason: string;
  phase: DeploymentPhase;
  slug: string;
  domain: string;
  url: string;
  release: string;
  previousRelease: string;
  kind: "" | "static" | "node";
  logs: string;
  updatedAt: string;
}

interface BrokerRequest {
  action: "deploy" | "rollback";
  projectName: string;
  sourcePath: string;
  slug: string;
}

interface BrokerResponse {
  ok: boolean;
  error?: string;
  release?: string;
  previousRelease?: string;
  kind?: "static" | "node";
  logs?: string;
}

type BrokerCall = (request: BrokerRequest) => Promise<BrokerResponse>;

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class DeploymentManager {
  private readonly states = new Map<string, DeploymentStatus>();
  private readonly activeProjects = new Set<string>();
  private readonly statePath: string;
  private persistQueue = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly domainSuffix: string,
    socketPath: string,
    private readonly brokerCall: BrokerCall = (request) => requestBroker(socketPath, request),
  ) {
    this.statePath = path.join(dataDir, "deployments.json");
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const saved = await readFile(this.statePath, "utf8").then((value) => JSON.parse(value) as Record<string, DeploymentStatus>).catch(() => ({}));
    for (const [projectId, state] of Object.entries(saved)) {
      this.states.set(projectId, state.phase === "deploying" || state.phase === "rolling_back"
        ? { ...state, phase: "failed", logs: `${state.logs}\nDeployment was interrupted by a Comote restart.`.trim(), updatedAt: new Date().toISOString() }
        : state);
    }
  }

  status(project: Project): DeploymentStatus {
    if (project.name === "comote") {
      return { ...emptyStatus(false, this.domainSuffix), disabledReason: "Comote itself stays private and cannot be published as a production app." };
    }
    const existing = this.states.get(project.id);
    if (existing) return { ...existing, enabled: Boolean(this.domainSuffix), domainSuffix: this.domainSuffix };
    return emptyStatus(Boolean(this.domainSuffix), this.domainSuffix);
  }

  start(project: Project, slugInput: string): DeploymentStatus {
    this.assertEnabled();
    this.assertPublishable(project);
    const slug = validateDeploymentSlug(slugInput);
    this.assertIdle(project.id);
    const existing = this.states.get(project.id);
    if (existing?.release && existing.slug !== slug) throw new Error("This project already uses a different production name.");
    const domain = `${slug}.${this.domainSuffix}`;
    const state: DeploymentStatus = {
      ...emptyStatus(true, this.domainSuffix),
      ...existing,
      enabled: true,
      domainSuffix: this.domainSuffix,
      disabledReason: "",
      phase: "deploying",
      slug,
      domain,
      url: `https://${domain}`,
      logs: "Deployment queued. Preparing a clean release from the canonical branch…",
      updatedAt: new Date().toISOString(),
    };
    this.states.set(project.id, state);
    this.activeProjects.add(project.id);
    void this.persist();
    void this.finish(project, state, {
      action: "deploy",
      projectName: project.name,
      sourcePath: project.path,
      slug,
    });
    return { ...state };
  }

  rollback(project: Project): DeploymentStatus {
    this.assertEnabled();
    this.assertPublishable(project);
    this.assertIdle(project.id);
    const current = this.states.get(project.id);
    if (!current?.slug || !current.previousRelease) throw new Error("No previous production release is available.");
    const state = {
      ...current,
      phase: "rolling_back" as const,
      logs: "Rollback queued…",
      updatedAt: new Date().toISOString(),
    };
    this.states.set(project.id, state);
    this.activeProjects.add(project.id);
    void this.persist();
    void this.finish(project, state, {
      action: "rollback",
      projectName: project.name,
      sourcePath: project.path,
      slug: current.slug,
    });
    return { ...state };
  }

  private async finish(project: Project, pending: DeploymentStatus, request: BrokerRequest): Promise<void> {
    try {
      const result = await this.brokerCall(request);
      if (!result.ok) {
        throw new Error([result.error || "Deployment broker rejected the request.", result.logs].filter(Boolean).join("\n"));
      }
      this.states.set(project.id, {
        ...pending,
        phase: "deployed",
        release: result.release ?? pending.release,
        previousRelease: result.previousRelease ?? "",
        kind: result.kind ?? pending.kind,
        logs: result.logs ?? "Deployment completed.",
        updatedAt: new Date().toISOString(),
      });
    } catch (cause) {
      this.states.set(project.id, {
        ...pending,
        phase: "failed",
        logs: (cause as Error).message,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      this.activeProjects.delete(project.id);
      await this.persist();
    }
  }

  private assertEnabled(): void {
    if (!this.domainSuffix) throw new Error("Production deployment is not configured on this server.");
  }

  private assertPublishable(project: Project): void {
    if (project.name === "comote") throw new Error("Comote itself stays private and cannot be deployed publicly.");
  }

  private assertIdle(projectId: string): void {
    if (this.activeProjects.has(projectId)) throw new Error("A deployment is already in progress for this project.");
  }

  private async persist(): Promise<void> {
    const save = async () => {
      const payload = Object.fromEntries(this.states);
      const temporary = `${this.statePath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.statePath);
    };
    this.persistQueue = this.persistQueue.then(save, save);
    await this.persistQueue;
  }
}

export function validateDeploymentSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (slug.length > 24 || !slugPattern.test(slug)) {
    throw new Error("Invalid deployment name. Use 1–24 lowercase letters, numbers, or single dashes.");
  }
  return slug;
}

function emptyStatus(enabled: boolean, domainSuffix: string): DeploymentStatus {
  return {
    enabled,
    domainSuffix,
    disabledReason: "",
    phase: "idle",
    slug: "",
    domain: "",
    url: "",
    release: "",
    previousRelease: "",
    kind: "",
    logs: "",
    updatedAt: "",
  };
}

function requestBroker(socketPath: string, request: BrokerRequest): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Deployment timed out after 15 minutes."));
    }, 15 * 60_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-2_000_000);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Deployment service is unavailable: ${error.message}`));
    });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(output) as BrokerResponse);
      } catch {
        reject(new Error("Deployment service returned an invalid response."));
      }
    });
  });
}
