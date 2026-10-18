/**
 * Consumet API service (GogoAnime provider).
 *
 * Typed helpers that talk to a self-hostable Consumet instance and resolve
 * real, playable HLS (.m3u8) streaming links for an episode — used to feed the
 * video player's source selector dynamically when a user opens an episode.
 *
 * Endpoints (relative to the configured base URL):
 *   - Search   : GET /anime/gogoanime/{query}
 *   - Info     : GET /anime/gogoanime/info/{id}
 *   - Watch    : GET /anime/gogoanime/watch?episodeId={episodeId}
 *
 * Resilience: the base URL is configurable via `CONSUMET_BASE` (server) or
 * `NEXT_PUBLIC_CONSUMET_BASE` (client); every request has a 12s timeout and is
 * wrapped in a typed `ConsumetError`. The orchestrator throws when no usable
 * source is found so callers (/api/stream) can fall back to demo sources.
 */

import type { EpisodeStream, SourceQuality, StreamingSource } from "@/types";

/** Default public Consumet mirror (override with CONSUMET_BASE). */
const DEFAULT_BASE = "https://api.consumet.ts";
const REQUEST_TIMEOUT_MS = 12000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; ShinkaiAnimeStreamer/1.0; +https://github.com/shinkai)";

/** Typed wrapper so callers can distinguish Consumet failures from app errors. */
export class ConsumetError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConsumetError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Raw response shapes (kept minimal + tolerant of provider drift)     */
/* ------------------------------------------------------------------ */

export interface ConsumetSearchItem {
  id: string;
  title: string;
  image?: string;
  totalEpisodes?: number;
  [key: string]: unknown;
}

export interface ConsumetEpisode {
  id: string;
  number?: number;
  url?: string;
  thumbnail?: string;
  [key: string]: unknown;
}

export interface ConsumetInfo {
  id: string;
  title?: string;
  totalEpisodes?: number;
  episodes?: ConsumetEpisode[];
  [key: string]: unknown;
}

export interface ConsumetSource {
  id: string;
  name?: string;
  quality?: string;
  /** Adaptive HLS / progressive URL at the top level. */
  url?: string;
  isM3U8?: boolean;
  hasM3U8?: boolean;
  /** Nested stream metadata some provider versions emit here. */
  stream?: { source?: string; url?: string; isM3U8?: boolean; hasM3U8?: boolean };
  properties?: { url?: string; thumbnail?: string };
  download?: { source?: string; url?: string };
  [key: string]: unknown;
}

