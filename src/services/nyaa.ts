import Parser from "rss-parser";

/**
 * Nyaa (nyaa.si) search/RSS service — the *live* P2P source provider.
 *
 * This is the integration surface that turns a real anime title + episode into
 * a usable WebTorrent magnet, replacing the CC0 demo magnets in `stream.ts`.
 *
 * It is intentionally SERVER-ONLY (it imports `rss-parser`). The live query
 * runs at runtime from the `/api/p2p-source` route — never at build time
 * (the watch page is statically precompiled and must not hit a torrent index,
 * nor bake a stale magnet into HTML) and never from the browser (CORS + the
 * site's rate-limiting for non-browser clients). The route falls back to the
 * demo magnet in `stream.ts` on any miss or error, so playback always has a
 * P2P option.
 *
 * Legal / ethical note: this surfaces publicly-listed torrent metadata
 * (magnet, size, seed/leech counts) from a public torrent index. Operators are
 * solely responsible for ensuring they have the right to serve the content.
 */

/** Anime / English / DVD / Rip / Sub — Nyaa top-level `1`, 2nd-level `2`. */
const NYAA_CATEGORY = "1_2";

const USER_AGENT =
  "shinkai-p2p/1.0 (+https://shinkai.local; RSS; magnet-resolution)";
/** Hard ceiling so a hung feed can never stall the request. */
const FETCH_TIMEOUT_MS = 8000;
/** How long a resolved magnet stays fresh before re-querying the feed. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Bound the in-memory cache to this many entries (evict oldest first). */
const CACHE_MAX = 100;

/** Namespaced custom fields nyaa emits inside each <item>. */
const ITEM_CUSTOM_FIELDS: string[] = [
  "nyaa:magnet",
  "nyaa:size",
  "nyaa:seeds",
  "nyaa:leeches",
  "nyaa:files",
  "nyaa:category",
];

interface CacheEntry {
  at: number;
  result: NyaaTorrentResult | null;
}

/** In-memory TTL + LRU-ish cache keyed by title+episode; revalidates on TTL. */
const cache = new Map<string, CacheEntry>();

function cacheKey(title: string, episode: number): string {
  return `${title.toLowerCase().replace(/\s+/g, " ").trim() || "*"}::ep${episode}`;
}

function cacheGet(
  key: string,
  ttl: number
): NyaaTorrentResult | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > ttl) {
    cache.delete(key);
    return undefined;
  }
  return entry.result;
}

function cacheSet(key: string, result: NyaaTorrentResult | null): void {
  if (cache.size >= CACHE_MAX && !cache.has(key)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { at: Date.now(), result });
}

/** Strip the HTML entities xml2js may leave behind inside field text. */
function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/**
 * Extract a clean magnet URI from a parsed nyaa RSS item, tolerating schema
 * naming variance (the documented `nyaa:magnet`, then the enclosure, then a
 * whole-item scan) and normalising `&amp;` artefacts.
 */
function extractMagnet(item: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    item["nyaa:magnet"],
    item["magnet"],
    (item.enclosure as { url?: string } | undefined)?.url,
  ];
  for (const value of Object.values(item)) {
    if (typeof value === "string" && value.includes("magnet:")) {
      candidates.push(value);
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const cleaned = candidate
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, "")
      .trim();
    const idx = cleaned.indexOf("magnet:");
    if (idx === -1) continue;
    const magnet = cleaned.slice(idx);
    if (magnet.includes("xt=")) return magnet;
  }
  return null;
}

/** Parse a human size string ("1.2 GB") into bytes. */
function parseSize(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  const m = value.match(/^([\d.]+)\s*([KMGT]?B)?/i);
  if (!m) return 0;
  const mult: Record<string, number> = {
    "": 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
  };
  const unit = (m[2] ?? "").replace("b", "").toUpperCase();
  return Math.round(parseFloat(m[1]) * (mult[unit] ?? 1));
}

const toInt = (v: unknown): number =>
  parseInt(String(v ?? "0").replace(/[^\d]/g, ""), 10) || 0;

