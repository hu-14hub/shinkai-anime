/**
 * Resolves playable sources + subtitle tracks for an episode via AniPub's API.
 *
 * Returns null when AniPub cannot resolve a valid episode link. The admin
 * CRUD (AdminAnime.episodes[].sources/subtitles) is the integration point
 * for real server URLs — swap `getEpisodeStream` to read from your CMS/CDN.
 */

import type { EpisodeStream, StreamingSource, SubtitleTrack } from "@/types";

const ANIPUB_BASE = "https://anipub.org";

/**
 * Headers required by AniPub's server / Cloudflare protection.
 * Vercel serverless IP ranges are often blocked unless a proper browser-like
 * User-Agent, Referer, and Accept header are supplied.
 */
const ANIPUB_HEADERS: HeadersInit = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://anipub.org/",
};

/**
 * Strips a leading AniList ID prefix from a slug.
 *
 * Accepts forms like:
 *   - `al-210655-ace-of-the-diamond` → `ace-of-the-diamond`
 *   - `210655-ace-of-the-diamond`    → `ace-of-the-diamond`
 *   - `ace-of-the-diamond`           → `ace-of-the-diamond` (unchanged)
 */
function cleanSlug(slug: string): string {
  return slug.replace(/^(?:al-)?\d+-/, "");
}

/**
 * Shape of a single AniPub search result item.
 */
interface AniPubSearchResult {
  Name?: string;
  Id?: number;
  _id?: number;
  finder?: string;
  Image?: string;
  ImagePath?: string;
}

/**
 * Categorised error info for AniPub fetch failures so we can see exactly
 * what went wrong in Vercel Runtime Logs.
 */
interface AniPubFetchError {
  type: "network" | "http" | "parse" | "timeout";
  status?: number;
  message: string;
  url: string;
  rawBody?: string;
}

/**
 * Fetch a URL with enhanced logging and error categorisation for debugging
 * serverless (Vercel) network restrictions.
 *
 * Logs:
 *   - The exact URL being fetched
 *   - HTTP status code and response headers
 *   - Raw response body (truncated) for parse failures
 *   - Categorised error type (network / http / parse / timeout)
 */
async function fetchWithDebug(
  url: string,
  opts: RequestInit = {}
): Promise<{
  ok: boolean;
  status: number;
  data?: unknown;
  error?: AniPubFetchError;
  rawText?: string;
}> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

  console.log(
    `[STREAM] [AniPub][DEBUG] FETCH url="${url}" headers=${JSON.stringify({
      ...ANIPUB_HEADERS,
      ...opts.headers,
    })}`
  );

  try {
    const res = await fetch(url, {
      ...opts,
      headers: { ...ANIPUB_HEADERS, ...opts.headers },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const rawText = await res.text().catch(() => "");

    console.log(
      `[STREAM] [AniPub][DEBUG] RESPONSE url="${url}" status=${res.status} statusText="${res.statusText}" headers=${JSON.stringify(
        Object.fromEntries(res.headers.entries())
      )} rawBody="${rawText.slice(0, 500)}${rawText.length > 500 ? "…" : ""}"`
    );

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: {
          type: "http",
          status: res.status,
          message: `HTTP ${res.status} ${res.statusText}`,
          url,
          rawBody: rawText.slice(0, 1000),
        },
        rawText,
      };
    }

    let data: unknown;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch (parseErr) {
      return {
        ok: false,
        status: res.status,
        error: {
          type: "parse",
          status: res.status,
          message: `JSON parse error: ${
            parseErr instanceof Error ? parseErr.message : String(parseErr)
          }`,
          url,
          rawBody: rawText.slice(0, 1000),
        },
        rawText,
      };
    }

    return { ok: true, status: res.status, data, rawText };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof Error && err.name === "AbortError") {
      console.error(
        `[STREAM] [AniPub][DEBUG] TIMEOUT url="${url}" after 10000ms`
      );
      return {
        ok: false,
        status: 0,
        error: {
          type: "timeout",
          message: `Request timed out after 10000ms`,
          url,
        },
      };
    }

    console.error(
      `[STREAM] [AniPub][DEBUG] NETWORK_ERROR url="${url}" error=${err instanceof Error ? err.message : String(err)}`
    );
    return {
      ok: false,
      status: 0,
      error: {
        type: "network",
        message: err instanceof Error ? err.message : String(err),
        url,
      },
    };
  }
}

