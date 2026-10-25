"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Flag,
  Server,
} from "lucide-react";
import { addReport } from "@/lib/store";
import type { Dictionary } from "@/i18n/get-dictionary";
import type { Locale } from "@/i18n/config";
import type { Anime, EpisodeStream, StreamingSource } from "@/types";
import { cn } from "@/lib/utils";
import { VideoPlayer } from "@/components/video-player";
import { CommentsSection } from "@/components/comments-section";
import { getEpisodeStream } from "@/services/stream";

export function WatchClient({ slug, num, anime, stream, locale, dict: t }: {
  slug: string; num: number; anime: Anime; stream: EpisodeStream | null; locale: Locale; dict: Dictionary;
}) {
  const router = useRouter();
  const [reported, setReported] = useState(false);
  // Live streaming sources resolved client-side by calling AniPub's API
  // directly in the browser. The SSR `stream` prop is always null on Vercel —
  // that blocked / failure-prone server request is never run server-side anymore.
  const [liveStream, setLiveStream] = useState<EpisodeStream | null>(null);
  const [streamLoading, setStreamLoading] = useState(true);
  // Track which server pill is active. Starts empty; set once live sources
  // resolve. Client navigation keeps this component mounted, so reset on
  // episode change.
  const [activeSourceId, setActiveSourceId] = useState<string>(
    () => stream?.sources.find((s) => s.default)?.id ?? stream?.sources[0]?.id ?? ""
  );
  // Bump to force the live source fetch to re-run (Retry button in the player).
  const [refreshKey, setRefreshKey] = useState(0);
  const retryStream = () => {
    setLiveStream(null); // clear any stale live sources so the effect re-runs
    setRefreshKey((k) => k + 1);
  };

  // Reset the active pill when the episode changes (client navigation keeps
  // this component mounted) so it re-selects once the live sources resolve.
  useEffect(() => {
    setActiveSourceId("");
  }, [slug, num]);

  // Resolve the episode's stream DIRECTLY in the browser by calling AniPub's
  // API (getEpisodeStream hits https://anipub.org, which sends
  // Access-Control-Allow-Origin: *). Runs on mount + every episode change and
  // is never executed during `next build`, so Vercel's blocked serverless
  // requests are bypassed entirely.
  useEffect(() => {
    let cancelled = false;
    setStreamLoading(true);
    getEpisodeStream(slug, num, anime.title.en)
      .then((ls) => {
        if (cancelled) return;
        if (ls && ls.sources.length) {
          setLiveStream(ls);
          setActiveSourceId(
            ls.sources.find((s) => s.default)?.id ?? ls.sources[0].id
          );
        }
      })
      .catch(() => {
        /* network / CORS error — keep the connecting spinner + empty state */
      })
      .finally(() => {
        if (!cancelled) setStreamLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, num, anime.title.en, refreshKey]);

  const current = anime.episodes[num - 1];
  const hasNext = num < anime.episodes.length;
  const hasPrev = num > 1;
  // Effective sources/subtitles: live sources once resolved, otherwise
  // the SSR sources from the page. The pill list and the player both read
  // this single array, so a live swap updates both.
  const activeSources = liveStream?.sources?.length ? liveStream.sources : stream?.sources ?? [];
  const activeSubtitles = liveStream?.subtitles?.length ? liveStream.subtitles : stream?.subtitles ?? [];
  // The currently-selected HTTP/HLS server.
  const activeSource: StreamingSource | undefined = activeSources.find((s) => s.id === activeSourceId);

  const report = () => {
    addReport({ slug, targetType: "video", targetId: `${slug}-ep-${num}`, reason: "Broken video source" });
    setReported(true);
    window.setTimeout(() => setReported(false), 2500);
  };

  // Interactive server pill for each HTTP/HLS source.
  const renderPill = (s: StreamingSource) => {
    const isActive = s.id === activeSourceId;
    return (
      <button
        key={s.id}
        type="button"
        role="radio"
        aria-checked={isActive}
        aria-label={`${s.name} ${s.quality}`}
        onClick={() => setActiveSourceId(s.id)}
        className={cn(
          "group flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-bold transition-all duration-300",
          isActive
            ? "bg-brand text-neutral-950 shadow-lg shadow-brand/20"
            : "bg-white/5 text-neutral-300 hover:bg-white/10 hover:text-white"
        )}
      >
        <Server className="h-3 w-3" aria-hidden />
        <span>{s.name}</span>
        <span dir="ltr" className="rounded-full bg-black/10 px-1.5 py-0.5 text-[10px] font-semibold">
          {s.quality}
        </span>
        {isActive && <Check className="h-3 w-3" aria-hidden />}
      </button>
    );
  };

  return (
    <>
      <section aria-label={t.watch.nowPlaying}>
        <VideoPlayer
          sources={activeSources}
          subtitles={activeSubtitles}
          slug={slug}
          episode={num}
          totalEpisodes={anime.episodes.length}
          poster={anime.banner}
          epTitle={current.title[locale]}
          dict={t}
          requestedSourceId={activeSourceId}
          hasNext={hasNext}
          hasPrev={hasPrev}
          fillerEpisodes={anime.episodes.filter((e) => e.isFiller).map((e) => e.number)}
          onNext={() => router.push(`/anime/${slug}/watch?ep=${num + 1}`)}
          onPrev={() => router.push(`/anime/${slug}/watch?ep=${num - 1}`)}
          onRetryStream={retryStream}
        />
      </section>

      {current.isFiller && (
        <div
          role="note"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm"
        >
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-amber-400 ring-1 ring-amber-500/30">
            {t.detail.fillerBadge}
          </span>
          <p className="text-amber-100/90">{t.watch.fillerNote}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {hasPrev ? (
          <Link href={`/anime/${anime.slug}/watch?ep=${num - 1}`}
            className="flex items-center gap-2 rounded-full bg-white/10 px-5 py-2.5 text-sm font-bold text-white transition-colors duration-300 hover:bg-white/20">
            <ChevronLeft className="h-4 w-4 rtl-flip" aria-hidden />
            {t.watch.prevEpisode}
          </Link>
        ) : <span />}
        <div className="flex-1" />
        {hasNext && (
          <Link href={`/anime/${anime.slug}/watch?ep=${num + 1}`}
            className="flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-bold text-neutral-950 transition-all duration-300 hover:scale-105 hover:bg-brand-300">
            {t.watch.nextEpisode}
            <ChevronRight className="h-4 w-4 rtl-flip" aria-hidden />
          </Link>
        )}
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
        <div role="radiogroup" aria-label={t.player.server} className="flex flex-wrap items-center gap-2">
          <span className="mr-1 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-neutral-500">
            <Server className="h-3.5 w-3.5" aria-hidden />
            {t.player.server}
          </span>
          {streamLoading && (
            <span
              role="status"
              className="flex items-center gap-1.5 rounded-full bg-white/5 px-3.5 py-1.5 text-xs font-bold text-neutral-400"
            >
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-500 border-t-transparent" aria-hidden />
              {t.player.connecting}
            </span>
          )}
          {activeSources.map(renderPill)}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-3">
          <div className="flex min-w-0 items-center gap-2 text-xs text-neutral-400">
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                activeSource ? "bg-emerald-400 shadow shadow-emerald-500/40" : "bg-neutral-500"
              )}
              aria-hidden
            />
            <span dir="ltr" className="truncate font-mono text-[11px]">
              {(activeSource?.url ?? "—").slice(0, 64)}
            </span>
          </div>
          <button
            type="button"
            onClick={report}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-semibold text-neutral-300 transition-all duration-300 hover:bg-white/10 hover:text-white"
            aria-live="polite"
          >
            {reported ? <Check className="h-3 w-3" aria-hidden /> : <Flag className="h-3 w-3" aria-hidden />}
            {reported ? t.admin.confirmed : t.player.reportVideo}
          </button>
        </div>
      </div>
      <CommentsSection target={`watch:${anime.slug}:${num}`} dict={t} title={t.player.commentsHere} />
    </>
  );
}
