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
 * Returns the demo/fallback streaming sources for an episode. No live
 * provider resolution is performed here.
 *
 * Kept purely request-driven (reads the query string), so it is dynamic at
 * runtime and is never executed during `next build`.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const episode = Math.max(1, Number(searchParams.get("episode") ?? "1"));
  const title = searchParams.get("title") ?? "";
  const slug = searchParams.get("slug") ?? "";

  // Demo/fallback stream.
  const stream = getEpisodeStream(slug || `episode-${episode}`, episode, title);
  return NextResponse.json({ ...stream, source: "demo" });
}