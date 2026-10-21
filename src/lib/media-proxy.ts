/**
 * Media proxy helpers (shared by the `/api/proxy` route and the services).
 *
 * WHY THIS EXISTS
 * ---------------
 * The hiAnime/Consumet provider returns media URLs that only accept requests
 * carrying provider headers (`Referer: https://hianime.dk/watch/...`,
 * `User-Agent`). `Referer` is a *forbidden* header name for browser fetch/XHR,
 * so the browser can never play those URLs directly. Everything therefore has
 * to be relayed through a same-origin server route that adds the headers.
 *
 * WHY PATH-BASED
 * --------------
 * A proxy URL that carries the upstream URL in the query string breaks HLS:
 * hls.js resolves *relative* playlist/segment URIs against the manifest URL,
 * and a query string is dropped by relative resolution — the segments then
 * point at the wrong place. So the upstream URL travels in the URL *path*:
 *
 *   /api/proxy/<token>                 -> <upstream manifest>
 *   /api/proxy/<token>/child.m3u8      -> (rewritten children point here)
 *
 * `<token>` is base64url(JSON) of `{ u: <upstream url>, h: <headers> }`, plus
 * an HMAC-SHA256 signature so the token cannot be forged by a visitor.
 * Every rewritten child URI inside a manifest is emitted as an absolute
 * `/api/proxy/<token>` URL, so no client-side relative resolution is needed.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Secret used to sign proxy tokens.
 *
 * Set `MEDIA_PROXY_SECRET` in the deployment environment to a long random
 * string. When it is missing we fall back to a fixed development constant —
 * tokens then stay valid across serverless cold starts (which is essential:
 * a per-process random secret would invalidate every manifest URL as soon as
 * a new lambda spins up) but the tokens are forgeable by anyone who reads the
 * source. The allow-list below still limits the damage.
 */
export const DEV_TOKEN_SECRET = "shinkai-dev-media-proxy-secret-change-me";

/**
 * The signing secret.
 *
 * Read lazily on every call so that the value always reflects the *runtime*
 * environment (Next.js can inline `process.env.X` at build time for some
 * bundles, which would freeze a stale value into the deployed function).
 */
function tokenSecret(): string {
  return process.env.MEDIA_PROXY_SECRET?.trim() || DEV_TOKEN_SECRET;
}

