// Diagnostic: pinpoint where webtorrent loading hangs.
import { setTimeout as wait } from "node:timers/promises";

const t0 = Date.now();
const log = (msg) => console.log("[" + (Date.now() - t0) + "ms] " + msg);

log("before dynamic import");
let m;
try {
  const p = import("webtorrent");
  const winner = await Promise.race([
    p.then((r) => "ok"),
    wait(15000).then(() => "timeout"),
  ]);
  if (winner === "timeout") {
    log("IMPORT TIMED OUT after 15s (top-level await in native graph?)");
    process.exit(2);
  }
  m = await p;
  log("import resolved; default type=" + typeof m.default);
} catch (e) {
  log("import error: " + e.message);
  process.exit(3);
}

log("before constructor");
try {
  const c = new m.default({ noWebRTC: true });
  log("constructor returned OK; ready=" + c.ready);
  // give it a moment to settle, then confirm event loop is free
  await wait(1500);
  log("event loop free after 1.5s settle");
  process.exit(0);
} catch (e) {
  log("constructor error: " + e.message);
  process.exit(4);
}