/**
 * Fetch AniPub details for a given identifier and extract the episode link.
 *
 * Returns the resolved URL string, or null when the anime/episode is not
 * available on AniPub.
 */
async function resolveAniPubEpisodeLink(
  identifier: string | number,
  episode: number
): Promise<string | null> {
  const url = `${ANIPUB_BASE}/v1/api/details/${encodeURIComponent(String(identifier))}`;

  const result = await fetchWithDebug(url);

  if (!result.ok || !result.data) {
    const reason = result.error
      ? `type="${result.error.type}" status="${result.error.status}" message="${result.error.message}" rawBody="${result.error.rawBody ?? ""}"`
      : "unknown error";
    console.warn(
      `[STREAM] [AniPub] details failed for identifier="${identifier}" ep=${episode} — ${reason}`
    );
    return null;
  }

  const data = result.data as Record<string, unknown>;
  const local = data?.local as Record<string, unknown> | undefined;
  const epArray = local?.ep;

  if (!Array.isArray(epArray) || epArray.length === 0) {
    console.warn(
      `[STREAM] [AniPub] no episode array for identifier="${identifier}" ep=${episode}`
    );
    return null;
  }

  // Episode numbers are 1-based; the array is 0-indexed.
  const epItem = epArray[episode - 1];
  const rawLink = epItem?.link;

  if (typeof rawLink !== "string" || rawLink.length === 0) {
    console.warn(
      `[STREAM] [AniPub] ep ${episode} has no link for identifier="${identifier}"`
    );
    return null;
  }

  // Strip the "src=" prefix if present (e.g. "src=https://..." → "https://...").
  const urlResolved = rawLink.startsWith("src=") ? rawLink.slice(4) : rawLink;

  if (urlResolved.length === 0) {
    console.warn(
      `[STREAM] [AniPub] ep ${episode} link empty after stripping src= for identifier="${identifier}"`
    );
    return null;
  }

  console.log(
    `[STREAM] [AniPub] resolved ep ${episode} via identifier="${identifier}" → ${urlResolved}`
  );
  return urlResolved;
}

/**
 * Classify a resolved AniPub URL into a playback mechanism.
 *
 * AniPub returns third-party *web-page* embed links (e.g. gogoanime
 * `streaming.php?id=...&ep=...`) rather than direct media files. Those cannot
 * be played by hls.js / `<video src>` and must be rendered inside an
 * `<iframe>`. Direct media URLs (`.m3u8` / `.mp4` / …) are the `hls` kind.
 */
function classifySource(url: string): { kind: "hls" | "iframe"; isHls: boolean } {
  const looksLikeIframe =
    /(streaming|video|watch|player)\.php/i.test(url) ||
    /\.php(\?|$)/i.test(url) ||
    /\/video\//i.test(url) ||
    /\.(html?|aspx|jsp)(\?|$)/i.test(url);

  if (looksLikeIframe) return { kind: "iframe", isHls: false };

  const isHls = /\.m3u8(\?|$)/i.test(url);
  return { kind: "hls", isHls };
}

/** Build the single AniPub streaming source for a resolved episode URL. */
function buildAniPubSource(url: string): StreamingSource {
  const { kind, isHls } = classifySource(url);
  return {
    id: "anipub",
    name: "AniPub",
    url,
    quality: "auto",
    default: true,
    kind,
    isHls,
  };
}

