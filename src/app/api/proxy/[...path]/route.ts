import { NextResponse } from "next/server";

import {
  decodeProxyToken,
  encodeProxyToken,
  resolveManifestUri,
  sanitizeHeaders,
  validateRedirectTarget,
  validateUpstreamUrl,
} from "@/lib/media-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Upstream fetch timeout (ms). */
const UPSTREAM_TIMEOUT_MS = 15_000;

/** Maximum number of upstream redirects we are willing to follow. */
const MAX_REDIRECTS = 5;

/** Hard cap on the manifest size we will rewrite (bytes). */
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

/** `Referer` sent upstream when the caller did not supply one. */
/* hianime.to is obsolete; hianime.dk is the confirmed current mirror. */
const DEFAULT_REFERER = "https://hianime.dk/";

/** Default `User-Agent` — some CDNs reject requests without a browser UA. */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Fetch an upstream resource, following redirects manually.
 *
 * Each redirect target is validated against the same allow-list and private-IP
 * rules as the original URL, so an allow-listed CDN cannot redirect the proxy
 * into the internal network. The `Referer`/`User-Agent` headers are preserved
 * across hops because several CDNs require them on the redirected URL too.
 */
async function fetchFollowingRedirects(
  startUrl: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  maxRedirects: number
): Promise<{ response: Response; finalUrl: URL }> {
  let current = startUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetch(current.toString(), {
      method: "GET",
      headers,
      redirect: "manual",
      signal,
      cache: "no-store",
    });

    const isRedirect =
      response.status === 301 ||
      response.status === 302 ||
      response.status === 303 ||
      response.status === 307 ||
      response.status === 308;

    if (!isRedirect) return { response, finalUrl: current };

    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current };

    // Drain the redirect body so the socket can be released.
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }

    if (hop === maxRedirects) {
      throw new Error("Too many redirects");
    }

    const validated = validateRedirectTarget(location, current.toString());
    if (!validated.ok) {
      throw new Error(`Blocked redirect: ${validated.reason}`);
    }
    current = validated.url;
  }

  throw new Error("Too many redirects");
}

/**
 * Same-origin media proxy.
 *
 *   GET /api/proxy/<token>          -> the upstream resource
 *   GET /api/proxy/<token>/<name>   -> same (extra path segments are ignored;
 *                                      rewritten manifests point at <token> only)
 *
 * `<token>` = base64url(JSON) of `{ u: <upstream url>, h: <headers> }`.
 *
 * The upstream headers (notably `Referer`) are replayed for every request, and
 * HLS manifests are rewritten so every child URI becomes an absolute proxy
 * path — that keeps hls.js resolution working regardless of the CDN layout.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ path?: string[] }> }
): Promise<Response> {
  const { path } = await context.params;
  const segments = (path ?? []).filter(Boolean);

  if (segments.length === 0) {
    return NextResponse.json({ error: "Missing proxy token" }, { status: 400 });
  }

  const token = segments[0];
  const payload = decodeProxyToken(token);
  if (!payload) {
    return NextResponse.json({ error: "Invalid proxy token" }, { status: 400 });
  }

  const validated = validateUpstreamUrl(payload.u);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.reason }, { status: 403 });
  }

  const upstreamUrl = validated.url;
  const headers = sanitizeHeaders(payload.h) ?? {};
  if (!headers.referer) headers.referer = DEFAULT_REFERER;
  if (!headers["user-agent"]) headers["user-agent"] = DEFAULT_USER_AGENT;
  headers.accept = headers.accept ?? "*/*";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream: Response;
  let finalUrl: URL;
  try {
    const result = await fetchFollowingRedirects(
      upstreamUrl,
      headers,
      controller.signal,
      MAX_REDIRECTS
    );
    upstream = result.response;
    finalUrl = result.finalUrl;
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    const message = err instanceof Error ? err.message : "";
    if (!aborted && /redirect/i.test(message)) {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    return NextResponse.json(
      { error: aborted ? "Upstream timeout" : "Upstream request failed" },
      { status: aborted ? 504 : 502 }
    );
  } finally {
    clearTimeout(timeout);
  }

  const contentType = upstream.headers.get("content-type") || "";
  const isManifest =
    contentType.includes("mpegurl") ||
    contentType.includes("application/vnd.apple.mpegurl") ||
    /\.m3u8(\?|$)/i.test(finalUrl.pathname);

  if (!upstream.ok) {
    return NextResponse.json(
      { error: `Upstream error ${upstream.status}` },
      { status: upstream.status === 404 ? 404 : 502 }
    );
  }

  if (!isManifest) {
    // Pass the binary stream straight through (segments, keys, mp4).
    const outHeaders = new Headers();
    const len = upstream.headers.get("content-length");
    if (len) outHeaders.set("content-length", len);
    outHeaders.set("content-type", contentType || "application/octet-stream");
    outHeaders.set("cache-control", "public, max-age=3600");
    outHeaders.set("x-content-type-options", "nosniff");
    return new Response(upstream.body, {
      status: 200,
      headers: outHeaders,
    });
  }

  // --- Manifest: rewrite every URI to an absolute proxy path. -------------
  const raw = await upstream.text();
  if (raw.length > MAX_MANIFEST_BYTES) {
    return NextResponse.json({ error: "Manifest too large" }, { status: 502 });
  }

  const rewritten = rewriteManifest(raw, finalUrl.toString(), headers);
  return new Response(rewritten, {
    status: 200,
    headers: {
      "content-type": "application/vnd.apple.mpegurl",
      "cache-control": "public, max-age=60",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Rewrite an HLS manifest so that every URI reference becomes an absolute
 * `/api/proxy/<token>` path carrying the same upstream headers.
 */
export function rewriteManifest(
  manifest: string,
  baseUrl: string,
  headers: Record<string, string>
): string {
  const lines = manifest.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }

    // Comment / directive lines that embed a URI.
    if (trimmed.startsWith("#")) {
      const withUri = trimmed.match(
        /^#EXT-X-(?:KEY|MAP|MEDIA|PART|SESSION-KEY|I-FRAME-STREAM-INF|IMAGE-STREAM-INF|PRELOAD-HINT|RENDITION-REPORT):/i
      );
      if (!withUri) {
        out.push(line);
        continue;
      }
      const uriMatch = trimmed.match(/URI="([^"]+)"/i);
      if (!uriMatch) {
        out.push(line);
        continue;
      }
      const resolved = resolveManifestUri(baseUrl, uriMatch[1]);
      if (!resolved || !isProxyableUri(resolved)) {
        out.push(line);
        continue;
      }
      const proxied = `/api/proxy/${encodeProxyToken(resolved, headers)}`;
      out.push(line.replace(uriMatch[1], proxied));
      continue;
    }

    // Bare URI line (segment, variant playlist, key).
    const resolved = resolveManifestUri(baseUrl, trimmed);
    if (!resolved || !isProxyableUri(resolved)) {
      out.push(line);
      continue;
    }
    out.push(`/api/proxy/${encodeProxyToken(resolved, headers)}`);
  }

  return out.join("\n");
}

/**
 * Only `http(s)` URIs can be proxied. `data:` URIs (inline keys) and `skd:`
 * (FairPlay) must be passed through untouched.
 */
function isProxyableUri(uri: string): boolean {
  return uri.startsWith("http://") || uri.startsWith("https://");
}
