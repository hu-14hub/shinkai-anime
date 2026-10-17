"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Gauge,
  HardDrive,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  Radio,
  RotateCcw,
  SkipForward,
  Subtitles,
  Users,
  Volume2,
  VolumeX,
  Warehouse,
  X,
} from "lucide-react";
import type { Dictionary } from "@/i18n/get-dictionary";
import type { StreamingSource, SubtitleTrack } from "@/types";
import { getProgress, saveProgress } from "@/lib/library";
import { getSettings } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useWebTorrent } from "@/lib/webtorrent-client";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** Seconds of the head/tail treated as intro / outro skip windows. */
const INTRO_WINDOW = 90;
const OUTRO_WINDOW = 90;
const AUTOHIDE_MS = 2600;

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Human-readable bytes-per-second for the P2P stats badge. */
function fmtSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bps;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** Human-readable byte count for the P2P HUD (B / KB / MB / GB). */
function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export interface VideoPlayerProps {
  sources: StreamingSource[];
  subtitles: SubtitleTrack[];
  slug: string;
  episode: number;
  totalEpisodes: number;
  poster: string;
  epTitle: string;
  dict: Dictionary;
  hasNext: boolean;
  hasPrev: boolean;
  /** Set of episode numbers marked as filler (drives badge/notice in the player). */
  fillerEpisodes?: number[];
  /**
   * Optional BitTorrent magnet link (or `file://` / torrent-file URL). When
   * provided, playback prefers a WebTorrent P2P source and transparently
   * falls back to the HTTP sources above if the peer swarm is unavailable.
   */
  magnet?: string;
  /**
   * Id of the source currently selected in the external (watch-page) server
   * pill list. When it changes, the player switches to that source so the
   * two server selectors (in-player controls and watch-page pills) stay in
   * sync even if the user switches inside the pill list.
   */
  requestedSourceId?: string;
  /** Called when the in-player source control changes the active source. */
  onSourceChange?: (id: string) => void;
  /** Client-side navigation handlers (optional). */
  onNext?: () => void;
  onPrev?: () => void;
}

/**
 * Cinematic adaptive-HLS player: hls.js adaptive streaming with quality
 * levels, subtitle & speed selectors, keyboard shortcuts
 * (Space/F/M/←→/J/L/↑↓/T), skip intro/outro, autoplay-next countdown,
 * resume-from-position, theater mode, Picture-in-Picture, fullscreen and
 * mobile gestures (tap → controls, double-tap → seek, swipe → volume).
 */
