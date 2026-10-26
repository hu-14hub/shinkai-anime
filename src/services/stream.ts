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
  const local = data?.local;

  // AniPub's /v1/api/details/:id returns the data shape:
  //   { local: { name, finder, link, type, ep: [{link}, ...], ... } }
  // Two layouts are observed in the wild (verified against the live API):
  //   (A) `local` is the *episode-1 object*:
  //         local.link = ep1,  local.ep[] = ep2..epN   (the common case)
  //   (B) `local` is an *array* of episode objects (a legacy/alternate layout).
  //     -> local[0] = ep1, local[1] = ep2, ...
  // We handle both. Episode numbers are 1-based.
  let rawLink: string | null = null;

  if (typeof local === "object" && local !== null && !Array.isArray(local)) {
    const loc = local as Record<string, unknown>;
    if (episode === 1) {
      // Episode 1 lives on `local.link` itself (NOT inside local.ep).
      rawLink = typeof loc.link === "string" ? loc.link : null;
    } else {
      // Episodes 2..N live in `local.ep`, 0-indexed -> ep 2 is ep[0].
      const epArray = loc.ep;
      if (Array.isArray(epArray)) {
        const item = epArray[episode - 2] as Record<string, unknown> | undefined;
        rawLink = typeof item?.link === "string" ? item.link : null;
      }
    }
  } else if (Array.isArray(local)) {
    const item = local[episode - 1] as Record<string, unknown> | undefined;
    rawLink = typeof item?.link === "string" ? item.link : null;
  }

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
 * AniPub is a web aggregator — its details API **always** returns web-page
 * URLs (e.g. gogoanime `streaming.php?id=...&ep=...` or `anipub.org/play/...`),
 * never direct media files. Every path on the site is a full page that must be
 * rendered inside an `<iframe>` because it supplies its own player, controls,
 * and tracking.
 *
 * Only an explicit media-file extension (`.m3u8` / `.mp4`) is treated as a
 * native `<video>` / hls.js source. This inverted default ensures any
 * unexpected AniPub URL shape is safely handled by the iframe renderer
 * rather than being fed to a native video element.
 */
function classifySource(url: string): { kind: "hls" | "iframe"; isHls: boolean } {
  // Explicit media-file extension → native <video> or hls.js.
  const isMediaFile = /\.(m3u8|mp4)(\?|$)/i.test(url);
  if (isMediaFile) return { kind: "hls", isHls: /\.m3u8(\?|$)/i.test(url) };
  // Everything else is a web page → render in an <iframe>.
  return { kind: "iframe", isHls: false };
}

/** An embed server listed on the Animex (animex.one) watch page. Each
 * resolves a deterministic iframe embed URL from the normalized anime slug +
 * 1-based episode number. */
export type AnimexServerId =
  | "anmx"
  | "zen"
  | "koto"
  | "zoro"
  | "yuki"
  | "loli"
  | "sora";
/** AniPub is the server we discover real URLs for via its search API. */
export type StreamProviderId = AnimexServerId | "anipub";

interface EmbedResolver {
  id: AnimexServerId;
  name: string;
  /** Build the iframe embed URL for (slug, 1-based episode). */
  buildUrl: (slug: string, episode: number) => string;
}

/** Embed URL patterns for the extra Animex servers. They are intentionally
 * best-effort guesses — different mirror sites use different host/path
 * conventions, so a host may need adjusting against the live site. Every one
 * always renders as an iframe (kind: "iframe" in buildEmbedSource) inside the
 * existing iframe branch in `video-player.tsx`. */
const ANIMEX_EMBED_SERVERS: EmbedResolver[] = [
  {
    id: "anmx",
    name: "ANMX",
    buildUrl: (slug, episode) => `https://anmx.one/embed/${slug}/1/${episode}`,
  },
  {
    id: "zen",
    name: "ZEN",
    buildUrl: (slug, episode) =>
      `https://zenembed1.cc/e/${encodeURIComponent(slug)}?episode=${episode}`,
  },
  {
    id: "koto",
    name: "KOTO",
    buildUrl: (slug, episode) => `https://koto-anime.net/embed/${slug}-${episode}`,
  },
  {
    id: "zoro",
    name: "Zoro",
    buildUrl: (slug, episode) =>
      `https://zoro.tv/watch/${slug}/episode-${episode}`,
  },
  {
    id: "yuki",
    name: "Yuki",
    buildUrl: (slug, episode) =>
      `https://yuki.to/watch/${slug}/episode-${episode}`,
  },
  {
    id: "loli",
    name: "Loli",
    buildUrl: (slug, episode) => `https://loli.net/embed/${slug}-${episode}`,
  },
  {
    id: "sora",
    name: "Sora",
    buildUrl: (slug, episode) => `https://sora.to/embed/${slug}/${episode}`,
  },
];

/** Build an iframe source from an embed resolver. These are always iframes. */
function buildEmbedSource(
  resolver: EmbedResolver,
  slug: string,
  episode: number
): StreamingSource {
  return {
    id: resolver.id,
    name: resolver.name,
    url: resolver.buildUrl(slug, episode),
    quality: "auto",
    default: false,
    kind: "iframe",
    isHls: false,
  };
}

/** Build iframe sources for every extra Animex embed server. */
function buildAnimexEmbedSources(
  slug: string,
  episode: number
): StreamingSource[] {
  const clean = cleanSlug(slug);
  return ANIMEX_EMBED_SERVERS.map((resolver) =>
    buildEmbedSource(resolver, clean, episode)
  );
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
 * Returns a `sources` array of every available server so the watch page can
 * render them all as selectable options:
 *   - The AniPub source — the only server whose real URL is *discovered* at
 *     runtime via its search API. It stays the default (`default: true`).
 *   - The extra Animex servers (ANMX, ZEN, KOTO, Zoro, Yuki, Loli, Sora) —
 *     deterministic iframe embeds built straight from the anime slug + episode
 *     (`kind: "iframe"`), always included so they appear in the server
 *     selector even when AniPub fails.
 *
 * AniPub resolution flow (browser-safe — runs client-side so Vercel's blocked
 * server-side requests are never involved):
 *   1. Search AniPub by the anime title (or cleaned slug) — `/api/search/:q`.
 *   2. AniPub returns a JSON *array* of candidates OR a *single* result object
 *      — both are normalised. Pick the best match and prefer its numeric `Id`
 *      (with the `finder` slug as a fallback) for the details lookup.
 *   3. Fetch `/v1/api/details/:id` and pick the (1-based) episode's `link`.
 *   4. Classify that link (`iframe` vs `hls`) and use it as the source.
 *
 * The Animex embed sources always resolve, so the function only returns null
 * when there is no episode at all to stream.
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
          sources: [
            buildAniPubSource(url),
            ...buildAnimexEmbedSources(slug, episode),
          ],
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

  console.warn(
    `[STREAM] [AniPub] NO_VALID_SOURCE slug="${slug}" (cleaned="${clean}") ep=${episode} — AniPub lookup failed; falling back to Animex embed servers`
  );
  // AniPub failed, but the deterministic Animex iframe servers (ANMX, ZEN, …)
  // still resolve from the slug + episode, so return them as selectable
  // options instead of bailing out with null.
  return {
    slug,
    episode,
    sources: buildAnimexEmbedSources(slug, episode),
    subtitles: [],
  };
}