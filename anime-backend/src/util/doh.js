/**
 * DoH (DNS-over-HTTPS) client for the nyaa.si scraper.
 *
 * Why this exists:
 *   Some networks (corporate VPNs, campus Wi-Fi, sandboxed runtimes) have DNS
 *   resolvers that drop, poison, or outright block specific remote domains
 *   such as nyaa.si — the original error surfaces as ENOTFOUND / EAI_AGAIN
 *   in the axios call even though the domain is perfectly public.
 *
 * Strategy:
 *   1. Try the **system resolver** first (zero overhead on a healthy network,
 *      and we still honour /etc/hosts, split-horizon DNS, dns.setServers).
 *   2. On a system-resolution failure, call a public DoH provider in
 *      sequence — Cloudflare then Google — until one returns an A record.
 *   3. Cache successful results for 5 min; also negative-cache system-DNS
 *      failures for 60 s so a broken local resolver isn't re-queried per
 *      request.
 *   4. Log every attempt, so an operator can tell at a glance which network
 *      path each scrape used and what the resolver actually reported.
 *
 * No third-party deps — uses Node's `dns` + global `fetch` (Node 18+).
 */
import dns from "node:dns";
import { promisify } from "node:util";

const dnsLookupP = promisify(dns.lookup);

/** How long a successful resolution is trusted before re-checking. */
const POSITIVE_TTL_MS = 5 * 60 * 1000;
/** How long we remember a system-DNS failure before retrying the system. */
const SYSTEM_FAIL_TTL_MS = 1 * 60 * 1000;
/** Per-provider DoH request timeout. */
const DOH_TIMEOUT_MS = 5_000;

/**
 * Domains we're willing to route through DoH. Only nyaa.si is here today,
 * but sub-domains also match. Anything else passes straight through to the
 * stock resolver untouched, so unrelated traffic is never affected.
 */
const DOH_DOMAINS = new Set(["nyaa.si"]);
function isDohTarget(host) {
  const h = String(host || "").toLowerCase();
  return DOH_DOMAINS.has(h) || DOH_DOMAINS.some((d) => h.endsWith("." + d));
}

/**
 * DoH providers, in priority order. Both use the "dns-json" format
 * (RFC 8484). For Cloudflare we switch from the default binary DNS-message
 * to JSON with a single Accept header — that saves us from hand-parsing the
 * wire format. First provider to return an A record wins.
 */
const PROVIDERS = [
  {
    name: "cloudflare",
    url: (h) =>
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(h)}&type=A`,
    headers: { accept: "application/dns-json" },
    extract: (j) =>
      (Array.isArray(j?.Answer) ? j.Answer : []).find(
        (a) => a?.type === 1 && a?.data
      )?.data,
  },
  {
    name: "google",
    url: (h) =>
      `https://dns.google/resolve?name=${encodeURIComponent(h)}&type=A`,
    headers: { accept: "application/dns-json" },
    extract: (j) =>
      (Array.isArray(j?.Answer) ? j.Answer : []).find(
        (a) => a?.type === 1 && a?.data
      )?.data,
  },
];

const positiveCache = new Map(); // host -> { address, family, source, expires }
const negativeCache = new Map(); // host -> { expiry } (short-ttl system-fail memo)

const log = (...a) => console.log("[doh]", ...a);
const warn = (...a) => console.warn("[doh]", ...a);
const err = (...a) => console.error("[doh]", ...a);

/** Log one provider's failure, in the format the top-level handler expects. */
function describeFailure(f) {
  return `   provider ${f.provider}: ${f.reason}${f.body ? ` — ${f.body}` : ""}${
    f.detail ? ` — ${f.detail}` : ""
  }`;
}

/**
 * Call each DoH provider in turn until one returns an A record.
 *
 * @returns {Promise<{address: string, family: number, source: string}>}
 * @throws {Error & { code: "ENOTFOUND", host: string, providers: Array }}
 */
async function dohAll(host) {
  const failures = [];
  for (const p of PROVIDERS) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DOH_TIMEOUT_MS);
    try {
      const res = await fetch(p.url(host), {
        headers: p.headers,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        warn(
          `${p.name}: HTTP ${res.status} (body: ${body || "(empty)"}) — trying next provider`
        );
        failures.push({ provider: p.name, reason: `HTTP ${res.status}`, body });
        continue;
      }
      const json = await res.json();
      const addr = p.extract(json, host);
      if (!addr) {
        warn(
          `${p.name}: no A record (DNS Status=${json?.Status}) — trying next provider`
        );
        failures.push({
          provider: p.name,
          reason: `no A record (DNS Status=${json?.Status})`,
        });
        continue;
      }
      log(`${p.name}: ${host} -> ${addr} (${Date.now() - t0} ms)`);
      return { address: addr, family: 4, source: `doh:${p.name}` };
    } catch (e) {
      clearTimeout(timer);
      const code =
        e.name === "AbortError" ? "TIMEOUT" : e.cause?.code || e.code || e.name;
      const msg = e.cause?.message || e.message;
      warn(`${p.name}: ${code} — ${msg} — trying next provider`);
      failures.push({ provider: p.name, reason: code, detail: msg });
    }
  }

  const e = new Error(`All DoH providers failed to resolve ${host}`);
  e.code = "ENOTFOUND";
  e.host = host;
  e.providers = failures;
  throw e;
}

