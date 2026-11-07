import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireOwner, Store } from "../src/store.mjs";

test("owner is exclusive across processes and is automatically released after a crash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notify-owner-"));
  const child = Bun.spawn([process.execPath, new URL("./fixtures/owner-child.mjs", import.meta.url).pathname, dir], { stdout: "pipe", stderr: "pipe" });
  let next;
  try {
    const reader = child.stdout.getReader();
    const result = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(result.value)).toBe("owned\n");
    expect(await acquireOwner(dir)).toBeNull();
    child.kill("SIGKILL"); await child.exited;
    next = await acquireOwner(dir);
    expect(next).not.toBeNull();
    expect(await acquireOwner(dir)).toBeNull();
  } finally { child.kill(); await child.exited; next?.release(); await rm(dir, { recursive: true, force: true }); }
});
test("corrupt state is not overwritten and new storage files have private permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notify-store-"));
  try {
    const s = await Store.open(dir); s.close();
    expect((await stat(join(dir, "state.sqlite"))).mode & 0o777).toBe(0o600);
    await writeFile(join(dir, "state.sqlite"), "corrupt");
    await expect(Store.open(dir)).rejects.toThrow("state_unavailable");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
