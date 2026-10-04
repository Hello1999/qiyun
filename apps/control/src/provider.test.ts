import test from "node:test";
import assert from "node:assert/strict";
import { parseEventStream, planWithArk, redact } from "./provider.js";
import type { Service } from "@qiyun/contracts";

function stream(events: unknown[], end = true): Response {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") +
      (end ? "data: [DONE]\r\n\r\n" : ""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
  );
}
const delta = (value: unknown) => ({
  choices: [{ delta: value, finish_reason: null }],
});
const service: Service = {
  id: "svc-blog",
  hostId: "host-one",
  name: "Blog",
  kind: "docker",
  category: "website",
  status: "healthy",
  state: "running",
  cpu: 1,
  memory: 10,
  description: "",
  updatedAt: new Date().toISOString(),
  revision: "r1",
  restartAllowed: true,
};
const input = {
  prompt: "检查博客",
  hosts: [],
  services: [service],
  readLogs: async () => [],
  onEvent: () => {},
};

test("SSE handles fragmented UTF-8, CRLF and function arguments", async () => {
  const result = await parseEventStream(
    stream([
      delta({
        content: "检查中",
        tool_calls: [
          {
            index: 0,
            id: "c1",
            function: { name: "read_service_logs", arguments: '{"service' },
          },
        ],
      }),
      delta({
        tool_calls: [{ index: 0, function: { arguments: 'Id":"svc-blog"}' } }],
      }),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]),
  );
  assert.equal(result.content, "检查中");
  assert.equal(result.tools[0]?.function.arguments, '{"serviceId":"svc-blog"}');
  assert.equal(result.usage.prompt_tokens, 10);
});
test("truncated stream is never accepted as a complete plan", async () => {
  await assert.rejects(
    parseEventStream(stream([delta({ content: "unfinished" })], false)),
    /提前结束/,
  );
});
test("tool loop never accepts a resource outside the provided scope", async () => {
  const fetcher: typeof fetch = async () =>
    stream([
      delta({
        tool_calls: [
          {
            index: 0,
            id: "a",
            function: {
              name: "read_service_logs",
              arguments: '{"serviceId":"other"}',
            },
          },
        ],
      }),
    ]);
  await assert.rejects(
    planWithArk(input, { apiKey: "test", fetch: fetcher }),
    /范围之外/,
  );
});
test("unknown tools and extra fields fail closed", async () => {
  for (const [name, args] of [
    ["shell.exec", "{}"],
    ["read_inventory", '{"command":"id"}'],
  ]) {
    const fetcher: typeof fetch = async () =>
      stream([
        delta({
          tool_calls: [
            { index: 0, id: "a", function: { name, arguments: args } },
          ],
        }),
      ]);
    await assert.rejects(
      planWithArk(input, { apiKey: "test", fetch: fetcher }),
    );
  }
});
test("restart tool only returns a proposal and does not execute", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () =>
    ++requests === 1
      ? stream([
          delta({
            tool_calls: [
              {
                index: 0,
                id: "a",
                function: {
                  name: "propose_service_restart",
                  arguments: '{"serviceId":"svc-blog"}',
                },
              },
            ],
          }),
        ])
      : stream([delta({ content: "已准备重启建议，请确认。" })]);
  const result = await planWithArk(
    { ...input, prompt: "重启博客" },
    { apiKey: "test", fetch: fetcher },
  );
  assert.equal(result.restartServiceId, "svc-blog");
  assert.equal(result.usage.requests, 2);
});
test("upstream auth failures do not leak the key or response body", async () => {
  const fetcher: typeof fetch = async () =>
    new Response("secret-upstream-echo", { status: 401 });
  await assert.rejects(
    planWithArk(input, { apiKey: "test-key", fetch: fetcher }),
    (error: unknown) =>
      error instanceof Error &&
      /凭据/.test(error.message) &&
      !/secret-upstream|test-key/.test(error.message),
  );
});
test("common credentials are removed from model evidence", () => {
  assert.equal(
    redact("password=unsafe Bearer abc.def"),
    "password=[已隐藏] Bearer [已隐藏]",
  );
});
