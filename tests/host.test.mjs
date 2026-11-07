import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { account, packageDir, until } from "./helpers.mjs";

// Optional integration against the unmodified, pinned Magpie host.js.
// All files and environment are isolated; only a loopback receiver is used.
const host = process.env.MAGPIE_TEST_HOST_JS;
(host ? test : test.skip)("unmodified Magpie Bun host loads the plugin and sends an idle-start alert", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notify-real-host-"));
  const messages = [], output = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    messages.push(await req.json()); return new Response(null, { status: 204 });
  } });
  const raw = { pollIntervalSeconds: 5, confirmSeconds: 1, channels: [{ type: "webhook", url: `http://127.0.0.1:${server.port}/` }] };
  const source = JSON.stringify([account()]);
  let child, reading;
  try {
    await writeFile(join(dir, "logins.json"), source);
    await writeFile(join(dir, "plugins.json"), JSON.stringify({ plugins: [{ spec: packageDir, options: raw }] }));
    await writeFile(join(dir, "models.json"), "{}");
    child = Bun.spawn([process.execPath, host], {
      cwd: dir, env: { HOME: dir, PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: dir },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    reading = (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          if (line) output.push(JSON.parse(line));
        }
      }
    })();
    child.stdin.write(JSON.stringify({ id: 1, method: "init", params: {
      directory: dir, authPath: join(dir, "plugin-auth.json"), modelsDevPath: join(dir, "models.json"),
      plugins: [{ spec: packageDir, target: packageDir, options: raw }],
    } }) + "\n");
    await child.stdin.flush();
    await until(() => output.some((x) => x.id === 1), 5000);
    const init = output.find((x) => x.id === 1);
    expect(init.error).toBeUndefined();
    expect(init.result.plugins[0].error).toBeUndefined();
    await until(() => messages.length === 1, 6000);
    expect(messages[0].event.kind).toBe("account.reauth_required");
    expect(await readFile(join(dir, "logins.json"), "utf8")).toBe(source);
    expect(JSON.stringify(output) + JSON.stringify(messages)).not.toContain("SECRET");
    expect(JSON.stringify(messages)).not.toContain("private.example");
  } finally {
    child?.stdin.end();
    if (child) { child.kill(); await child.exited; }
    await reading;
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
