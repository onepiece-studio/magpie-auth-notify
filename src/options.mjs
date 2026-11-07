import { canonical, cleanLabel, digest, Fault, object } from "./common.mjs";

const needs = {
  ntfy: ["topic"], bark: ["key"], gotify: ["server", "token"], serverchan: ["key"],
  feishu: ["webhook"], dingtalk: ["webhook"], wecom: ["webhook"],
  telegram: ["token", "chatId"], webhook: ["url"],
};
function number(o, k, def, min, max) {
  if (o[k] === undefined) return def;
  if (typeof o[k] !== "number" || !Number.isFinite(o[k]) || o[k] < min || o[k] > max) throw new Fault("options_invalid");
  return o[k];
}
function list(v) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 2000 || v.some((s) => typeof s !== "string" || !s || s.length > 1024)) throw new Fault("options_invalid");
  return v.map((s) => s.toLowerCase());
}
function endpoint(s) {
  try {
    const u = new URL(s);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw 0;
    return s;
  } catch { throw new Fault("channel_invalid"); }
}

export function options(raw = {}) {
  if (!object(raw)) throw new Fault("options_invalid");
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean" ||
      raw.notifyRecovery !== undefined && typeof raw.notifyRecovery !== "boolean") throw new Fault("options_invalid");
  const aliases = raw.accountAliases ?? {};
  if (!object(aliases) || Object.keys(aliases).length > 2000 ||
      Object.values(aliases).some((s) => typeof s !== "string" || !cleanLabel(s))) throw new Fault("options_invalid");
  if (raw.instanceName !== undefined && (typeof raw.instanceName !== "string" || !cleanLabel(raw.instanceName))) throw new Fault("options_invalid");
  const channels = raw.channels ?? [];
  if (!Array.isArray(channels) || channels.length > 16) throw new Fault("channels_invalid");
  const active = [];
  const keys = new Set();
  for (const c of channels) {
    if (!object(c)) throw new Fault("channel_invalid");
    if (c.off === true) continue;
    if (!Object.hasOwn(needs, c.type) || needs[c.type].some((k) => k === "chatId"
      ? !["string", "number"].includes(typeof c[k]) || String(c[k]).trim() === ""
      : typeof c[k] !== "string" || !c[k].trim())) throw new Fault("channel_invalid");
    for (const k of ["secret", "token", "server", "webhook", "url"]) {
      if (c[k] !== undefined && typeof c[k] !== "string") throw new Fault("channel_invalid");
    }
    for (const k of ["server", "webhook", "url"]) if (c[k] !== undefined) endpoint(c[k]);
    if (c.headers !== undefined && (!object(c.headers) || Object.values(c.headers).some((v) => typeof v !== "string"))) throw new Fault("channel_invalid");
    // Channel keys reveal neither URLs nor credentials. off/id don't change a destination.
    const { off, id, ...destination } = c;
    const key = digest(canonical(destination));
    if (keys.has(key)) throw new Fault("channel_duplicate");
    keys.add(key);
    active.push({ ...destination, ref: key, label: `${c.type}-${active.length + 1}` });
  }
  return {
    enabled: raw.enabled !== false,
    instanceName: cleanLabel(raw.instanceName ?? "Magpie"),
    pollMs: number(raw, "pollIntervalSeconds", 30, 5, 3600) * 1000,
    confirmMs: number(raw, "confirmSeconds", 2, 1, 60) * 1000,
    notifyRecovery: raw.notifyRecovery === true,
    reminderMs: number(raw, "reminderHours", 0, 0, 720) * 3600000,
    maxPerHour: Math.floor(number(raw, "maxNotificationsPerHour", 20, 1, 1000)),
    maxPending: Math.floor(number(raw, "maxPending", 1000, 1, 10000)),
    ttlMs: number(raw, "notificationTtlHours", 24, 1, 720) * 3600000,
    allow: list(raw.accountAllowlist), ignore: list(raw.accountIgnorelist),
    aliases: Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k.toLowerCase(), cleanLabel(v)])),
    channels: active,
  };
}

export function included(row, o) {
  const names = [row.user, ...(row.id ? [row.id.toLowerCase(), `id:${row.id.toLowerCase()}`] : [])];
  return (!o.allow.length || names.some((n) => o.allow.includes(n))) && !names.some((n) => o.ignore.includes(n));
}
