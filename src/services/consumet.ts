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

function consumetBase(): string {
  const fromEnv =
    process.env.CONSUMET_BASE ?? process.env.NEXT_PUBLIC_CONSUMET_BASE ?? "";
  return (fromEnv.trim() || DEFAULT_BASE).replace(/\/+$/, "");
}

async function consumetGet<T>(path: string): Promise<T> {
  const url = `${consumetBase()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
  } catch (e) {
    throw new ConsumetError("CONSUMET_NETWORK", `Network error: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) throw new ConsumetError("CONSUMET_RATE_LIMITED", "Rate limited (429)");
  if (!res.ok) throw new ConsumetError(`CONSUMET_HTTP_${res.status}`, `HTTP ${res.status}`);
  const text = await res.text();
  if (!text) throw new ConsumetError("CONSUMET_EMPTY", "Empty response body");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConsumetError("CONSUMET_PARSE", "Invalid JSON from Consumet");
  }
}

/* ------------------------------------------------------------------ */
/* Typed endpoint helpers                                               */
/* ------------------------------------------------------------------ */

/** `GET /anime/gogoanime/{query}` — full-text search. */
export async function consumetSearch(query: string): Promise<ConsumetSearchItem[]> {
  const q = query.trim();
  if (!q) return [];
  const path = `/anime/gogoanime/${encodeURIComponent(q)}`;
  const data = await consumetGet<{ items?: ConsumetSearchItem[] }>(path);
  const items = Array.isArray(data.items) ? data.items : [];
  return items.filter((i) => i && typeof i.id === "string");
}

/** `GET /anime/gogoanime/info/{id}` — info + per-episode list. */
export async function consumetInfo(id: string): Promise<ConsumetInfo> {
  const data = await consumetGet<ConsumetInfo>(
    `/anime/gogoanime/info/${encodeURIComponent(id)}`
  );
  if (!data || (!data.id && !Array.isArray(data.episodes))) {
    throw new ConsumetError("CONSUMET_EMPTY", "Info response had no usable fields");
  }
  return data;
}

/** `GET /anime/gogoanime/watch?episodeId={episodeId}` — streaming sources. */
export async function consumetWatch(episodeId: string): Promise<ConsumetWatch> {
  const path = `/anime/gogoanime/watch?episodeId=${encodeURIComponent(episodeId)}`;
  const data = await consumetGet<ConsumetWatch>(path);
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

/** Case/diacritic-insensitive similarity so "Demon Slayer" matches "Demon-Slayer". */
function similarity(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const ta = new Set(na.split(""));
  let common = 0;
  for (const ch of nb.split("")) if (ta.has(ch)) common += 1;
  return common / Math.max(na.length, nb.length);
}

function pickBestItem(items: ConsumetSearchItem[], query: string): ConsumetSearchItem | undefined {
  if (!items.length) return undefined;
  return items
    .map((item, i) => ({ item, score: similarity(item.title, query) + 1 / (i + 1) }))
    .sort((x, y) => y.score - x.score)[0]?.item;
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
  if (!cleanTitle) throw new ConsumetError("CONSUMET_NO_TITLE", "No title to search");

  /* 1) Title → GogoAnime id (cached). */
  let gogoId = cacheGet(idCache, cleanTitle);
  if (!gogoId) {
    const items = await consumetSearch(cleanTitle);
    const best = pickBestItem(items, cleanTitle);
    if (!best) throw new ConsumetError("CONSUMET_NOT_FOUND", `No match for "${cleanTitle}"`);
    gogoId = best.id;
    idCache.set(cleanTitle, { exp: Date.now() + CACHE_TTL, val: gogoId });
  }

  /* 2) id → info + episode list (cached), then the requested episode's id. */
  let info = cacheGet(infoCache, gogoId);
  if (!info) {
    info = await consumetInfo(gogoId);
    infoCache.set(gogoId, { exp: Date.now() + CACHE_TTL, val: info });
  }
  const episodes = info.episodes ?? [];
  const epItem =
    episodes.find((e) => (e.number ?? 0) === episode) ??
    episodes[episode - 1] ??
    undefined;
  const episodeId = epItem?.id;
  if (!episodeId) throw new ConsumetError("CONSUMET_NO_EPISODE", `Episode ${episode} not found`);

  /* 3) episodeId → streaming sources. */
  const watch = await consumetWatch(episodeId);
  const sources = toStreamingSources(watch);
  if (!sources.length) throw new ConsumetError("CONSUMET_NO_SOURCES", "No playable sources");

  return { slug: "", episode, sources, subtitles: [] };
}