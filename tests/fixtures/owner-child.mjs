import { acquireOwner } from "../../src/store.mjs";
const owner = await acquireOwner(process.argv[2]);
process.stdout.write(owner ? "owned\n" : "busy\n");
if (owner) setInterval(() => { globalThis.retainedOwner = owner; }, 1000);
