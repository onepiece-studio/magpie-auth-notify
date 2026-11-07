// Adapted from magpie-community/plugins packages/notify/channels.mjs (MIT).
// See THIRD_PARTY_NOTICES.md. Only configured delivery endpoints are accessed.
import { createHmac } from "node:crypto";

export function payload(c, m, now = Date.now()) {
  const base = (s) => String(s).replace(/\/+$/, "");
  const text = `${m.title}\n${m.body}`;
  switch (c.type) {
    case "ntfy": return [base(c.server ?? "https://ntfy.sh"), {
      topic: c.topic, title: m.title, message: m.body, priority: c.priority ?? 3,
      tags: c.tags ?? [m.ok ? "white_check_mark" : "warning"],
    }, c.token ? { authorization: `Bearer ${c.token}` } : {}];
    case "bark": return [`${base(c.server ?? "https://api.day.app")}/push`, {
      device_key: c.key, title: m.title, body: m.body, group: c.group ?? "magpie",
      ...(c.sound ? { sound: c.sound } : {}),
    }];
    case "gotify": return [`${base(c.server)}/message`, {
      title: m.title, message: m.body, ...(c.priority != null ? { priority: c.priority } : {}),
      ...(c.extras ? { extras: c.extras } : {}),
    }, { "X-Gotify-Key": c.token }];
    case "serverchan": {
      const v3 = String(c.key).match(/^sctp(\d+)t/i);
      return [v3 ? `https://${v3[1]}.push.ft07.com/send/${c.key}.send` : `https://sctapi.ftqq.com/${c.key}.send`,
        { title: m.title, desp: m.body }, {}, true];
    }
    case "feishu": {
      const b = { msg_type: "text", content: { text } };
      if (c.secret) {
        b.timestamp = String(Math.floor(now / 1000));
        b.sign = createHmac("sha256", `${b.timestamp}\n${c.secret}`).update("").digest("base64");
      }
      return [c.webhook, b];
    }
    case "dingtalk": {
      let url = c.webhook;
      if (c.secret) {
        const sign = createHmac("sha256", c.secret).update(`${now}\n${c.secret}`).digest("base64");
        url += `${url.includes("?") ? "&" : "?"}timestamp=${now}&sign=${encodeURIComponent(sign)}`;
      }
      return [url, { msgtype: "text", text: { content: text } }];
    }
    case "wecom": return [c.webhook, { msgtype: "text", text: { content: text } }];
    case "telegram": return [`${base(c.server ?? "https://api.telegram.org")}/bot${c.token}/sendMessage`, {
      chat_id: c.chatId, text, disable_web_page_preview: true,
    }];
    case "webhook": return [c.url, { title: m.title, body: m.body, event: m.event }, c.headers ?? {}];
    default: throw new Error("channel_invalid");
  }
}

export function retryAfter(value, now) {
  if (value == null) return 0;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 30 * 86400000)) : 0;
}

async function bodyJSON(res) {
  if (!res.body) return { value: null, empty: true };
  const reader = res.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) { await reader.cancel(); return { invalid: true }; }
      chunks.push(value);
    }
    if (!length) return { value: null, empty: true };
    try { return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }; }
    catch { return { invalid: true }; }
  } finally { reader.releaseLock(); }
}

export async function send(c, message, { signal, fetcher = fetch, now = Date.now(), timeoutMs = 10000 } = {}) {
  try {
    const [url, body, headers = {}, form = false] = payload(c, message, now);
    const deadline = AbortSignal.timeout(timeoutMs);
    const res = await fetcher(url, {
      method: "POST", redirect: "error",
      headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", ...headers },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    const after = retryAfter(res.headers.get("retry-after"), now);
    const parsed = await bodyJSON(res);
    if (!res.ok) return { ok: false, code: `http_${res.status}`, status: res.status,
      permanent: res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status), retryMs: after };
    if ((parsed.invalid || parsed.empty) && c.type !== "webhook") return { ok: false, code: "invalid_response", retryMs: after };
    const data = parsed.value;
    const code = data?.code ?? data?.errcode ?? data?.StatusCode;
    const businessOK = data?.ok !== false && (code == null || code === 0 || code === 200);
    if (!businessOK) {
      const retryMs = Math.max(after, retryAfter(data?.parameters?.retry_after, now));
      return { ok: false, code: "remote_rejected", retryMs,
        permanent: c.type === "telegram" && [400, 401, 403, 404].includes(data?.error_code) };
    }
    // Robots have defined success envelopes; an arbitrary 200 JSON isn't an ACK.
    const robot = {
      feishu: data?.code === 0 || data?.StatusCode === 0,
      dingtalk: data?.errcode === 0, wecom: data?.errcode === 0, telegram: data?.ok === true,
      serverchan: data?.code === 0, bark: data?.code === 200,
    };
    if (c.type in robot && !robot[c.type]) return { ok: false, code: "invalid_response", retryMs: after };
    return { ok: true, status: res.status, code: "sent" };
  } catch {
    // fetch/remote error text may include webhook tokens, headers or server echoes.
    return { ok: false, code: signal?.aborted ? "cancelled" : "network_or_timeout", permanent: false, retryMs: 0 };
  }
}
