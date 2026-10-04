import test from "node:test";
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { buildApp } from "./app.js";
import { ControlStore } from "./store.js";
import { demoSnapshot } from "./demo.js";
import type { Session, Task, AgentJob, Overview } from "@qiyun/contracts";

const origin = "http://localhost:4310";
async function harness() {
  const store = new ControlStore(":memory:");
  const app = await buildApp({ store, allowedOrigins: [origin] });
  await app.ready();
  return {
    app,
    store,
    close: async () => {
      await app.close();
      store.close();
    },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;
type Auth = { cookie: string; csrf: string };
async function auth(h: Harness, mode: "demo" | "live" = "demo"): Promise<Auth> {
  const response = await h.app.inject({
    method: "POST",
    url: mode === "demo" ? "/api/auth/demo" : "/api/auth/setup",
    headers: { origin, "content-type": "application/json" },
    payload:
      mode === "demo"
        ? {}
        : { name: "测试管理员", password: "safe-test-password-123" },
  });
  assert.equal(response.statusCode, 200, response.body);
  return {
    cookie: response.cookies[0]!.name + "=" + response.cookies[0]!.value,
    csrf: response.json<Session>().csrfToken!,
  };
}
function headers(auth: Auth) {
  return {
    origin,
    cookie: auth.cookie,
    "content-type": "application/json",
    "x-csrf-token": auth.csrf,
  };
}
async function create(h: Harness, a: Auth, serviceId: string): Promise<Task> {
  const response = await h.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: headers(a),
    payload: { prompt: "重启服务", serviceId },
  });
  assert.equal(response.statusCode, 202, response.body);
  const id = response.json<Task>().id;
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await h.app.inject({
      url: `/api/tasks/${id}`,
      headers: { cookie: a.cookie },
    });
    const task = result.json<Task>();
    if (task.status !== "observing") return task;
  }
  throw new Error("Task did not progress");
}
function seedLive(h: Harness): void {
  const snapshot = demoSnapshot();
  snapshot.host.id = "host1";
  snapshot.services = snapshot.services
    .slice(0, 1)
    .map((s) => ({ ...s, id: "host1:docker:blog", hostId: "host1" }));
  snapshot.logs = {};
  h.store.registerHost("host1");
  h.store.snapshot("host1", snapshot);
}

test("authentication, exact origin, CSRF and additional parameter rejection", async () => {
  const h = await harness();
  try {
    assert.equal((await h.app.inject("/api/overview")).statusCode, 401);
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/auth/demo",
          headers: {
            origin: "https://evil.example",
            "content-type": "application/json",
          },
          payload: {},
        })
      ).statusCode,
      403,
    );
    const a = await auth(h);
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/tasks",
          headers: { ...headers(a), "x-csrf-token": "wrong" },
          payload: { prompt: "查询" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/tasks",
          headers: headers(a),
          payload: { prompt: "查询", command: "rm -rf /" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/pairing",
          headers: headers(a),
          payload: {},
        })
      ).statusCode,
      403,
    );
  } finally {
    await h.close();
  }
});

