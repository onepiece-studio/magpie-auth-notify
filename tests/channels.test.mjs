import { test, expect } from "bun:test";
import { send, payload, retryAfter } from "../src/channels.mjs";
import { options } from "../src/options.mjs";

const m = { title: "账号提醒", body: "检查登录", ok: false, event: { id: "stable-event" } };
const channel = { type: "webhook", url: "https://webhook.invalid/SECRET" };

test("HTTP 200 business failures are not treated as delivery; response text is never propagated", async () => {
  for (const c of [
    { type: "feishu", webhook: channel.url }, { type: "dingtalk", webhook: channel.url },
    { type: "wecom", webhook: channel.url }, { type: "telegram", token: "SECRET", chatId: "1" },
  ]) {
    const result = await send(c, m, { fetcher: async () => Response.json({ code: 123, errcode: 123, ok: false, msg: "TOKEN_SECRET" }) });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  }
});
test("all nine channels form valid payloads and honor their success envelopes", async () => {
  const configs = [
    [{ type: "webhook", url: channel.url }, null],
    [{ type: "ntfy", topic: "topic" }, { id: "x" }],
    [{ type: "bark", key: "secret" }, { code: 200 }],
    [{ type: "gotify", server: "https://gotify.invalid", token: "secret" }, { id: 1 }],
    [{ type: "serverchan", key: "SCTsecret" }, { code: 0 }],
    [{ type: "feishu", webhook: channel.url, secret: "secret" }, { code: 0 }],
    [{ type: "dingtalk", webhook: channel.url, secret: "secret" }, { errcode: 0 }],
    [{ type: "wecom", webhook: channel.url }, { errcode: 0 }],
    [{ type: "telegram", token: "secret", chatId: 1 }, { ok: true }],
  ];
  for (const [raw, body] of configs) {
    const c = options({ channels: [raw] }).channels[0];
    const result = await send(c, m, { fetcher: async (url, opts) => {
      expect(url.startsWith("https://")).toBe(true);
      expect(opts.method).toBe("POST");
      expect(opts.redirect).toBe("error");
      expect(opts.signal).toBeDefined();
      if (c.type === "bark") expect(JSON.parse(opts.body).device_key).toBe("secret");
      if (c.type === "serverchan") expect(url).toContain("SCTsecret.send");
      return body === null ? new Response(null, { status: 204 }) : Response.json(body);
    } });
    expect(result.ok).toBe(true);
  }
  expect(payload(configs[5][0], m, 1700000000000)[1].sign).toHaveLength(44);
  expect(payload(configs[6][0], m, 1700000000000)[0]).toContain("timestamp=1700000000000");
});
test("rate limits, permanent errors, invalid JSON and large bodies are bounded", async () => {
  expect(await send(channel, m, { fetcher: async () => new Response("busy", { status: 429, headers: { "retry-after": "120" } }) }))
    .toMatchObject({ ok: false, permanent: false, retryMs: 120000 });
  expect(await send(channel, m, { fetcher: async () => new Response(null, { status: 401 }) }))
    .toMatchObject({ ok: false, permanent: true });
  const robot = { type: "feishu", webhook: channel.url };
  expect((await send(robot, m, { fetcher: async () => new Response("<html>SECRET</html>") })).code).toBe("invalid_response");
  expect((await send(robot, m, { fetcher: async () => new Response("x".repeat(70000)) })).ok).toBe(false);
  expect((await send(channel, m, { fetcher: async () => new Response("ok") })).ok).toBe(true);
  expect(retryAfter("Thu, 01 Jan 1970 00:02:00 GMT", 60000)).toBe(60000);
  const fail = await send(channel, m, { fetcher: async () => { throw new Error("SECRET in URL"); } });
  expect(JSON.stringify(fail)).not.toContain("SECRET");
});
test("real fetch posts only to a loopback fake receiver and carries stable event IDs", async () => {
  const seen = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    seen.push(await req.json());
    return new Response(null, { status: 204 });
  } });
  try {
    expect((await send({ type: "webhook", url: `http://127.0.0.1:${server.port}/` }, m)).ok).toBe(true);
    expect(seen[0].event.id).toBe("stable-event");
  } finally { server.stop(true); }
});
test("cancellation and timeouts abort HTTP without exposing URLs", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise(() => {}) });
  try {
    const result = await send({ type: "webhook", url: `http://127.0.0.1:${server.port}/SECRET` }, m, { timeoutMs: 30 });
    expect(result.code).toBe("network_or_timeout");
    const controller = new AbortController(); controller.abort();
    expect((await send(channel, m, { signal: controller.signal })).code).toBe("cancelled");
  } finally { server.stop(true); }
});
