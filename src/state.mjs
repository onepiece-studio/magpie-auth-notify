import { randomUUID } from "node:crypto";
import { privateRef } from "./common.mjs";
import { included } from "./options.mjs";

export function identify(row, s, o) {
  const userKey = privateRef(s.salt, `codex:user:${row.user}`);
  const key = row.id ? privateRef(s.salt, `codex:id:${row.id}`) : userKey;
  const label = (row.id && (o.aliases[`id:${row.id.toLowerCase()}`] ?? o.aliases[row.id.toLowerCase()])) ?? o.aliases[row.user] ?? `账号 ${key.slice(0, 8)}`;
  return { key, userKey, label, idBased: Boolean(row.id), lapsed: row.lapsed };
}

export function migrateIDs(s, rows, o) {
  const projected = rows.filter((r) => included(r, o)).map((r) => identify(r, s, o));
  for (const p of projected) {
    if (!p.idBased || s.records[p.key] || projected.filter((r) => r.userKey === p.userKey).length !== 1) continue;
    const olds = Object.entries(s.records).filter(([, r]) => !r.idBased && r.userKey === p.userKey);
    if (olds.length !== 1) continue;
    const [oldKey, r] = olds[0];
    s.records[p.key] = { ...r, idBased: true };
    delete s.records[oldKey];
    for (const d of s.outbox) if (d.account === oldKey) d.account = p.key;
  }
  return projected;
}

function enqueue(s, account, r, channel, kind, now, o) {
  if (s.outbox.some((d) => d.account === account && d.incident === r.incident && d.channel === channel.ref && d.kind === kind)) return;
  if (s.outbox.length >= o.maxPending) { s.diagnostics.queueFull++; return; }
  s.outbox.push({ id: randomUUID(), account, incident: r.incident, channel: channel.ref,
    kind, createdAt: now, dueAt: now, attempts: 0, status: "pending" });
}

function expire(s, o, now) {
  s.outbox = s.outbox.filter((d) => {
    if (now - d.createdAt <= o.ttlMs) return true;
    const r = s.records[d.account];
    if (r?.incident === d.incident) {
      const v = r.delivery[d.channel] ?? {};
      if (d.kind === "reauth") v.expired = true;
      if (d.kind === "recovery") v.recoveryExpired = true;
      if (d.kind === "reminder") v.lastReminder = now;
      r.delivery[d.channel] = v;
    }
    s.diagnostics.expired++;
    return false;
  });
  s.attempts = s.attempts.filter((t) => now - t < 3600000);
}

