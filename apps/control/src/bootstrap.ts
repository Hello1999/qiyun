import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { ControlStore } from "./store.js";
import { hashPassword, redact } from "./security.js";

async function secretPrompt(): Promise<string> {
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (input.length > 1024) throw new Error("密码输入过长");
    }
    return input.replace(/\r?\n$/, "");
  }
  process.stdout.write("管理员密码（至少 12 个字符，输入不回显）: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise<string>((resolveSecret, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("已取消初始化"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolveSecret(value);
          return;
        }
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else if (character >= " " && value.length < 257) value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = resolve(
    process.env.QIYUN_DATA_DIR || resolve(root, ".local"),
  );
  const store = new ControlStore(
    process.env.QIYUN_DB_PATH ?? resolve(dataDir, "qiyun.sqlite"),
    { recover: false },
  );
  try {
    if (store.getSetting("password"))
      throw new Error("管理员已经初始化；此工具不会覆盖现有密码");
    let name = process.env.QIYUN_ADMIN_NAME;
    if (!name && process.stdin.isTTY) {
      const reader = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      name = await reader.question("管理员名称: ");
      reader.close();
    }
    name = (name ?? "管理员").trim();
    const password = process.env.QIYUN_ADMIN_PASSWORD_FILE
      ? (await readFile(process.env.QIYUN_ADMIN_PASSWORD_FILE, "utf8")).replace(
          /\r?\n$/,
          "",
        )
      : await secretPrompt();
    if (name.length < 1 || name.length > 80)
      throw new Error("管理员名称须为 1–80 个字符");
    if (password.length < 12 || password.length > 256)
      throw new Error("密码须为 12–256 个字符");
    store.initialize(redact(name), await hashPassword(password));
    process.stdout.write("管理员初始化完成。现在可以在 Web 工作台登录。\n");
  } finally {
    store.close();
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? redact(error.message) : "初始化失败"}\n`,
  );
  process.exitCode = 1;
});
