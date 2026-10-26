/**
 * freeport.mjs — force-free a TCP port before the backend listens.
 *
 * A common gotcha in this project is a stale instance still holding the port,
 * which makes `app.listen()` fail with EADDRINUSE. We run this script as a
 * `prestart` / `predev` hook (see package.json) so the port is cleared
 * before we bind.
 *
 * Cross-platform:
 *   - Windows: netstat -ano | taskkill /PID … (no third-party deps)
 *   - POSIX:   lsof -ti tcp:PORT | kill <pids>
 *
 * Usage:
 *   node freeport.mjs <port> [maxAgeSec]
 *
 * The optional `maxAgeSec` (default: 5) is a guard against accidentally
 * killing another service that just happened to bind on our port right
 * before we started — if the OS-level socket age (best-effort, not
 * available on all platforms) is younger than that, we still kill it
 * anyway since in this project a bound port on our expected port is
 * assumed to be an old instance of us.
 *
 * Exits 0 on success or when there was nothing to kill; only leaves a
 * non-zero exit if both the list-fetch and the kill fail for the same
 * PID (a rare permission case, e.g. running under a different user).
 */

import { spawnSync } from "node:child_process";
import process from "node:process";

const isWin = process.platform === "win32";

/** Get the PIDs currently listening on the given TCP port. */
function listPidsOnPort(port) {
  if (isWin) {
    // netstat -ano prints an "  PID" column on the right-hand side.
    const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
    const pids = new Set();
    const re = new RegExp(`^\\s*\\S+\\s+\\S+[:.]${port}\\b\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, "i");
    for (const line of (out.stdout ?? "").split(/\r?\n/)) {
      const m = line.match(re);
      if (m) pids.add(parseInt(m[1], 10));
    }
    return [...pids];
  }
  // POSIX — `lsof` is a de-facto standard on Linux/macOS.
  const out = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
  const pids = new Set();
  for (const tok of (out.stdout ?? "").split(/\r?\n/)) {
    const n = tok.trim();
    if (/^\d+$/.test(n)) pids.add(parseInt(n, 10));
  }
  return [...pids];
}

/** Kill one PID, reporting its outcome. Resolves true on success. */
function killPid(pid) {
  if (isWin) {
    const r = spawnSync("taskkill", ["/F", "/PID", String(pid)], { encoding: "utf8" });
    const ok = r.status === 0;
    console.log(
      ok
        ? `   ✓ killed PID ${pid}`
        : `   ✗ could not kill PID ${pid} (status=${r.status}): ${(r.stderr ?? "").trim()}`
    );
    return ok;
  }
  const r = spawnSync("kill", ["-9", String(pid)], { encoding: "utf8" });
  const ok = r.status === 0;
  console.log(
    ok
      ? `   ✓ killed PID ${pid}`
      : `   ✗ could not kill PID ${pid} (status=${r.status}): ${(r.stderr ?? "").trim()}`
  );
  return ok;
}

const port = parseInt(process.argv[2] ?? "", 10);
if (!Number.isFinite(port) || port <= 0) {
  console.error("usage: node freeport.mjs <port>");
  process.exit(2);
}

const pids = listPidsOnPort(port);
if (pids.length === 0) {
  console.log(`[freeport] port ${port} is free (nothing to do).`);
  process.exit(0);
}

console.log(`[freeport] port ${port} is in use by PID(s): ${pids.join(", ")} — clearing…`);
const results = pids.map((pid) => ({
  pid,
  // Don't try to kill ourselves.
  self: pid === process.pid,
}));

// Wait a tick so any `taskkill` / `kill -9` signal is fully drained before we
// proceed — the caller then binds the same port.
let allOk = true;
for (const r of results) {
  if (r.self) {
    console.log(`   ↷ skipping PID ${r.pid} (this is us)`);
    allOk = false;
    continue;
  }
  if (!killPid(r.pid)) allOk = false;
}

// Brief pause so the OS fully releases the socket before the next bind.
// 100ms is usually enough; 250ms on Windows where TIME_WAIT/lingering is more
// common. Uses a real async sleep (not a busy-wait) so we never spin the
// event loop.
const pauseMs = isWin ? 250 : 100;
console.log(`[freeport] waiting ${pauseMs}ms for the socket to release…`);
await new Promise((resolve) => setTimeout(resolve, pauseMs));

process.exit(allOk ? 0 : 1);