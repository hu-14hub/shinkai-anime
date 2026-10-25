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

/** Map an episode to its streaming sources & subtitle tracks. */
export async function getEpisodeStream(
  slug: string,
  episode: number,
  animeTitle?: string
): Promise<EpisodeStream> {
  const clean = cleanSlug(slug);

  /* ---------------------------------------------------------------- */
  /* 1) Try AniPub API                                                */
  /* ---------------------------------------------------------------- */
  try {
    console.log(
      `[STREAM] [AniPub] fetching details for slug="${slug}" (cleaned="${clean}") ep=${episode}`
    );

    const res = await fetch(
      `${ANIPUB_BASE}/v1/api/details/${encodeURIComponent(clean)}`,
      {
        cache: "no-store",
        headers: { Accept: "application/json" },
      }
    );

    if (!res.ok) {
      console.warn(
        `[STREAM] [AniPub] HTTP ${res.status} for slug="${clean}" — falling back to Demo`
      );
      return buildDemoStream(slug, episode);
    }

    const data = await res.json();
    const local = data?.local;
    const epArray = local?.ep;

    if (!Array.isArray(epArray) || epArray.length === 0) {
      console.warn(
        `[STREAM] [AniPub] no episode array for slug="${clean}" — falling back to Demo`
      );
      return buildDemoStream(slug, episode);
    }

    // Episode numbers are 1-based; the array is 0-indexed.
    const epItem = epArray[episode - 1];
    const rawLink = epItem?.link;

    if (typeof rawLink !== "string" || rawLink.length === 0) {
      console.warn(
        `[STREAM] [AniPub] ep ${episode} has no link for slug="${clean}" — falling back to Demo`
      );
      return buildDemoStream(slug, episode);
    }

    // Strip the "src=" prefix if present (e.g. "src=https://..." → "https://...").
    const url = rawLink.startsWith("src=") ? rawLink.slice(4) : rawLink;

    if (url.length === 0) {
      console.warn(
        `[STREAM] [AniPub] ep ${episode} link empty after stripping src= for slug="${clean}" — falling back to Demo`
      );
      return buildDemoStream(slug, episode);
    }

    console.log(
      `[STREAM] [AniPub] resolved ep ${episode} for slug="${clean}" → ${url}`
    );

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
  } catch (err) {
    console.warn(
      `[STREAM] [AniPub] request failed for slug="${clean}" (${
        err instanceof Error ? err.message : String(err)
      }) — falling back to Demo`
    );
    return buildDemoStream(slug, episode);
  }

  /* ---------------------------------------------------------------- */
  /* 2) Fallback: demo stream                                         */
  /* ---------------------------------------------------------------- */
  function buildDemoStream(s: string, ep: number): EpisodeStream {
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

    return { slug: s, episode: ep, sources, subtitles };
  }

  return buildDemoStream(slug, episode);
}