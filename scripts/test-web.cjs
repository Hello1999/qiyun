const { chromium } = require(
  process.env.QIYUN_PLAYWRIGHT_MODULE || "playwright",
);
const assert = require("node:assert/strict");
const fs = require("node:fs");
(async () => {
  const browser = await chromium.launch({
    channel: process.env.QIYUN_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(() => {
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
  });
  const page = await context.newPage();
  const errors = [];
  const checks = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const check = (name) => {
    checks.push(name);
    console.log("PASS", name);
  };
  const close = async () => {
    await page.getByRole("button", { name: "关闭面板" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  };
  try {
    await page.goto(process.env.QIYUN_WEB_URL || "http://127.0.0.1:5173");
    await page.getByRole("button", { name: "体验演示工作台" }).click();
    await page.locator(".stats-grid").waitFor();
    check("demo authentication and overview");
    await page.getByRole("button", { name: "语音输入" }).click();
    assert.match(await page.locator(".voice-note").innerText(), /不支持/);
    check("voice fallback remains editable");
    await page
      .getByRole("textbox", { name: "告诉栖云需要处理什么" })
      .fill("检查所有服务运行状况");
    await page.getByRole("button", { name: "发送任务" }).click();
    await page.locator(".result-card.succeeded").waitFor();
    check("natural language task and completion");
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(
        () => !!document.activeElement.closest("[role=dialog]"),
      ),
      true,
    );
    check("modal keyboard focus");
    await close();
    await page.locator(".service-card").filter({ hasText: "博客网站" }).click();
    await page.getByRole("button", { name: "服务日志", exact: true }).click();
    await page
      .getByText("[演示] upstream response exceeded 800ms", { exact: true })
      .waitFor();
    check("service log request");
    await page.getByRole("button", { name: "运行概况", exact: true }).click();
    await page.getByRole("button", { name: "重启服务", exact: true }).click();
    await page.getByRole("button", { name: "确认重启 博客网站" }).waitFor();
    await page.screenshot({ path: ".local/approval.png", fullPage: true });
    check("structured approval visible before write");
    await page.getByRole("button", { name: "确认重启 博客网站" }).click();
    await page.locator(".result-card.succeeded").waitFor();
    check("approved demo restart completion");
    await close();
    await page
      .locator(".service-card")
      .filter({ hasText: "PostgreSQL" })
      .click();
    assert.equal(
      await page.getByRole("button", { name: "重启服务", exact: true }).count(),
      0,
    );
    check("read-only service hides forbidden action");
    await close();
    await page
      .locator("nav button")
      .filter({ hasText: /^服务\s*4$/ })
      .click();
    await page
      .getByRole("textbox", { name: "查找服务", exact: true })
      .fill("nothing-matches");
    await page.getByRole("heading", { name: "没有找到匹配的服务" }).waitFor();
    await page.getByRole("button", { name: "清除搜索" }).click();
    await page.getByRole("button", { name: "数据库", exact: true }).click();
    assert.equal(await page.locator(".service-card").count(), 1);
    check("search and category filter");
    await page
      .locator("nav button")
      .filter({ hasText: /^操作记录$/ })
      .click();
    await page.locator(".task-table-row").first().waitFor();
    check("persisted task history");
    await page.getByRole("button", { name: /深色外观/ }).click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).color,
      ),
      "rgb(227, 235, 229)",
    );
    assert.equal(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).backgroundColor,
      ),
      "rgb(20, 29, 25)",
    );
    await page
      .locator("nav button")
      .filter({ hasText: /^概览$/ })
      .click();
    await page.locator(".stats-grid").waitFor();
    await page.screenshot({ path: ".local/dark.png", fullPage: true });
    check("dark theme");
    await page.getByRole("button", { name: /浅色外观/ }).click();
    await page.route("**/api/overview", (route) => route.abort());
    await page.locator(".page-heading button").click();
    await page.locator(".connection-banner").waitFor();
    assert.equal(await page.locator(".service-card").count(), 4);
    check("connection failure preserves last snapshot");
    await page.unroute("**/api/overview");
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.locator(".connection-banner").waitFor({ state: "hidden" });
    check("connection recovery");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole("button", { name: "打开导航" }).click();
      await page
        .locator("nav button")
        .filter({ hasText: /^设置$/ })
        .click();
      await page.getByRole("heading", { name: "工作台设置" }).waitFor();
      const size = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        width: innerWidth,
      }));
      assert.ok(size.scroll <= size.width + 1, JSON.stringify(size));
      check(`mobile ${width}px settings without horizontal overflow`);
      await page.getByRole("button", { name: "打开导航" }).click();
      await page
        .locator("nav button")
        .filter({ hasText: /^概览$/ })
        .click();
      await page.locator(".stats-grid").waitFor();
      const home = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        width: innerWidth,
      }));
      assert.ok(home.scroll <= home.width + 1, JSON.stringify(home));
      await page.screenshot({
        path: `.local/mobile-${width}.png`,
        fullPage: true,
      });
      check(`mobile ${width}px overview`);
    }
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "退出演示" }).click();
    await page.getByRole("button", { name: "体验演示工作台" }).waitFor();
    check("logout clears session");
    assert.deepEqual(errors, []);
    check("no uncaught browser errors");
    fs.writeFileSync(
      ".local/browser-report.json",
      JSON.stringify(
        { passed: true, checks, errors, at: new Date().toISOString() },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
