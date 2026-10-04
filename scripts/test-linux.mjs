import { spawn, execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

// This acceptance test manages only newly created qiyun-fixture-* containers.
// The helper receives a one-container allowlist; the control process has no Docker socket.
const root = process.cwd();
const withArk = process.env.QIYUN_TEST_ARK === "1";
if (withArk && !process.env.ARK_API_KEY && !process.env.ARK_API_KEY_FILE)
  throw new Error("QIYUN_TEST_ARK requires server-side Ark credentials.");
const artifact = resolve(".local/artifacts/qiyun-agent-linux-amd64");
if (!existsSync(artifact))
  throw new Error(
    "Build the Linux agent to .local/artifacts/qiyun-agent-linux-amd64 first.",
  );
mkdirSync(resolve(".local"), { recursive: true });
const directory = mkdtempSync(resolve(".local/acceptance-"));
const suffix = randomBytes(4).toString("hex");
const serviceName = `qiyun-fixture-web-${suffix}`;
const agentName = `qiyun-fixture-agent-${suffix}`;
const image = `qiyun-agent-fixture:${suffix}`;
const hostId = `fixture-${suffix}`;
// Reserve available ports before starting our control process. A fixed occupied
// port could otherwise make the test send initialization requests to another app.
async function reservePort(port, host) {
  const listener = createServer();
  await new Promise((resolvePort, reject) => {
    listener.once("error", reject);
    listener.listen({ port, host, exclusive: true }, resolvePort);
  });
  return listener;
}
const requestedPort =
  process.env.QIYUN_TEST_PORT === undefined
    ? 0
    : Number(process.env.QIYUN_TEST_PORT);
if (
  !Number.isInteger(requestedPort) ||
  requestedPort < 0 ||
  requestedPort > 65534
)
  throw new Error(
    "QIYUN_TEST_PORT must be 0..65534; 0 or omitted selects available ports.",
  );
const webReservation = await reservePort(requestedPort, "127.0.0.1");
let gatewayReservation;
try {
  gatewayReservation = await reservePort(
    requestedPort ? requestedPort + 1 : 0,
    "0.0.0.0",
  );
} catch (error) {
  await new Promise((done) => webReservation.close(done));
  throw error;
}
const port = webReservation.address().port;
const gatewayPort = gatewayReservation.address().port;
await Promise.all(
  [webReservation, gatewayReservation].map(
    (listener) => new Promise((done) => listener.close(done)),
  ),
);
const origin = `http://127.0.0.1:${port}`;
const created = [];
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const pause = (ms) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
let output = "";
let sessionCookie = "";
let csrf = "";
const control = spawn(process.execPath, ["apps/control/dist/server.js"], {
  cwd: root,
  env: {
    ...process.env,
    QIYUN_DATA_DIR: directory,
    QIYUN_DB_PATH: join(directory, "qiyun.sqlite"),
    QIYUN_PORT: String(port),
    QIYUN_HOST: "127.0.0.1",
    QIYUN_AGENT_HOST: "0.0.0.0",
    QIYUN_AGENT_PORT: String(gatewayPort),
    QIYUN_AGENT_URL: `https://host.docker.internal:${gatewayPort}`,
    QIYUN_ALLOWED_ORIGINS: origin,
    ARK_API_KEY: withArk ? process.env.ARK_API_KEY || "" : "",
    ARK_API_KEY_FILE: withArk ? process.env.ARK_API_KEY_FILE || "" : "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
control.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
control.stderr.on("data", (chunk) => {
  output += chunk.toString();
});
async function api(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: origin,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookie = response.headers.get("set-cookie");
  if (cookie) sessionCookie = cookie.split(";")[0];
  const data = await response.json();
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${data.error || path}`);
  if (data.csrfToken) csrf = data.csrfToken;
  return data;
}
async function until(check, description, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check();
    if (value) return value;
    if (control.exitCode !== null) throw new Error(`Control exited: ${output}`);
    await pause(1000);
  }
  throw new Error(`Timed out: ${description}`);
}
try {
  await until(async () => {
    try {
      return await api("/api/session");
    } catch {
      return false;
    }
  }, "control startup");
  await api("/api/auth/setup", {
    name: "Acceptance fixture",
    password: randomBytes(24).toString("base64url"),
  });
  const pairing = await api("/api/pairing", {});
  const configDir = join(directory, "fixture");
  const contextDir = join(directory, "build");
  mkdirSync(configDir);
  mkdirSync(contextDir);
  copyFileSync(artifact, join(contextDir, "qiyun-agent-linux-amd64"));
  copyFileSync(
    resolve("tests/fixtures/agent-entrypoint.sh"),
    join(contextDir, "agent-entrypoint.sh"),
  );
  copyFileSync(
    resolve("tests/fixtures/Dockerfile"),
    join(contextDir, "Dockerfile"),
  );
  const config = {
    hostId,
    name: "Linux 验证环境",
    controlUrl: pairing.controlUrl,
    enrollmentUrl: pairing.controlUrl,
    caFile: "/var/lib/qiyun-agent/ca.pem",
    certificateFile: "/var/lib/qiyun-agent/client.pem",
    privateKeyFile: "/var/lib/qiyun-agent/client-key.pem",
    signingPublicKeyFile: "/var/lib/qiyun-agent/signing-public.pem",
    stateDir: "/var/lib/qiyun-agent",
    helperSocket: "/run/qiyun-helper/helper.sock",
    pollSeconds: 2,
  };
  const helperConfig = {
    ...config,
    stateDir: "/var/lib/qiyun-helper",
    signingPublicKeyFile: "/etc/qiyun/signing-public.pem",
    agentUid: 65534,
    agentGid: 65534,
    dockerSocket: "/var/run/docker.sock",
    dockerContainers: [serviceName],
    dockerRestartAllowlist: [serviceName],
    discoverManaged: false,
  };
  writeFileSync(join(configDir, "agent.json"), JSON.stringify(config));
  writeFileSync(join(configDir, "helper.json"), JSON.stringify(helperConfig));
  writeFileSync(join(configDir, "token"), pairing.token, { mode: 0o600 });
  copyFileSync(join(directory, "tls", "ca.pem"), join(configDir, "ca.pem"));
  docker("build", "-t", image, contextDir);
  docker(
    "run",
    "-d",
    "--name",
    serviceName,
    "--label",
    "qiyun.managed=true",
    "--entrypoint",
    "/bin/sh",
    "postgres:16-alpine",
    "-c",
    'echo "Qiyun isolated service is ready"; exec sleep 86400',
  );
  created.push(serviceName);
  docker(
    "run",
    "-d",
    "--name",
    agentName,
    "--add-host",
    "host.docker.internal:host-gateway",
    "-v",
    `${configDir}:/fixture:ro`,
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    image,
  );
  created.push(agentName);
  const overview = await until(async () => {
    const value = await api("/api/overview");
    return value.services.some((service) => service.hostId === hostId)
      ? value
      : false;
  }, "mTLS enrollment and Linux snapshot");
  assert.equal(overview.mode, "live");
  const service = overview.services.find((item) => item.hostId === hostId);
  assert.equal(service.name, serviceName);
  assert.equal(service.restartAllowed, true);
  const logs = await api(
    `/api/services/${encodeURIComponent(service.id)}/logs`,
  );
  assert.ok(
    logs.lines.some((line) => line.message.includes("isolated service")),
  );
  const startedBefore = docker(
    "inspect",
    "--format",
    "{{.State.StartedAt}}",
    serviceName,
  );
  const requested = await api("/api/tasks", {
    prompt: withArk
      ? "请为当前选中的这个隔离测试容器生成重启方案，等待我确认后再执行。目标已经明确，不需要扩大范围。"
      : "重启服务",
    serviceId: service.id,
  });
  const plan = await until(
    async () => {
      const value = await api(`/api/tasks/${requested.id}`);
      if (["failed", "succeeded", "unknown"].includes(value.status))
        throw new Error(
          `Expected a restart plan: ${value.error || value.summary || value.status}`,
        );
      return value.status === "awaiting_approval" ? value : false;
    },
    "approval plan",
    withArk ? 120000 : 45000,
  );
  if (withArk)
    assert.ok(
      plan.usage?.requests > 0,
      "The real planner must have made a model request.",
    );
  assert.equal(
    docker("inspect", "--format", "{{.State.StartedAt}}", serviceName),
    startedBefore,
  );
  const approved = await api(`/api/tasks/${plan.id}/approve`, {
    planHash: plan.plan.hash,
  });
  assert.equal(approved.status, "queued");
  const completed = await until(async () => {
    const value = await api(`/api/tasks/${plan.id}`);
    if (["failed", "unknown"].includes(value.status))
      throw new Error(JSON.stringify(value));
    return value.status === "succeeded" ? value : false;
  }, "real Docker restart and verification");
  const startedAfter = docker(
    "inspect",
    "--format",
    "{{.State.StartedAt}}",
    serviceName,
  );
  assert.notEqual(startedAfter, startedBefore);
  const repeated = await api(`/api/tasks/${plan.id}/approve`, {
    planHash: plan.plan.hash,
  });
  assert.equal(repeated.status, "succeeded");
  await pause(3000);
  assert.equal(
    docker("inspect", "--format", "{{.State.StartedAt}}", serviceName),
    startedAfter,
  );
  const report = {
    passed: true,
    withArk,
    usage: completed.usage,
    hostId,
    serviceName,
    checks: [
      "one-time enrollment",
      "mTLS snapshot",
      "scoped Docker discovery",
      "bounded real logs",
      ...(withArk ? ["real Ark natural-language restart planning"] : []),
      "approval before side effect",
      "signed job",
      "actual container restart",
      "post-execution verification",
      "duplicate approval did not restart twice",
    ],
    events: completed.events.map((event) => event.title),
    at: new Date().toISOString(),
  };
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  for (const name of created) {
    try {
      writeFileSync(join(directory, `${name}.log`), docker("logs", name));
    } catch {}
  }
  writeFileSync(join(directory, "control.log"), output);
  console.error(error instanceof Error ? error.message : error);
  console.error(`Fixture diagnostics: ${directory}`);
  process.exitCode = 1;
} finally {
  control.kill();
  for (const name of created.reverse()) {
    try {
      docker("rm", "-f", name);
    } catch {}
  }
  try {
    docker("image", "rm", image);
  } catch {}
}