export function VideoPlayer({
  sources,
  subtitles,
  slug,
  episode,
  poster,
  epTitle,
  dict,
  hasNext,
  hasPrev,
  fillerEpisodes = [],
  magnet,
  requestedSourceId,
  onSourceChange,
  onNext,
  onPrev,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [srcIndex, setSrcIndex] = useState(() =>
    Math.max(0, sources.findIndex((s) => s.default))
  );
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [levels, setLevels] = useState<{ i: number; label: string }[]>([]);
  const [level, setLevel] = useState(-1); // -1 = adaptive/auto
  const [panel, setPanel] = useState<null | "speed" | "quality" | "subs">(null);
  const [selectedSub, setSelectedSub] = useState<string>("off");
  const [theater, setTheater] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);

  const source = sources[srcIndex] ?? sources[0];
  const settings = useMemo(() => getSettings(), []);

  /* ---------------------------------------------------------------- */
  /* WebTorrent P2P engine                                             */
  /* ---------------------------------------------------------------- */
  const wt = useWebTorrent();
  // P2P is "active" only while the selected source actually carries a magnet
  // link and the P2P engine has not entered an error state. This keeps the
  // <video> element owned by exactly one engine at a time.
  const p2pSource = magnet;
  const p2pActive = !!p2pSource && wt.status !== "error";

  /**
   * Keep the internal `srcIndex` in sync with the external server pill list
   * (`requestedSourceId`). This is what makes the watch-page pills actually
   * switch the active stream — picking "P2P (WebTorrent)" changes this id,
   * which flips `p2pSource` on, which hands the <video> to WebTorrent.
   */
  useEffect(() => {
    if (!requestedSourceId) return;
    const idx = sources.findIndex((s) => s.id === requestedSourceId);
    if (idx >= 0 && idx !== srcIndex) setSrcIndex(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedSourceId]);

  /**
   * Prefer the P2P route whenever the active source carries a magnet. On
   * any P2P error (no peers, no video file, unsupported SW, etc.) the
   * `p2pActive` derivation collapses to `false` and the HLS engine below
   * takes over transparently.
   */
  useEffect(() => {
    if (!p2pSource) {
      // No magnet on the active source — make sure we have stopped P2P.
      wt.stop();
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    wt.load(p2pSource, video).catch(() => {
      /* hook already sets wt.status = "error"; HLS takes over */
    });
    return () => {
      wt.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p2pSource]);

  /**
   * Auto-fallback: if we're on a P2P source but P2P dropped into an error
   * (swarm dead / no video file / …), jump to the first non-P2P source so
   * playback continues seamlessly. Guarded so it never loops while the user
   * is intentionally on an HLS source.
   */
  useEffect(() => {
    if (!source?.magnet || wt.status !== "error") return;
    const fallback = sources.find((s) => !s.magnet);
    if (!fallback) return;
    const fallbackIdx = sources.findIndex((s) => s.id === fallback.id);
    if (fallbackIdx >= 0 && fallbackIdx !== srcIndex) setSrcIndex(fallbackIdx);
    // Notify the parent so the server pills re-highlight the HLS source and
    // stop pushing us back to the dead P2P source (prevents toggle loop).
    if (onSourceChange && fallback.id !== requestedSourceId) onSourceChange(fallback.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wt.status]);

  /**
   * Wire WebTorrent download progress into the player's `buffered` state.
   * While P2P is healthy we approximate how far ahead of the playhead we can
   * seek: `fileProgress` (0..1 of the selected file) mapped onto the media
   * `duration`. In the progressive `file.streamTo` path the Media Source is
   * range-addressable so the `<video>`'s own buffered ranges are unreliable
   * here — the torrent byte progress is the source of truth.
   */
  useEffect(() => {
    if (p2pActive) {
      setBuffered(duration > 0 ? wt.fileProgress * duration : 0);
    } else {
      // Back to HTTP playback — reset to 0; the buffered ranges below manage
      // themselves from the <video> element.
      const video = videoRef.current;
      let end = 0;
      if (video?.buffered?.length) {
        for (let i = 0; i < video.buffered.length; i += 1) {
          if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) {
            end = video.buffered.end(i);
          }
        }
      }
      setBuffered(end);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wt.fileProgress, duration, p2pActive]);

  /* Track native buffered extent as a fallback / for the HTTP path. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      if (p2pActive) return; // P2P manages `buffered` itself
      let end = 0;
      if (video.buffered?.length) {
        for (let i = 0; i < video.buffered.length; i += 1) {
          if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) {
            end = video.buffered.end(i);
          }
        }
      }
      setBuffered(end);
    };
    video.addEventListener("timeupdate", onTime);
    return () => video.removeEventListener("timeupdate", onTime);
  }, [p2pActive]);

  /* ---------------------------------------------------------------- */
  /* HLS engine                                                        */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const video = videoRef.current;
    // P2P owns the <video> while it is healthy (magnet present and not in an
    // error state). When P2P errors, `p2pActive` flips to false and this
    // effect re-runs, handing the element back to the HLS engine.
    if (p2pActive) return;
    if (!video || !source) return;
    setError(false);
    setLoading(true);
    setLevels([]);
    let hls: Hls | null = null;
    const isHls = /\.m3u8(\?|$)/i.test(source.url);

    const onMeta = () => {
      setLoading(false);
      setDuration(video.duration || 0);
      if (settings.rememberProgress && video.currentTime <= 0.5) {
        const saved = getProgress(slug, episode);
        if (saved && saved.time > 10 && saved.duration > 0 && saved.time / saved.duration < 0.95) {
          setResumeAt(saved.time);
        }
      }
    };
    video.addEventListener("loadedmetadata", onMeta);

    if (isHls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true });
      hls.loadSource(source.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        setLoading(false);
        setLevels(
          data.levels.map((l, i) => ({
            i,
            label: l.height ? `${l.height}p` : `${Math.round((l.bitrate ?? 0) / 1000)}k`,
          }))
        );
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          setError(true);
          setLoading(false);
        }
      });
    } else {
      // Native HLS (Safari) or progressive fallback.
      video.src = source.url;
      video.load();
    }

    return () => {
      video.removeEventListener("loadedmetadata", onMeta);
      hls?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, settings, p2pActive, slug, episode]);

  /* ---------------------------------------------------------------- */
  /* Media element events                                               */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const timeUpdate = () => setCurrent(video.currentTime);
    const play = () => setPlaying(true);
    const pause = () => setPlaying(false);
    const wait = () => setLoading(true);
    const canPlay = () => setLoading(false);
    const dur = () => setDuration(video.duration || 0);
    const ended = () => {
      setPlaying(false);
      if (hasNext && settings.autoplayNext) setNextCountdown(5);
    };
    video.addEventListener("timeupdate", timeUpdate);
    video.addEventListener("play", play);
    video.addEventListener("pause", pause);
    video.addEventListener("waiting", wait);
    video.addEventListener("canplay", canPlay);
    video.addEventListener("durationchange", dur);
    video.addEventListener("ended", ended);
    return () => {
      video.removeEventListener("timeupdate", timeUpdate);
      video.removeEventListener("play", play);
      video.removeEventListener("pause", pause);
      video.removeEventListener("waiting", wait);
      video.removeEventListener("canplay", canPlay);
      video.removeEventListener("durationchange", dur);
      video.removeEventListener("ended", ended);
    };
  }, [hasNext, settings.autoplayNext]);

  /* ---------------------------------------------------------------- */
  /* Resume from saved position                                         */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    if (resumeAt == null || resumeAt <= 0) return;
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = resumeAt;
    setResumeAt(null);
  }, [resumeAt]);

  /* ---------------------------------------------------------------- */
  /* Autoplay next countdown                                              */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    if (!nextCountdown || nextCountdown <= 0) return;
    const id = setInterval(() => {
      setNextCountdown((n) => (n! <= 1 ? null : n! - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [nextCountdown]);

  /* ---------------------------------------------------------------- */
  /* Persist playback position every 5s                                  */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !settings.rememberProgress) return;
    const id = setInterval(() => {
      if (video.paused || !video.duration) return;
      saveProgress({
        slug,
        ep: episode,
        time: video.currentTime,
        duration: video.duration,
        updatedAt: Date.now(),
      });
    }, 5000);
    return () => clearInterval(id);
  }, [slug, episode, settings.rememberProgress]);

  /* ---------------------------------------------------------------- */
  /* Keyboard shortcuts                                                  */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const video = videoRef.current;
      if (!video) return;

      const ctrlJump = (delta: number) => {
        video.currentTime = Math.min(Math.max(0, video.currentTime + delta), video.duration || 0);
      };

      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          video.paused ? video.play() : video.pause();
          break;
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "m":
        case "M":
          e.preventDefault();
          setMuted((prev) => {
            video.muted = !prev;
            return !prev;
          });
          break;
        case "ArrowLeft":
          e.preventDefault();
          ctrlJump(-10);
          break;
        case "ArrowRight":
          e.preventDefault();
          ctrlJump(10);
          break;
        case "j":
        case "J":
          e.preventDefault();
          ctrlJump(-5);
          break;
        case "l":
        case "L":
          e.preventDefault();
          ctrlJump(5);
          break;
        case "ArrowUp":
          e.preventDefault();
          video.volume = Math.min(1, video.volume + 0.1);
          setVolume(video.volume);
          setMuted(false);
          break;
        case "ArrowDown":
          e.preventDefault();
          video.volume = Math.max(0, video.volume - 0.1);
          setVolume(video.volume);
          break;
        case "t":
        case "T":
          e.preventDefault();
          setTheater((prev) => !prev);
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Mobile gestures (tap controls, double-tap seek, swipe volume)       */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let lastTap = 0;
    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      if (Date.now() - lastTap < 300) {
        e.preventDefault();
        const video = videoRef.current;
        if (!video) return;
        const x = e.touches[0].clientX;
        const mid = wrap.clientWidth / 2;
        const delta = x < mid ? -5 : 5;
        video.currentTime = Math.min(Math.max(0, video.currentTime + delta), video.duration || 0);
      } else {
        lastTap = Date.now();
      }
    };

    const onTouchEnd = () => setShowControls((prev) => !prev);

    const onTouchMove = (e: TouchEvent) => {
      const video = videoRef.current;
      if (!video || !startY) return;
      const delta = (startY - e.touches[0].clientY) / 100;
      if (Math.abs(delta) > 0.05) {
        const vol = Math.min(1, Math.max(0, video.volume + delta));
        video.volume = vol;
        setVolume(vol);
        setMuted(vol === 0);
        startY = e.touches[0].clientY;
      }
    };

    wrap.addEventListener("touchstart", onTouchStart, { passive: false });
    wrap.addEventListener("touchend", onTouchEnd, { passive: true });
    wrap.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      wrap.removeEventListener("touchstart", onTouchStart);
      wrap.removeEventListener("touchend", onTouchEnd);
      wrap.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  /* ---------------------------------------------------------------- */
  /* Fullscreen & theater helpers                                        */
  /* ---------------------------------------------------------------- */
  const toggleFullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(() => setFullscreen(false));
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Control handlers                                                     */
  /* ---------------------------------------------------------------- */
  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    video.paused ? video.play() : video.pause();
  };

  const seek = (delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(Math.max(0, video.currentTime + delta), video.duration || 0);
  };

  const skipTo = (position: "intro" | "outro") => {
    const video = videoRef.current;
    if (!video || !duration) return;
    video.currentTime =
      position === "intro"
        ? Math.min(INTRO_WINDOW, duration)
        : Math.max(0, duration - OUTRO_WINDOW);
  };

  const changeSource = (index: number) => {
    setSrcIndex(index);
    setPanel(null);
    setError(false);
    setLoading(true);
  };

  const togglePanel = (name: "speed" | "quality" | "subs") => {
    setPanel((prev) => (prev === name ? null : name));
  };

  const toggleTheater = () => setTheater((prev) => !prev);

  const pip = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      await video.requestPictureInPicture().catch(() => {});
    }
  };

  /* ---------------------------------------------------------------- */
  /* Computed values                                                      */
  /* ---------------------------------------------------------------- */
  const progressPct = duration > 0 ? (current / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0;
  const remaining = duration > 0 ? duration - current : 0;
  const inIntro = current <= INTRO_WINDOW && duration > INTRO_WINDOW;
  const inOutro =
    remaining <= OUTRO_WINDOW && remaining > 0 && duration > OUTRO_WINDOW;
  const defaultSub = subtitles.find((t) => t.default);
  const activeSub = selectedSub === "off" ? null : subtitles.find((t) => t.id === selectedSub);

  /* Apply speed / subtitles to video element */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speed;
    const track = video.textTracks?.[0];
    if (track) {
      track.mode =
        selectedSub === "off" ? "disabled" : activeSub?.id === track.id ? "showing" : "hidden";
    }
  }, [speed, selectedSub, activeSub]);

  /* Apply volume / muted to video element */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = muted ? 0 : volume;
    video.muted = muted;
  }, [muted, volume]);

  /* ---------------------------------------------------------------- */
  /* Render                                                              */
  /* ---------------------------------------------------------------- */
  return (
    <div
      ref={wrapRef}
      className={cn(
        "relative bg-black rounded-2xl overflow-hidden shadow-2xl shadow-black/80 transition-all duration-500",
        theater && "fixed inset-0 z-50 w-screen h-screen",
        fullscreen && "fixed inset-0 z-50 w-screen h-screen"
      )}
    >
      {/* Video element */}
      <div className="relative aspect-video w-full bg-black">
        <video
          ref={videoRef}
          className="w-full h-full block object-contain"
          poster={poster}
          preload="metadata"
          muted={muted || volume === 0}
        >
          {source && (
            <track kind="captions" src={activeSub?.url ?? ""} label={activeSub?.label ?? ""} />
          )}
        </video>

        {/* P2P status badge — top-center, self-contained pill */}
        {p2pActive && (
          <div
            className="absolute top-3 left-1/2 z-30 w-[min(92%,660px)] -translate-x-1/2 rounded-2xl border border-white/10 bg-black/60 px-3 py-2.5 shadow-2xl shadow-black/50 backdrop-blur-xl sm:px-4"
            role="status"
            aria-live="polite"
          >
            {/* Header: P2P/WebTorrent badge + live state pill */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {wt.status === "ready" ? (
                  <Radio className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                ) : (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand" aria-hidden />
                )}
                <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-white">
                  P2P
                  <span className="text-neutral-500">/</span>
                  <span className="text-brand-300">WebTorrent</span>
                </span>
                <span className="ml-1 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-neutral-300">
                  {wt.status === "ready"
                    ? wt.strategy === "stream"
                      ? "Streaming"
                      : "Live"
                    : wt.status === "connecting"
                      ? "Connecting"
                      : "Downloading"}
                </span>
              </div>
              <span dir="ltr" className="hidden truncate text-[11px] font-medium tabular-nums text-neutral-500 sm:inline">
                {wt.status === "connecting"
                  ? wt.peers > 0
                    ? `${wt.peers} peer${wt.peers === 1 ? "" : "s"} found`
                    : "Searching swarm…"
                  : wt.fileName}
              </span>
            </div>

            {/* Live metrics: peers · speed · downloaded/total */}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:gap-x-4">
              <div className="flex items-center gap-1.5" title="Active peers">
                <Users className="h-3.5 w-3.5 text-neutral-400" aria-hidden />
                <span dir="ltr" className="text-[11px] font-semibold tabular-nums text-white">
                  {wt.peers}
                </span>
                <span className="text-[10px] text-neutral-500">peers</span>
              </div>
              <div className="flex items-center gap-1.5" title="Download speed">
                <Download className="h-3.5 w-3.5 text-neutral-400" aria-hidden />
                <span dir="ltr" className="text-[11px] font-semibold tabular-nums text-white">
                  {fmtSpeed(wt.downloadSpeed)}
                  <span className="text-neutral-500">/s</span>
                </span>
              </div>
              <div className="flex items-center gap-1.5" title="Downloaded / Total size">
                <HardDrive className="h-3.5 w-3.5 text-neutral-400" aria-hidden />
                <span dir="ltr" className="text-[11px] font-semibold tabular-nums text-white">
                  {fmtBytes(wt.fileDownloaded)}
                  <span className="text-neutral-500"> / </span>
                  {wt.fileLength > 0 ? fmtBytes(wt.fileLength) : "—"}
                </span>
              </div>
              <div className="ml-auto text-[11px] font-bold tabular-nums text-brand-300">
                <span dir="ltr">{Math.round(wt.fileProgress * 100)}%</span>
              </div>
            </div>

            {/* Live buffer/progress bar (driven by WebTorrent file progress) */}
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-gradient-to-r from-brand to-emerald-400 transition-[width] duration-500 ease-out"
                style={{ width: `${Math.min(100, Math.max(0, bufferedPct))}%` }}
              />
            </div>
          </div>
        )}

        {/* Loading overlay */}
        {(loading || (p2pActive && wt.status !== "ready")) && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10 pointer-events-none">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-brand" />
              {p2pActive && (
                <span className="text-xs font-medium text-neutral-300" dir="rtl">
                  {wt.status === "connecting"
                    ? "جارٍ الاتصال بالشبكة…"
                    : `جارٍ التحميل عبر P2P — ${Math.round(wt.fileProgress * 100)}%`}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Error overlay */}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-20 text-center p-6">
            <AlertTriangle className="h-10 w-10 text-red-400 mb-3" />
            <h3 className="text-white font-semibold">{dict.common.error}</h3>
            <p className="text-neutral-400 text-sm mt-2">{dict.player.error}</p>
            <button
              type="button"
              onClick={() => {
                setError(false);
                setLoading(true);
              }}
              className="mt-5 rounded-full bg-white/10 px-6 py-2 text-sm font-semibold text-white transition-all duration-300 hover:bg-white/20"
            >
              {dict.common.retry}
            </button>
          </div>
        )}

        {/* Center play / pause overlay */}
        {!playing && !loading && !error && (
          <div
            className="absolute inset-0 flex items-center justify-center z-20 opacity-70 hover:opacity-100 transition-opacity"
            onClick={togglePlay}
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10 backdrop-blur-md">
              <Play className="h-7 w-7 text-white ml-0.5 rtl-flip" />
            </div>
          </div>
        )}

        {/* Resume prompt */}
        {resumeAt && resumeAt > 0 && (
          <div className="absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 backdrop-blur-sm">
            <Clock className="h-4 w-4 text-brand" aria-hidden />
            <span className="text-sm text-white">
              {dict.player.resumeFrom} {fmt(resumeAt)}
            </span>
            <button
              type="button"
              onClick={() => {
                const video = videoRef.current;
                if (video) video.currentTime = resumeAt;
                setResumeAt(null);
              }}
              className="px-2 py-1 text-xs font-bold text-brand hover:underline"
            >
              {dict.player.restart}
            </button>
          </div>
        )}

        {/* Filler indicator for the currently playing episode */}
        {fillerEpisodes.includes(episode) && (
          <div
            className="absolute top-4 left-4 z-20 flex items-center gap-2 rounded-full border border-amber-500/20 bg-black/60 px-3 py-1.5 backdrop-blur-sm"
            role="status"
            aria-label={dict.detail.fillerBadge}
          >
            <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-400 ring-1 ring-amber-500/30">
              {dict.detail.fillerBadge}
            </span>
            <span className="hidden text-[11px] font-semibold text-amber-100/90 sm:inline">
              {dict.watch.fillerNote}
            </span>
          </div>
        )}

        {/* Autoplay next countdown */}
        {nextCountdown && (
          <div className="absolute top-4 right-4 z-20 rounded-full bg-black/70 px-4 py-2 backdrop-blur-sm flex items-center gap-2">
            <SkipForward className="h-4 w-4 text-brand" aria-hidden />
            <span className="text-sm text-white">
              {dict.player.autoplayNext} <span dir="ltr">{nextCountdown}s</span>
            </span>
            {fillerEpisodes.includes(episode + 1) && (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-400 ring-1 ring-amber-500/30">
                {dict.detail.fillerBadge}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setNextCountdown(null);
                onNext?.();
              }}
              className="px-2 py-1 text-xs font-bold text-brand hover:underline"
            >
              {dict.watch.nextEpisode}
            </button>
          </div>
        )}

        {/* Skip intro / outro */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex gap-2">
          {inIntro && (
            <button
              type="button"
              onClick={() => skipTo("intro")}
              className="rounded-full bg-black/60 px-5 py-2 text-xs font-bold text-white backdrop-blur hover:bg-black/80 transition"
            >
              {dict.player.skipIntro}
            </button>
          )}
          {inOutro && (
            <button
              type="button"
              onClick={() => skipTo("outro")}
              className="rounded-full bg-black/60 px-5 py-2 text-xs font-bold text-white backdrop-blur hover:bg-black/80 transition"
            >
              {dict.player.skipOutro}
            </button>
          )}
        </div>
      </div>

      {/* Controls bar */}
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 z-30 flex flex-col gap-1.5 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-4 py-3 transition-opacity duration-300",
          showControls ? "opacity-100" : "opacity-0"
        )}
      >
        {/* Top row: play/pause, time, progress */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={togglePlay}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 backdrop-blur-md text-white hover:bg-white/20 transition"
            aria-label={playing ? dict.player.pause : dict.player.play}
          >
            {playing ? (
              <Pause className="h-5 w-5" />
            ) : (
              <Play className="h-5 w-5 ml-0.5 rtl-flip" />
            )}
          </button>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between text-[11px] text-neutral-400 mb-1">
              <span dir="ltr">{fmt(current)}</span>
              <span dir="ltr">{fmt(duration)}</span>
            </div>
            <div
              className="relative h-1.5 w-full cursor-pointer rounded-full bg-white/10 overflow-hidden"
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = (e.clientX - rect.left) / rect.width;
                const video = videoRef.current;
                if (video && video.duration) video.currentTime = pct * video.duration;
              }}
            >
              <div className="h-full bg-brand" style={{ width: `${progressPct}%` }} />
              <div className="absolute left-0 top-0 h-full bg-white/20" style={{ width: `${bufferedPct}%` }} />
              <div
                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-brand ring-2 ring-black/60"
                style={{ left: `${progressPct}%` }}
              />
            </div>
          </div>
        </div>

        {/* Bottom row: volume, speed, quality, subs, theater, PiP, fullscreen */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMuted((prev) => !prev)}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
              aria-label={muted ? dict.player.unmute : dict.player.mute}
            >
              {muted || volume === 0 ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={volume}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setVolume(v);
                setMuted(v === 0);
                const video = videoRef.current;
                if (video) {
                  video.volume = v;
                  video.muted = v === 0;
                }
              }}
              className="h-1.5 w-20 bg-white/30 rounded-lg appearance-none cursor-pointer accent-brand"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => togglePanel("speed")}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition",
                panel === "speed" && "bg-brand text-neutral-950"
              )}
              aria-label={dict.player.speed}
              aria-expanded={panel === "speed"}
            >
              <Gauge className="h-4 w-4" aria-hidden />
              <span className="sr-only">{dict.player.speed}</span>
            </button>

            {!p2pActive && (
              <button
                type="button"
                onClick={() => togglePanel("quality")}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition",
                  panel === "quality" && "bg-brand text-neutral-950"
                )}
                aria-label={dict.player.quality}
                aria-expanded={panel === "quality"}
              >
                <Warehouse className="h-4 w-4" aria-hidden />
                <span className="sr-only">{dict.player.quality}</span>
              </button>
            )}

            {!p2pActive && (
              <button
                type="button"
                onClick={() => togglePanel("subs")}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition",
                  panel === "subs" && "bg-brand text-neutral-950"
                )}
                aria-label={dict.player.subtitles}
                aria-expanded={panel === "subs"}
              >
                <Subtitles className="h-4 w-4" aria-hidden />
                <span className="sr-only">{dict.player.subtitles}</span>
              </button>
            )}

            <button
              type="button"
              onClick={toggleTheater}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
              aria-label={theater ? dict.player.exitFullscreen : dict.player.theaterMode}
              aria-pressed={theater}
            >
              {theater ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </button>

            <button
              type="button"
              onClick={pip}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
              aria-label={dict.player.pip}
              disabled={!document.pictureInPictureEnabled}
            >
              <PictureInPicture2 className="h-4 w-4" aria-hidden />
            </button>

            <button
              type="button"
              onClick={toggleFullscreen}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
              aria-label={fullscreen ? dict.player.exitFullscreen : dict.player.fullscreen}
              aria-pressed={fullscreen}
            >
              {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </button>

            <button
              type="button"
              onClick={() => setShowControls((prev) => !prev)}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
              aria-label={showControls ? "Hide controls" : "Show controls"}
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      </div>

      {/* Speed selector panel */}
      {panel === "speed" && (
        <div className="absolute top-12 right-4 z-40 rounded-xl bg-white/[0.95] text-neutral-950 shadow-xl shadow-black/60 p-2">
          <div className="flex flex-col gap-1">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setSpeed(s);
                  setPanel(null);
                }}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium transition",
                  speed === s
                    ? "bg-brand text-neutral-950"
                    : "text-neutral-600 hover:bg-neutral-200"
                )}
              >
                <span dir="ltr">{s}x</span>
                {speed === s && (
                  <ChevronRight className="h-3 w-3 fill-neutral-950" aria-hidden />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quality selector panel */}
      {panel === "quality" && levels.length > 0 && (
        <div className="absolute top-12 right-4 z-40 rounded-xl bg-white/[0.95] text-neutral-950 shadow-xl shadow-black/60 p-2">
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => {
                setLevel(-1);
                setPanel(null);
              }}
              className={cn(
                "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium transition",
                level === -1 ? "bg-brand text-neutral-950" : "text-neutral-600 hover:bg-neutral-200"
              )}
            >
              <span>Auto</span>
              {level === -1 && <ChevronRight className="h-3 w-3 fill-neutral-950" aria-hidden />}
            </button>
            {levels.map((l) => (
              <button
                key={l.i}
                type="button"
                onClick={() => {
                  setLevel(l.i);
                  setPanel(null);
                }}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium transition",
                  level === l.i ? "bg-brand text-neutral-950" : "text-neutral-600 hover:bg-neutral-200"
                )}
              >
                <span dir="ltr">{l.label}</span>
                {level === l.i && <ChevronRight className="h-3 w-3 fill-neutral-950" aria-hidden />}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Subtitle selector panel */}
      {panel === "subs" && (
        <div className="absolute top-12 right-4 z-40 rounded-xl bg-white/[0.95] text-neutral-950 shadow-xl shadow-black/60 p-2">
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => {
                setSelectedSub("off");
                setPanel(null);
              }}
              className={cn(
                "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium transition",
                selectedSub === "off" ? "bg-brand text-neutral-950" : "text-neutral-600 hover:bg-neutral-200"
              )}
            >
              <span>{dict.player.subtitlesOff}</span>
              {selectedSub === "off" && <ChevronRight className="h-3 w-3 fill-neutral-950" aria-hidden />}
            </button>
            {subtitles.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setSelectedSub(t.id);
                  setPanel(null);
                }}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium transition",
                  selectedSub === t.id ? "bg-brand text-neutral-950" : "text-neutral-600 hover:bg-neutral-200"
                )}
              >
                <span>{t.label}</span>
                {selectedSub === t.id && <ChevronRight className="h-3 w-3 fill-neutral-950" aria-hidden />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
