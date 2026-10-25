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

/** Map an episode to its streaming sources & subtitle tracks.
 *
 * Returns null when AniPub cannot resolve a valid episode link.
 */
export async function getEpisodeStream(
  slug: string,
  episode: number,
  animeTitle?: string
): Promise<EpisodeStream | null> {
  const clean = cleanSlug(slug);

  /* ---------------------------------------------------------------- */
  /* 1) Try AniPub API with the cleaned slug directly                  */
  /* ---------------------------------------------------------------- */
  console.log(
    `[STREAM] [AniPub] fetching details for slug="${slug}" (cleaned="${clean}") ep=${episode}`
  );

  let url = await resolveAniPubEpisodeLink(clean, episode);

  /* ---------------------------------------------------------------- */
  /* 2) If direct slug failed and we have a title, search AniPub       */
  /* ---------------------------------------------------------------- */
  if (!url && animeTitle) {
    const searchUrl = `${ANIPUB_BASE}/api/search/${encodeURIComponent(animeTitle)}`;

    console.log(
      `[STREAM] [AniPub] direct slug failed — searching by title="${animeTitle}" url="${searchUrl}"`
    );

    const searchRes = await fetchWithDebug(searchUrl);

    if (searchRes.ok && searchRes.data) {
      const searchData = searchRes.data as AniPubSearchResult;

      // Prefer the `finder` slug (works with /v1/api/details/:id),
      // then fall back to the numeric Id/_id.
      const finder =
        searchData.finder ?? searchData.Id ?? searchData._id;

      if (finder != null) {
        console.log(
          `[STREAM] [AniPub] search found identifier="${String(finder)}" for title="${animeTitle}"`
        );
        url = await resolveAniPubEpisodeLink(finder, episode);
      } else {
        console.warn(
          `[STREAM] [AniPub] search returned no usable identifier for title="${animeTitle}" data=${JSON.stringify(searchData).slice(0, 500)}`
        );
      }
    } else {
      const reason = searchRes.error
        ? `type="${searchRes.error.type}" status="${searchRes.error.status}" message="${searchRes.error.message}" rawBody="${searchRes.error.rawBody ?? ""}"`
        : "unknown error";
      console.warn(
        `[STREAM] [AniPub] search failed for title="${animeTitle}" — ${reason}`
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* 3) Resolved via AniPub                                            */
  /* ---------------------------------------------------------------- */
  if (url) {
    const sources: StreamingSource[] = [
      {
        id: "anipub",
        name: "AniPub",
        url,
        quality: "auto",
        default: true,
      },
    ];

    return { slug, episode, sources, subtitles: [] };
  }

  /* ---------------------------------------------------------------- */
  /* 4) No valid source found                                           */
  /* ---------------------------------------------------------------- */
  console.error(
    `[STREAM] [AniPub] NO_VALID_SOURCE slug="${slug}" (cleaned="${clean}") ep=${episode} — AniPub lookup failed`
  );
  return null;
}