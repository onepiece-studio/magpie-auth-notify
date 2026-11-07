import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, Fault, object, PACKAGE } from "./common.mjs";

// Fixed files only. Never enumerate directories, watch files, or run commands.
export async function readJSON(file, maxBytes = 8 * 1024 * 1024) {
  let handle;
  try {
    handle = await open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Fault("source_not_regular");
    if (stat.size > maxBytes) throw new Fault("source_too_large");
    const chunks = [];
    let size = 0;
    while (size <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (size > maxBytes) throw new Fault("source_too_large");
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch { throw new Fault("source_invalid_json"); }
  } catch (e) {
    if (e instanceof Fault) throw e;
    throw new Fault(e?.code === "ENOENT" ? "source_missing" : "source_unreadable");
  } finally { await handle?.close(); }
}

export async function readAccounts(directory) {
  const raw = await readJSON(join(directory, "logins.json"));
  if (!Array.isArray(raw) || raw.length > 10000) throw new Fault("accounts_schema");
  const rows = [];
  const seen = new Set();
  for (const r of raw) {
    if (!object(r) || typeof r.agent !== "string") throw new Fault("accounts_schema");
    if (r.agent !== "codex") continue;
    if (typeof r.user !== "string" || !r.user.trim() || r.user.length > 1024 ||
        ["id", "lapsed"].some((k) => r[k] !== undefined && typeof r[k] !== "string") ||
        (r.id?.length ?? 0) > 256) throw new Fault("accounts_schema");
    const id = r.id || null;
    const user = r.user.toLowerCase();
    const key = id ? `id:${id}` : `user:${user}`;
    if (seen.has(key)) throw new Fault("accounts_duplicate");
    seen.add(key);
    // Neither auth nor lapsed's raw text leaves this reader.
    rows.push({ id, user, lapsed: Boolean(r.lapsed?.trim()) });
  }
  if (rows.length > 2000) throw new Fault("accounts_too_many");
  return rows;
}

export async function readGoneCount(directory) {
  try {
    const raw = await readJSON(join(directory, "codex-signin-gone.json"), 1024 * 1024);
    if (!object(raw) || Object.values(raw).some((v) => typeof v !== "string" || !/^[a-f0-9]{64}$/i.test(v))) {
      return { status: "invalid", count: 0 };
    }
    // Historical hints only: no paths or credential hashes are retained.
    return { status: "unverified", count: Object.keys(raw).length };
  } catch (e) {
    return { status: e.code === "source_missing" ? "absent" : "unavailable", count: 0 };
  }
}

const npmName = (s) => { const at = s.lastIndexOf("@"); return at > 0 ? s.slice(0, at) : s; };
const samePath = async (a, b) => {
  try { return await realpath(a) === await realpath(b); } catch { return false; }
};

// Magpie passes no plugin spec to server(). Resolve only explicitly named entries.
// Git installs are mapped through Magpie's plugins/package.json, as its Target does.
export function configGuard(directory, entryURL, initialOptions) {
  const entryFile = fileURLToPath(entryURL);
  const packageDir = dirname(entryFile);
  const initial = canonical(initialOptions ?? {});
  return async () => {
    let list;
    try { list = await readJSON(join(directory, "plugins.json"), 2 * 1024 * 1024); }
    catch { return { ok: false, code: "config_unreadable" }; }
    if (!object(list) || !Array.isArray(list.plugins)) return { ok: false, code: "config_invalid" };
    const matches = [];
    let dependencies;
    for (const e of list.plugins) {
      if (!object(e) || typeof e.spec !== "string") return { ok: false, code: "config_invalid" };
      const s = e.spec;
      let target;
      if (s.startsWith("file://")) {
        try { target = fileURLToPath(s); } catch { continue; }
      } else if (isAbsolute(s) || s.startsWith(".")) {
        target = resolve(directory, s);
      } else if (npmName(s) === PACKAGE) {
        target = join(directory, "plugins", "node_modules", PACKAGE);
      } else if (/^(github:|gitlab:|bitbucket:|git\+|git:|https?:)|^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(s)) {
        if (dependencies === undefined) {
          try { dependencies = (await readJSON(join(directory, "plugins", "package.json"), 1024 * 1024)).dependencies ?? {}; }
          catch { dependencies = {}; }
        }
        const names = Object.entries(dependencies).filter(([, spec]) => spec === s).map(([name]) => name);
        if (names.length === 1 && names[0] === PACKAGE) target = join(directory, "plugins", "node_modules", PACKAGE);
      }
      if (target && (await samePath(target, packageDir) || await samePath(target, entryFile))) matches.push(e);
    }
    if (matches.length !== 1) return { ok: false, code: matches.length ? "config_ambiguous" : "plugin_removed" };
    const e = matches[0];
    if (e.off === true) return { ok: false, code: "plugin_disabled" };
    if (e.off !== undefined && typeof e.off !== "boolean" || e.options != null && !object(e.options)) return { ok: false, code: "config_invalid" };
    if (canonical(e.options ?? {}) !== initial) return { ok: false, code: "config_changed" };
    return { ok: true };
  };
}
