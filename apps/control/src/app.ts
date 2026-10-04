import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import { existsSync } from "node:fs";
import type { Session, Overview, Task, LogLine } from "@qiyun/contracts";
import { createTaskSchema, approveTaskSchema } from "@qiyun/contracts";
import { ControlStore, type StoredSession } from "./store.js";
import { ApiError, checkPassword, hashPassword, redact } from "./security.js";
import { planWithArk, providerStatus } from "./provider.js";

export interface AppOptions {
  store: ControlStore;
  allowedOrigins?: string[];
  agentControlUrl?: string;
  webRoot?: string;
  demoEnabled?: boolean;
}
const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", additionalProperties: false, properties, required });
const passwordSchema = { type: "string", minLength: 12, maxLength: 256 };
const taskParams = objectSchema(
  { id: { type: "string", minLength: 1, maxLength: 160 } },
  ["id"],
);
const emptyBody = objectSchema({});

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    logger: false,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
      },
    },
  });
  const store = options.store;
  const origins = options.allowedOrigins ?? [
    "http://localhost:4310",
    "http://127.0.0.1:4310",
  ];
  const demoEnabled = options.demoEnabled ?? true;
  const attempts = new Map<string, { count: number; until: number }>();
  const planning = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  await app.register(cookie);
  const current = (request: FastifyRequest) =>
    store.session(request.cookies.qiyun_session);
  const discardSession = (id: string) => {
    const old = store.session(id);
    if (old?.mode === "demo")
      for (const task of store.tasks(old.scope)) planning.get(task.id)?.abort();
    store.deleteSession(id);
  };
  const requireSession = (request: FastifyRequest): StoredSession => {
    const s = current(request);
    if (!s) throw new ApiError(401, "请先登录");
    return s;
  };
  const sessionView = (s?: StoredSession): Session => ({
    authenticated: !!s,
    setupRequired: !store.getSetting("password"),
    demoAvailable: demoEnabled,
    ...(s ? { name: s.name, mode: s.mode, csrfToken: s.csrf } : {}),
  });
  function throttle(key: string, limit: number, windowMs: number): void {
    const now = Date.now();
    for (const [k, item] of attempts) if (item.until < now) attempts.delete(k);
    const item = attempts.get(key) ?? { count: 0, until: now + windowMs };
    item.count++;
    attempts.set(key, item);
    if (item.count > limit) throw new ApiError(429, "请求过于频繁，请稍后再试");
  }
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (!request.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    const path = request.url.split("?")[0];
    const bootstrapping = [
      "/api/auth/demo",
      "/api/auth/setup",
      "/api/auth/login",
    ].includes(path!);
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (!origins.includes(request.headers.origin ?? ""))
        throw new ApiError(403, "请求来源不被允许");
      if (
        !request.headers["content-type"]
          ?.toLowerCase()
          .startsWith("application/json")
      )
        throw new ApiError(415, "请求必须使用 JSON");
      if (!bootstrapping) {
        const s = requireSession(request);
        if (request.headers["x-csrf-token"] !== s.csrf)
          throw new ApiError(403, "CSRF 校验失败，请刷新后重试");
      }
    }
    if (path !== "/api/session" && !bootstrapping) requireSession(request);
    if (bootstrapping) {
      throttle(`auth:${request.ip}`, 10, 60_000);
      throttle("auth:global", 60, 60_000);
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const candidate =
      typeof error === "object" && error !== null
        ? (error as {
            statusCode?: unknown;
            validation?: unknown;
            message?: unknown;
          })
        : {};
    const status =
      typeof candidate.statusCode === "number" &&
      candidate.statusCode >= 400 &&
      candidate.statusCode < 600
        ? candidate.statusCode
        : 500;
    reply
      .code(status)
      .send({
        error:
          status === 500
            ? "服务器内部错误，请稍后重试"
            : candidate.validation
              ? "请求参数不符合接口规范"
              : typeof candidate.message === "string"
                ? redact(candidate.message)
                : "请求失败",
      });
  });
  app.get("/api/session", async (request) => sessionView(current(request)));
  const establish = (
    request: FastifyRequest,
    reply: FastifyReply,
    mode: "live" | "demo",
    name: string,
  ): Session => {
    if (request.cookies.qiyun_session)
      discardSession(request.cookies.qiyun_session);
    const { id, session } = store.createSession(mode, name);
    reply.setCookie("qiyun_session", id, {
      httpOnly: true,
      sameSite: "strict",
      secure: request.headers.origin?.startsWith("https://") ?? false,
      path: "/",
      maxAge: 12 * 60 * 60,
    });
    return sessionView(session);
  };
  app.post(
    "/api/auth/demo",
    { schema: { body: emptyBody } },
    async (request, reply) => {
      if (!demoEnabled) throw new ApiError(404, "演示入口未启用");
      return establish(request, reply, "demo", "演示工作台");
    },
  );
  app.post<{ Body: { name: string; password: string } }>(
    "/api/auth/setup",
    {
      schema: {
        body: objectSchema(
          {
            name: { type: "string", minLength: 1, maxLength: 80 },
            password: passwordSchema,
          },
          ["name", "password"],
        ),
      },
    },
    async (request, reply) => {
      if (store.getSetting("password"))
        throw new ApiError(409, "管理员已经初始化");
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip))
        throw new ApiError(
          403,
          "首次管理员初始化只允许本机访问，请使用 SSH 本地端口转发",
        );
      store.initialize(
        redact(request.body.name),
        await hashPassword(request.body.password),
      );
      return establish(request, reply, "live", request.body.name);
    },
  );
  app.post<{ Body: { password: string } }>(
    "/api/auth/login",
    {
      schema: {
        body: objectSchema({ password: passwordSchema }, ["password"]),
      },
    },
    async (request, reply) => {
      const stored = store.getSetting("password");
      if (!stored || !(await checkPassword(request.body.password, stored)))
        throw new ApiError(401, "登录信息不正确");
      return establish(
        request,
        reply,
        "live",
        store.getSetting("name") ?? "管理员",
      );
    },
  );
  app.post(
    "/api/auth/logout",
    { schema: { body: emptyBody } },
    async (request, reply) => {
      if (request.cookies.qiyun_session)
        discardSession(request.cookies.qiyun_session);
      reply.clearCookie("qiyun_session", { path: "/" });
      return { ok: true };
    },
  );
  app.get("/api/overview", async (request): Promise<Overview> => {
    const s = requireSession(request);
    return {
      mode: s.mode,
      ...store.inventory(s.scope),
      tasks: store.tasks(s.scope),
      provider:
        s.mode === "demo"
          ? {
              configured: false,
              verified: false,
              model: "规则化演示 · 未调用模型",
              baseUrl: "",
            }
          : providerStatus(),
    };
  });
  app.get<{ Params: { id: string } }>(
    "/api/services/:id/logs",
    { schema: { params: taskParams } },
    async (request) => ({
      lines: store.logs(requireSession(request).scope, request.params.id),
    }),
  );
  app.post<{ Body: { prompt: string; serviceId?: string; hostId?: string } }>(
    "/api/tasks",
    { schema: { body: createTaskSchema } },
    async (request, reply) => {
      const s = requireSession(request);
      throttle(`task:${s.scope}`, 12, 60_000);
      if (
        store.tasks(s.scope).filter((t) => t.status === "observing").length >= 2
      )
        throw new ApiError(429, "已有任务正在分析，请稍后再试");
      const { prompt, serviceId, hostId } = request.body;
      const inventory = store.inventory(s.scope);
      if (!prompt.trim()) throw new ApiError(400, "请输入任务内容");
      if (
        (serviceId &&
          !inventory.services.some(
            (item) =>
              item.id === serviceId && (!hostId || item.hostId === hostId),
          )) ||
        (hostId && !inventory.hosts.some((item) => item.id === hostId))
      )
        throw new ApiError(404, "任务目标不存在");
      const task = store.createTask(s.scope, s.mode, prompt, serviceId, hostId);
      const controller = new AbortController();
      planning.set(task.id, controller);
      const work = runPlan(s, task, controller.signal).finally(() => {
        planning.delete(task.id);
        pending.delete(work);
      });
      pending.add(work);
      reply.code(202);
      return task;
    },
  );
  async function runPlan(
    s: StoredSession,
    task: Task,
    signal: AbortSignal,
  ): Promise<void> {
    // Yield until the initial observing response has been sent.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const alive = () =>
      !signal.aborted && store.getTask(s.scope, task.id).status === "observing";
    try {
      if (!alive()) return;
      const inventory = store.inventory(s.scope);
      const services = inventory.services.filter(
        (item) =>
          (!task.serviceId || item.id === task.serviceId) &&
          (!task.hostId || item.hostId === task.hostId),
      );
      const hosts = inventory.hosts
        .filter((item) => !task.hostId || item.id === task.hostId)
        .filter(
          (item) =>
            !task.serviceId ||
            services.some((service) => service.hostId === item.id),
        );
      if (task.prompt === "重启服务" && task.serviceId) {
        store.event(
          task,
          "analysis",
          "手动重启请求",
          "使用固定 service.restart 工具路径；未调用模型",
        );
        store.plan(s.scope, task, task.serviceId);
        return;
      }
      if (s.mode === "demo") {
        task.usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
        store.event(
          task,
          "analysis",
          "规则化演示分析",
          "此结果来自演示规则和样例数据，不是模型推理或真实监控",
        );
        if (/重启|restart|修复/.test(task.prompt)) {
          const target =
            services.find((item) => task.prompt.includes(item.name)) ??
            services.find((item) => item.id === task.serviceId) ??
            services.find((item) => item.status === "warning");
          if (!target) throw new ApiError(400, "请明确选择要重启的服务");
          store.plan(s.scope, task, target.id);
          return;
        }
        const warnings = services.filter((item) => item.status !== "healthy");
        task.summary = `演示观察：${hosts.length} 台主机、${services.length} 个服务。${warnings.length ? `${warnings.map((item) => item.name).join("、")} 需要关注；样例日志显示健康检查延迟。可选择服务并生成重启计划。` : "演示服务当前健康。"} 所有结果均为模拟数据。`;
      } else {
        const allowed = new Set(services.map((item) => item.id));
        const result = await planWithArk({
          prompt: task.prompt,
          hosts,
          services,
          signal,
          readLogs: async (id: string): Promise<LogLine[]> => {
            if (!allowed.has(id))
              throw new ApiError(403, "读取超出本次任务范围");
            return store.logs(s.scope, id);
          },
          onEvent: (event) => {
            if (alive()) {
              store.event(task, event.kind, event.title, event.detail);
              store.saveTask(s.scope, task);
            }
          },
        });
        if (!alive()) return;
        task.summary = redact(result.summary);
        task.usage = result.usage;
        if (result.restartServiceId) {
          if (!allowed.has(result.restartServiceId))
            throw new ApiError(403, "模型建议超出任务范围");
          store.plan(s.scope, task, result.restartServiceId);
          return;
        }
      }
      if (alive()) {
        task.status = "succeeded";
        store.event(task, "verification", "观察任务完成", "没有执行写操作");
        store.saveTask(s.scope, task);
      }
    } catch (error) {
      if (!signal.aborted) {
        try {
          if (store.getTask(s.scope, task.id).status !== "observing") return;
        } catch {
          return;
        }
        task.status = "failed";
        task.error = redact(
          error instanceof Error ? error.message : "任务失败",
        ).slice(0, 1000);
        store.event(task, "error", "任务未能完成", task.error);
        store.saveTask(s.scope, task);
      }
    }
  }
  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id",
    { schema: { params: taskParams } },
    async (request) => {
      store.reconcileTimeouts();
      return store.getTask(requireSession(request).scope, request.params.id);
    },
  );
  app.post<{ Params: { id: string }; Body: { planHash: string } }>(
    "/api/tasks/:id/approve",
    { schema: { params: taskParams, body: approveTaskSchema } },
    async (request) => {
      const s = requireSession(request);
      const task = store.approve(
        s.scope,
        request.params.id,
        request.body.planHash,
      );
      if (s.mode === "demo" && task.status === "queued") {
        store.completeDemo(s.scope, task.id);
        return store.getTask(s.scope, task.id);
      }
      return task;
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/cancel",
    { schema: { params: taskParams, body: emptyBody } },
    async (request) => {
      const s = requireSession(request);
      const result = store.cancel(s.scope, request.params.id);
      if (result.status === "cancelled") planning.get(result.id)?.abort();
      return result;
    },
  );
  app.post("/api/pairing", { schema: { body: emptyBody } }, async (request) => {
    const s = requireSession(request);
    if (s.mode !== "live") throw new ApiError(403, "演示模式不能接入真实主机");
    throttle("pairing", 5, 60_000);
    return {
      ...store.createPairing(),
      controlUrl: options.agentControlUrl ?? "https://localhost:4311",
    };
  });
  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(staticPlugin, { root: options.webRoot });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "接口不存在" })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", async () => {
    for (const controller of planning.values()) controller.abort();
    await Promise.allSettled(pending);
  });
  return app;
}
