import { writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { delay, publicCode } from "./common.mjs";
import { readAccounts, readGoneCount } from "./files.mjs";
import { prepareDirectory, acquireOwner, Store } from "./store.mjs";
import { reconcile, identify, validDelivery, chooseBatch, finishBatch } from "./state.mjs";
import { included } from "./options.mjs";
import { message } from "./message.mjs";
import { send } from "./channels.mjs";

export class Monitor {
  constructor({ directory, options, guard, log = () => {}, sender = send, clock = Date.now, sleep = delay }) {
    Object.assign(this, { directory, options, guard, log, sender, clock, sleep });
    this.controller = new AbortController();
    this.store = null;
    this.owner = null;
    this.running = null;
    this.statusWrites = Promise.resolve();
    this.lastLog = "";
    this.inflight = null;
    this.suspended = true;
  }
  start() {
    this.running ??= this.run();
    return this;
  }
  report(code) {
    if (this.lastLog !== code) {
      this.lastLog = code;
      try { this.log(code); } catch { /* logging must not break the gateway */ }
    }
  }
  async checkGuard() {
    let result;
    try { result = await this.guard(); } catch { result = { ok: false, code: "config_unreadable" }; }
    if (!result.ok) {
      this.suspended = true;
      this.inflight?.controller.abort();
      this.report(result.code);
      if (this.store) this.store.update((s) => { s.diagnostics.outcome = result.code; });
      if (["plugin_disabled", "plugin_removed", "config_changed", "config_ambiguous"].includes(result.code)) this.controller.abort();
    }
    return result.ok && !this.controller.signal.aborted;
  }
  status() {
    if (!this.store) return;
    this.statusWrites = this.statusWrites.then(async () => {
      if (!this.store) return;
      const s = this.store.read();
      const data = { ...s.diagnostics, ownerPid: process.pid,
        enabledChannels: this.options.channels.length,
        pending: s.outbox.filter((d) => d.status === "pending").length,
        blocked: s.outbox.filter((d) => d.status === "blocked").length,
        lapsed: Object.values(s.records).filter((r) => r.status === "lapsed").length,
        updatedAt: this.clock() };
      const temp = join(this.dir, `.status-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        await rename(temp, join(this.dir, "status.json"));
      } finally { await unlink(temp).catch(() => {}); }
    }).catch(() => { this.report("status_write_failed"); });
  }
  async run() {
    let delivery;
    try {
      if (!this.options.enabled) { this.report("disabled_by_option"); return; }
      while (!this.controller.signal.aborted) {
        if (await this.checkGuard()) {
          if (!this.owner) {
            this.dir ??= await prepareDirectory(this.directory);
            this.owner = await acquireOwner(this.dir);
            if (!this.owner) this.report("standby");
            else {
              this.store = await Store.open(this.dir);
              // A restart/config reload explicitly retries permanent channel failures.
              this.store.update((s) => { for (const d of s.outbox) if (d.status === "blocked") { d.status = "pending"; d.dueAt = this.clock(); } });
              delivery = this.deliverLoop();
            }
          }
          if (this.store) await this.scan();
        }
        this.status();
        await this.sleep(this.options.pollMs, this.controller.signal);
      }
    } catch (e) {
      this.report(publicCode(e, "monitor_failed"));
    } finally {
      this.controller.abort();
      this.inflight?.controller.abort();
      await delivery;
      await this.statusWrites;
      this.store?.close();
      this.store = null;
      this.owner?.release();
      this.owner = null;
    }
  }
  async scan() {
    try {
      const rows = await readAccounts(this.directory);
      if (this.controller.signal.aborted) return;
      const result = this.store.update((s) => reconcile(s, rows, this.options, this.clock()));
      this.suspended = !result.known;
      this.cancelObsolete();
      if (result.candidates) {
        await this.sleep(this.options.confirmMs, this.controller.signal);
        if (!await this.checkGuard()) return;
        const again = await readAccounts(this.directory);
        const confirmed = this.store.update((s) => reconcile(s, again, this.options, this.clock()));
        this.suspended = !confirmed.known;
        this.cancelObsolete();
      }
      const gone = await readGoneCount(this.directory);
      this.store.update((s) => { s.diagnostics.gone = gone; });
      this.report(this.store.read().diagnostics.outcome);
    } catch (e) {
      this.suspended = true;
      this.inflight?.controller.abort();
      const code = publicCode(e, "scan_failed");
      this.store.update((s) => { s.diagnostics.outcome = code; s.diagnostics.lastScanAt = this.clock(); });
      this.report(code);
    }
  }
  cancelObsolete() {
    if (!this.inflight) return;
    const s = this.store.read();
    if (this.suspended || this.inflight.ids.some((id) => !s.outbox.some((d) => d.id === id && validDelivery(s, d)))) this.inflight.controller.abort();
  }
  async deliverLoop() {
    try {
      while (!this.controller.signal.aborted) {
        if (!this.suspended) await this.deliver();
        await this.sleep(1000, this.controller.signal);
      }
    } catch (e) {
      this.report(publicCode(e, "delivery_failed"));
      this.controller.abort();
    }
  }
  async deliver() {
    const now = this.clock();
    let state = this.store.read();
    // No source-file polling every second while the send budget is exhausted.
    if (state.attempts.filter((t) => now - t < 3600000).length >= this.options.maxPerHour) return;
    let batch = chooseBatch(state, this.options, now);
    if (!batch.length) return;
    if (!await this.checkGuard()) return;
    const channel = this.options.channels.find((c) => c.ref === batch[0].channel);
    if (!channel) return;
    let rows;
    try { rows = await readAccounts(this.directory); }
    catch {
      this.suspended = true;
      this.store.update((s) => { s.diagnostics.outcome = "delivery_source_unknown"; });
      this.status(); return;
    }
    if (!rows.length && state.hadAccounts) { this.suspended = true; return; }
    if (this.controller.signal.aborted) return;
    const projected = rows.filter((r) => included(r, this.options)).map((r) => identify(r, state, this.options));
    const stillMatches = (d) => {
      const r = state.records[d.account];
      const p = projected.find((p) => p.key === d.account) ??
        (!r.idBased && projected.filter((p) => p.userKey === r.userKey).length === 1 ? projected.find((p) => p.userKey === r.userKey) : null);
      return p && (d.kind === "recovery" ? !p.lapsed : p.lapsed);
    };
    const invalid = batch.filter((d) => !stillMatches(d)).map((d) => d.id);
    this.store.update((s) => { s.outbox = s.outbox.filter((d) => !invalid.includes(d.id)); });
    // The scanner may have cleared/migrated records while file I/O was pending.
    state = this.store.read();
    batch = state.outbox.filter((d) => batch.some((b) => b.id === d.id) && validDelivery(state, d));
    if (!batch.length || this.suspended || !await this.checkGuard()) return;
    state = this.store.read();
    batch = state.outbox.filter((d) => batch.some((b) => b.id === d.id) && validDelivery(state, d));
    if (!batch.length || this.suspended || this.controller.signal.aborted) return;
    const allowed = this.store.update((s) => {
      s.attempts = s.attempts.filter((t) => now - t < 3600000);
      if (s.attempts.length >= this.options.maxPerHour) return false;
      s.attempts.push(now);
      return true;
    });
    if (!allowed) return;
    state = this.store.read();
    const ids = batch.map((d) => d.id);
    const controller = new AbortController();
    this.inflight = { ids, controller };
    let result;
    try {
      result = await this.sender(channel, message(state, batch, this.options), {
        signal: AbortSignal.any([controller.signal, this.controller.signal]), now,
      });
    } catch { result = { ok: false, code: "delivery_failed" }; }
    finally { this.inflight = null; }
    this.store.update((s) => finishBatch(s, ids, result, this.clock(), channel.label));
    this.status();
  }
  async stop() {
    this.controller.abort();
    this.inflight?.controller.abort();
    await this.running;
  }
}
