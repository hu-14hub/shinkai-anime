import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { getDictionary } from "@/i18n/get-dictionary";
import { getLocale } from "@/i18n/server";
import { animeList, getAnimeBySlug } from "@/data/anime";
import { anilistIdFromSlug, getAnimeDetail } from "@/services/anilistService";
import { getEpisodeStream } from "@/services/stream";
import { WatchClient } from "@/components/watch-client";

export function generateStaticParams() {
  return animeList.map((a) => ({ slug: a.slug }));
}

export default async function WatchPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ ep?: string }>;
}) {
  const { slug } = await params;
  const { ep } = await searchParams;
  const locale = await getLocale();
  const t = getDictionary(locale);
  let anime = getAnimeBySlug(slug);
  const alId = anilistIdFromSlug(slug);
  if (!anime && alId) {
    try { anime = await getAnimeDetail(alId); } catch { /* fallback */ }
  }
  if (!anime) notFound();
  const num = Math.min(Math.max(parseInt(ep ?? "1", 10) || 1, 1), anime.episodes.length);
  const BackIcon = locale === "ar" ? ArrowRight : ArrowLeft;
  const stream = await getEpisodeStream(slug, num, anime.title[locale]);
  const current = anime.episodes[num - 1];
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-10 px-4 py-8 sm:px-6 sm:py-10">
      <div>
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-neutral-400">
          <Link href="/" className="rounded-full transition-colors duration-300 hover:text-white">{t.nav.home}</Link>
          <span aria-hidden className="text-neutral-600">/</span>
          <Link href={`/anime/${anime.slug}`} className="inline-flex items-center gap-1.5 rounded-full transition-colors duration-300 hover:text-white">
            <BackIcon className="h-3.5 w-3.5" />{t.watch.backToDetails}
          </Link>
          <span aria-hidden className="text-neutral-600">/</span>
          <span aria-current="page" className="text-neutral-200">{t.watch.episode} <span dir="ltr">{num}</span></span>
        </nav>
        <h1 className="mt-3 text-2xl font-black leading-tight tracking-tight text-white sm:text-3xl">
          {anime.title[locale]} <span dir="ltr" className="text-brand-300">· EP {num}</span>
        </h1>
        <p className="mt-2 text-sm leading-6 text-neutral-400 sm:text-base sm:leading-7">
          {current.title[locale]} · <span dir="ltr">{current.duration}</span>
        </p>
      </div>
      <WatchClient slug={slug} num={num} anime={anime} stream={stream} locale={locale} dict={t} />
    </main>
  );
}
