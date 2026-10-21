/**
 * Manual validation script for the media proxy helpers.
 *
 * Run with:  node scripts/verify-media-proxy.mjs
 *
 * It exercises token signing/verification, URL validation, redirect
 * validation, header sanitisation and manifest rewriting — no network access.
 */
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..", "src");

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: { "@": srcDir },
});

const mp = await jiti("../src/lib/media-proxy.ts");
const route = await jiti("../src/app/api/proxy/[...path]/route.ts");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ` -> ${extra}` : ""}`);
  }
}

console.log("\n=== Token signing / verification ===");
const token = mp.encodeProxyToken("https://s01.megacloud.tv/hls/test.m3u8", {
  Referer: "https://hianime.to/watch/abc-123",
  "User-Agent": "UA/1.0",
});
check("token has payload.signature shape", /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token), token);
const decoded = mp.decodeProxyToken(token);
check("valid token decodes", decoded?.u === "https://s01.megacloud.tv/hls/test.m3u8");
check("headers survive the round trip", decoded?.h?.referer === "https://hianime.to/watch/abc-123");

const [body, sig] = token.split(".");
const tamperedBody = Buffer.from(
  JSON.stringify({ u: "https://evil.example.com/x.m3u8" })
).toString("base64url");
check("forged payload is rejected", mp.decodeProxyToken(`${tamperedBody}.${sig}`) === null);
check("forged signature is rejected", mp.decodeProxyToken(`${body}.${"A".repeat(sig.length)}`) === null);
check("missing signature is rejected", mp.decodeProxyToken(body) === null);
check("garbage token is rejected", mp.decodeProxyToken("not-a-token!!") === null);
check("empty token is rejected", mp.decodeProxyToken("") === null);
check("dot-only token is rejected", mp.decodeProxyToken(".") === null);

const { createHmac } = await import("node:crypto");
const garbage = Buffer.from("not json").toString("base64url");
const goodSig = createHmac("sha256", mp.DEV_TOKEN_SECRET)
  .update(garbage)
  .digest("base64url");
check("signed-but-non-JSON payload is rejected", mp.decodeProxyToken(`${garbage}.${goodSig}`) === null);

console.log("\n=== Upstream URL validation ===");
const cases = [
  ["https://s01.megacloud.tv/hls/x.m3u8", true],
  ["https://megacloud.tv/e/abc", true],
  ["https://watchsb.com/e/abc", true],
  ["https://hianime.to/watch/abc-123", true],
  ["https://v1.akamaized.net/x.m3u8", true],
  ["https://cdn.example.com/x.m3u8", false],
  ["http://localhost:3000/x.m3u8", false],
  ["https://127.0.0.1/x.m3u8", false],
  ["https://10.0.0.1/x.m3u8", false],
  ["https://192.168.1.1/x.m3u8", false],
  ["https://169.254.169.254/latest/meta-data", false],
  ["https://metadata.google.internal/x", false],
  ["https://foo.local/x", false],
  ["file:///etc/passwd", false],
  ["https://user:pass@megacloud.tv/x.m3u8", false],
];
for (const [url, expected] of cases) {
  const res = mp.validateUpstreamUrl(url);
  check(`${expected ? "allow" : "deny "}  ${url}`, res.ok === expected, res.ok ? "" : res.reason);
}

console.log("\n=== Redirect validation ===");
const rel = mp.validateRedirectTarget("/seg/1.ts", "https://s01.megacloud.tv/hls/x.m3u8");
check("relative redirect resolves", rel.ok && rel.url.toString() === "https://s01.megacloud.tv/seg/1.ts");
const abs = mp.validateRedirectTarget("https://v1.akamaized.net/seg/1.ts", "https://s01.megacloud.tv/hls/x.m3u8");
check("absolute redirect to allowed host", abs.ok);
const bad1 = mp.validateRedirectTarget("https://169.254.169.254/latest", "https://s01.megacloud.tv/hls/x.m3u8");
check("redirect to metadata IP is blocked", !bad1.ok, bad1.ok ? "" : bad1.reason);
const bad2 = mp.validateRedirectTarget("https://internal.example.com/x", "https://s01.megacloud.tv/hls/x.m3u8");
check("redirect to unknown host is blocked", !bad2.ok);

console.log("\n=== Header sanitisation ===");
const sanitized = mp.sanitizeHeaders({
  Referer: "https://hianime.to/watch/x",
  Cookie: "session=secret",
  Authorization: "Bearer abc",
  "X-Forwarded-For": "1.2.3.4",
  watchsb: "sbstream",
});
check("referer kept", sanitized?.referer === "https://hianime.to/watch/x");
check("cookie dropped", sanitized?.cookie === undefined);
check("authorization dropped", sanitized?.authorization === undefined);
check("x-forwarded-for dropped", sanitized?.["x-forwarded-for"] === undefined);
check("watchsb kept (StreamSB)", sanitized?.watchsb === "sbstream");
const crlf = mp.sanitizeHeaders({ referer: "https://x/\r\nInjected: 1" });
check("CRLF header injection blocked", crlf?.referer === undefined);

console.log("\n=== HLS manifest rewriting ===");
const manifest = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-KEY:METHOD=AES-128,URI="key.php?r=42",IV=0x00',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/en.m3u8"',
  "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
  "360p.m3u8",
  "#EXTINF:9.009,",
  "seg-0.ts?token=abc",
  "#EXTINF:9.009,",
  "https://other-cdn.example.net/seg-1.ts",
  "#EXT-X-ENDLIST",
].join("\n");

const rewritten = route.rewriteManifest(manifest, "https://s01.megacloud.tv/hls/master.m3u8", {
  referer: "https://hianime.to/watch/x",
});
console.log(rewritten.split("\n").map((l) => `      ${l}`).join("\n"));

const lines = rewritten.split("\n");
check("master header kept", lines[0] === "#EXTM3U");
check("key URI proxied", lines[2].includes('URI="/api/proxy/'));
check("map URI proxied", lines[3].includes('URI="/api/proxy/'));
check("audio media URI proxied", lines[4].includes('URI="/api/proxy/'));
check("variant playlist proxied", lines[6].startsWith("/api/proxy/"));
check("relative segment proxied", lines[8].startsWith("/api/proxy/"));
check("absolute segment proxied", lines[10].startsWith("/api/proxy/"));
check("no raw upstream host leaks in URIs", !/https?:\/\/[^"'\s]+\.ts/.test(rewritten));
check(
  "every proxied path has a signed token",
  (rewritten.match(/\/api\/proxy\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? []).length === 6
);

const inlineKey = route.rewriteManifest(
  '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"\nseg.ts',
  "https://s01.megacloud.tv/hls/m.m3u8",
  {}
);
check("data: URI left untouched", inlineKey.includes('URI="data:text/plain;base64,AAAA"'));

const tokenFromManifest = /\/api\/proxy\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(rewritten)[1];
const roundTrip = mp.decodeProxyToken(tokenFromManifest);
check(
  "manifest token round-trips",
  roundTrip?.u === "https://s01.megacloud.tv/hls/key.php?r=42",
  roundTrip?.u
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