/** Map an episode to its streaming sources & subtitle tracks.
 *
 * Resolution flow (browser-safe — runs client-side so Vercel's blocked
 * server-side requests are never involved):
 *   1. Search AniPub by the anime title (or cleaned slug) — `/api/search/:q`.
 *   2. AniPub returns a JSON *array* of candidates OR a *single* result object
 *      — both are normalised. Pick the best match and prefer its numeric `Id`
 *      (with the `finder` slug as a fallback) for the details lookup.
 *   3. Fetch `/v1/api/details/:id` and pick the (1-based) episode's `link`.
 *   4. Classify that link (`iframe` vs `hls`) and return it as a source.
 *
 * Returns null when AniPub cannot resolve a valid episode link.
 */
export async function getEpisodeStream(
  slug: string,
  episode: number,
  animeTitle?: string
): Promise<EpisodeStream | null> {
  const clean = cleanSlug(slug);
  const query = (animeTitle && animeTitle.trim()) || clean;
  const searchUrl = `${ANIPUB_BASE}/api/search/${encodeURIComponent(query)}`;

  console.log(
    `[STREAM] [AniPub] searching q="${query}" slug="${slug}" (cleaned="${clean}") ep=${episode}`
  );

  const searchRes = await fetchWithDebug(searchUrl);

  if (searchRes.ok && searchRes.data) {
    // AniPub's /api/search/:q is inconsistent about its response shape — it can
    // return a JSON *array* of candidates OR a *single* result object
    // (e.g. {"Name":"Overgeared","Id":8473,"finder":"overgeared",...}).
    // Normalise both into an array so a single-object response is never
    // silently dropped (that was the "no numeric id" false negative).
    const raw = searchRes.data;
    const candidates: AniPubSearchResult[] = Array.isArray(raw)
      ? (raw as AniPubSearchResult[])
      : [raw as AniPubSearchResult];

    const hasNumericId = (c: AniPubSearchResult): c is AniPubSearchResult & { Id: number | string } =>
      typeof c.Id === "number" ||
      (typeof c.Id === "string" && /^\d+$/.test(c.Id));

    const finderOf = (c: AniPubSearchResult | undefined): string | null =>
      c && typeof c.finder === "string" && c.finder.trim() ? c.finder.trim() : null;

    // Prefer an exact finder/slug match, then a name match, then the first
    // candidate carrying a numeric Id.
    const match =
      candidates.find((c) => finderOf(c) === clean) ??
      candidates.find(
        (c) =>
          typeof c.Name === "string" &&
          c.Name.trim().toLowerCase() === clean.toLowerCase()
      ) ??
      candidates.find(hasNumericId);

    // Resolve which identifier to send to /v1/api/details/:id. The details
    // endpoint requires the numeric Id (the finder slug is less reliable, but
    // is a valid fallback). Prefer the numeric Id when present — a value like
    // 8473 is a perfectly valid numeric id and must not be rejected.
    const detailId =
      (match && hasNumericId(match) ? String(match.Id) : null) ??
      finderOf(match) ??
      null;

    if (detailId) {
      console.log(
        `[STREAM] [AniPub] search matched detailId="${detailId}" (name="${match?.Name ?? "?"}", finder="${finderOf(match) ?? "?"}")`
      );
      const url = await resolveAniPubEpisodeLink(detailId, episode);
      if (url) {
        return {
          slug,
          episode,
          sources: [buildAniPubSource(url)],
          subtitles: [],
        };
      }
    } else {
      console.warn(
        `[STREAM] [AniPub] no usable id/finder in search results q="${query}" candidates=${candidates.length} data=${JSON.stringify(raw).slice(0, 400)}`
      );
    }
  } else {
    const reason = searchRes.error
      ? `type="${searchRes.error.type}" status="${searchRes.error.status}" message="${searchRes.error.message}" rawBody="${searchRes.error.rawBody ?? ""}"`
      : "unknown error";
    console.warn(`[STREAM] [AniPub] search failed q="${query}" — ${reason}`);
  }

  console.error(
    `[STREAM] [AniPub] NO_VALID_SOURCE slug="${slug}" (cleaned="${clean}") ep=${episode} — AniPub lookup failed`
  );
  return null;
}