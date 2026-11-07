import { mkdtemp, writeFile, rename, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { options } from "../src/options.mjs";
import { configGuard } from "../src/files.mjs";
import { Monitor } from "../src/monitor.mjs";

export const entryURL = new URL("../index.mjs", import.meta.url);
export const packageDir = fileURLToPath(new URL("..", import.meta.url));
export const fakeChannel = { type: "webhook", url: "https://notification.invalid/hook/CHANNEL_SECRET" };
export function account(id = "a", lapsed = true) {
  return { agent: "codex", id, user: `${id}@private.example`, on: false, paused: true,
    lapsed: lapsed ? "TOKEN_SECRET: raw sign-in error private@example.com" : "",
    auth: { tokens: { access_token: "ACCESS_SECRET", refresh_token: "REFRESH_SECRET" } } };
}
export async function fixture(raw = {}, rows = [account()]) {
  const dir = await mkdtemp(join(tmpdir(), "magpie-notify-test-"));
  const input = { channels: [fakeChannel], ...raw };
  const config = { plugins: [{ spec: packageDir, options: input }] };
  await writeFile(join(dir, "plugins.json"), JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(dir, "logins.json"), JSON.stringify(rows), { mode: 0o600 });
  const logs = [], messages = [];
  const normalized = { ...options(input), pollMs: 30, confirmMs: 10 };
  const monitor = new Monitor({ directory: dir, options: normalized,
    guard: configGuard(dir, entryURL, input), log: (s) => logs.push(s),
    sender: async (c, m) => { messages.push({ c, m }); return { ok: true, code: "sent", status: 200 }; } });
  return { dir, raw: input, config, monitor, logs, messages,
    async rows(rows) {
      await writeFile(join(dir, "logins.next"), JSON.stringify(rows));
      await rename(join(dir, "logins.next"), join(dir, "logins.json"));
    },
    async configWrite() { await writeFile(join(dir, "plugins.json"), JSON.stringify(config)); },
    async text(name) { return readFile(join(dir, name), "utf8"); },
    async close() { await monitor.stop(); await rm(dir, { recursive: true, force: true }); },
  };
}
export async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
}
