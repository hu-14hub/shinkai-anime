import { NextResponse } from "next/server";
import { getConsumetEpisodeStream } from "@/services/consumet";
import { getEpisodeStream } from "@/services/stream";
import type { EpisodeStream } from "@/types";

/**
 * Force runtime evaluation. This handler is purely request-driven (reads the
 * query string + fetches upstream), so it must never be evaluated during `next
 * build`. `force-dynamic` makes that guarantee explicit and future-proof.
 */
export const dynamic = "force-dynamic";

/**
 * GET /api/stream?episode=N&title=<anime title>[&slug=<slug>]
 *
 * Thin server-side proxy that resolves real HLS streaming sources for an
 * episode via the Consumet (HiAnime) provider. Falling back to the demo
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
    console.log(
      `[STREAM] live resolved: "${title}" ep=${episode} → ${live.sources.length} source(s)`
    );
    // Keep demo subtitles (EN/AR WebVTT) — the provider doesn't supply them.
    return NextResponse.json({ ...fallback, ...live, subtitles: fallback.subtitles, source: "live" });
  } catch (err) {
    // Surface the exact provider failure in the server console so we can
    // diagnose network/parsing/title-resolution issues without a client round-trip.
    const code = (err as { code?: string })?.code ?? "UNKNOWN";
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(
      `[STREAM] Consumet resolution failed → falling back to demo.\n` +
        `  title="${title}" episode=${episode} slug="${slug}"\n` +
        `  code=${code}\n  message=${message}` +
        (stack ? `\n  stack=\n${stack}` : "")
    );
    return NextResponse.json({ ...fallback, source: "fallback" });
  }
}