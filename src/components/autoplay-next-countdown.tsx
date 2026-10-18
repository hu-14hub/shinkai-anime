"use client";

import { XIcon } from "./player-icons";
import { NextIcon } from "./player-icons";

interface AutoplayNextCounterProps {
  show: boolean;
  seconds: number | null;
  maxSeconds: number;
  countdownLabel: string;
  nextLabel: string;
  cancelLabel: string;
  fillerWarning?: boolean;
  fillerBadge?: string;
  onNow: () => void;
  onCancel: () => void;
}

/**
 * Modern "Autoplay Next" overlay — a translucent, blurred card in the lower
 * third with a live counting-down number wrapped in an animated ring, a primary
 * "play now" action and a dismiss button. Replaces the old skinny pill.
 */
export function AutoplayNextCounter({
  show,
  seconds,
  maxSeconds,
  countdownLabel,
  nextLabel,
  cancelLabel,
  fillerWarning = false,
  fillerBadge = "",
  onNow,
  onCancel,
}: AutoplayNextCounterProps) {
  if (!show) return null;
  const R = 18;
  const C = 2 * Math.PI * R;
  const frac = maxSeconds > 0 && seconds != null ? Math.max(0, Math.min(1, seconds / maxSeconds)) : 1;

  return (
    <div className="absolute inset-x-0 bottom-24 z-30 flex justify-center px-4">
      <div className="pointer-events-auto animate-player-pop flex w-full max-w-md items-center gap-4 rounded-2xl border border-white/10 bg-neutral-950/70 px-5 py-4 shadow-2xl shadow-black/60 ring-1 ring-white/5 backdrop-blur-2xl">
        <div className="relative flex h-12 w-12 shrink-0 items-center justify-center" aria-hidden>
          <svg viewBox="0 0 44 44" className="absolute inset-0 h-12 w-12" style={{ transform: "rotate(-90deg)" }}>
            <circle cx="22" cy="22" r={R} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="3" />
            <circle
              cx="22"
              cy="22"
              r={R}
              fill="none"
              stroke="var(--color-brand)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={`${frac * C} ${C}`}
              style={{ filter: "drop-shadow(0 0 5px rgba(6,182,212,0.7))", transition: "stroke-dasharray 0.9s linear" }}
            />
          </svg>
          <NextIcon size={18} className="relative text-white" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-white">{countdownLabel}</div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-neutral-400">
            {seconds != null && (
              <span dir="ltr" className="tabular-nums text-brand-300">
                {seconds}s
              </span>
            )}
            {fillerWarning && (
              <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-300 ring-1 ring-amber-400/30">
                {fillerBadge}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-1.5 self-stretch">
          <button
            type="button"
            onClick={onNow}
            className="flex items-center justify-center gap-1.5 rounded-full bg-brand px-4 py-1.5 text-xs font-bold text-neutral-950 shadow-lg shadow-brand/30 transition-all duration-300 hover:scale-[1.03] hover:bg-brand-300"
          >
            <NextIcon size={13} />
            {nextLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            aria-label={cancelLabel}
            className="flex items-center justify-center gap-1 rounded-full px-4 py-1 text-xs font-medium text-neutral-400 transition-colors duration-300 hover:bg-white/10 hover:text-white"
          >
            <XIcon size={12} />
            <span className="hidden sm:inline">{cancelLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}