/** Normalised shape surfaced to the API route / UI. */
export interface NyaaTorrentResult {
  magnet: string;
  title: string;
  size: number;
  seeds: number;
  leeches: number;
  url: string;
  pubDate: string;
}
/** Normalise a title to comparable tokens (case-insensitive, alpha+digit runs). */
function titleTokens(source: string): Set<string> {
  const out = new Set<string>();
  const m = source.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of m) {
    if (token.length >= 2) out.add(token);
  }
  return out;
}

/**
 * Score every parsed item against the wanted title + episode and return the
 * best-matching item, or `null` when nothing plausible fits. A strict title
 * bar is kept to avoid serving the wrong episode's file.
 */
function pickBestItem(
  items: Record<string, unknown>[],
  title: string,
  episode: number
): Record<string, unknown> | null {
  const wanted = titleTokens(title);
  if (wanted.size === 0) return null;
  const epPadded = `.e${String(episode).padStart(2, "0")}.`;
  let bestItem: Record<string, unknown> | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const itemTitle = cleanText(item.title);
    if (!itemTitle) continue;
    const it = titleTokens(itemTitle);
    let overlap = 0;
    for (const w of wanted) if (it.has(w)) overlap += 1;
    let score = (overlap / wanted.size) * 100;
    // Reject weak title matches outright (wrong-anime guard).
    if (score < 60) continue;
    const lower = itemTitle.toLowerCase();
    // Episode affinity — an explicit episode tag is the strongest signal.
    if (lower.includes(`ep${episode}`) || lower.includes(`episode${episode}`)) score += 25;
    else if (lower.includes(epPadded)) score += 18;
    // Deprioritise OAD / specials / trailers; prefer full-episode releases.
    if (/\b(oad|special|bonus|trailer|pv|cm)\b/.test(lower)) score -= 20;
    // Among equally matched episodes, prefer larger (full-res) files.
    score += Math.min(parseSize(item["nyaa:size"]) / 1e9, 10);
    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }
  return bestItem;
}
/**
 * Query nyaa.si's RSS search endpoint for a specific anime episode.
 *
 * Returns the highest-confidence torrent's magnet, or `null` when the feed is
 * unreachable / empty / nothing credible matches. Callers must handle the
 * null case by falling back to the CC0 demo magnet in `stream.ts`.
 */
export async function findNyaaTorrent(
  title: string,
  episode: number
): Promise<NyaaTorrentResult | null> {
  const key = cacheKey(title, episode);
  const cached = cacheGet(key, CACHE_TTL_MS);
  if (cached !== undefined) return cached;

  // Skip the network call for non-Latin (Arabic / Japanese / Thai / Hebrew)
  // titles — Nyaa's search field is ASCII-only and would return empty results
  // anyway. Returning null immediately lets the demo fallback take over.
  if (/[^\x00-\x7F]/.test(title) || !title.trim()) {
    cacheSet(key, null);
    return null;
  }

  const qs = new URLSearchParams({
    page: "rss",
    q: `${title} ep${episode}`,
    c: NYAA_CATEGORY,
  });
  const url = `https://nyaa.si/?${qs.toString()}`;

  let result: NyaaTorrentResult | null = null;
  try {
    const parser = new Parser<
      Record<string, unknown>,
      Record<string, unknown>
    >({
      timeout: FETCH_TIMEOUT_MS,
      headers: { "User-Agent": USER_AGENT },
      customFields: { item: ITEM_CUSTOM_FIELDS },
    });
    const feed = await parser.parseURL(url);
    const items: Record<string, unknown>[] = Array.isArray(feed.items)
      ? feed.items.map((i) => i as Record<string, unknown>)
      : [];
    const best = pickBestItem(items, title, episode);
    if (best) {
      const magnet = extractMagnet(best);
      if (magnet) {
        result = {
          magnet,
          title: cleanText(best.title),
          size: parseSize(best["nyaa:size"]),
          seeds: toInt(best["nyaa:seeds"]),
          leeches: toInt(best["nyaa:leeches"]),
          url: typeof best.link === "string" ? best.link : "",
          pubDate:
            typeof best.pubDate === "string" ? best.pubDate : "",
        };
      }
    }
  } catch {
    // Network error / parse failure — silently fall through to null.
  }

  cacheSet(key, result);
  return result;
}