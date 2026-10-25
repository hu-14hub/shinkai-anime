/**
 * Resolves playable sources + subtitle tracks for an episode.
 *
 * In this template there is no production video backend, so a reliable public
 * HLS sample stream is used as the fallback when no live source can be
 * resolved. The admin CRUD (AdminAnime.episodes[].sources/subtitles) is the
 * integration point for real server URLs — swap `getEpisodeStream` to read
 * from your CMS/CDN.
 */

import type { EpisodeStream, StreamingSource, SubtitleTrack } from "@/types";

/**
 * Built-in public test HLS stream used when live sources cannot be resolved.
 *
 * `test-streams.mux.dev/x36xhzz` is a well-known, long-running adaptive HLS
 * sample (Big Buck Bunny) served with `Access-Control-Allow-Origin: *`, so it
 * plays directly in the browser without a proxy. It is a valid *master*
 * playlist, so hls.js auto-adapts across the encoded qualities.
 *
 * Override via `NEXT_PUBLIC_FALLBACK_HLS` in `.env.local` to point at any
 * other publicly-reachable, CORS-friendly .m3u8.
 */
const FALLBACK_HLS =
  process.env.NEXT_PUBLIC_FALLBACK_HLS ||
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

const ANIPUB_BASE = "https://anipub.org";

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
 * Fetch AniPub details for a given identifier and extract the episode link.
 *
 * Returns the resolved URL string, or null when the anime/episode is not
 * available on AniPub.
 */
async function resolveAniPubEpisodeLink(
  identifier: string | number,
  episode: number
): Promise<string | null> {
  try {
    const res = await fetch(
      `${ANIPUB_BASE}/v1/api/details/${encodeURIComponent(String(identifier))}`,
      {
        cache: "no-store",
        headers: { Accept: "application/json" },
      }
    );

    if (!res.ok) {
      console.warn(
        `[STREAM] [AniPub] HTTP ${res.status} for identifier="${identifier}"`
      );
      return null;
    }

    const data = await res.json();
    const local = data?.local;
    const epArray = local?.ep;

    if (!Array.isArray(epArray) || epArray.length === 0) {
      console.warn(
        `[STREAM] [AniPub] no episode array for identifier="${identifier}"`
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
    const url = rawLink.startsWith("src=") ? rawLink.slice(4) : rawLink;

    if (url.length === 0) {
      console.warn(
        `[STREAM] [AniPub] ep ${episode} link empty after stripping src= for identifier="${identifier}"`
      );
      return null;
    }

    console.log(
      `[STREAM] [AniPub] resolved ep ${episode} via identifier="${identifier}" → ${url}`
    );
    return url;
  } catch (err) {
    console.warn(
      `[STREAM] [AniPub] request failed for identifier="${identifier}" (${
        err instanceof Error ? err.message : String(err)
      })`
    );
    return null;
  }
}

/** Map an episode to its streaming sources & subtitle tracks. */
export async function getEpisodeStream(
  slug: string,
  episode: number,
  animeTitle?: string
): Promise<EpisodeStream> {
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
    try {
      console.log(
        `[STREAM] [AniPub] direct slug failed — searching by title="${animeTitle}"`
      );

      const searchRes = await fetch(
        `${ANIPUB_BASE}/api/search/${encodeURIComponent(animeTitle)}`,
        {
          cache: "no-store",
          headers: { Accept: "application/json" },
        }
      );

      if (searchRes.ok) {
        const searchData = (await searchRes.json()) as AniPubSearchResult;

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
            `[STREAM] [AniPub] search returned no usable identifier for title="${animeTitle}"`
          );
        }
      } else {
        console.warn(
          `[STREAM] [AniPub] search HTTP ${searchRes.status} for title="${animeTitle}"`
        );
      }
    } catch (err) {
      console.warn(
        `[STREAM] [AniPub] search request failed for title="${animeTitle}" (${
          err instanceof Error ? err.message : String(err)
        })`
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
  /* 4) Fallback: demo stream                                         */
  /* ---------------------------------------------------------------- */
  console.warn(
    `[STREAM] [AniPub] no valid source found for slug="${slug}" (cleaned="${clean}") ep=${episode} — falling back to Demo`
  );

  const sources: StreamingSource[] = [
    {
      id: "demo",
      name: "Demo",
      url: FALLBACK_HLS,
      quality: "auto",
      default: true,
      isHls: true,
    },
  ];

  // No bundled subtitle tracks with the demo stream.
  const subtitles: SubtitleTrack[] = [];

  return { slug, episode, sources, subtitles };
}