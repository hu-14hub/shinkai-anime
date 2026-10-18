"use client";

import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";

interface Chapter {
  at: number; // 0..1 position
  label?: string;
}

interface ProgressBarProps {
  current: number;
  duration: number;
  buffered: number;
  chapters?: Chapter[];
  onSeek: (time: number) => void;
}

/**
 * Sleek, minimalist scrubber. A thin track that swells on hover/drag, a faint
 * "buffered" fill, a glowing cyan progress + handle, optional chapter markers,
 * and a floating time tooltip. Fully draggable and keyboard-accessible.
 */
export function ProgressBar({ current, duration, buffered, chapters = [], onSeek }: ProgressBarProps) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [drag, setDrag] = useState(false);
  const active = hover || drag;

  const pct = (v: number) => (duration > 0 ? Math.min(100, Math.max(0, (v / duration) * 100)) : 0);

  const timeAt = (clientX: number) => {
    const el = track.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * (duration || 0);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag(true);
    onSeek(timeAt(e.clientX));
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    onSeek(timeAt(e.clientX));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDrag(false);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = duration / 40 || 5;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      onSeek(Math.min(duration, current + step));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      onSeek(Math.max(0, current - step));
    } else if (e.key === "Home") {
      e.preventDefault();
      onSeek(0);
    } else if (e.key === "End") {
      e.preventDefault();
      onSeek(duration || 0);
    }
  };

  const fillPct = pct(current);
  const bufferPct = pct(buffered);
  const bubblePct = Math.min(94, Math.max(6, fillPct));

  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(current)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onKeyDown={onKeyDown}
      className="group relative w-full cursor-pointer select-none py-2.5 outline-none"
    >
      {/* Swelling track (generous hit area + visual line live inside it) */}
      <div
        className={cn(
          "relative w-full overflow-visible rounded-full transition-all duration-200 md:overflow-hidden",
          active ? "h-[5px] md:h-2" : "h-[3px]"
        )}
      >
        <div className="absolute inset-0 rounded-full bg-white/10" />
        {/* buffered */}
        <div className="absolute inset-y-0 left-0 rounded-full bg-white/20" style={{ width: `${bufferPct}%` }} />
        {/* progress */}
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${fillPct}%`,
            background: "linear-gradient(90deg, var(--color-brand-600), var(--color-brand))",
          }}
        />
        {/* chapter / skip markers */}
        {chapters.map((c, i) => (
          <span
            key={i}
            aria-hidden
            className="absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 rounded-full bg-white/45"
            style={{ left: `${c.at * 100}%` }}
          />
        ))}
      </div>

      {/* glowing rounded handle */}
      <div
        aria-hidden
        className={cn("pointer-events-none absolute top-1/2 z-10 h-3.5 w-3.5 rounded-full bg-white", active ? "opacity-100" : "opacity-90")}
        style={{
          left: `${fillPct}%`,
          transform: `translate(-50%, -50%) scale(${active ? 1 : 0.72})`,
          boxShadow: active
            ? "0 0 0 4px var(--accent-soft), 0 0 16px 1px rgba(6,182,212,0.75)"
            : "0 0 10px 1px rgba(6,182,212,0.6)",
          transition: "transform .18s ease, box-shadow .18s ease, left .05s linear",
        }}
      />

      {/* floating time tooltip */}
      {active && duration > 0 && (
        <div aria-hidden className="pointer-events-none absolute bottom-[22px] z-20 -translate-x-1/2" style={{ left: `${bubblePct}%` }}>
          <div
            dir="ltr"
            className="rounded-md bg-black/85 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white shadow-lg ring-1 ring-white/10 backdrop-blur-md"
          >
            {Math.floor(current / 3600) > 0
              ? `${Math.floor(current / 3600)}:${String(Math.floor((current % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(current % 60)).padStart(2, "0")}`
              : `${Math.floor(current / 60)}:${String(Math.floor(current % 60)).padStart(2, "0")}`}
          </div>
        </div>
      )}
    </div>
  );
}