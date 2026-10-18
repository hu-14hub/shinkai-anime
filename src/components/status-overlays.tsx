"use client";

import { cn } from "@/lib/utils";
import { AlertIcon, ClockIcon, PlayIcon, RetryIcon } from "./player-icons";

/**
 * Transparent edge scrim used for legibility behind the title (top) and the
 * control bar (bottom). Fades with the rest of the UI when controls hide.
 */
export function Scrim({ side, hidden = false, className = "" }: { side: "top" | "bottom"; hidden?: boolean; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 z-20 transition-opacity duration-300",
        side === "top"
          ? "top-0 h-28 bg-gradient-to-b from-black/70 to-transparent"
          : "bottom-0 h-32 bg-gradient-to-t from-black/85 to-transparent",
        hidden && "opacity-0",
        className
      )}
    />
  );
}

export function LoadingOverlay({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
      <div className="relative">
        <div className="absolute -inset-4 -z-10 rounded-full bg-brand/20 blur-xl" />
        <svg
          width="54"
          height="54"
          viewBox="0 0 48 48"
          className="animate-spin"
          style={{ animationDuration: "1.1s" }}
          aria-hidden
        >
          <circle cx="24" cy="24" r="20" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="3.5" />
          <circle
            cx="24"
            cy="24"
            r="20"
            fill="none"
            stroke="var(--color-brand)"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray="92 35"
            style={{ filter: "drop-shadow(0 0 6px rgba(6,182,212,0.7))" }}
          />
        </svg>
      </div>
    </div>
  );
}

interface ErrorOverlayProps {
  show: boolean;
  title: string;
  message: string;
  retry: string;
  onRetry: () => void;
}

export function ErrorOverlay({ show, title, message, retry, onRetry }: ErrorOverlayProps) {
  if (!show) return null;
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-6 backdrop-blur-md">
      <div className="animate-player-pop flex max-w-sm flex-col items-center rounded-2xl border border-white/10 bg-white/[0.05] px-8 py-9 text-center shadow-2xl shadow-black/60 ring-1 ring-white/5">
        <div className="relative mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10 ring-1 ring-red-500/25">
          <div className="absolute -inset-2 -z-10 rounded-full bg-red-500/20 blur-lg" />
          <AlertIcon size={26} className="text-red-300" />
        </div>
        <h3 className="text-lg font-bold tracking-tight text-white">{title}</h3>
        <p className="mt-1.5 text-sm text-neutral-400">{message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 flex items-center gap-2 rounded-full bg-brand px-6 py-2.5 text-sm font-bold text-neutral-950 shadow-lg shadow-brand/30 transition-all duration-300 hover:scale-[1.03] hover:bg-brand-300 hover:drop-shadow-[0_0_14px_rgba(6,182,212,0.55)]"
        >
          <RetryIcon size={16} />
          {retry}
        </button>
      </div>
    </div>
  );
}

export function CenterPlayButton({ show, label, onClick }: { show: boolean; label: string; onClick: () => void }) {
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="group absolute inset-0 z-20 flex items-center justify-center bg-gradient-to-t from-black/20 to-transparent"
    >
      <span className="relative flex items-center justify-center">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand/25" style={{ animationDuration: "2.6s" }} />
        <span className="relative flex h-20 w-20 items-center justify-center rounded-full border border-white/15 bg-white/5 backdrop-blur-xl transition-all duration-300 group-hover:scale-110 group-hover:border-brand/40">
          <span className="absolute -inset-3 -z-10 rounded-full bg-brand/25 blur-2xl" />
          <PlayIcon size={30} className="ml-1 text-white drop-shadow-[0_0_10px_rgba(6,182,212,0.6)]" />
        </span>
      </span>
    </button>
  );
}

interface ResumeChipProps {
  show: boolean;
  label: string;
  time: string;
  restart: string;
  onJump: () => void;
}

export function ResumeChip({ show, label, time, restart, onJump }: ResumeChipProps) {
  if (!show) return null;
  return (
    <div className="absolute bottom-28 left-5 z-20 flex items-center gap-3 rounded-full border border-white/10 bg-black/50 py-2 pe-2 ps-4 shadow-xl shadow-black/40 backdrop-blur-xl">
      <ClockIcon size={16} className="text-brand" />
      <span className="text-sm text-white/90">
        {label} <span dir="ltr" className="font-semibold tabular-nums text-brand-300">{time}</span>
      </span>
      <button
        type="button"
        onClick={onJump}
        className="rounded-full bg-white/10 px-3 py-1 text-xs font-bold text-white transition-colors duration-300 hover:bg-brand hover:text-neutral-950"
      >
        {restart}
      </button>
    </div>
  );
}

interface SkipButtonsProps {
  inIntro: boolean;
  inOutro: boolean;
  skipIntro: string;
  skipOutro: string;
  onSkip: (p: "intro" | "outro") => void;
}

export function SkipButtons({ inIntro, inOutro, skipIntro, skipOutro, onSkip }: SkipButtonsProps) {
  if (!inIntro && !inOutro) return null;
  return (
    <div className="absolute inset-x-0 bottom-24 z-20 flex justify-center gap-2 px-4">
      {inIntro && (
        <button
          type="button"
          onClick={() => onSkip("intro")}
          className="rounded-full border border-white/10 bg-black/50 px-5 py-2 text-sm font-bold text-white shadow-xl backdrop-blur-xl transition-all duration-300 hover:border-brand/40 hover:bg-brand hover:text-neutral-950"
        >
          {skipIntro}
        </button>
      )}
      {inOutro && (
        <button
          type="button"
          onClick={() => onSkip("outro")}
          className="rounded-full border border-white/10 bg-black/50 px-5 py-2 text-sm font-bold text-white shadow-xl backdrop-blur-xl transition-all duration-300 hover:border-brand/40 hover:bg-brand hover:text-neutral-950"
        >
          {skipOutro}
        </button>
      )}
    </div>
  );
}

export function FillerBadge({ show, badge, note }: { show: boolean; badge: string; note: string }) {
  if (!show) return null;
  return (
    <div role="status" aria-label={badge} className="absolute left-4 top-4 z-20 flex items-center gap-2 rounded-full border border-amber-400/20 bg-black/50 px-3 py-1.5 backdrop-blur-xl">
      <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-300 ring-1 ring-amber-400/30">{badge}</span>
      <span className="hidden text-[11px] font-semibold text-amber-100/90 sm:inline">{note}</span>
    </div>
  );
}

/** Small "live" dot used in the now-playing bar to show the active server. */
export function LiveDot() {
  return <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_8px_rgba(6,182,212,0.9)]" />;
}