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
 * Base URL of the local WebTorrent streaming backend (see `anime-backend/`).
 * Override with NEXT_PUBLIC_TORRENT_API_BASE in production (e.g. to point at
 * a deployed backend instance).
 */
const TORRENT_API_BASE =
  process.env.NEXT_PUBLIC_TORRENT_API_BASE ?? "http://localhost:4000";

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

/**
 * Build a WebTorrent streaming source for a magnet link.
 *
 * The magnet URL is base64-encoded and then `encodeURIComponent`d so it survives
 * URL routing (Express URL-decodes `req.query.*` values once — this keeps the
 * base64 payload intact). The backend's `decodeMagnet` reverses the base64 step.
 *
 * `kind: "hls"` + `isHls: false` is the codebase convention for a *progressive*
 * native `<video src>` stream — the player plays it directly (no hls.js, no
 * iframe), and the backend's HTTP Range support enables seeking.
 */
export function buildTorrentSource(magnetUrl: string): StreamingSource {
  const payload = btoa(magnetUrl);
  const url = `${TORRENT_API_BASE}/api/torrent/stream?magnet=${encodeURIComponent(
    payload
  )}`;
  return {
    id: "torrent",
    name: "Torrent (Nyaa)",
    url,
    quality: "auto",
    default: true,
    kind: "hls",
    isHls: false,
  };
}

/** Shape of one torrent candidate returned by /api/torrent/search (backend). */
interface NyaaTorrentResult {
  title: string;
  seeders: number;
  leeches: number;
  size: string | null;
  sizeBytes: number;
  /** `magnet:?xt=urn:btih:…` link. */
  magnet: string;
  /** Direct .torrent / nyaa.view URL (non-magnet), when available. */
  url: string | null;
}

/** Wrap the backend's top magnet result in a playable progressive source. */
function buildTorrentSourceFromResult(r: NyaaTorrentResult): StreamingSource {
  const payload = btoa(r.magnet);
  const url = `${TORRENT_API_BASE}/api/torrent/stream?magnet=${encodeURIComponent(
    payload
  )}`;
  return {
    id: "torrent",
    name: "Torrent (Nyaa)",
    url,
    quality: "auto",
    default: true,
    kind: "hls",
    isHls: false,
  };
}

/**
 * Ask the local WebTorrent backend for the best magnet for a title + episode.
 *
 * Hits `${TORRENT_API_BASE}/api/torrent/search?query=…&episode=…` (the nyaa.si
 * scraper). Returns a READY-TO-PLAY progressive source built from the top
 * magnet, or `null` when the backend is offline / blocked / has no result.
 *
 * We fail CLOSED here on purpose: any error means "no torrent source", which
 * lets the caller silently fall through to the web-embed (AniPub) path.
 *
 * Every branch logs verbosely (tag `[STREAM] [Nyaa]`) so that, in the browser
 * console, you can see the exact URL hit and the precise reason a magnet did
 * or did not come back in real time.
 */