/** Payload encoded into the proxy path token. */
export interface ProxyTokenPayload {
  /** Absolute upstream URL. */
  u: string;
  /** Request headers to replay upstream (e.g. `Referer`). */
  h?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

/** base64url encode a byte buffer (works in Node and Edge runtimes). */
function b64urlEncodeBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url encode (works in Node and Edge runtimes). */
function b64urlEncode(input: string): string {
  return b64urlEncodeBytes(new TextEncoder().encode(input));
}

/** Sign a payload string with the token secret. */
function sign(payload: string): string {
  return b64urlEncodeBytes(
    createHmac("sha256", tokenSecret()).update(payload).digest()
  );
}

/** Constant-time comparison of two base64url signatures. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** base64url decode. Returns `null` when the token is malformed. */
function b64urlDecode(input: string): string | null {
  try {
    const norm = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Encode an upstream URL + headers into the path token.
 *
 * Layout: `<base64url(payload)>.<base64url(hmac-sha256(payload))>`
 */
export function encodeProxyToken(url: string, headers?: Record<string, string>): string {
  const payload: ProxyTokenPayload = { u: url };
  const h = sanitizeHeaders(headers);
  if (h && Object.keys(h).length) payload.h = h;
  const body = b64urlEncode(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

/**
 * Decode a path token back into its payload (`null` when invalid or when the
 * signature does not match — a forged token is rejected outright).
 */
export function decodeProxyToken(token: string): ProxyTokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig) return null;
  if (!safeEqual(sig, sign(body))) return null;
  const raw = b64urlDecode(body);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ProxyTokenPayload;
    if (!parsed || typeof parsed.u !== "string" || !parsed.u) return null;
    return { u: parsed.u, h: sanitizeHeaders(parsed.h) };
  } catch {
    return null;
  }
}

/** Build the same-origin proxy path for an upstream URL. */
export function buildProxyPath(url: string, headers?: Record<string, string>): string {
  return `/api/proxy/${encodeProxyToken(url, headers)}`;
}

/* ------------------------------------------------------------------ */
/* Headers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Only forward a safe, useful subset of headers upstream. `Referer`,
 * `Origin` and `User-Agent` are what the hiAnime CDNs check; `watchsb` is
 * required by the StreamSB extractor.
 *
 * Cookies are deliberately NOT forwarded: the provider never needs the
 * visitor's own cookies, and relaying them would leak the app's session
 * cookies to third-party CDNs.
 */
const FORWARDABLE_HEADERS = new Set([
  "referer",
  "origin",
  "user-agent",
  "accept",
  "accept-language",
  "watchsb",
]);

export function sanitizeHeaders(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof k !== "string" || typeof v !== "string" || !v) continue;
    const key = k.toLowerCase();
    if (!FORWARDABLE_HEADERS.has(key)) continue;
    if (/[\r\n]/.test(v)) continue;
    out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}


/* ------------------------------------------------------------------ */
/* Security: host allow-list + SSRF protection                        */
/* ------------------------------------------------------------------ */

/**
 * Hosts the proxy is allowed to talk to.
 *
 * The list covers the hiAnime (Consumet) provider chain:
 *   - the hiAnime site itself (`hianime.dk`, was `hianime.to`) — the `Referer` target,
 *   - the embed servers the provider extracts from
 *     (MegaCloud, StreamSB, StreamTape),
 *   - the public CDNs those embeds hand out media URLs from
 *     (Akamai, CloudFront, Fastly/Google, Bunny, Mux …).
 *
 * It is intentionally an allow-list: the proxy is a public, unauthenticated
 * endpoint, so anything not explicitly listed is rejected. Extend it with
 * `MEDIA_PROXY_ALLOWED_HOSTS` (comma separated) if a provider hands out hosts
 * we do not know about.
 */
const DEFAULT_ALLOWED_HOST_PATTERNS: RegExp[] = [
  /* --- hiAnime site (Referer origin) --- */
  /* hianime.to is obsolete; hianime.dk is the confirmed current mirror.
     The `hianime.<tld>` wildcard below covers hianime.dk (and any future
     hianime.* mirror); hianime.dk is listed explicitly for clarity. */
  /^hianime\.to$/i,
  /^hianime\.dk$/i,
  /^hianime\.[a-z]{2,}$/i,
  /^www\.hianime\.to$/i,

  /* --- hiAnime embed servers --- */
  /^megacloud\.tv$/i,
  /^(.*\.)?megacloud\.tv$/i,
  /^watchsb\.com$/i,
  /^(.*\.)?watchsb\.com$/i,
  /^streamsss\.net$/i,
  /^(.*\.)?streamsss\.net$/i,
  /^streamtape\.com$/i,
  /^(.*\.)?streamtape\.com$/i,
  /^vidstreaming\.[a-z]{2,}$/i,
  /^(.*\.)?vidstreaming\.[a-z]{2,}$/i,

  /* --- media CDNs --- */
  /^(.*\.)?(akamaized\.net|akamai\.net|akamaiedge\.net|edgekey\.net)$/i,
  /^(.*\.)?(cloudfront\.net|amazonaws\.com)$/i,
  /^(.*\.)?(fastly\.net|fastlylb\.net)$/i,
  /^(.*\.)?(b-cdn\.net|bunnycdn\.com|bunnynet\.com)$/i,
  /^(.*\.)?(cdnvideo\.com|cdnvideo\.ru|cdnvideo\.net)$/i,
  /^(.*\.)?(mcdn\.bvn\.[a-z]{2,})$/i,
  /^(.*\.)?googlevideo\.com$/i,
  /^(.*\.)?fbcdn\.net$/i,
  /^(.*\.)?mux\.dev$/i,
];

/** Private / loopback / link-local hostnames that must never be reached. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
]);

/** RFC1918 and friends, in dotted form. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const n = parts.map((p) => Number(p));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b] = n;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe80")) return true;
  if (/^f[cd]/.test(h)) return true;
  if (h.startsWith("::ffff:")) return isPrivateIpv4(h.slice(7));
  return false;
}

/** True when the host is a private/reserved name or address (SSRF guard). */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIpv4(h);
  if (h.includes(":")) return isPrivateIpv6(h);
  return false;
}

function allowedHostPatterns(): RegExp[] {
  const extra = (process.env.MEDIA_PROXY_ALLOWED_HOSTS || "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const patterns = [...DEFAULT_ALLOWED_HOST_PATTERNS];
  for (const host of extra) {
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    patterns.push(new RegExp(`^${escaped}$`, "i"));
    patterns.push(new RegExp(`^(.*\\.)?${escaped}$`, "i"));
  }
  return patterns;
}

/**
 * Validate an upstream URL for the proxy.
 * Returns the normalised URL, or an error describing why it was rejected.
 */
export function validateUpstreamUrl(
  rawUrl: string
): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `Unsupported protocol: ${url.protocol}` };
  }
  // Credentials in the URL would be sent to the upstream host — reject them.
  if (url.username || url.password) {
    return { ok: false, reason: "Credentials in URL are not allowed" };
  }
  if (isBlockedHost(url.hostname)) {
    return { ok: false, reason: `Blocked host: ${url.hostname}` };
  }
  const allowed = allowedHostPatterns().some((re) => re.test(url.hostname));
  if (!allowed) {
    return { ok: false, reason: `Host not allowed: ${url.hostname}` };
  }
  return { ok: true, url };
}

/**
 * Validate a redirect target.
 *
 * Redirects are followed manually (instead of `redirect: "follow"`) so that
 * every hop is re-validated against the same allow-list — otherwise an
 * allow-listed host could bounce the proxy to an arbitrary internal address.
 */
export function validateRedirectTarget(
  location: string,
  baseUrl: string
): { ok: true; url: URL } | { ok: false; reason: string } {
  let target: URL;
  try {
    target = new URL(location, baseUrl);
  } catch {
    return { ok: false, reason: "Invalid redirect target" };
  }
  return validateUpstreamUrl(target.toString());
}

/**
 * Resolve a possibly relative URI found inside an HLS manifest against the
 * manifest's own URL (RFC 3986).
 */
export function resolveManifestUri(baseUrl: string, uri: string): string | null {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return null;
  }
}
