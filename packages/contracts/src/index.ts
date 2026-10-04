export type Mode = "demo" | "live";
export type Health = "healthy" | "warning" | "critical" | "unknown";
export type TaskStatus =
  | "observing"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown"
  | "expired";
export interface Host {
  id: string;
  name: string;
  address: string;
  os: string;
  arch: string;
  status: "online" | "offline";
  /** CPU, memory and disk are percentages; null means not measured. Uptime is seconds. */
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  uptime: number;
  lastSeen: string;
  labels: string[];
  history: number[];
}
export interface Service {
  id: string;
  hostId: string;
  name: string;
  kind: "docker" | "systemd";
  category: "website" | "database" | "application" | "infrastructure";
  /** Service CPU is percent; memory is MB. Do not replace missing samples with zero. */
  status: Health;
  state: string;
  image?: string;
  url?: string;
  port?: string;
  cpu: number | null;
  memory: number | null;
  responseMs?: number;
  description: string;
  updatedAt: string;
  revision: string;
  restartAllowed: boolean;
}
export interface LogLine {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
}
export interface TaskEvent {
  id: string;
  at: string;
  kind:
    | "observation"
    | "analysis"
    | "approval"
    | "execution"
    | "verification"
    | "warning"
    | "error";
  title: string;
  detail?: string;
}
export interface RestartPlan {
  hash: string;
  expiresAt: string;
  action: "service.restart";
  hostId: string;
  serviceId: string;
  serviceName: string;
  expectedRevision: string;
  impact: string;
  verification: string;
  rollback: string;
}
export interface Usage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}
export interface Task {
  id: string;
  prompt: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  mode: Mode;
  hostId?: string;
  serviceId?: string;
  summary?: string;
  plan?: RestartPlan;
  events: TaskEvent[];
  error?: string;
  usage?: Usage;
}
export interface ProviderStatus {
  configured: boolean;
  model: string;
  baseUrl: string;
  verified: boolean;
}
export interface Overview {
  mode: Mode;
  hosts: Host[];
  services: Service[];
  tasks: Task[];
  provider: ProviderStatus;
}
export interface Session {
  authenticated: boolean;
  setupRequired: boolean;
  demoAvailable: boolean;
  name?: string;
  mode?: Mode;
  csrfToken?: string;
}
export interface AgentSnapshot {
  host: Host;
  services: Service[];
  logs: Record<string, LogLine[]>;
}
export interface AgentJob {
  id: string;
  taskId: string;
  hostId: string;
  serviceId: string;
  action: "service.restart";
  expectedRevision: string;
  expiresAt: string;
}
export interface SignedJob {
  payload: string;
  signature: string;
}
export interface AgentJobResult {
  jobId: string;
  status: "succeeded" | "failed" | "unknown";
  detail: string;
  revision?: string;
}

export const createTaskSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: 2000 },
    serviceId: { type: "string", maxLength: 160 },
    hostId: { type: "string", maxLength: 160 },
  },
} as const;
export const approveTaskSchema = {
  type: "object",
  additionalProperties: false,
  required: ["planHash"],
  properties: { planHash: { type: "string", pattern: "^[a-f0-9]{64}$" } },
} as const;
