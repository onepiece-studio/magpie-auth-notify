import { createHash, createHmac } from "node:crypto";

export const PACKAGE = "magpie-account-reauth-notify";
export class Fault extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const digest = (v) => createHash("sha256").update(v).digest("hex");
export const privateRef = (salt, v) => createHmac("sha256", salt).update(v).digest("hex");
export const publicCode = (e, fallback = "internal_error") => e instanceof Fault ? e.code : fallback;
export const cleanLabel = (s) => s.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 80);

export function delay(ms, signal, unref = true) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    if (unref) timer.unref?.();
    signal?.addEventListener("abort", finish, { once: true });
  });
}
