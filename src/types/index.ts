export type AnimeStatus = "ongoing" | "completed";

export interface LocalizedText {
  en: string;
  ar: string;
}

export interface Episode {
  number: number;
  title: LocalizedText;
  duration: string; // e.g. "23:40"
  thumbnail: string;
  airedAt: string; // ISO date
  /**
   * True when the episode is filler (not part of the main / source-matter story).
   * Populated from the curated registry in `@/lib/anime-filler` — the public
   * AniList/Jikan/MAL APIs do NOT expose a per-episode filler flag.
   */
  isFiller?: boolean;
}

export type AnimeFormat = "TV" | "MOVIE" | "OVA" | "ONA" | "SPECIAL" | "MUSIC" | string;
export type AnimeSeason = "WINTER" | "SPRING" | "SUMMER" | "FALL" | string;

export interface AnimeCharacter {
  id: number;
  name: string;
  image: string;
  role?: string;
}

export interface Anime {
  id: string;
  slug: string;
  anilistId?: number;
  title: LocalizedText;
  nativeTitle?: string;
  romajiTitle?: string;
  synopsis: LocalizedText;
  cover: string;
  banner: string;
  rating: number; // 0 - 10
  popularity?: number;
  year: number;
  season?: AnimeSeason;
  seasonYear?: number;
  format?: AnimeFormat;
  duration?: number;
  status: AnimeStatus;
  genres: string[]; // genre keys, translated in UI later
  tags?: string[];
  studio: LocalizedText;
  imdbRating?: number | string;
  animeAwardsCount?: number;
  episodeCount: number;
  trailerUrl?: string;
  trending?: boolean;
  nextAiringAt?: number | null;
  nextAiringEpisode?: number | null;
  characters?: AnimeCharacter[];
  related?: Anime[];
  recommendations?: Anime[];
  episodes: Episode[];
}

export interface Genre {
  key: string;
  label: LocalizedText;
}

export type ListStatus = "watching" | "plan" | "completed" | "onhold" | "dropped" | "favorite";

export interface LibraryEntry {
  slug: string;
  anilistId?: number;
  title: string;
  /** Arabic title snapshot so profile cards render correctly in AR mode. */
  titleAr?: string;
  cover: string;
  /** Site score (0-10) snapshotted at add time. */
  rating?: number;
  format?: string;
  year?: number;
  episodes?: number;
  status: ListStatus;
  score?: number; // user score 1-10
  progress?: number; // watched episodes
  favorited?: boolean;
  updatedAt: number;
}

export interface WatchProgress {
  slug: string;
  ep: number;
  time: number;
  duration: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Streaming sources & subtitles                                      */
/* ------------------------------------------------------------------ */

export type SourceQuality = "auto" | "1080p" | "720p" | "480p" | "360p";

export interface StreamingSource {
  id: string;
  name: string;
  /**
   * HLS (.m3u8) or progressive URL. Adaptive HLS preferred.
   */
  url: string;
  quality: SourceQuality;
  /** Whether this source is the default for the episode. */
  default?: boolean;
}

export interface SubtitleTrack {
  id: string;
  label: string;
  /** BCP-47 language tag, e.g. "en", "ar". */
  lang: string;
  /** WebVTT URL. */
  url: string;
  default?: boolean;
}

/** A playable episode instance assembled from sources + subtitles. */
export interface EpisodeStream {
  slug: string;
  episode: number;
  sources: StreamingSource[];
  subtitles: SubtitleTrack[];
}

/* ------------------------------------------------------------------ */
/* Comments (threaded, likes, moderation)                              */
/* ------------------------------------------------------------------ */

export type CommentTargetType = "anime" | "episode" | "watch";

export interface CommentReply {
  id: string;
  author: string;
  text: string;
  createdAt: number;
}

export interface CommentItem {
  id: string;
  /** e.g. `anime:one-piece` or `watch:one-piece:5` */
  target: string;
  author: string;
  text: string;
  createdAt: number;
  likes: number;
  likedByMe?: boolean;
  replies: CommentReply[];
  /** moderation flag set by admins */
  hidden?: boolean;
}

export interface ReportItem {
  id: string;
  targetType: "video" | "comment";
  targetId: string;
  slug?: string;
  episode?: number;
  reason: string;
  detail?: string;
  createdAt: number;
  status: "open" | "resolved" | "dismissed";
}

/* ------------------------------------------------------------------ */
/* User area: settings, ratings, profile                               */
/* ------------------------------------------------------------------ */

/** Permanently locked to cinematic dark. Kept as a type for stored-data compatibility. */
export type ThemePref = "dark";

export interface UserSettings {
  locale: "en" | "ar";
  theme: ThemePref;
  autoplayNext: boolean;
  autoplayPreviews: boolean;
  /** Language tag of the preferred subtitle track ("off" disables). */
  defaultSubtitle: string;
  preferredQuality: SourceQuality;
  rememberProgress: boolean;
}

export interface UserRating {
  slug: string;
  /** 1 - 10 */
  score: number;
  updatedAt: number;
}

export type UserRole = "viewer" | "editor" | "admin";

export interface UserProfile {
  name: string;
  email: string;
  role: UserRole;
  avatar?: string;
}

/* ------------------------------------------------------------------ */
/* Schedule / airing calendar                                          */
/* ------------------------------------------------------------------ */

export interface AiringEntry {
  id: number;
  airingAt: number;
  episode: number;
  anime: Anime;
}

/* ------------------------------------------------------------------ */
/* Browse filters (URL-synchronised)                                   */
/* ------------------------------------------------------------------ */

export type BrowseSort = "popularity" | "score" | "newest" | "az" | "trending";

export interface BrowseFilters {
  q: string;
  genres: string[];
  year?: number;
  season?: string;
  format?: string;
  status?: string;
  sort: BrowseSort;
  page: number;
}

/* ------------------------------------------------------------------ */
/* Admin / content management                                          */
/* ------------------------------------------------------------------ */

export interface AdminEpisode {
  number: number;
  title: LocalizedText;
  duration: string;
  thumbnail: string;
  airedAt: string;
  sources: StreamingSource[];
  subtitles: SubtitleTrack[];
}

/** Editable record used by the admin CRUD screens. */
export interface AdminAnime {
  id: string;
  slug: string;
  anilistId?: number;
  title: LocalizedText;
  nativeTitle?: string;
  romajiTitle?: string;
  synopsis: LocalizedText;
  cover: string;
  banner: string;
  rating: number;
  popularity?: number;
  year: number;
  season?: AnimeSeason;
  seasonYear?: number;
  format?: AnimeFormat;
  duration?: number;
  status: AnimeStatus;
  genres: string[];
  tags?: string[];
  studio: LocalizedText;
  imdbRating?: number | string;
  animeAwardsCount?: number;
  episodeCount: number;
  trailerUrl?: string;
  trending?: boolean;
  featured?: boolean;
  episodes: AdminEpisode[];
}

export interface AdminUserRecord {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: number;
  watchlistCount: number;
  commentsCount: number;
}

export interface HeroSlide {
  id: string;
  slug: string;
  title: LocalizedText;
  banner: string;
  enabled: boolean;
  order: number;
}

export interface AnalyticsSnapshot {
  totalViews: number;
  totalTitles: number;
  topTitles: { slug: string; title: LocalizedText; views: number }[];
  viewsByDay: { date: string; views: number }[];
}

