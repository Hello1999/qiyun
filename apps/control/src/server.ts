import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlStore } from "./store.js";
import { buildApp } from "./app.js";
import { startGateway } from "./gateway.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = resolve(process.env.QIYUN_DATA_DIR || resolve(root, ".local"));
const store = new ControlStore(
  process.env.QIYUN_DB_PATH ?? resolve(dataDir, "qiyun.sqlite"),
);
const port = Number(process.env.QIYUN_PORT ?? 4310);
const host = process.env.QIYUN_HOST ?? "127.0.0.1";
const app = await buildApp({
  store,
  allowedOrigins: (
    process.env.QIYUN_ALLOWED_ORIGINS || process.env.QIYUN_ORIGINS
  )
    ?.split(",")
    .map((value) => value.trim()) ?? [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ],
  agentControlUrl: process.env.QIYUN_AGENT_URL,
  demoEnabled: process.env.QIYUN_DEMO !== "false",
  webRoot: resolve(root, "apps/web/dist"),
});
const gateway = await startGateway(store, { dataDir });
app.addHook("onClose", async () => {
  await gateway.close();
  store.close();
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
await app.listen({ host, port });
console.log(`栖云控制端已启动: http://${host}:${port}`);