/**
 * Smart resolver — prefer system DNS, fall through to DoH on any
 * system-resolution failure. All hits are cached (positive 5 min, negative
 * 60 s for system-only failures) so a burst of scrapers doesn't re-pay for
 * the same lookup.
 *
 * @param {string} host
 * @param {{family?: number}} [opts] — the `family` option is forwarded.
 * @returns {Promise<{address: string, family: number, source: string}>}
 *   `source` is one of: "system" | "doh:cloudflare" | "doh:google" | "cache".
 */
export async function resolveSmart(host, opts = {}) {
  const family = opts.family ?? 0;

  // 0) Positive cache hit — return immediately, no network call.
  const cached = positiveCache.get(host);
  if (cached && cached.expires > Date.now()) {
    log(
      `cache: ${host} -> ${cached.address} ` +
        `(ttl=${Math.ceil((cached.expires - Date.now()) / 1000)}s, source=${cached.source})`
    );
    return cached;
  }
  if (cached) positiveCache.delete(host); // TTL expired — re-resolve.

  // 1) System resolver — skip if the negative cache says it recently failed.
  const neg = negativeCache.get(host);
  const skipSystem = !!neg && neg.expiry > Date.now();
  if (!skipSystem) {
    const t0 = Date.now();
    try {
      const { address, family: fam } = await dnsLookupP(host, { family });
      const rec = {
        address,
        family: fam,
        source: "system",
        expires: Date.now() + POSITIVE_TTL_MS,
      };
      positiveCache.set(host, rec);
      negativeCache.delete(host); // we just proved the system works now.
      log(`system: ${host} -> ${address} (${Date.now() - t0} ms)`);
      return rec;
    } catch (e) {
      const code = e.code || e.name;
      const msg = e.cause?.message || e.message;
      warn(
        `system resolver failed for ${host} (${code}: ${msg}) — falling back to DoH`
      );
      negativeCache.set(host, { expiry: Date.now() + SYSTEM_FAIL_TTL_MS });
      // continue to DoH below.
    }
  } else {
    log(
      `system recently failed for ${host} ` +
        `(negative-cache alive for ${Math.ceil((neg.expiry - Date.now()) / 1000)}s) — going straight to DoH`
    );
  }

  // 2) DoH (Cloudflare -> Google -> throw).
  const rec = await dohAll(host);
  rec.expires = Date.now() + POSITIVE_TTL_MS;
  positiveCache.set(host, rec);
  return rec;
}

/**
 * Drop-in `dns.lookup` replacement, usable as the `lookup` option of
 * `https.Agent` / `http.Agent` (and thus forwarded through Axios).
 *
 *   - Intercepts nyaa.si + its sub-domains only, routing them through
 *     `resolveSmart` (system first, DoH on failure, cached).
 *   - Passes every other host through to the stock `dns.lookup` so this
 *     change cannot disturb unrelated network traffic.
 *
 * Supports both the callback form `(hostname, options, callback)` that Node
 * sockets invoke, and the promise form `(hostname, options) => Promise`.
 *
 * Env override: `DISABLE_DOH=1` (or `true`) forces every lookup — including
 * nyaa.si — to use the plain stock resolver. Useful for debugging
 * "is DoH the problem?" without editing code.
 *
 * @param {string} hostname
 * @param {object|function} optionsOrCallback
 * @param {function} [callback] — (err, address, family)
 * @returns {void|Promise<{address: string, family: number}>}
 */
export function dohLookup(hostname, optionsOrCallback, callback) {
  const options =
    typeof optionsOrCallback === "object" && optionsOrCallback !== null
      ? optionsOrCallback
      : {};
  const cb = typeof callback === "function" ? callback : optionsOrCallback;

  // Operator escape hatch: always the stock resolver, never DoH.
  if (process.env.DISABLE_DOH && /^1|true$/i.test(process.env.DISABLE_DOH)) {
    const run = () =>
      dnsLookupP(hostname, options).then(({ address, family }) => ({
        address,
        family,
        source: "passthrough(disabled-do)",
      }));
    if (cb) {
      run().then(
        (r) => cb(null, r.address, r.family),
        (e) => cb(e)
      );
      return;
    }
    return run();
  }

  const run = () =>
    isDohTarget(hostname)
      ? resolveSmart(hostname, options)
      : dnsLookupP(hostname, options).then(({ address, family }) => ({
          address,
          family,
          source: "passthrough",
        }));

  // Callback form — what Node's tls/http agents actually call.
  if (cb) {
    run().then(
      (r) => {
        if (r.source !== "passthrough") {
          log(
            `lookup ${hostname} -> ${r.address} (family=${r.family}, source=${r.source})`
          );
        }
        cb(null, r.address, r.family);
      },
      (e) => {
        err(
          `lookup ${hostname} failed: ${e.code || e.name} — ${e.message}`
        );
        for (const f of e.providers || []) err(describeFailure(f));
        cb(e);
      }
    );
    return;
  }

  // Promise form.
  return run();
}

/* -------------------------------------------------------------------- */
/* Test-only exports (do not use in production code)                    */
/* -------------------------------------------------------------------- */
export const __test = {
  PROVIDERS,
  isDohTarget,
  clearCaches: () => {
    positiveCache.clear();
    negativeCache.clear();
  },
};