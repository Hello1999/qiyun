import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { existsSync } from "node:fs";

const major = Number(process.versions.node.split(".")[0]);
if (
  major < 24 ||
  (major === 24 && Number(process.versions.node.split(".")[1]) < 15)
) {
  console.error("Qiyun requires Node.js 24.15 or newer.");
  process.exit(1);
}
if (existsSync(".env")) process.loadEnvFile(".env");
const webRequire = createRequire(resolve("apps/web/package.json"));
const vite = resolve(
  dirname(webRequire.resolve("vite/package.json")),
  "bin/vite.js",
);
const children = [
  spawn(
    process.execPath,
    [
      "--env-file-if-exists=.env",
      "--import",
      "tsx",
      "apps/control/src/server.ts",
    ],
    { stdio: "inherit", env: process.env },
  ),
  spawn(process.execPath, [vite, "--host", "127.0.0.1"], {
    cwd: resolve("apps/web"),
    stdio: "inherit",
    env: {
      ...process.env,
      QIYUN_CONTROL_URL: `http://127.0.0.1:${process.env.QIYUN_PORT || 4310}`,
    },
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach((child) => child.kill());
  process.exitCode = code;
}
children.forEach((child) => {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => stop(code || 0));
});
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
