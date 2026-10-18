import { NextResponse } from "next/server";
import { getConsumetEpisodeStream } from "@/services/consumet";
import { getEpisodeStream } from "@/services/stream";
import type { EpisodeStream } from "@/types";

/**
 * GET /api/stream?episode=N&title=<anime title>[&slug=<slug>]
 *
 * Thin server-side proxy that resolves real HLS streaming sources for an
 * episode via the Consumet (GogoAnime) provider. Falling back to the demo
 * source map on any failure so playback — and the /api/stream build — never
 * breaks when the external provider is unreachable or a title doesn't resolve.
 *
 * Note: kept purely request-driven (reads the query string + fetches upstream),
 * so it is dynamic at runtime and is never executed during `next build`.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const episode = Math.max(1, Number(searchParams.get("episode") ?? "1"));
  const title = searchParams.get("title") ?? "";
  const slug = searchParams.get("slug") ?? "";

  // Static fallback: the curated/demo stream (EN+AR WebVTT + test HLS).
  const fallback = getEpisodeStream(slug || `episode-${episode}`, episode, title);

  try {
    const live = await getConsumetEpisodeStream(title, episode);
    // Keep demo subtitles (EN/AR WebVTT) — the provider doesn't supply them.
    return NextResponse.json({ ...fallback, ...live, subtitles: fallback.subtitles, source: "live" });
  } catch {
    return NextResponse.json({ ...fallback, source: "fallback" });
  }
}