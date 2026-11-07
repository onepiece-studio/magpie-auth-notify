import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { options } from "../src/options.mjs";
import { reconcile, chooseBatch, finishBatch } from "../src/state.mjs";
import { message } from "../src/message.mjs";
import { fakeChannel } from "./helpers.mjs";

const rows = (lapsed = true, id = "a", user = "a@private.example") => [{ id, user, lapsed }];
const base = () => options({ channels: [fakeChannel] });
async function stateTest(fn) {
  const dir = await mkdtemp(join(tmpdir(), "notify-state-"));
  let store = await Store.open(dir);
  try { await fn(store, dir); }
  finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}
test("startup loss is confirmed, batched, persisted and not replayed after restart", async () => {
  await stateTest(async (store, dir) => {
    const o = base();
    const all = [...rows(), ...rows(true, "b", "b@private.example")];
    store.update((s) => reconcile(s, all, o, 1000));
    expect(store.read().outbox).toHaveLength(0);
    store.update((s) => reconcile(s, all, o, 3000));
    const batch = chooseBatch(store.read(), o, 3000);
    expect(batch).toHaveLength(2);
    const m = message(store.read(), batch, o);
    expect(m.body).toContain("启动时");
    expect(JSON.stringify(m)).not.toContain("private.example");
    store.update((s) => finishBatch(s, batch.map((d) => d.id), { ok: true, code: "sent" }, 4000, "webhook-1"));
    const reopened = await Store.open(dir);
    reopened.update((s) => reconcile(s, all, o, 5000));
    expect(reopened.read().outbox).toHaveLength(0);
    reopened.close();
  });
});
test("recovery and a later relapse have separate incidents; UNKNOWN/empty never recovers", async () => {
  await stateTest((store) => {
    const o = { ...base(), notifyRecovery: true };
    for (const at of [1000, 3000]) store.update((s) => reconcile(s, rows(), o, at));
    const old = store.read().outbox[0];
    store.update((s) => finishBatch(s, [old.id], { ok: true, code: "sent" }, 4000, "webhook-1"));
    store.update((s) => reconcile(s, [], o, 5000));
    expect(Object.values(store.read().records)[0].status).toBe("lapsed");
    expect(store.read().outbox).toHaveLength(0);
    store.update((s) => reconcile(s, rows(false), o, 6000));
    expect(store.read().outbox[0].kind).toBe("recovery");
    for (const at of [7000, 9000]) store.update((s) => reconcile(s, rows(), o, at));
    expect(store.read().outbox).toHaveLength(1);
    expect(store.read().outbox[0].kind).toBe("reauth");
    expect(store.read().outbox[0].incident).not.toBe(old.incident);
  });
});
test("an ID added later migrates an incident and its pending event without duplicate", async () => {
  await stateTest((store) => {
    const o = base();
    for (const at of [1000, 3000]) store.update((s) => reconcile(s, rows(true, null), o, at));
    const before = store.read().outbox[0];
    store.update((s) => reconcile(s, rows(), o, 4000));
    const after = store.read().outbox[0];
    expect(after.id).toBe(before.id);
    expect(after.account).not.toBe(before.account);
    expect(Object.keys(store.read().records)).toHaveLength(1);
  });
});
test("same email with separate workspace IDs stays separate; removal is not recovery", async () => {
  await stateTest((store) => {
    const o = { ...base(), notifyRecovery: true };
    const all = [...rows(true, "workspace-a"), ...rows(true, "workspace-b")];
    for (const at of [1000, 3000]) store.update((s) => reconcile(s, all, o, at));
    expect(store.read().outbox).toHaveLength(2);
    store.update((s) => reconcile(s, rows(true, "workspace-a"), o, 4000));
    expect(store.read().outbox).toHaveLength(1);
    expect(store.read().outbox[0].kind).toBe("reauth");
  });
});
test("channel failures retry independently; Retry-After wins and success never repeats", async () => {
  await stateTest((store) => {
    const o = options({ channels: [fakeChannel, { ...fakeChannel, url: "https://second.invalid/" }] });
    for (const at of [1000, 3000]) store.update((s) => reconcile(s, rows(), o, at));
    const [a, b] = store.read().outbox;
    store.update((s) => finishBatch(s, [a.id], { ok: true, code: "sent" }, 4000, "webhook-1"));
    store.update((s) => finishBatch(s, [b.id], { ok: false, code: "http_429", retryMs: 900000 }, 4000, "webhook-2", () => 0));
    store.update((s) => reconcile(s, rows(), o, 5000));
    expect(store.read().outbox).toHaveLength(1);
    expect(store.read().outbox[0].dueAt).toBe(904000);
    expect(chooseBatch(store.read(), o, 5000)).toHaveLength(0);
  });
});
test("queue cap defers unscheduled accounts and TTL doesn't silently replay expired alerts", async () => {
  await stateTest((store) => {
    const o = { ...base(), maxPending: 1, ttlMs: 10000 };
    const all = [...rows(), ...rows(true, "b", "b@private.example")];
    for (const at of [1000, 3000]) store.update((s) => reconcile(s, all, o, at));
    expect(store.read().outbox).toHaveLength(1);
    expect(store.read().diagnostics.queueFull).toBeGreaterThan(0);
    store.update((s) => reconcile(s, all, o, 14000));
    expect(store.read().diagnostics.expired).toBe(1);
    expect(store.read().outbox).toHaveLength(1);
    expect(Object.values(store.read().records).filter((r) => Object.values(r.delivery).some((d) => d.expired))).toHaveLength(1);
  });
});
test("unsent failures don't produce recovery notifications, and reminders are opt-in", async () => {
  await stateTest((store) => {
    const o = { ...base(), notifyRecovery: true };
    for (const at of [1000, 3000]) store.update((s) => reconcile(s, rows(), o, at));
    store.update((s) => reconcile(s, rows(false), o, 4000));
    expect(store.read().outbox).toHaveLength(0);
    for (const at of [5000, 7000]) store.update((s) => reconcile(s, rows(), o, at));
    const d = store.read().outbox[0];
    store.update((s) => finishBatch(s, [d.id], { ok: true, code: "sent" }, 8000, "webhook-1"));
    store.update((s) => reconcile(s, rows(), o, 100000));
    expect(store.read().outbox).toHaveLength(0);
    store.update((s) => reconcile(s, rows(), { ...o, reminderMs: 1000 }, 100001));
    expect(store.read().outbox[0].kind).toBe("reminder");
  });
});