async function fetchTorrentSource(
  query: string,
  episode: number
): Promise<StreamingSource | null> {
  const params = new URLSearchParams({
    query,
    ...(episode ? { episode: String(episode) } : {}),
  });
  const url = `${TORRENT_API_BASE}/api/torrent/search?${params.toString()}`;
  const t0 = performance.now();
  const elapsed = () => `${Math.round(performance.now() - t0)} ms`;

  // Log the base URL too so a port/host mismatch is instantly visible.
  console.log(
    `[STREAM] [Nyaa] -> GET ${url}\n   (TORRENT_API_BASE=${TORRENT_API_BASE})`
  );

  const controller = new AbortController();
  const abortState = { timedOut: false };
  const timeoutId = setTimeout(() => {
    abortState.timedOut = true;
    controller.abort();
  }, 10_000);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    // A REJECTED fetch (no response at all) is one of:
    //   (a) our 10 s timeout fired       -> AbortError, abortState.timedOut=true
    //   (b) backend not running          -> "Failed to fetch" (connection refused)
    //   (c) CORS preflight blocked       -> "Failed to fetch"
    // The browser wording for (b) vs (c) is identical, and (b) — the backend
    // not being up on that port — is by far the most common cause.
    const msg = err instanceof Error ? err.message : String(err);
    if (abortState.timedOut) {
      console.error(
        `[STREAM] [Nyaa] TIMEOUT after 10000 ms for "${query}" ep=${episode}.\n` +
          `        Backend is up but the nyaa.si scrape is too slow.\n` +
          `        Check the backend console (a slow/blocked nyaa scrape).\n` +
          `        Or point NEXT_PUBLIC_TORRENT_API_BASE at a hotter instance.`
      );
    } else {
      console.error(
        `[STREAM] [Nyaa] NETWORK/CORS failure (${elapsed()}): ${msg}\n` +
          `        Failed: GET ${url}\n` +
          `        => Most likely the backend is NOT running at ${TORRENT_API_BASE}.\n` +
          `        => Start it:  cd anime-backend && npm start    then reload/retry.\n` +
          `        (If it IS running and you still see this, it is a CORS block —\n` +
          `         but the backend sends Access-Control-Allow-Origin: * by default.)`
      );
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  // Read the body as text so non-200 responses (404/502/503/504) KEEP their
  // JSON reason — the single most useful diagnostic for "why no magnet".
  const bodyText = await res.text().catch(() => "");
  const ms = Math.round(performance.now() - t0);

  if (!res.ok) {
    console.error(
      `[STREAM] [Nyaa] <== HTTP ${res.status} ${res.statusText} (${ms} ms) — no magnet\n` +
        `        body: ${bodyText.slice(0, 600) || "(empty)"}`
    );
    return null;
  }

  let data: {
    best?: NyaaTorrentResult | null;
    results?: NyaaTorrentResult[];
    count?: number;
  };
  try {
    data = bodyText ? (JSON.parse(bodyText) as typeof data) : {};
  } catch (parseErr) {
    console.error(
      `[STREAM] [Nyaa] 200 but body is not JSON — cannot read a magnet. body: ${bodyText.slice(0, 600)}`
    );
    return null;
  }

  const best = data.best ?? data.results?.[0];
  if (best?.magnet) {
    console.log(
      `[STREAM] [Nyaa] OK ${data.count ?? 1} result(s), using best: "${best.title}" ` +
        `(seeders=${best.seeders}, leeches=${best.leeches}, ${best.size})\n` +
        `        magnet: ${best.magnet}`
    );
    return buildTorrentSourceFromResult(best);
  }

  console.warn(
    `[STREAM] [Nyaa] 200 but NO magnet in payload (count=${
      data.count ?? data.results?.length ?? 0
    }). body: ${bodyText.slice(0, 600)}`
  );
  return null;
}

/**
 * Resolve a single AniPub streaming source for an episode, or `null` when
 * AniPub cannot produce a valid episode link.
 *
 * This is the standalone web-embed provider. It is NO LONGER a silent
 * fallback behind the torrent path — it runs as its own independent source and
 * is exposed to the UI as a separate, selectable server option (see
 * `getEpisodeStream`). The resolution flow is unchanged from what was
 * inlined in `getEpisodeStream` before:
 *
 *   1. Search AniPub by the anime title (or cleaned slug) — `/api/search/:q`.
 *   2. Normalise the response (array or single-object) into a candidates list.
 *      Prefer an exact `finder` match, then a `Name` match, then the first
 *      candidate with a numeric `Id`.
 *   3. Fetch `/v1/api/details/:id` and pick the (1-based) episode's `link`.
 *   4. Classify that link (`iframe` vs `hls`) and return it as a source.
 *
 * `slug` is used only for the (cleaned) search fallback + logging, so a
 * caller can pass `""` when it has no slug; the search `query` is
 * normalised by the caller.
 */
async function resolveAniPubSource(
  slug: string,
  query: string,
  episode: number
): Promise<StreamingSource | null> {
  const clean = cleanSlug(slug);
  const searchUrl = `${ANIPUB_BASE}/api/search/${encodeURIComponent(query)}`;

  const searchRes = await fetchWithDebug(searchUrl);

  if (searchRes.ok && searchRes.data) {
    // AniPub's /api/search/:q is inconsistent about its response shape — it
    // can return a JSON *array* of candidates OR a *single* result object
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

    const match =
      candidates.find((c) => finderOf(c) === clean) ??
      candidates.find(
        (c) =>
          typeof c.Name === "string" &&
          c.Name.trim().toLowerCase() === clean.toLowerCase()
      ) ??
      candidates.find(hasNumericId);

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
        return buildAniPubSource(url);
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
    `[STREAM] [AniPub] NO_VALID_SOURCE slug="${slug}" (cleaned="${clean}") ep=${episode} — AniPub lookup failed`
  );
  return null;
}

/**
 * Map an episode to its streaming sources & subtitle tracks, exposing every
 * provider that can play it as an INDEPENDENT, user-selectable server:
 *   - "Torrent (Nyaa)" — the local WebTorrent backend (nyaa.si magnet → a
 *     seekable progressive file, native `<video>`).
 *   - "AniPub"         — the web-embed provider (an `<iframe>` page).
 *
 * Both providers are resolved in PARALLEL (`Promise.all`). When both succeed,
 * the returned `sources` array carries one entry per provider and the UI's
 * server pill row renders them side-by-side so the user can switch between
 * Torrent and AniPub at any time. When one fails it is simply omitted (no
 * source entry) and the other is returned; we return null only when NEITHER
 * can produce a valid source.
 *
 * The first-resolved source is marked `default` so the player opens on a
 * working stream out of the box (Torrent first — the first-class, seekable
 * source for this app; AniPub when no torrent is available).
 *
 * Browser-safe: runs client-side so Vercel's blocked server-side requests are
 * never involved.
 */
export async function getEpisodeStream(
  slug: string,
  episode: number,
  animeTitle?: string
): Promise<EpisodeStream | null> {
  const clean = cleanSlug(slug);
  const query = (animeTitle && animeTitle.trim()) || clean;

  console.log(
    `[STREAM] resolving episode "${query}" ep=${episode} slug="${slug}" (cleaned="${clean}") — torrent + anipub in parallel`
  );

  // Resolve both providers independently. fetchTorrentSource already fails
  // closed (returns null on any error), and resolveAniPubSource returns null
  // when it cannot resolve a link, so neither can throw and abort the pair.
  const [torrentSource, anipubSource] = await Promise.all([
    fetchTorrentSource(query, episode),
    resolveAniPubSource(slug, query, episode),
  ]);

  const selected = [torrentSource, anipubSource].filter(
    (s): s is StreamingSource => Boolean(s)
  );

  if (selected.length === 0) {
    console.error(
      `[STREAM] NO_VALID_SOURCE slug="${slug}" (cleaned="${clean}") ep=${episode} — both Torrent (Nyaa) and AniPub failed`
    );
    return null;
  }

  // Every entry carries default:true from its builder; re-mark so exactly one
  // (the first — Torrent, since it is the first-class seekable source) is the
  // auto-played default and the rest are plain switchable options.
  for (const [i, s] of selected.entries()) {
    s.default = i === 0 ? true : undefined;
  }

  console.log(
    `[STREAM] ready slug="${slug}" ep=${episode} sources=[${selected
      .map((s) => s.name)
      .join(", ")}] default="${selected[0].name}"`
  );

  return { slug, episode, sources: selected, subtitles: [] };
}