export function reconcile(s, rows, o, now) {
  s.diagnostics.lastScanAt = now;
  if (!rows.length && s.hadAccounts) {
    s.diagnostics.outcome = "accounts_empty_unknown";
    return { candidates: false, known: false };
  }
  expire(s, o, now);
  const projected = migrateIDs(s, rows, o);
  const present = new Set(projected.map((p) => p.key));
  const channels = new Set(o.channels.map((c) => c.ref));
  s.outbox = s.outbox.filter((d) => channels.has(d.channel));
  for (const [key, r] of Object.entries(s.records)) {
    if (!present.has(key)) {
      r.status = "removed";
      r.removedAt ??= now;
      s.outbox = s.outbox.filter((d) => d.account !== key);
      if (now - r.removedAt > 7 * 86400000) delete s.records[key];
    }
  }
  for (const p of projected) {
    let r = s.records[p.key];
    if (!r) {
      r = s.records[p.key] = { userKey: p.userKey, idBased: p.idBased, label: p.label, status: "healthy",
        lastObservedAt: now, delivery: {}, existing: !s.hasSnapshot };
    }
    r.label = p.label;
    r.userKey = p.userKey;
    r.lastObservedAt = now;
    delete r.removedAt;
    if (p.lapsed) {
      if (r.status === "removed" && r.openedAt && !r.closedAt) r.status = "lapsed"; // don't replay a previously delivered incident
      if (r.status !== "candidate" && r.status !== "lapsed") {
        s.outbox = s.outbox.filter((d) => d.account !== p.key);
        r.status = "candidate"; r.candidateAt = now; r.incident = randomUUID(); r.delivery = {};
        r.existing = !s.hasSnapshot;
        delete r.closedAt; delete r.openedAt;
      } else if (r.status === "candidate" && now - r.candidateAt >= o.confirmMs) {
        r.status = "lapsed"; r.openedAt = r.candidateAt;
      }
    } else {
      if (r.status === "lapsed") r.closedAt = now;
      r.status = "healthy";
      s.outbox = s.outbox.filter((d) => d.account !== p.key || d.kind === "recovery");
    }
    if (r.status === "lapsed") {
      for (const channel of o.channels) {
        const delivered = r.delivery[channel.ref];
        if (!delivered?.sentAt && !delivered?.expired) enqueue(s, p.key, r, channel, "reauth", now, o);
        else if (delivered?.sentAt && o.reminderMs && now - (delivered.lastReminder ?? delivered.sentAt) >= o.reminderMs) {
          enqueue(s, p.key, r, channel, "reminder", now, o);
        }
      }
    } else if (r.status === "healthy" && o.notifyRecovery && r.closedAt) {
      for (const channel of o.channels) {
        const delivered = r.delivery[channel.ref];
        if (delivered?.sentAt && !delivered.recoveredAt && !delivered.recoveryExpired) enqueue(s, p.key, r, channel, "recovery", now, o);
      }
    }
  }
  if (!o.notifyRecovery) s.outbox = s.outbox.filter((d) => d.kind !== "recovery");
  // Bound historical accounts under sustained account churn. Active rows are
  // already capped by the reader; removed rows have no outstanding deliveries.
  const keys = Object.keys(s.records);
  if (keys.length > 4000) {
    const removed = keys.filter((k) => s.records[k].status === "removed")
      .sort((a, b) => s.records[a].removedAt - s.records[b].removedAt);
    for (const k of removed.slice(0, keys.length - 4000)) delete s.records[k];
  }
  s.hasSnapshot = true;
  s.hadAccounts ||= rows.length > 0;
  Object.assign(s.diagnostics, { outcome: "ready", lastSuccessAt: now, accounts: projected.length });
  return { known: true, candidates: projected.some((p) => s.records[p.key].status === "candidate") };
}

export function validDelivery(s, d) {
  const r = s.records[d.account];
  return r && r.incident === d.incident && (d.kind === "recovery" ? r.status === "healthy" && r.closedAt : r.status === "lapsed");
}

export function chooseBatch(s, o, now) {
  const ready = (d) => d.status === "pending" && d.dueAt <= now && now - d.createdAt <= o.ttlMs && validDelivery(s, d);
  const d = s.outbox.find(ready);
  if (!d) return [];
  return s.outbox.filter((x) => x.channel === d.channel && x.kind === d.kind && ready(x)).slice(0, 20);
}

export function finishBatch(s, ids, result, now, channelLabel, random = Math.random) {
  s.diagnostics.channelResults[channelLabel] = { at: now, outcome: result.code, status: result.status ?? null };
  s.outbox = s.outbox.filter((d) => {
    if (!ids.includes(d.id)) return true;
    if (!validDelivery(s, d)) return false;
    const r = s.records[d.account];
    if (result.ok) {
      const v = r.delivery[d.channel] ?? {};
      if (d.kind === "reauth") v.sentAt = now;
      else if (d.kind === "recovery") v.recoveredAt = now;
      else v.lastReminder = now;
      r.delivery[d.channel] = v;
      return false;
    }
    d.attempts++;
    d.status = result.permanent ? "blocked" : "pending";
    const wait = [30000, 120000, 600000][Math.min(d.attempts - 1, 2)] * (1 + random() * 0.2);
    d.dueAt = now + Math.max(wait, result.retryMs ?? 0);
    return true;
  });
}