export interface ConsumetWatch {
  title?: string;
  description?: string;
  episodes?: ConsumetEpisode[];
  sources?: ConsumetSource[];
  downloadLink?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Low-level fetch                                                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Endpoint base resolution + automatic failover                       */
/* ------------------------------------------------------------------ */

/**
 * Ordered list of Consumet base URLs to try, most-preferred first.
 *
 * Configure via `CONSUMET_BASES` (comma/space separated) to give the service a
 * set of mirrors to fail over automatically; `CONSUMET_BASE` / the single
 * public default are always appended so it keeps working with no env.
 *   e.g. CONSUMET_BASES="http://localhost:7830,https://my-mirror.example.com"
 */
function baseList(): string[] {
  const raw =
    process.env.CONSUMET_BASES ??
    process.env.CONSUMET_BASE ??
    process.env.NEXT_PUBLIC_CONSUMET_BASE ??
    "";
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const ordered = [...parts, DEFAULT_BASE];
  return Array.from(new Set(ordered));
}

/** Primary base (first configured) — used by logs and the default `consumetGet`. */
function consumetBase(): string {
  return baseList()[0];
}

/**
 * Remembers which base actually answered a request for ~30min so subsequent
 * calls in a hot session skip re-probing dead mirrors first.
 */
const preferred = { base: null as string | null, exp: 0 };
const PREFERRED_TTL = 30 * 60 * 1000;
function markPreferred(base: string) {
  preferred.base = base;
  preferred.exp = Date.now() + PREFERRED_TTL;
}

/**
 * Run `fn(base)` against the preferred base first, then every configured
 * mirror in order, until one succeeds; records the winner. Only throws once all
 * bases are exhausted — this is the service's automatic failover.
 */
async function withFallback<T>(
  label: string,
  fn: (base: string) => Promise<T>
): Promise<T> {
  const order: string[] = [];
  if (preferred.base && preferred.exp > Date.now()) order.push(preferred.base);
  for (const b of baseList()) if (!order.includes(b)) order.push(b);
  if (!order.length) {
    throw new ConsumetError("CONSUMET_NO_BASE", "No Consumet endpoint configured");
  }
  let lastErr: unknown = null;
  for (const base of order) {
    try {
      const out = await fn(base);
      if (base !== preferred.base) markPreferred(base);
      return out;
    } catch (e) {
      lastErr = e;
      const detail = e instanceof Error ? e.message : String(e);
      console.warn(
        `[CONSUMET] ${label} failed on ${base} (${detail}) → trying next mirror`
      );
    }
  }
  throw lastErr instanceof ConsumetError
    ? lastErr
    : new ConsumetError(
        "CONSUMET_UNAVAILABLE",
        `All ${order.length} Consumet endpoint(s) failed: ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`
      );
}

async function consumetGet<T>(path: string, base: string): Promise<T> {
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
  } catch (e) {
    // AbortController timeouts surface as a DOMException("AbortError").
    const aborted = e instanceof Error && e.name === "AbortError";
    const detail = aborted
      ? `timeout after ${REQUEST_TIMEOUT_MS}ms`
      : (e as Error).message;
    console.error(`[CONSUMET] ✗ network error on ${path}: ${detail}`);
    throw new ConsumetError("CONSUMET_NETWORK", `Network error: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) {
    console.error(`[CONSUMET] ✗ rate limited (429) on ${path}`);
    throw new ConsumetError("CONSUMET_RATE_LIMITED", "Rate limited (429)");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[CONSUMET] ✗ HTTP ${res.status} on ${path}${body ? ` — body: ${body.slice(0, 300)}` : ""}`);
    throw new ConsumetError(`CONSUMET_HTTP_${res.status}`, `HTTP ${res.status}`);
  }
  const text = await res.text();
  if (!text) {
    console.error(`[CONSUMET] ✗ empty response body on ${path}`);
    throw new ConsumetError("CONSUMET_EMPTY", "Empty response body");
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    console.error(`[CONSUMET] ✗ invalid JSON on ${path}: ${(e as Error).message} — head: ${text.slice(0, 300)}`);
    throw new ConsumetError("CONSUMET_PARSE", "Invalid JSON from Consumet");
  }
}

/* ------------------------------------------------------------------ */
/* Typed endpoint helpers                                               */
/* ------------------------------------------------------------------ */

/** `GET /anime/gogoanime/{query}` — full-text search. */
export async function consumetSearch(query: string): Promise<ConsumetSearchItem[]> {
  const q = query.trim();
  if (!q) {
    console.warn("[CONSUMET] search skipped: empty query");
    return [];
  }
  const path = `/anime/gogoanime/${encodeURIComponent(q)}`;
  console.log(`[CONSUMET] search → query="${q}" path=${path}`);
  const data = await withFallback("search", (base) =>
    consumetGet<{ items?: ConsumetSearchItem[] }>(path, base)
  );
  const items = Array.isArray(data.items) ? data.items : [];
  const valid = items.filter((i) => i && typeof i.id === "string");
  console.log(
    `[CONSUMET] search ← ${items.length} raw / ${valid.length} valid item(s):`
  );
  valid.slice(0, 10).forEach((i, idx) => {
    console.log(`  [${idx}] "${i.title}" (id=${i.id}, ep=${i.totalEpisodes ?? "?"})`);
  });
  return valid;
}

/** `GET /anime/gogoanime/info/{id}` — info + per-episode list. */
export async function consumetInfo(id: string): Promise<ConsumetInfo> {
  const path = `/anime/gogoanime/info/${encodeURIComponent(id)}`;
  const data = await withFallback("info", (base) =>
    consumetGet<ConsumetInfo>(path, base)
  );
  if (!data || (!data.id && !Array.isArray(data.episodes))) {
    throw new ConsumetError("CONSUMET_EMPTY", "Info response had no usable fields");
  }
  return data;
}