test("demo sessions and live resources are isolated", async () => {
  const h = await harness();
  try {
    const a = await auth(h);
    const b = await auth(h);
    const live = await auth(h, "live");
    seedLive(h);
    const task = await create(h, a, "demo-blog");
    assert.equal(task.status, "awaiting_approval");
    assert.equal(
      (
        await h.app.inject({
          url: `/api/tasks/${task.id}`,
          headers: { cookie: b.cookie },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await h.app.inject({
          url: `/api/tasks/${task.id}`,
          headers: { cookie: live.cookie },
        })
      ).statusCode,
      404,
    );
    const demoOverview = (
      await h.app.inject({
        url: "/api/overview",
        headers: { cookie: a.cookie },
      })
    ).json<Overview>();
    const liveOverview = (
      await h.app.inject({
        url: "/api/overview",
        headers: { cookie: live.cookie },
      })
    ).json<Overview>();
    assert.equal(demoOverview.hosts[0]?.id, "demo-tokyo");
    assert.equal(liveOverview.hosts[0]?.id, "host1");
    assert.equal(
      (
        await h.app.inject({
          url: "/api/services/host1:docker:blog/logs",
          headers: { cookie: a.cookie },
        })
      ).statusCode,
      404,
    );
  } finally {
    await h.close();
  }
});

test("approval binds plan and revision; signed delivery is not replayed", async () => {
  const h = await harness();
  try {
    const a = await auth(h, "live");
    seedLive(h);
    const task = await create(h, a, "host1:docker:blog");
    assert.equal(task.status, "awaiting_approval");
    assert.equal(h.store.jobs("host1").length, 0);
    const approve = (hash: string) =>
      h.app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/approve`,
        headers: headers(a),
        payload: { planHash: hash },
      });
    assert.equal((await approve("0".repeat(64))).statusCode, 409);
    assert.equal((await approve(task.plan!.hash)).statusCode, 200);
    assert.equal((await approve(task.plan!.hash)).statusCode, 200);
    const jobs = h.store.jobs("host1");
    assert.equal(jobs.length, 1);
    assert.equal(h.store.jobs("host1").length, 0);
    const signed = jobs[0]!;
    const bytes = Buffer.from(signed.payload, "base64");
    assert.equal(
      verify(
        null,
        bytes,
        h.store.signingPublicKey,
        Buffer.from(signed.signature, "base64"),
      ),
      true,
    );
    const job = JSON.parse(bytes.toString("utf8")) as AgentJob;
    assert.throws(() =>
      h.store.result("different-host", {
        jobId: job.id,
        status: "succeeded",
        detail: "ok",
      }),
    );
    h.store.result("host1", {
      jobId: job.id,
      status: "succeeded",
      detail: "verified active",
    });
    h.store.result("host1", {
      jobId: job.id,
      status: "succeeded",
      detail: "duplicate",
    });
    assert.equal(h.store.getTask("live", task.id).status, "succeeded");
    assert.equal(
      h.store
        .getTask("live", task.id)
        .events.filter((e) => e.kind === "verification").length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("drift, stale observations and unknown results block unsafe repeat operations", async () => {
  const h = await harness();
  try {
    const a = await auth(h, "live");
    seedLive(h);
    const task = await create(h, a, "host1:docker:blog");
    const row = h.store.db
      .prepare("SELECT value FROM snapshots WHERE scope='live'")
      .get() as { value: string };
    const snapshot = JSON.parse(row.value) as ReturnType<typeof demoSnapshot>;
    snapshot.services[0]!.revision = "changed";
    h.store.snapshot("host1", snapshot);
    assert.throws(
      () => h.store.approve("live", task.id, task.plan!.hash),
      /漂移/,
    );
    const second = await create(h, a, "host1:docker:blog");
    h.store.approve("live", second.id, second.plan!.hash);
    const job = JSON.parse(
      Buffer.from(h.store.jobs("host1")[0]!.payload, "base64").toString(),
    ) as AgentJob;
    h.store.result("host1", {
      jobId: job.id,
      status: "unknown",
      detail: "lost result",
    });
    const third = await create(h, a, "host1:docker:blog");
    assert.throws(
      () => h.store.approve("live", third.id, third.plan!.hash),
      /未知/,
    );
    snapshot.host.lastSeen = new Date(Date.now() - 90_000).toISOString();
    snapshot.services[0]!.updatedAt = snapshot.host.lastSeen;
    h.store.db
      .prepare("UPDATE snapshots SET value=? WHERE scope='live'")
      .run(JSON.stringify(snapshot));
    assert.equal(h.store.inventory("live").hosts[0]?.status, "offline");
    const stale = await create(h, a, "host1:docker:blog");
    assert.equal(stale.status, "failed");
  } finally {
    await h.close();
  }
});

test("one-use pairing, cancellation before dispatch and missing provider credentials", async () => {
  const previous = process.env.ARK_API_KEY;
  const previousFile = process.env.ARK_API_KEY_FILE;
  delete process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY_FILE;
  const h = await harness();
  try {
    const pairing = h.store.createPairing();
    h.store.consumePairing(pairing.token, "paired-host");
    assert.throws(() => h.store.consumePairing(pairing.token, "another-host"));
    const a = await auth(h, "live");
    seedLive(h);
    const task = await create(h, a, "host1:docker:blog");
    h.store.approve("live", task.id, task.plan!.hash);
    h.store.cancel("live", task.id);
    assert.equal(h.store.jobs("host1").length, 0);
    assert.equal(h.store.getTask("live", task.id).status, "cancelled");
    const response = await h.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: headers(a),
      payload: { prompt: "检查服务状态" },
    });
    const id = response.json<Task>().id;
    for (let i = 0; i < 10; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.store.getTask("live", id).status, "failed");
    assert.match(h.store.getTask("live", id).error!, /Key/);
  } finally {
    await h.close();
    if (previous !== undefined) process.env.ARK_API_KEY = previous;
    if (previousFile !== undefined) process.env.ARK_API_KEY_FILE = previousFile;
  }
});

test("process restart preserves signing identity and marks dispatched commands unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "qiyun-store-test-"));
  let store: ControlStore | undefined;
  try {
    const path = join(dir, "state.sqlite");
    store = new ControlStore(path);
    const publicKey = store.signingPublicKey;
    const snapshot = demoSnapshot();
    snapshot.host.id = "persist";
    snapshot.services = snapshot.services
      .slice(0, 1)
      .map((s) => ({ ...s, id: "persist:docker:blog", hostId: "persist" }));
    snapshot.logs = {};
    store.registerHost("persist");
    store.snapshot("persist", snapshot);
    const task = store.createTask(
      "live",
      "live",
      "重启服务",
      "persist:docker:blog",
    );
    store.plan("live", task, "persist:docker:blog");
    store.approve("live", task.id, task.plan!.hash);
    assert.equal(store.jobs("persist").length, 1);
    store.close();
    store = new ControlStore(path);
    assert.equal(store.signingPublicKey, publicKey);
    assert.equal(store.getTask("live", task.id).status, "unknown");
    assert.equal(store.jobs("persist").length, 0);
    const next = store.createTask(
      "live",
      "live",
      "重启服务",
      "persist:docker:blog",
    );
    store.plan("live", next, "persist:docker:blog");
    assert.throws(
      () => store!.approve("live", next.id, next.plan!.hash),
      /未知/,
    );
  } finally {
    store?.close();
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("qiyun-store-test-"));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expired approval never creates a job; logout removes demo data and pending work", async () => {
  const h = await harness();
  try {
    const live = await auth(h, "live");
    seedLive(h);
    const task = await create(h, live, "host1:docker:blog");
    task.plan!.expiresAt = new Date(Date.now() - 1000).toISOString();
    h.store.saveTask("live", task);
    assert.throws(() => h.store.approve("live", task.id, task.plan!.hash));
    assert.equal(h.store.getTask("live", task.id).status, "expired");
    assert.equal(h.store.jobs("host1").length, 0);
    const demo = await auth(h);
    const result = await h.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: headers(demo),
      payload: { prompt: "看看有哪些服务异常" },
    });
    assert.equal(result.statusCode, 202);
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/auth/logout",
          headers: headers(demo),
          payload: {},
        })
      ).statusCode,
      200,
    );
    for (let i = 0; i < 3; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      (
        h.store.db
          .prepare(
            "SELECT count(*) AS count FROM tasks WHERE scope LIKE 'demo:%'",
          )
          .get() as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        await h.app.inject({
          url: "/api/overview",
          headers: { cookie: demo.cookie },
        })
      ).statusCode,
      401,
    );
  } finally {
    await h.close();
  }
});
