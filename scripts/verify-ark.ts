import { planWithArk } from "../apps/control/src/provider.js";

// Read credentials only from the server environment or ARK_API_KEY_FILE.
// This bounded smoke test uses a fabricated inventory and never reaches a host.
const now = new Date().toISOString();
try {
  const result = await planWithArk({
    prompt:
      "请调用 read_inventory 查看范围内的服务，只读检查后用一句中文回答状态。不要重启或修改任何东西。",
    hosts: [
      {
        id: "smoke-host",
        name: "接口验证样例",
        address: "example.invalid",
        os: "Linux (fixture)",
        arch: "amd64",
        status: "online",
        cpu: 5,
        memory: 20,
        disk: 10,
        uptime: 60,
        lastSeen: now,
        labels: ["接口验证，不是真实主机"],
        history: [],
      },
    ],
    services: [
      {
        id: "smoke-host:docker:sample",
        hostId: "smoke-host",
        name: "sample",
        kind: "docker",
        category: "website",
        status: "healthy",
        state: "running",
        cpu: null,
        memory: null,
        description: "无副作用的模型接口验证样例",
        updatedAt: now,
        revision: "fixture-v1",
        restartAllowed: false,
      },
    ],
    readLogs: async () => [],
    onEvent: (event) =>
      console.log(JSON.stringify({ event: event.kind, title: event.title })),
  });
  console.log(
    JSON.stringify(
      {
        verified: true,
        summary: result.summary,
        usage: result.usage,
        proposedWrite: Boolean(result.restartServiceId),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      verified: false,
      error:
        error instanceof Error ? error.message : "Unknown provider failure",
    }),
  );
  process.exitCode = 1;
}
