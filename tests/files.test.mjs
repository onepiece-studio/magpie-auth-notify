import { test, expect } from "bun:test";
import { writeFile, mkdir, symlink, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readAccounts, readGoneCount, readJSON, configGuard } from "../src/files.mjs";
import { options } from "../src/options.mjs";
import { PACKAGE } from "../src/common.mjs";
import { account, fixture, entryURL, packageDir } from "./helpers.mjs";

test("file projection drops auth and error text, includes on=false, follows atomic replacement", async () => {
  const f = await fixture();
  try {
    const before = await f.text("logins.json");
    const rows = await readAccounts(f.dir);
    expect(rows).toEqual([{ id: "a", user: "a@private.example", lapsed: true }]);
    expect(JSON.stringify(rows)).not.toContain("SECRET");
    expect(await f.text("logins.json")).toBe(before);
    await f.rows([account("a", false)]);
    expect((await readAccounts(f.dir))[0].lapsed).toBe(false);
  } finally { await f.close(); }
});
test("invalid, truncated, duplicate, oversized and missing inputs are UNKNOWN errors", async () => {
  const f = await fixture();
  try {
    for (const text of ["{ACCESS_SECRET", "{}", JSON.stringify([account(), account()]), JSON.stringify([{ ...account(), lapsed: 1 }])]) {
      await writeFile(join(f.dir, "logins.json"), text);
      let error;
      try { await readAccounts(f.dir); } catch (e) { error = e; }
      expect(error).toBeDefined();
      expect(error.message).not.toContain("ACCESS_SECRET");
    }
    await expect(readJSON(join(f.dir, "plugins.json"), 2)).rejects.toThrow("source_too_large");
    await expect(readJSON(join(f.dir, "absent"))).rejects.toThrow("source_missing");
  } finally { await f.close(); }
});
test("gone records return only a count, never paths/hashes or a reauth assertion", async () => {
  const f = await fixture();
  try {
    expect(await readGoneCount(f.dir)).toEqual({ status: "absent", count: 0 });
    await writeFile(join(f.dir, "codex-signin-gone.json"), JSON.stringify({ "/private/account/home": "a".repeat(64) }));
    expect(await readGoneCount(f.dir)).toEqual({ status: "unverified", count: 1 });
    await writeFile(join(f.dir, "codex-signin-gone.json"), "not json SECRET");
    expect(await readGoneCount(f.dir)).toEqual({ status: "unavailable", count: 0 });
  } finally { await f.close(); }
});
test("config guard checks the exact local entry, off/removal, options and ambiguity", async () => {
  const f = await fixture();
  try {
    const guard = configGuard(f.dir, entryURL, f.raw);
    expect(await guard()).toEqual({ ok: true });
    f.config.plugins[0].off = true; await f.configWrite();
    expect((await guard()).code).toBe("plugin_disabled");
    f.config.plugins[0].off = false;
    f.config.plugins[0].options = { ...f.raw, instanceName: "new" }; await f.configWrite();
    expect((await guard()).code).toBe("config_changed");
    f.config.plugins[0].options = f.raw;
    f.config.plugins.push({ spec: entryURL.href, options: f.raw }); await f.configWrite();
    expect((await guard()).code).toBe("config_ambiguous");
    f.config.plugins = []; await f.configWrite();
    expect((await guard()).code).toBe("plugin_removed");
  } finally { await f.close(); }
});
test("config guard resolves npm versions and explicit git dependency mappings, not lookalike specs", async () => {
  const f = await fixture();
  try {
    const modules = join(f.dir, "plugins", "node_modules");
    await mkdir(modules, { recursive: true });
    await symlink(packageDir, join(modules, PACKAGE));
    const guard = configGuard(f.dir, entryURL, f.raw);
    f.config.plugins[0].spec = `${PACKAGE}@0.1.0`; await f.configWrite();
    expect((await guard()).ok).toBe(true);
    f.config.plugins[0].spec = "github:example/notify#main"; await f.configWrite();
    await writeFile(join(f.dir, "plugins", "package.json"), JSON.stringify({ dependencies: { [PACKAGE]: f.config.plugins[0].spec } }));
    expect((await guard()).ok).toBe(true);
    f.config.plugins[0].spec = `${PACKAGE}-fake@1`; await f.configWrite();
    expect((await guard()).ok).toBe(false);
  } finally { await f.close(); }
});
test("configuration rejects invalid channels, duplicated destinations and invalid timing", () => {
  expect(() => options({ pollIntervalSeconds: 0 })).toThrow("options_invalid");
  expect(() => options({ channels: [{ type: "webhook", url: "file:///tmp/x" }] })).toThrow("channel_invalid");
  expect(() => options({ channels: [{ type: "telegram", token: "x" }] })).toThrow("channel_invalid");
  expect(options().pollMs).toBe(30000);
  expect(options().channels).toHaveLength(0);
});
test("runtime sources do not enumerate/watch files, start subprocesses or call provider APIs", async () => {
  const files = ["index.mjs", ...["common", "files", "options", "store", "state", "message", "monitor", "channels"].map((n) => `src/${n}.mjs`)];
  for (const file of files) {
    const text = await readFile(join(packageDir, file), "utf8");
    expect(text).not.toMatch(/\b(?:readdir|opendir|watchFile|child_process|spawnSync|execFile)\b|\b(?:fs|Bun)\.(?:watch|spawn)\s*\(/);
    expect(text).not.toMatch(/\/wham\/usage|\/oauth\/token|\/v1\/models|magpie accounts/);
  }
});
