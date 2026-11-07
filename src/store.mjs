import { Database } from "bun:sqlite";
import { mkdir, open, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Fault, object } from "./common.mjs";

const busy = (e) => /busy|locked/i.test(String(e?.code) + " " + String(e?.message));
async function privateFile(file) {
  try { const f = await open(file, "wx", 0o600); await f.close(); }
  catch (e) { if (e?.code !== "EEXIST") throw e; }
  await chmod(file, 0o600);
}

export async function prepareDirectory(directory) {
  const dir = join(directory, "account-reauth-notify");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

// A separate SQLite connection holds an OS-backed writer lock for our lifetime.
// No time-based lease stealing, PID checks, lock-file deletion, or directory scan.
// The kernel releases it after a crash. State commits use a different database.
export async function acquireOwner(dir) {
  let db;
  try {
    const file = join(dir, "owner.sqlite");
    await privateFile(file);
    db = new Database(file, { create: true });
    db.exec("PRAGMA busy_timeout=0");
    db.exec("CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL)");
    db.exec("BEGIN IMMEDIATE");
    db.exec("INSERT OR REPLACE INTO owner(id, value) VALUES(1, 1)");
    return { release() { if (db) { try { db.exec("ROLLBACK"); } finally { db.close(); db = null; } } } };
  } catch (e) {
    db?.close();
    if (busy(e)) return null;
    throw new Fault("owner_store_unavailable");
  }
}

function initial() {
  return { version: 1, instance: randomUUID(), salt: randomBytes(32).toString("hex"),
    hasSnapshot: false, hadAccounts: false, records: {}, outbox: [], attempts: [],
    diagnostics: { outcome: "starting", lastScanAt: null, lastSuccessAt: null, accounts: 0,
      gone: { status: "absent", count: 0 }, queueFull: 0, expired: 0, channelResults: {} } };
}
function validate(s) {
  if (!object(s) || s.version !== 1 || !/^[a-f0-9]{64}$/.test(s.salt) || typeof s.instance !== "string" ||
      typeof s.hasSnapshot !== "boolean" || typeof s.hadAccounts !== "boolean" || !object(s.records) || Object.keys(s.records).length > 4000 ||
      !Array.isArray(s.outbox) || s.outbox.length > 10000 || !Array.isArray(s.attempts) ||
      s.attempts.some((t) => !Number.isFinite(t)) || !object(s.diagnostics) || !object(s.diagnostics.channelResults)) throw new Fault("state_invalid");
  for (const [key, r] of Object.entries(s.records)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !object(r) || typeof r.userKey !== "string" || typeof r.label !== "string" ||
        !["healthy", "candidate", "lapsed", "removed"].includes(r.status) || !object(r.delivery) ||
        !Number.isFinite(r.lastObservedAt)) throw new Fault("state_invalid");
  }
  for (const d of s.outbox) {
    if (!object(d) || typeof d.id !== "string" || !s.records[d.account] || typeof d.channel !== "string" ||
        !["reauth", "recovery", "reminder"].includes(d.kind) || !["pending", "blocked"].includes(d.status) ||
        !Number.isFinite(d.dueAt) || !Number.isFinite(d.createdAt) || !Number.isFinite(d.attempts)) throw new Fault("state_invalid");
  }
  return s;
}

export class Store {
  static async open(dir) {
    let db;
    try {
      const file = join(dir, "state.sqlite");
      await privateFile(file);
      db = new Database(file, { create: true });
      db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
      db.exec("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
      if (!db.query("SELECT value FROM state WHERE id=1").get()) {
        db.query("INSERT INTO state(id, value) VALUES(1, ?)").run(JSON.stringify(initial()));
      }
      const store = new Store(db);
      store.read();
      return store;
    } catch (e) { db?.close(); throw e instanceof Fault ? e : new Fault("state_unavailable"); }
  }
  constructor(db) { this.db = db; }
  read() {
    try { return validate(JSON.parse(this.db.query("SELECT value FROM state WHERE id=1").get().value)); }
    catch (e) { throw e instanceof Fault ? e : new Fault("state_invalid"); }
  }
  update(fn) {
    try {
      return this.db.transaction(() => {
        const s = this.read();
        const result = fn(s);
        validate(s);
        this.db.query("UPDATE state SET value=? WHERE id=1").run(JSON.stringify(s));
        return result;
      })();
    } catch (e) { throw e instanceof Fault ? e : new Fault("state_write_failed"); }
  }
  close() { this.db.close(); }
}
