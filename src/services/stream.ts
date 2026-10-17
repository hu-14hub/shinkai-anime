/**
 * Resolves playable sources + subtitle tracks for an episode.
 *
 * In this template there is no real video backend, so we synthesize demo
 * sources from public HLS test streams plus EN/AR WebVTT tracks. The admin
 * CRUD (AdminAnime.episodes[].sources/subtitles) is the integration point
 * for real server URLs — swap this function to read from your CMS/CDN.
 *
 * In addition, a dedicated **P2P (WebTorrent)** source is emitted on every
 * episode. Today it points at a small, legally-released CC0 / CC-BY demo
 * magnet (Big Buck Bunny or Sintel) so the P2P pipeline is fully testable
 * end-to-end. To enable real anime P2P:
 *   1. Add a slug-level mapping in `P2P_SLUG_MAGNETS` (or override
 *      `resolveP2pMagnet` to read from your torrent index / API), and
 *   2. Populate each `StreamingSource.magnet` from your CDN's .torrent DB.
 */

import type { EpisodeStream, StreamingSource, SubtitleTrack } from "@/types";

const DEMO_M3U8 =
  "https://test-vod.co.uk/hotel_california/Hotel_California_720p.m3u8";
const DEMO_SUB_EN =
  "https://test-vod.co.uk/hotel_california/subtitles_en.vtt";
const DEMO_SUB_AR =
  "https://test-vod.co.uk/hotel_california/subtitles_ar.vtt";

/* ---------------------------------------------------------------------- */
/* WebTorrent P2P sources                                            */
/* ---------------------------------------------------------------------- */

/**
 * Demo / placeholder CC-licensed magnet URIs (Blender Open Movies — Big Buck
 * Bunny & Sintel, both CC0 / CC-BY).
 *
 * ⚠️ OPERATOR INTEGRATION SURFACE — PLEASE VERIFY BEFORE SHIP.
 *
 * The DHT info-hashes below are well-known community magnets for the Blender
 * Open Movies films, but magnet info-hashes are NOT verified in this build
 * and can rotate as upstream trackers re-seed. In production:
 *
 *   1. Look up the *current* info-hash for the title on a trusted torrent
 *      index (1337x, rarbg / archive mirrors, the-blend.io, etc).
 *   2. Replace the `xt=urn:btih:<hash>` value in the magnet string.
 *   3. (Optional) Append a `&ws=https://host/file.mp4` WebSeed pointing at a
 *      public HTTP mirror so the client always has a non-DHT fallback.
 *
 * The demo magnets below exist so the P2P pipeline is testable end-to-end
 * from the very first launch, and are selected deterministically per-episode
 * (see `resolveP2pMagnet`). If the swarm is empty at runtime, the player will
 * still render the HUD, connect metrics, and gracefully degrade to the HLS
 * fallback source.
 */
export const DEMO_MAGNET_BBB_720P =
  "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=big_buck_bunny_720p_bluray&tr=udp%3A%2F%2Fopen.demoni.com%3A1337&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.green.shadowtracker.com%3A1337";

export const DEMO_MAGNET_BBB_1080P =
  "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=big_buck_bunny_1080p&tr=udp%3A%2F%2Fopen.demoni.com%3A1337&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337";

/**
 * Canonical magnet for the CC-licensed Blender film "Sintel" (12min short,
 * CC-BY 3.0).
 */
export const DEMO_MAGNET_SINTEL_1080P =
  "magnet:?xt=urn:btih:b72c28279c94cd667bc114433d3cf71028781029&dn=Sintel.1080p&tr=udp%3A%2F%2Fopen.demoni.com%3A1337&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337";

/**
 * Optional slug → magnet mapping. Populate this (or extend it dynamically
 * from a CMS or torrent index API) to point specific anime titles at
 * real P2P swarms. Keys must match the anime `slug` value used at
 * `/anime/[slug]/watch?ep=N`.
 *
 * Example:
 *   "one-piece":
 *     "magnet:?xt=urn:btih:…&dn=One.Piece.Ep.001.720p&tr=…",
 */
export const P2P_SLUG_MAGNETS: Record<string, string> = {};

/**
 * Resolves the magnet URI to hand to the WebTorrent client for an episode.
 *
 * Resolution order:
 *   1. An explicit per-episode override (slug + ep) if present in the
 *      registry.
 *   2. A slug-level override for the whole anime.
 *   3. A deterministic CC0 demo fallback (Big Buck Bunny 720p for most
 *      episodes, Sintel 1080p for every 3rd episode) so the P2P pipeline
 *      always has a working, legal stream to connect to during testing.
 *
 * `null` indicates “no P2P source configured” — the player will continue
 * to stream through the standard HLS source list.
 */
export function resolveP2pMagnet(
  slug: string,
  episode: number
): string | null {
  // 1. Per-episode override (highest specificity).
  const epKey = `${slug}:ep${episode}`;
  const perEpisode = P2P_SLUG_MAGNETS[epKey];
  if (perEpisode) return perEpisode;

  // 2. Slug-level override.
  const slugMagnet = P2P_SLUG_MAGNETS[slug];
  if (slugMagnet) return slugMagnet;

  // 3. Deterministic CC0 demo fallback — rotate between BBB 720p (short,
  //    well-seeded) and Sintel 1080p so the P2P player exercises both
  //    fast / slow paths against different swarms.
  if (episode % 3 === 0) return DEMO_MAGNET_SINTEL_1080P;
  return DEMO_MAGNET_BBB_720P;
}

/** Map an episode to its streaming sources & subtitle tracks. */
export function getEpisodeStream(
  slug: string,
  episode: number,
  animeTitle?: string
): EpisodeStream {
  const magnet = resolveP2pMagnet(slug, episode);

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
    ...(magnet
      ? [
          {
            id: "p2p",
            name: "P2P (WebTorrent)",
            // url is empty — the WebTorrent client builds its own
            // MSE stream URL when activated (see video-player.tsx).
            url: "",
            quality: "P2P" as const,
            magnet,
          },
        ]
      : []),
  ];

  const subtitles: SubtitleTrack[] = [
    { id: "sub-en", label: "English", lang: "en", url: DEMO_SUB_EN, default: true },
    { id: "sub-ar", label: "Arabic", lang: "ar", url: DEMO_SUB_AR },
  ];

  return { slug, episode, sources, subtitles, magnet: magnet ?? undefined };
}