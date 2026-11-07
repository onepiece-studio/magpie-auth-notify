import { test, expect } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Monitor } from "../src/monitor.mjs";
import { configGuard } from "../src/files.mjs";
import { account, fixture, until, entryURL } from "./helpers.mjs";

test("idle startup alerts a lapsed on=false account, leaves healthy B alone, and does not alter source files", async () => {
  const f = await fixture({}, [account("a"), account("b", false)]);
  try {
    const source = await f.text("logins.json");
    f.monitor.start();
    await until(() => f.messages.length === 1);
    expect(f.messages[0].m.event.accounts).toHaveLength(1);
    expect(await f.text("logins.json")).toBe(source);
    await until(() => f.monitor.store?.read().outbox.length === 0);
    const saved = JSON.stringify(f.monitor.store.read());
    const all = saved + JSON.stringify(f.messages.map((x) => x.m)) + f.logs.join("\n");
    for (const secret of ["ACCESS_SECRET", "REFRESH_SECRET", "TOKEN_SECRET", "CHANNEL_SECRET", "private.example"]) expect(all).not.toContain(secret);
    await f.monitor.statusWrites;
    expect(await f.text("account-reauth-notify/status.json")).not.toContain("SECRET");
  } finally { await f.close(); }
});
test("restart reuses persistent delivery receipts and sends only a new incident", async () => {
  const f = await fixture();
  let next;
  try {
    f.monitor.start();
    await until(() => f.messages.length === 1 && f.monitor.store?.read().outbox.length === 0);
    await f.monitor.stop();
    const messages = [];
    next = new Monitor({ directory: f.dir, options: f.monitor.options,
      guard: configGuard(f.dir, entryURL, f.raw), sender: async (c, m) => { messages.push(m); return { ok: true, code: "sent" }; } }).start();
    await until(() => next.store?.read().diagnostics.lastSuccessAt);
    expect(next.store.read().outbox).toHaveLength(0);
    await f.rows([account("a", false)]);
    await until(() => Object.values(next.store.read().records)[0].status === "healthy");
    await f.rows([account("a", true)]);
    await until(() => messages.length === 1);
    expect(messages[0].event.accounts[0].incidentId).not.toBe(f.messages[0].m.event.accounts[0].incidentId);
  } finally { await next?.stop(); await f.close(); }
});
test("two overlapping hosts have one owner, and a waiting host takes over after release", async () => {
  const f = await fixture();
  let second;
  const sent = [];
  try {
    f.monitor.start();
    await until(() => f.monitor.store);
    second = new Monitor({ directory: f.dir, options: f.monitor.options,
      guard: configGuard(f.dir, entryURL, f.raw), sender: async () => { sent.push(1); return { ok: true, code: "sent" }; } }).start();
    await until(() => second.lastLog === "standby");
    await until(() => f.messages.length === 1 && f.monitor.store.read().outbox.length === 0);
    expect(sent).toHaveLength(0);
    await f.monitor.stop();
    await until(() => second.store?.read().diagnostics.lastSuccessAt);
    expect(second.store.read().outbox).toHaveLength(0);
    expect(sent).toHaveLength(0);
  } finally { await second?.stop(); await f.close(); }
});
test("a recovered account is rechecked before delivery and its queued alert is dropped", async () => {
  const f = await fixture();
  try {
    // Deterministically exercise startup and the pre-send path without a worker timer.
    f.monitor.start();
    await until(() => f.monitor.store?.read().outbox.length === 1);
    await f.rows([account("a", false)]);
    await f.monitor.deliver();
    expect(f.messages).toHaveLength(0);
    expect(f.monitor.store.read().outbox).toHaveLength(0);
  } finally { await f.close(); }
});
test("invalid/empty source preserves an incident and suppresses sends until readable again", async () => {
  const f = await fixture();
  try {
    f.monitor.start();
    await until(() => f.monitor.store?.read().outbox.length === 1);
    const incident = Object.values(f.monitor.store.read().records)[0].incident;
    await writeFile(join(f.dir, "logins.json"), "BROKEN SECRET");
    await f.monitor.deliver();
    expect(f.messages).toHaveLength(0);
    await until(() => f.monitor.store.read().diagnostics.outcome === "source_invalid_json");
    await f.rows([]);
    await until(() => f.monitor.store.read().diagnostics.outcome === "accounts_empty_unknown");
    expect(Object.values(f.monitor.store.read().records)[0].incident).toBe(incident);
    expect(Object.values(f.monitor.store.read().records)[0].status).toBe("lapsed");
    await f.rows([account()]);
    await until(() => f.messages.length === 1);
    expect(f.messages[0].m.event.accounts[0].incidentId).toBe(incident);
  } finally { await f.close(); }
});
test("disabling the plugin before delivery prevents the notification and stops its worker", async () => {
  const f = await fixture();
  try {
    f.monitor.start();
    await until(() => f.monitor.store?.read().outbox.length === 1);
    f.config.plugins[0].off = true; await f.configWrite();
    await f.monitor.deliver();
    await f.monitor.running;
    expect(f.messages).toHaveLength(0);
    expect(f.monitor.store).toBeNull();
    expect(f.logs).toContain("plugin_disabled");
  } finally { await f.close(); }
});
test("slow channel does not stop periodic scans, and options changes abort its in-flight send", async () => {
  const f = await fixture();
  let began = false, cancelled = false;
  f.monitor.sender = async (_c, _m, { signal }) => {
    began = true;
    return new Promise((resolve) => {
      const cancel = () => { cancelled = true; resolve({ ok: false, code: "cancelled" }); };
      if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
    });
  };
  try {
    f.monitor.start();
    await until(() => began);
    const at = f.monitor.store.read().diagnostics.lastSuccessAt;
    await until(() => f.monitor.store.read().diagnostics.lastSuccessAt > at);
    f.config.plugins[0].options = { ...f.raw, instanceName: "changed" }; await f.configWrite();
    await until(() => cancelled);
    await f.monitor.running;
    expect(f.logs).toContain("config_changed");
  } finally { await f.close(); }
});
test("gone hints and expired token fields alone never generate a notification", async () => {
  const f = await fixture({}, [{ ...account("a", false), auth: { exp: 0 } }]);
  try {
    await writeFile(join(f.dir, "codex-signin-gone.json"), JSON.stringify({ "/old/home": "a".repeat(64) }));
    f.monitor.start();
    await until(() => f.monitor.store?.read().diagnostics.gone.count === 1);
    expect(f.monitor.store.read().outbox).toHaveLength(0);
    expect(f.messages).toHaveLength(0);
  } finally { await f.close(); }
});
test("scanner awaits confirmation before scheduling its next poll; unrelated files never trigger scans", async () => {
  const f = await fixture({}, [account("a", false)]);
  const waits = [];
  const sleepers = [];
  f.monitor.sleep = (ms, signal) => {
    waits.push(ms);
    return new Promise((resolve) => {
      sleepers.push(resolve);
      signal.addEventListener("abort", resolve, { once: true });
    });
  };
  try {
    f.monitor.start();
    await until(() => f.monitor.store?.read().diagnostics.lastSuccessAt);
    const at = f.monitor.store.read().diagnostics.lastSuccessAt;
    await writeFile(join(f.dir, "unrelated.json"), "{}");
    await f.rows([account()]);
    expect(f.monitor.store.read().diagnostics.lastSuccessAt).toBe(at);
    expect(f.monitor.store.read().outbox).toHaveLength(0);
    expect(waits.filter((v) => v === 30)).toHaveLength(1);
  } finally { await f.close(); }
});
