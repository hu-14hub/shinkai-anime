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

/** Map an episode to its streaming sources & subtitle tracks. */
export function getEpisodeStream(
  slug: string,
  episode: number,
  animeTitle?: string
): EpisodeStream {
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

  // No bundled subtitle tracks with the demo stream — the previously referenced
  // host no longer resolves.
  const subtitles: SubtitleTrack[] = [];

  return { slug, episode, sources, subtitles };
}