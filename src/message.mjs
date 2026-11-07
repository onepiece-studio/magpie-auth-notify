import { digest } from "./common.mjs";

export function message(s, batch, o) {
  const recovery = batch[0].kind === "recovery";
  const accounts = batch.map((d) => {
    const r = s.records[d.account];
    return { ref: d.account.slice(0, 16), label: r.label, incidentId: d.incident,
      eventId: d.id, firstObservedAt: new Date(r.openedAt ?? r.candidateAt).toISOString() };
  });
  return {
    ok: recovery,
    title: recovery ? `【Magpie】${accounts.length} 个 Codex 账号的登录标记已解除` : `【Magpie】${accounts.length} 个 Codex 账号需要检查登录`,
    body: [
      `实例：${o.instanceName}`,
      ...accounts.map((a) => `• ${a.label}（首次观测：${a.firstObservedAt}）`),
      !recovery && batch.some((d) => s.records[d.account].existing) ? "包含插件启动时发现的已有失效记录。" : "",
      recovery ? "Magpie 保存的重新登录标记已解除；这不代表实时验证了所有模型。" : "Magpie 已记录这些账号需要重新登录。",
      recovery ? "" : "请在供应商 → Codex 中检查；若刚刚登录过，请以界面当前状态为准。",
    ].filter(Boolean).join("\n"),
    event: { id: digest(batch.map((d) => d.id).sort().join("\n")),
      kind: recovery ? "account.reauth_cleared" : batch[0].kind === "reminder" ? "account.reauth_reminder" : "account.reauth_required",
      instance: o.instanceName, instanceId: s.instance, accounts },
  };
}
