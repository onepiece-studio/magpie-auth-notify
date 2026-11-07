import { isAbsolute, resolve } from "node:path";
import { configGuard } from "./src/files.mjs";
import { options } from "./src/options.mjs";
import { Monitor } from "./src/monitor.mjs";
import { canonical, publicCode } from "./src/common.mjs";

const instances = new Map();

// Only this default server export: Magpie calls exported functions as plugins.
// Importing the module performs no I/O and starts no timer.
export default {
  id: "account-reauth-notify",
  server(input, raw = {}) {
    const log = (code) => {
      const message = `account-reauth-notify: ${code}`;
      try {
        const promise = input?.client?.app?.log?.({ body: { service: "account-reauth-notify", level: "info", message } });
        promise?.catch?.(() => {});
      } catch { /* no raw error text */ }
    };
    try {
      if (!input?.directory || !isAbsolute(input.directory)) { log("directory_invalid"); return {}; }
      const directory = resolve(input.directory);
      const normalized = options(raw);
      const signature = canonical(raw);
      const old = instances.get(directory);
      if (old?.signature === signature && !old.monitor.controller.signal.aborted) return {};
      const monitor = new Monitor({ directory, options: normalized,
        guard: configGuard(directory, import.meta.url, raw), log });
      instances.set(directory, { signature, monitor });
      const start = async () => { await old?.monitor.stop(); monitor.start(); };
      start().catch(() => log("startup_failed"));
    } catch (e) { log(publicCode(e, "options_invalid")); }
    return {};
  },
};
