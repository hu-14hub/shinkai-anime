/**
 * Resolves playable sources + subtitle tracks for an episode.
 *
 * In this template there is no real video backend, so we synthesize demo
 * sources from public HLS test streams plus EN/AR WebVTT tracks. The admin
 * CRUD (AdminAnime.episodes[].sources/subtitles) is the integration point
 * for real server URLs — swap this function to read from your CMS/CDN.
 */

import type { EpisodeStream, StreamingSource, SubtitleTrack } from "@/types";

const DEMO_M3U8 =
  "https://test-vod.co.uk/hotel_california/Hotel_California_720p.m3u8";
const DEMO_SUB_EN =
  "https://test-vod.co.uk/hotel_california/subtitles_en.vtt";
const DEMO_SUB_AR =
  "https://test-vod.co.uk/hotel_california/subtitles_ar.vtt";

/** Map an episode to its streaming sources & subtitle tracks. */
export function getEpisodeStream(
  slug: string,
  episode: number,
  animeTitle?: string
): EpisodeStream {
  const sources: StreamingSource[] = [
    {
      id: "server-1",
      name: "Server 1",
      url: DEMO_M3U8,
      quality: "720p",
      default: true,
    },
    {
      id: "server-2",
      name: "Server 2",
      url: DEMO_M3U8,
      quality: "1080p",
    },
    {
      id: "server-3",
      name: "Server 3 (Mirror)",
      url: DEMO_M3U8,
      quality: "480p",
    },
  ];

  const subtitles: SubtitleTrack[] = [
    { id: "sub-en", label: "English", lang: "en", url: DEMO_SUB_EN, default: true },
    { id: "sub-ar", label: "Arabic", lang: "ar", url: DEMO_SUB_AR },
  ];

  return { slug, episode, sources, subtitles };
}