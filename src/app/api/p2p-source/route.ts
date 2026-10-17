import { NextResponse } from "next/server";
import { findNyaaTorrent, type NyaaTorrentResult } from "@/services/nyaa";
import { resolveP2pMagnet } from "@/services/stream";

/**
 * Runtime-only P2P source resolver.
 *
 * Lives at the edge of the request lifecycle (never the static watch page) so
 * a live Nyaa lookup doesn't run at build time and the browser never touches
 * nyaa.si directly (CORS / rate-limiting). The caller (watch page) passes the
 * human title + episode + slug; we return either a real torrent or the CC0
 * demo fallback so the P2P pipeline always has a magnet to try.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();
  const slug = (searchParams.get("slug") ?? "").trim();
  const ep = searchParams.get("ep");
  if (!q || !ep) {
    return NextResponse.json(
      { error: "Missing required params: q, ep, slug" },
      { status: 400 }
    );
  }
  const episode = Math.max(1, parseInt(ep, 10) || 1);

  let live: NyaaTorrentResult | null = null;
  try {
    live = await findNyaaTorrent(q, episode);
  } catch {
    live = null;
  }
  if (live?.magnet) {
    return NextResponse.json({
      source: "nyaa",
      magnet: live.magnet,
      item: {
        title: live.title,
        size: live.size,
        seeds: live.seeds,
        leeches: live.leeches,
        pubDate: live.pubDate,
        url: live.url,
      },
    });
  }

  const demo = resolveP2pMagnet(slug, episode);
  if (!demo) {
    return NextResponse.json({ source: "none", magnet: null }, { status: 404 });
  }
  return NextResponse.json({ source: "demo", magnet: demo });
}