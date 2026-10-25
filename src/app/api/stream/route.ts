import { NextResponse } from "next/server";
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
 * Resolves streaming sources for an episode via AniPub's API
 * (https://anipub.org/v1/api/details/:id). Returns 404 if AniPub cannot
 * resolve a valid source for the episode.
 *
 * Kept purely request-driven (reads the query string), so it is dynamic at
 * runtime and is never executed during `next build`.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const episode = Math.max(1, Number(searchParams.get("episode") ?? "1"));
  const title = searchParams.get("title") ?? "";
  const slug = searchParams.get("slug") ?? "";

  // Resolve stream from AniPub.
  const stream = await getEpisodeStream(
    slug || `episode-${episode}`,
    episode,
    title
  );

  if (!stream || !stream.sources.length) {
    return NextResponse.json(
      { error: "No streaming source available for this episode" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ...stream,
    source: stream.sources[0]?.id,
  });
}