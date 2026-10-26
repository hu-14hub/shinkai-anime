// Temporary smoke test: boots index.js and verifies /health responds.
import { spawn } from "node:child_process";
import http from "node:http";

const PORT = process.env.SMOKE_PORT || 4123;
const child = spawn(process.execPath, ["index.js"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
let err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));

function getHealth() {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: Number(PORT), path: "/health" },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error("timeout"));
    });
  });
}

async function tryHealth() {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) break;
    try {
      return await getHealth();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

const result = await tryHealth();
const code = child.exitCode;
try {
  child.kill("SIGKILL");
} catch {}

if (result) {
  console.log("SMOKE_PASS");
  console.log(`  status=${result.status} body=${result.body}`);
} else {
  console.log("SMOKE_FAIL");
  console.log(`  child_exit=${code}`);
}
console.log("--- server stdout ---");
console.log(out.trim());
if (err.trim()) {
  console.log("--- server stderr ---");
  console.log(err.trim());
}
process.exit(result ? 0 : 1);