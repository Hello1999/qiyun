import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type {
  AgentSnapshot,
  AgentJob,
  AgentJobResult,
  Host,
  Service,
  LogLine,
  Mode,
  Task,
  TaskEvent,
  SignedJob,
} from "@qiyun/contracts";
import { ApiError, digest, redact, token } from "./security.js";
import { demoSnapshot } from "./demo.js";

export interface StoredSession {
  scope: string;
  mode: Mode;
  name: string;
  csrf: string;
  expires: number;
}
interface Row {
  value: string;
}
interface JobRow {
  id: string;
  host_id: string;
  service_id: string;
  task_id: string;
  value: string;
  state: string;
}
export const STALE_MS = 45_000;
const json = <T>(row: unknown): T | undefined =>
  row ? (JSON.parse((row as Row).value) as T) : undefined;

export class ControlStore {
  readonly db: DatabaseSync;
  readonly signingPublicKey: string;
  private readonly signingPrivateKey: string;
  private ownerToken?: string;
  constructor(path: string, options: { recover?: boolean } = {}) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (scope TEXT NOT NULL, host_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,host_id));
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, scope TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, service_id TEXT NOT NULL, task_id TEXT NOT NULL, value TEXT NOT NULL, state TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_resource ON jobs(service_id) WHERE state IN ('queued','running','unknown');
      CREATE TABLE IF NOT EXISTS pairings (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY);
    `);
    const keyPath =
      path === ":memory:"
        ? undefined
        : join(dirname(path), "job-signing-private.pem");
    const publicPath =
      path === ":memory:"
        ? undefined
        : join(dirname(path), "job-signing-public.pem");
    if (
      keyPath &&
      existsSync(keyPath) &&
      publicPath &&
      existsSync(publicPath)
    ) {
      this.signingPrivateKey = readFileSync(keyPath, "utf8");
      this.signingPublicKey = readFileSync(publicPath, "utf8");
    } else {
      const keys = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      this.signingPrivateKey = keys.privateKey;
      this.signingPublicKey = keys.publicKey;
      if (keyPath && publicPath) {
        writeFileSync(keyPath, keys.privateKey, { mode: 0o600, flag: "wx" });
        writeFileSync(publicPath, keys.publicKey, { mode: 0o644, flag: "wx" });
      }
    }
    // Only the owning server performs recovery; maintenance CLIs must not alter live tasks.
    if (options.recover !== false) {
      try {
        this.transaction(() => {
          const previousOwner = this.getSetting("server-owner");
          if (previousOwner) {
            const pid = Number(previousOwner.split(":")[0]);
            let alive = false;
            try {
              process.kill(pid, 0);
              alive = true;
            } catch (error) {
              alive = (error as NodeJS.ErrnoException).code === "EPERM";
            }
            if (alive)
              throw new Error("此数据库已有运行中的控制端，拒绝启动第二个实例");
          }
          this.ownerToken = `${process.pid}:${randomUUID()}`;
          this.setSetting("server-owner", this.ownerToken);
        });
      } catch (error) {
        this.db.close();
        throw error;
      }
      for (const row of this.db
        .prepare("SELECT * FROM jobs WHERE state='running'")
        .all() as unknown as JobRow[]) {
        this.db
          .prepare("UPDATE jobs SET state='unknown' WHERE id=?")
          .run(row.id);
        const task = this.getTask("live", row.task_id);
        task.status = "unknown";
        this.event(task, "warning", "控制端重启，执行结果待核实");
        this.saveTask("live", task);
      }
      for (const row of this.db
        .prepare("SELECT scope,value FROM tasks")
        .all() as unknown as { scope: string; value: string }[]) {
        const task = JSON.parse(row.value) as Task;
        if (task.status === "observing") {
          task.status = "failed";
          task.error = "控制端重启中断了规划，请重新提交请求";
          this.event(task, "warning", task.error);
          this.saveTask(row.scope, task);
        }
      }
    }
  }
  close(): void {
    if (this.ownerToken)
      this.db
        .prepare("DELETE FROM settings WHERE key='server-owner' AND value=?")
        .run(this.ownerToken);
    this.db.close();
  }
  getSetting(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
        | Row
        | undefined
    )?.value;
  }
  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  initialize(name: string, passwordHash: string): void {
    this.transaction(() => {
      if (this.getSetting("password"))
        throw new ApiError(409, "管理员已经初始化");
      this.setSetting("name", name);
      this.setSetting("password", passwordHash);
    });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  createSession(
    mode: Mode,
    name: string,
  ): { id: string; session: StoredSession } {
    for (const row of this.db
      .prepare("SELECT id,value FROM sessions")
      .all() as unknown as { id: string; value: string }[]) {
      const old = JSON.parse(row.value) as StoredSession;
      if (old.expires > Date.now()) continue;
      if (old.mode === "demo") {
        this.db.prepare("DELETE FROM snapshots WHERE scope=?").run(old.scope);
        this.db.prepare("DELETE FROM tasks WHERE scope=?").run(old.scope);
      }
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(row.id);
    }
    const id = token();
    const session: StoredSession = {
      scope: mode === "live" ? "live" : `demo:${randomUUID()}`,
      mode,
      name,
      csrf: token(),
      expires: Date.now() + 12 * 60 * 60_000,
    };
    this.db
      .prepare("INSERT INTO sessions VALUES (?,?)")
      .run(digest(id), JSON.stringify(session));
    if (mode === "demo")
      this.db
        .prepare("INSERT INTO snapshots VALUES (?,?,?)")
        .run(session.scope, "demo-tokyo", JSON.stringify(demoSnapshot()));
    return { id, session };
  }
  session(id: string | undefined): StoredSession | undefined {
    if (!id) return undefined;
    const session = json<StoredSession>(
      this.db.prepare("SELECT value FROM sessions WHERE id=?").get(digest(id)),
    );
    if (session && session.expires > Date.now()) return session;
    this.deleteSession(id);
    return undefined;
  }
  deleteSession(id: string): void {
    const session = json<StoredSession>(
      this.db.prepare("SELECT value FROM sessions WHERE id=?").get(digest(id)),
    );
    if (session?.mode === "demo") {
      this.db.prepare("DELETE FROM snapshots WHERE scope=?").run(session.scope);
      this.db.prepare("DELETE FROM tasks WHERE scope=?").run(session.scope);
    }
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(digest(id));
  }
  inventory(scope: string): { hosts: Host[]; services: Service[] } {
    const snapshots = this.db
      .prepare("SELECT value FROM snapshots WHERE scope=?")
      .all(scope)
      .map((row) => json<AgentSnapshot>(row)!);
    const hosts = snapshots.map((s) => ({
      ...s.host,
      status:
        scope !== "live" || Date.now() - Date.parse(s.host.lastSeen) <= STALE_MS
          ? ("online" as const)
          : ("offline" as const),
    }));
    const offline = new Set(
      hosts.filter((h) => h.status === "offline").map((h) => h.id),
    );
    return {
      hosts,
      services: snapshots
        .flatMap((s) => s.services)
        .map((s) =>
          offline.has(s.hostId)
            ? {
                ...s,
                status: "unknown" as const,
                state: "主机离线，最后已知状态不可确认",
              }
            : s,
        ),
    };
  }
  logs(scope: string, serviceId: string): LogLine[] {
    const service = this.inventory(scope).services.find(
      (s) => s.id === serviceId,
    );
    if (!service) throw new ApiError(404, "服务不存在");
    const snapshot = json<AgentSnapshot>(
      this.db
        .prepare("SELECT value FROM snapshots WHERE scope=? AND host_id=?")
        .get(scope, service.hostId),
    );
    return (snapshot?.logs[serviceId] ?? [])
      .slice(-100)
      .map((line) => ({
        ...line,
        message: redact(line.message).slice(0, 2000),
      }));
  }
  tasks(scope: string): Task[] {
    this.reconcileTimeouts();
    return this.db
      .prepare(
        "SELECT value FROM tasks WHERE scope=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(scope)
      .map((row) => json<Task>(row)!);
  }
  getTask(scope: string, id: string): Task {
    const task = json<Task>(
      this.db
        .prepare("SELECT value FROM tasks WHERE id=? AND scope=?")
        .get(id, scope),
    );
    if (!task) throw new ApiError(404, "任务不存在");
    return task;
  }
  saveTask(scope: string, task: Task): void {
    task.updatedAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO tasks VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(task.id, scope, JSON.stringify(task));
  }
  createTask(
    scope: string,
    mode: Mode,
    prompt: string,
    serviceId?: string,
    hostId?: string,
  ): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      prompt: redact(prompt),
      title: redact(prompt).slice(0, 80),
      status: "observing",
      createdAt: now,
      updatedAt: now,
      mode,
      serviceId,
      hostId,
      events: [],
    };
    this.event(
      task,
      "observation",
      mode === "demo" ? "演示任务 · 无真实服务器副作用" : "任务已建立",
      "正在读取允许范围内的状态",
    );
    this.saveTask(scope, task);
    return task;
  }
  event(
    task: Task,
    kind: TaskEvent["kind"],
    title: string,
    detail?: string,
  ): void {
    task.events.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      kind,
      title: redact(title),
      ...(detail ? { detail: redact(detail).slice(0, 4000) } : {}),
    });
  }
  plan(scope: string, task: Task, serviceId: string): void {
    const { hosts, services } = this.inventory(scope);
    const service = services.find((s) => s.id === serviceId);
    if (!service || !service.restartAllowed)
      throw new ApiError(403, "该服务没有重启权限");
    if (
      (task.serviceId && task.serviceId !== serviceId) ||
      (task.hostId && task.hostId !== service.hostId)
    )
      throw new ApiError(403, "操作超出本次任务范围");
    const host = hosts.find((h) => h.id === service.hostId);
    if (
      !host ||
      host.status !== "online" ||
      (scope === "live" &&
        Date.now() - Date.parse(service.updatedAt) > STALE_MS)
    )
      throw new ApiError(409, "目标状态已过期，请等待主机重新采集");
    const body = {
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      action: "service.restart" as const,
      hostId: service.hostId,
      serviceId,
      serviceName: service.name,
      expectedRevision: service.revision,
      impact: "服务会短暂中断，现有连接可能断开。",
      verification: "Agent 重启后检查服务运行状态；应用业务可用性需独立验证。",
      rollback: "重启不能回滚；失败时保留结果并停止后续操作。",
    };
    task.plan = {
      ...body,
      hash: digest(JSON.stringify({ taskId: task.id, scope, ...body })),
    };
    task.hostId = service.hostId;
    task.serviceId = serviceId;
    task.status = "awaiting_approval";
    this.event(
      task,
      "approval",
      "等待确认重启计划",
      "审批有效期 5 分钟，绑定当前服务配置版本",
    );
    this.saveTask(scope, task);
  }
  approve(scope: string, id: string, planHash: string): Task {
    this.reconcileTimeouts();
    return this.transaction(() => {
      const task = this.getTask(scope, id);
      const plan = task.plan;
      if (!plan || plan.hash !== planHash)
        throw new ApiError(409, "计划已改变或不匹配");
      if (
        ["queued", "running", "verifying", "succeeded", "unknown"].includes(
          task.status,
        )
      )
        return task;
      if (task.status !== "awaiting_approval")
        throw new ApiError(409, "此任务不能审批");
      if (Date.parse(plan.expiresAt) <= Date.now())
        throw new ApiError(409, "审批已过期，请创建新任务");
      const { hosts, services } = this.inventory(scope);
      const service = services.find((s) => s.id === plan.serviceId);
      if (
        !service ||
        !service.restartAllowed ||
        service.revision !== plan.expectedRevision ||
        hosts.find((h) => h.id === plan.hostId)?.status !== "online" ||
        (scope === "live" &&
          Date.now() - Date.parse(service.updatedAt) > STALE_MS)
      )
        throw new ApiError(409, "服务状态漂移或已离线，请重新规划");
      if (scope === "live") {
        const existing = this.db
          .prepare(
            "SELECT id FROM jobs WHERE service_id=? AND state IN ('queued','running','unknown')",
          )
          .get(service.id);
        if (existing)
          throw new ApiError(409, "该服务已有执行中或结果未知的任务");
        const job: AgentJob = {
          id: randomUUID(),
          taskId: id,
          hostId: plan.hostId,
          serviceId: plan.serviceId,
          action: plan.action,
          expectedRevision: plan.expectedRevision,
          expiresAt: plan.expiresAt,
        };
        this.db
          .prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?)")
          .run(
            job.id,
            job.hostId,
            job.serviceId,
            id,
            JSON.stringify(job),
            "queued",
          );
      }
      task.status = "queued";
      this.event(
        task,
        "approval",
        "计划已确认",
        `操作者：${scope === "live" ? (this.getSetting("name") ?? "管理员") : "演示会话"}；计划 ${plan.hash}，等待执行`,
      );
      this.saveTask(scope, task);
      return task;
    });
  }
  cancel(scope: string, id: string): Task {
    return this.transaction(() => {
      const task = this.getTask(scope, id);
      if (["succeeded", "failed", "cancelled", "expired"].includes(task.status))
        return task;
      if (["running", "verifying", "unknown"].includes(task.status)) {
        this.event(
          task,
          "warning",
          "已请求停止后续操作",
          "已经开始的重启无法可靠撤销，等待真实结果",
        );
      } else {
        task.status = "cancelled";
        this.db
          .prepare(
            "UPDATE jobs SET state='cancelled' WHERE task_id=? AND state='queued'",
          )
          .run(id);
        this.event(task, "warning", "任务已取消，未执行副作用");
      }
      this.saveTask(scope, task);
      return task;
    });
  }
  completeDemo(scope: string, id: string): void {
    const task = this.getTask(scope, id);
    if (task.mode !== "demo" || task.status !== "queued") return;
    task.status = "running";
    this.event(
      task,
      "execution",
      "模拟执行重启",
      "演示模式没有调用 Docker、systemd 或模型",
    );
    this.saveTask(scope, task);
    task.status = "verifying";
    this.event(task, "verification", "模拟健康检查通过");
    const snapshot = json<AgentSnapshot>(
      this.db
        .prepare("SELECT value FROM snapshots WHERE scope=? AND host_id=?")
        .get(scope, task.hostId!),
    );
    if (snapshot) {
      const service = snapshot.services.find((s) => s.id === task.serviceId);
      if (service) {
        service.status = "healthy";
        service.state = "running";
        service.revision = randomUUID();
        service.responseMs = 74;
      }
      this.db
        .prepare("UPDATE snapshots SET value=? WHERE scope=? AND host_id=?")
        .run(JSON.stringify(snapshot), scope, task.hostId!);
    }
    task.status = "succeeded";
    task.summary = "演示完成：模拟服务已恢复健康；没有操作真实服务器。";
    this.saveTask(scope, task);
  }
  createPairing(): { token: string; expiresAt: string } {
    const value = token();
    const expires = Date.now() + 5 * 60_000;
    this.db.prepare("DELETE FROM pairings WHERE expires<?").run(Date.now());
    this.db
      .prepare("INSERT INTO pairings VALUES (?,?)")
      .run(digest(value), expires);
    return { token: value, expiresAt: new Date(expires).toISOString() };
  }
  consumePairing(value: string, hostId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(hostId))
      throw new ApiError(400, "无效主机 ID");
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT expires FROM pairings WHERE hash=?")
        .get(digest(value)) as { expires: number } | undefined;
      if (!row || row.expires <= Date.now())
        throw new ApiError(403, "配对令牌无效或过期");
      if (this.db.prepare("SELECT id FROM hosts WHERE id=?").get(hostId))
        throw new ApiError(409, "主机 ID 已注册");
      this.db.prepare("DELETE FROM pairings WHERE hash=?").run(digest(value));
      this.registerHost(hostId);
    });
  }
  registerHost(hostId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO hosts VALUES (?)").run(hostId);
  }
  snapshot(hostId: string, snapshot: AgentSnapshot): void {
    if (
      snapshot.host.id !== hostId ||
      !this.db.prepare("SELECT id FROM hosts WHERE id=?").get(hostId)
    )
      throw new ApiError(403, "主机身份不匹配");
    if (
      snapshot.services.some(
        (s) => s.hostId !== hostId || !s.id.startsWith(`${hostId}:`),
      )
    )
      throw new ApiError(403, "服务超出主机范围");
    const now = new Date().toISOString();
    const clean: AgentSnapshot = {
      host: { ...snapshot.host, lastSeen: now },
      services: snapshot.services.map((s) => ({ ...s, updatedAt: now })),
      logs: {},
    };
    for (const service of clean.services)
      clean.logs[service.id] = (snapshot.logs[service.id] ?? [])
        .slice(-100)
        .map((l) => ({ ...l, message: redact(l.message).slice(0, 2000) }));
    this.db
      .prepare(
        "INSERT INTO snapshots VALUES (?,?,?) ON CONFLICT(scope,host_id) DO UPDATE SET value=excluded.value",
      )
      .run("live", hostId, JSON.stringify(clean));
  }
  jobs(hostId: string): SignedJob[] {
    this.reconcileTimeouts();
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT * FROM jobs WHERE host_id=? AND state='queued' LIMIT 10",
        )
        .all(hostId) as unknown as JobRow[];
      return rows.map((row) => {
        this.db
          .prepare("UPDATE jobs SET state='running' WHERE id=?")
          .run(row.id);
        const task = this.getTask("live", row.task_id);
        task.status = "running";
        this.event(
          task,
          "execution",
          "Agent 已领取任务",
          "只下发一次；失联时不会盲目重新执行",
        );
        this.saveTask("live", task);
        const bytes = Buffer.from(row.value, "utf8");
        return {
          payload: bytes.toString("base64"),
          signature: sign(null, bytes, this.signingPrivateKey).toString(
            "base64",
          ),
        };
      });
    });
  }
  result(hostId: string, result: AgentJobResult): void {
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM jobs WHERE id=? AND host_id=?")
        .get(result.jobId, hostId) as JobRow | undefined;
      if (!row) throw new ApiError(404, "任务不存在");
      if (["succeeded", "failed"].includes(row.state)) return;
      if (!["running", "unknown"].includes(row.state))
        throw new ApiError(409, "任务尚未下发或已取消");
      const task = this.getTask("live", row.task_id);
      task.status = result.status;
      this.event(
        task,
        result.status === "succeeded"
          ? "verification"
          : result.status === "failed"
            ? "error"
            : "warning",
        result.status === "succeeded"
          ? "Agent 执行及运行状态验证完成"
          : "Agent 返回执行结果",
        result.detail,
      );
      task.summary = redact(result.detail);
      if (result.status === "failed") task.error = redact(result.detail);
      this.db
        .prepare("UPDATE jobs SET state=? WHERE id=?")
        .run(result.status, row.id);
      this.saveTask("live", task);
    });
  }
  reconcileTimeouts(): void {
    for (const row of this.db
      .prepare("SELECT scope,value FROM tasks")
      .all() as unknown as { scope: string; value: string }[]) {
      const task = JSON.parse(row.value) as Task;
      if (
        task.status === "awaiting_approval" &&
        task.plan &&
        Date.parse(task.plan.expiresAt) <= Date.now()
      ) {
        task.status = "expired";
        this.event(task, "warning", "审批已过期，未执行操作");
        this.saveTask(row.scope, task);
      }
    }
    for (const row of this.db
      .prepare("SELECT * FROM jobs WHERE state IN ('queued','running')")
      .all() as unknown as JobRow[]) {
      const job = JSON.parse(row.value) as AgentJob;
      if (
        Date.parse(job.expiresAt) + (row.state === "running" ? 60_000 : 0) >
        Date.now()
      )
        continue;
      const task = this.getTask("live", row.task_id);
      task.status = row.state === "queued" ? "expired" : "unknown";
      this.event(
        task,
        "warning",
        row.state === "queued" ? "任务未下发即过期" : "等待结果超时，状态未知",
        "不会自动重复执行",
      );
      this.saveTask("live", task);
      this.db
        .prepare("UPDATE jobs SET state=? WHERE id=?")
        .run(task.status, row.id);
    }
  }
}
