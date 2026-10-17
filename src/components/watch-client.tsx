"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ChevronLeft, ChevronRight, Flag, Warehouse } from "lucide-react";
import { addReport } from "@/lib/store";
import type { Dictionary } from "@/i18n/get-dictionary";
import type { Locale } from "@/i18n/config";
import type { Anime, EpisodeStream } from "@/types";
import { VideoPlayer } from "@/components/video-player";
import { CommentsSection } from "@/components/comments-section";

export function WatchClient({ slug, num, anime, stream, locale, dict: t }: {
  slug: string; num: number; anime: Anime; stream: EpisodeStream; locale: Locale; dict: Dictionary;
}) {
  const router = useRouter();
  const [reported, setReported] = useState(false);
  const current = anime.episodes[num - 1];
  const hasNext = num < anime.episodes.length;
  const hasPrev = num > 1;

  const report = () => {
    addReport({ slug, targetType: "video", targetId: `${slug}-ep-${num}`, reason: "Broken video source" });
    setReported(true);
    window.setTimeout(() => setReported(false), 2500);
  };

  return (
    <>
      <section aria-label={t.watch.nowPlaying}>
        <VideoPlayer
          sources={stream.sources}
          subtitles={stream.subtitles}
          slug={slug}
          episode={num}
          totalEpisodes={anime.episodes.length}
          poster={anime.banner}
          epTitle={current.title[locale]}
          dict={t}
          magnet={stream.magnet}
          hasNext={hasNext}
          hasPrev={hasPrev}
          fillerEpisodes={anime.episodes.filter((e) => e.isFiller).map((e) => e.number)}
          onNext={() => router.push(`/anime/${slug}/watch?ep=${num + 1}`)}
          onPrev={() => router.push(`/anime/${slug}/watch?ep=${num - 1}`)}
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

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-widest text-neutral-500">{t.player.server}</span>
          {stream.sources.map((s) => (
            <span key={s.id}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${
                s.default ? "bg-brand text-neutral-950 shadow-lg shadow-brand/20" : "bg-white/5 text-neutral-300"
              }`}>
              {s.name}
              <span dir="ltr" className="text-[10px]">{s.quality}</span>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={report}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-semibold text-neutral-300 transition-all duration-300 hover:bg-white/10 hover:text-white">
            <Flag className="h-3 w-3" aria-hidden />
            {reported ? t.admin.confirmed : t.player.reportVideo}
          </button>
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white" title={t.player.switchServer}>
            <Warehouse className="h-4 w-4" aria-hidden />
          </span>
        </div>
      </div>
      <CommentsSection target={`watch:${anime.slug}:${num}`} dict={t} title={t.player.commentsHere} />
    </>
  );
}