/** `GET /anime/gogoanime/watch?episodeId={episodeId}` — streaming sources. */
export async function consumetWatch(episodeId: string): Promise<ConsumetWatch> {
  const path = `/anime/gogoanime/watch?episodeId=${encodeURIComponent(episodeId)}`;
  const data = await withFallback("watch", (base) =>
    consumetGet<ConsumetWatch>(path, base)
  );
  if (!data || !Array.isArray(data.sources)) {
    throw new ConsumetError("CONSUMET_EMPTY", "Watch response had no sources");
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Mapping to the player's source selector                              */
/* ------------------------------------------------------------------ */

const QUALITY_SET: SourceQuality[] = ["auto", "1080p", "720p", "480p", "360p"];

/** Normalize a provider quality label ("1080P", "720p", "540", ...) → our union. */
export function normalizeQuality(raw: string | undefined): SourceQuality {
  const s = (raw ?? "").trim().toLowerCase();
  if ((QUALITY_SET as string[]).includes(s)) return s as SourceQuality;
  const m = s.match(/(\d{3,4})/);
  if (!m) return "auto";
  const n = parseInt(m[1], 10);
  if (n >= 720 && n <= 1080) return "1080p";
  if (n >= 600 && n < 720) return "720p";
  if (n >= 360 && n < 600) return "480p";
  if (n < 360) return "360p";
  return "auto";
}

/** Best playable URL for a source (prefer an adaptive .m3u8). */
function sourcePlayableUrl(s: ConsumetSource): string | undefined {
  const candidates = [s.stream?.url, s.url, s.properties?.url].filter(
    (u): u is string => typeof u === "string" && u.length > 0
  );
  if (!candidates.length) return undefined;
  const m3u8 = candidates.find((u) => /\.m3u8(\?|$)/i.test(u));
  return m3u8 ?? candidates[0];
}

/**
 * Map a Consumet watch response onto the player's source selector. Emits one
 * pill per provider server plus a default "Auto" pill (highest quality) so the
 * selector reads e.g. Auto, 1080p, 720p.
 */
export function toStreamingSources(watch: ConsumetWatch): StreamingSource[] {
  const sources = watch.sources ?? [];
  const mapped: StreamingSource[] = [];
  sources.forEach((s, i) => {
    const url = sourcePlayableUrl(s);
    if (!url) return;
    mapped.push({
      id: `gogo-${s.id ?? i}`,
      name: s.name?.trim() || `Server ${i + 1}`,
      url,
      quality: s.quality ? normalizeQuality(s.quality) : "auto",
    });
  });
  if (!mapped.length) return [];

  /* "Auto" points at the highest-quality HLS link (hls.js adapts within it). */
  const heightOf = (url: string) => {
    const m = mapped.find((x) => x.url === url);
    const q = (m?.quality ?? "") as string;
    const n = q.match(/(\d{3,4})/);
    return n ? parseInt(n[1], 10) : 0;
  };
  const best = mapped.slice().sort((a, b) => heightOf(b.url) - heightOf(a.url))[0];
  const auto: StreamingSource = {
    id: "gogo-auto",
    name: "Auto",
    url: best.url,
    quality: "auto",
    default: true,
  };
  return [auto, ...mapped];
}

/* ------------------------------------------------------------------ */
/* Orchestration: title + episode number → playable sources            */
/* ------------------------------------------------------------------ */

const idCache = new Map<string, { exp: number; val: string }>();
const infoCache = new Map<string, { exp: number; val: ConsumetInfo }>();
const CACHE_TTL = 10 * 60 * 1000;

function cacheGet<T>(map: Map<string, { exp: number; val: T }>, key: string): T | undefined {
  const hit = map.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Title matching (season / spacing / punctuation tolerant)            */
/* ------------------------------------------------------------------ */

/**
 * Heavy normalization: case/diacritic-insensitive, drops punctuation and
 * whitespace entirely, so "Demon-Slayer" ≡ "Demon Slayer" and accented titles
 * compare equal to their romanized form.
 */
function normCompact(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Light normalization for word-level comparison: keeps alphanumerics + spaces
 * (collapses runs) so phrase tokenization operates on readable chunks.
 */
function normWords(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Parse a season out of a title, where a normal title would not contain one. */
function detectSeason(raw: string): number | undefined {
  const n = raw.toLowerCase();
  const m =
    n.match(/\bseason\s+(\d{1,2})\b/i) ??
    n.match(/\bs\s*(\d{1,2})\b/i) ??
    n.match(/\b(\d{1,2})\s+(?:season|cour)\b/i);
  if (m) {
    const v = parseInt(m[1], 10);
    return v >= 1 ? v : undefined;
  }
  // Only a trailing "(20xx)" counts as a season code; a bare year (e.g. "1999"
  // in "Space Dandy 1999") is NOT a season.
  if (n.includes("(20")) {
    const y = raw.match(/\(\s*(\d{4})\s*\)\s*$/);
    if (y) {
      const code = parseInt(y[1].slice(1), 10);
      if (code >= 1 && code <= 20) return code;
    }
  }
  return undefined;
}

/**
 * Strip season markers so both sides reduce to the core title
 * ("Aoashi S2" / "Aoashi (2025)" → "aoashi").
 */
function stripSeason(raw: string): string {
  return raw
    .replace(/\bseason\s+\d{1,2}\b/gi, " ")
    .replace(/\bs\s*\d{1,2}\b/gi, " ")
    .replace(/\b\d{1,2}\s+(?:season|cour)\b/gi, " ")
    .replace(/\(\s*\d{4}\s*\)/g, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();
}

/** Case/order-insensitive containment: both titles share every word. */
function containsAllWords(a: string, b: string): boolean {
  if (!a || !b) return false;
  const wa = new Set(a.split(/\s+/).filter(Boolean));
  const wb = b.split(/\s+/).filter(Boolean);
  if (!wa.size || !wb.length) return false;
  for (const w of wb) if (!wa.has(w)) return false;
  return true;
}

/** Band-limited Levenshtein (edit distance) on strings. */
function dist(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i += 1) {
    const cur = [i];
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[lb];
}

/** Per-word similarity (0..1) tolerating short per-word typos/reorderings. */
function wordScore(a: string, b: string): number {
  const wa = a.split(/\s+/).filter(Boolean);
  const wb = b.split(/\s+/).filter(Boolean);
  if (!wa.length || !wb.length) return 0;
  let matched = 0;
  const used = new Set<number>();
  for (const w of wa) {
    let m = 0;
    for (let j = 0; j < wb.length; j += 1) {
      if (used.has(j)) continue;
      const d = dist(w, wb[j]);
      const sc = Math.max(0, 1 - d / Math.max(w.length, wb[j].length, 1));
      if (sc > m) {
        m = sc;
        if (sc > 0.5) used.add(j);
      }
    }
    matched += m;
  }
  return matched / Math.max(wa.length, wb.length);
}

/**
 * Score one search result against the query. Combines, in order of strength:
 * an exact (fully-normalized) title match, a substring match, a word-set
 * containment match, a season-aware core-title comparison, then a per-word
 * Levenshtein fuzz score. Provider rank adds a small tie-breaker in
 * `pickBestItem` only.
 */
export function matchScore(item: ConsumetSearchItem, query: string): number {
  const itemTitle = item.title ?? "";
  const ncA = normCompact(itemTitle);
  const ncB = normCompact(query);
  if (ncA.length && ncB.length && ncA === ncB) return 1;

  const wA = normWords(itemTitle);
  const wB = normWords(query);
  if (wA && wB && (wA.includes(wB) || wB.includes(wA))) return 0.9;

  // Word-set symmetry: "Rising of the Shield The Hero" ≈ "The Shield Hero".
  if (containsAllWords(wA, wB) || containsAllWords(wB, wA)) return 0.85;

  // Season-aware comparison on the reduced core titles.
  const qSea = detectSeason(query);
  const iSea = detectSeason(itemTitle);
  const coreA = stripSeason(itemTitle);
  const coreB = stripSeason(query);
  let base: number;
  if (coreB && (normCompact(coreA) === normCompact(coreB) || containsAllWords(coreA, coreB))) {
    base = 0.82;
    // Both claim a season → reward a match, penalize a mismatch.
    if (qSea !== undefined && iSea !== undefined) base += qSea === iSea ? 0.05 : -0.15;
  } else {
    base = 0.5 * wordScore(coreA, coreB);
  }

  // The query explicitly wants a season the item isn't a season entry for.
  if (qSea !== undefined && iSea === undefined) base = Math.min(base, 0.6);

  return Math.max(0, Math.min(1, base));
}

/**
 * Pick the best-matching search result, logging every candidate's score so a
 * wrong pick (or an empty result set) is instantly visible in the server
 * console.
 */
function pickBestItem(
  items: ConsumetSearchItem[],
  query: string
): { item: ConsumetSearchItem; score: number } | undefined {
  if (!items.length) return undefined;
  const ranked = items
    .map((item, i) => ({ item, score: matchScore(item, query) + (1 / (i + 1)) * 0.05 }))
    .sort((a, b) => b.score - a.score);
  console.log(`[CONSUMET] match scores for "${query}":`);
  ranked.slice(0, 10).forEach((r, idx) => {
    console.log(`  #${idx} score=${r.score.toFixed(3)} → "${r.item.title}" (id=${r.item.id})`);
  });
  return { item: ranked[0].item, score: ranked[0].score };
}

/**
 * Resolve real HLS streaming sources for an episode from Consumet.
 *
 * Looks up the anime by title (search → best match), finds the requested
 * episode id (info), then fetches that episode's streaming sources (watch).
 * Throws `ConsumetError` when the title can't be matched or no usable source
 * is returned — callers (the /api/stream route) fall back to demo sources.
 */
export async function getConsumetEpisodeStream(
  title: string,
  episode: number
): Promise<EpisodeStream> {
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    console.error(`[CONSUMET] rejected: empty title (episode=${episode})`);
    throw new ConsumetError("CONSUMET_NO_TITLE", "No title to search");
  }
  console.log(`[CONSUMET] === resolve "${cleanTitle}" episode ${episode} ===`);

  /* 1) Title → GogoAnime id (cached). */
  let gogoId = cacheGet(idCache, cleanTitle);
  if (gogoId) {
    console.log(`[CONSUMET] cache hit id=${gogoId} for "${cleanTitle}"`);
  } else {
    const items = await consumetSearch(cleanTitle);
    if (!items.length) {
      console.error(`[CONSUMET] no search results for "${cleanTitle}" → falling back`);
      throw new ConsumetError("CONSUMET_NOT_FOUND", `No search results for "${cleanTitle}"`);
    }
    const best = pickBestItem(items, cleanTitle);
    if (!best) {
      console.error(`[CONSUMET] no usable match among ${items.length} results for "${cleanTitle}"`);
      throw new ConsumetError("CONSUMET_NOT_FOUND", `No match for "${cleanTitle}"`);
    }
    gogoId = best.item.id;
    console.log(
      `[CONSUMET] matched title="${best.item.title}" id=${gogoId} (score=${best.score.toFixed(3)})`
    );
    idCache.set(cleanTitle, { exp: Date.now() + CACHE_TTL, val: gogoId });
  }

  /* 2) id → info + episode list (cached), then the requested episode's id. */
  let info = cacheGet(infoCache, gogoId);
  if (info) {
    console.log(`[CONSUMET] cache hit info for ${gogoId} (${info.episodes?.length ?? 0} episodes)`);
  } else {
    info = await consumetInfo(gogoId);
    infoCache.set(gogoId, { exp: Date.now() + CACHE_TTL, val: info });
  }
  const episodes = info.episodes ?? [];
  console.log(`[CONSUMET] info id=${gogoId} title="${info.title}" totalEpisodes=${episodes.length}`);
  const epByNumber = episodes.find((e) => (e.number ?? 0) === episode);
  const epItem = epByNumber ?? episodes[episode - 1] ?? undefined;
  const episodeId = epItem?.id;
  if (!episodeId) {
    const numbers = episodes.slice(0, 60).map((e) => e.number ?? -1).join(",");
    console.error(
      `[CONSUMET] episode ${episode} not found (matched title "${info.title}" has ${episodes.length} episodes; numbers=${numbers})`
    );
    throw new ConsumetError(
      "CONSUMET_NO_EPISODE",
      `Episode ${episode} not found in "${info.title || gogoId}" (${episodes.length} available)`
    );
  } else if (!epByNumber) {
    console.warn(
      `[CONSUMET] no episode explicitly numbered ${episode}; using position ${episode} → id=${episodeId}`
    );
  }

  /* 3) episodeId → streaming sources. */
  const watch = await consumetWatch(episodeId);
  const sources = toStreamingSources(watch);
  console.log(
    `[CONSUMET] resolved episode ${episode} (id=${episodeId}) → ${sources.length} source(s)`
  );
  if (!sources.length) {
    console.error(
      `[CONSUMET] no playable sources for episode ${episode} (id=${episodeId}); raw server count=${
        watch.sources?.length ?? 0
      }`
    );
    throw new ConsumetError("CONSUMET_NO_SOURCES", "No playable sources");
  }

  return { slug: "", episode, sources, subtitles: [] };
}