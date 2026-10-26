"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import type { LoadPolicy } from "hls.js";
import type { Dictionary } from "@/i18n/get-dictionary";
import type { StreamingSource, SubtitleTrack } from "@/types";
import { getProgress, saveProgress } from "@/lib/library";
import { getSettings } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  CheckIcon,
  AlertIcon,
  ClockIcon,
  XIcon,
  ExitFullscreenIcon,
  ExitTheaterIcon,
  FullscreenIcon,
  PauseIcon,
  PipIcon,
  PlayIcon,
  QualityIcon,
  SpeedIcon,
  SubtitlesIcon,
  TheaterIcon,
  VolumeHighIcon,
  VolumeMuteIcon,
} from "./player-icons";
import { ProgressBar } from "./progress-bar";
import {
  AutoplayNextCounter,
} from "./autoplay-next-countdown";
import {
  CenterPlayButton,
  ErrorOverlay,
  FillerBadge,
  LiveDot,
  LoadingOverlay,
  NoSourcesOverlay,
  ResumeChip,
  Scrim,
  SkipButtons,
} from "./status-overlays";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const AUTOHIDE_MS = 2600;

/* Seconds of the head/tail treated as intro / outro skip windows. */
const INTRO_WINDOW = 90;
const OUTRO_WINDOW = 90;

/**
 * Hls.js per-request retry policy. Network errors (transient timeout /
 * dropped segment) are retried a few times with backoff before surfacing the
 * error state, so a single flaky segment doesn't immediately break playback.
 * `LoadPolicy` is shaped as `{ default: RetryConfig }` in hls.js v1.7+.
 */
const HLS_LOAD_POLICY: LoadPolicy = {
  default: {
    maxTimeToFirstByteMs: 20000,
    maxLoadTimeMs: 120000,
    timeoutRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000, backoff: "exponential" },
    errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000, backoff: "exponential" },
  },
};

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
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
   * Id of the source currently selected in the external (watch-page) server
   * pill list. When it changes, the player switches to that source so the
   * two server selectors (in-player controls and watch-page pills) stay in
   * sync even if the user switches inside the pill list.
   */
  requestedSourceId?: string;
  /** Client-side navigation handlers (optional). */
  onNext?: () => void;
  onPrev?: () => void;
  /**
   * Re-trigger the watch page's live source fetch (re-calls /api/stream).
   * Wired to the "Retry" / "No sources" overlay so the user can pull fresh
   * sources after a failure or when none were resolved initially.
   */
  onRetryStream?: () => void;
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
  totalEpisodes,
  fillerEpisodes = [],
  requestedSourceId,
  onNext,
  onPrev,
  onRetryStream,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivity = useRef(0);

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
  // Picture-in-Picture availability is a *browser* property. Reading
  // `document.pictureInPictureEnabled` during SSR throws (no `document`), which
  // crashed the watch page's server render — so probe it on the client only.
  const [pipSupported, setPipSupported] = useState(false);
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
  // Bump to force the load effect to run again (Retry button / recover).
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Iframe (AniPub embed) mode: shows a spinner until the embed loads and a
  // "Open in a new tab" fallback if it ever fails to load inside the frame.
  const [iframeLoading, setIframeLoading] = useState(true);
  const resumeRef = useRef(resumeAt);
  useEffect(() => {
    resumeRef.current = resumeAt;
  }, [resumeAt]);

  const source = sources[srcIndex] ?? sources[0];
  const settings = useMemo(() => getSettings(), []);

  /* ---------------------------------------------------------------- */
  /* Sync with the external (watch-page) server pills                    */
  /* ---------------------------------------------------------------- */
  /**
   * Keep the internal `srcIndex` in sync with the external server pill list
   * (`requestedSourceId`) so the watch-page pills switch the active stream.
   */
  useEffect(() => {
    if (!requestedSourceId) return;
    const idx = sources.findIndex((s) => s.id === requestedSourceId);
    if (idx >= 0 && idx !== srcIndex) setSrcIndex(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedSourceId]);

  /* ---------------------------------------------------------------- */
  /* Iframe (AniPub embed) mode: reset the loading flag on source change */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (source?.kind === "iframe") setIframeLoading(true);
  }, [source, loadAttempt]);

  /* Track native buffered extent for the HTTP/HLS path. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
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
  }, [source]);

  /* ---------------------------------------------------------------- */
  /* HLS engine                                                        */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source) return;
    setError(false);
    setLoading(true);
    setLevels([]);

    // Iframe-embedded third-party player (AniPub / gogoanime `streaming.php`).
    // There is no native <video> element to drive — the <iframe> below handles
    // playback, controls and buffering entirely. Just clear the spinner.
    if (source.kind === "iframe") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }

    let hls: Hls | null = null;
    // The proxied URL no longer ends in `.m3u8`, so prefer the explicit flag
    // and fall back to sniffing the URL.
    const isHls =
      source.isHls ?? /\.m3u8(\?|$)/i.test(source.url);

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

    // Native <video> error handling (Safari HLS / progressive fallback path).
    const onVideoError = () => {
      setError(true);
      setLoading(false);
    };

    if (isHls && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        manifestLoadPolicy: HLS_LOAD_POLICY,
        playlistLoadPolicy: HLS_LOAD_POLICY,
        fragLoadPolicy: HLS_LOAD_POLICY,
        keyLoadPolicy: HLS_LOAD_POLICY,
      });
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
        if (!data.fatal) return;
        // Media errors are usually transient (codec/audio) — let hls.js recover.
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls?.recoverMediaError();
          return;
        }
        // Network error persists after internal retries — tear down so a manual
        // Retry cleanly rebuilds, then surface the error + retry UI.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls?.destroy();
          hls = null;
        }
        setError(true);
        setLoading(false);
      });
    } else {
      // Native HLS (Safari) or progressive fallback.
      video.addEventListener("error", onVideoError);
      video.src = source.url;
      video.load();
    }

    return () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onVideoError);
      hls?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, settings, slug, episode, loadAttempt]);

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

  /**
   * Primary retry: re-runs the load effect for the current source, then asks
   * the watch page to re-fetch fresh live sources (which will re-trigger the
   * effect again when the sources array changes).
   */
  const handleRetry = () => {
    setError(false);
    setLoading(true);
    setLoadAttempt((a) => a + 1);
    onRetryStream?.();
  };

  /**
   * Secondary action: switch to the next server in the pill list AND re-run
   * the load effect so the new source takes effect immediately (the external
   * sync effect would only update `requestedSourceId`, which changes `sources`
   * in the same render cycle — we explicitly bump loadAttempt to be safe).
   */
  const handleNextSource = () => {
    if (sources.length <= 1) {
      handleRetry();
      return;
    }
    setError(false);
    setLoading(true);
    setSrcIndex((i) => (i + 1) % sources.length);
    setLoadAttempt((a) => a + 1);
    onRetryStream?.();
  };

  const seek = (delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(Math.max(0, video.currentTime + delta), video.duration || 0);
  };

  const seekTo = (time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(Math.max(0, time), video.duration || time);
  };

  const skipTo = (position: "intro" | "outro") => {
    const video = videoRef.current;
    if (!video || !duration) return;
    video.currentTime =
      position === "intro"
        ? Math.min(INTRO_WINDOW, duration)
        : Math.max(0, duration - OUTRO_WINDOW);
  };

  const togglePanel = (name: "speed" | "quality" | "subs") => {
    setPanel((prev) => (prev === name ? null : name));
  };

  /* ---------------------------------------------------------------- */
  /* Picture-in-Picture capability (client-only)                      */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const supported =
      "pictureInPictureEnabled" in document &&
      typeof HTMLVideoElement !== "undefined" &&
      "requestPictureInPicture" in HTMLVideoElement.prototype;
    setPipSupported(Boolean(supported));
  }, []);

  const toggleTheater = () => setTheater((prev) => !prev);

  const pip = async () => {
    const video = videoRef.current;
    if (!video || typeof document === "undefined") return;
    if (!document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      // PiP can be blocked (no user gesture, unsupported codec) — ignore.
    }
  };

  /* ---------------------------------------------------------------- */
  /* Auto-hide controls: fade after inactivity or when the cursor      */
  /* leaves the player; any pointer move / touch / button re-arms it.   */
  /* ---------------------------------------------------------------- */
  const uiVisible = showControls || !!resumeAt || !!nextCountdown || !!panel;

  const rearm = (force = false) => {
    lastActivity.current = Date.now();
    if (force && showControls) return;
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowControls(false), AUTOHIDE_MS);
  };

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onPointerMove = () => {
      if (Date.now() - lastActivity.current < 400) return;
      rearm();
    };
    const onLeave = () => {
      // Only hide when no overlay is pinned visible (panel / countdown / resume).
      if (panel || nextCountdown != null || resumeAt != null) return;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setShowControls(false);
    };
    const onPlayPause = () => rearm(true);
    wrap.addEventListener("pointermove", onPointerMove);
    wrap.addEventListener("pointerdown", onPointerMove);
    wrap.addEventListener("mouseleave", onLeave);
    const video = videoRef.current;
    video?.addEventListener("play", onPlayPause);
    video?.addEventListener("pause", onPlayPause);
    return () => {
      wrap.removeEventListener("pointermove", onPointerMove);
      wrap.removeEventListener("pointerdown", onPointerMove);
      wrap.removeEventListener("mouseleave", onLeave);
      video?.removeEventListener("play", onPlayPause);
      video?.removeEventListener("pause", onPlayPause);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, nextCountdown, resumeAt]);

  /* ---------------------------------------------------------------- */
  /* Computed values                                                      */
  /* ---------------------------------------------------------------- */
  const remaining = duration > 0 ? duration - current : 0;
  const inIntro = current <= INTRO_WINDOW && duration > INTRO_WINDOW;
  const inOutro =
    remaining <= OUTRO_WINDOW && remaining > 0 && duration > OUTRO_WINDOW;
  const defaultSub = subtitles.find((t) => t.default);
  const activeSub = selectedSub === "off" ? null : subtitles.find((t) => t.id === selectedSub);
  // Distinct "nothing to play" state: zero sources resolved (live + fallback
  // both empty). Shown with a friendly message + retry instead of an error.
  const noSources = sources.length === 0;
  // AniPub (and most third-party providers) return full iframe-embed pages
  // rather than direct media URLs. When the active source is an iframe, render
  // the <iframe> branch and hide every native <video> control — the embed page
  // supplies its own playback controls.
  const isWrap = source?.kind === "iframe";

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
        {!isWrap && (
          <video
            ref={videoRef}
            className="w-full h-full block object-contain"
            poster={poster}
            preload="metadata"
            muted={muted || volume === 0}
          >
            {source && activeSub?.url && (
              <track kind="captions" src={activeSub.url} label={activeSub.label} />
            )}
          </video>
        )}

        {/* Legibility scrims behind the overlays and the control bar */}
        <Scrim side="top" hidden={isWrap || !showControls} />
        <Scrim side="bottom" hidden={isWrap || !showControls} />

        <LoadingOverlay show={!isWrap && loading && !noSources} />

        <NoSourcesOverlay
          show={noSources}
          title={dict.player.noSources}
          message={dict.player.noSourcesMsg}
          retry={dict.common.retry}
          onRetry={handleRetry}
        />

        <ErrorOverlay
          show={!isWrap && error && !noSources}
          title={dict.common.error}
          message={dict.player.error}
          retry={dict.common.retry}
          onRetry={handleRetry}
          secondaryLabel={sources.length > 1 ? dict.player.switchServer : undefined}
          onSecondary={handleNextSource}
        />

        <CenterPlayButton
          show={!isWrap && !playing && !loading && !error && !noSources}
          label={dict.player.play}
          onClick={togglePlay}
        />

        <ResumeChip
          show={!isWrap && !!resumeAt && resumeAt > 0}
          label={dict.player.resumeFrom}
          time={resumeAt ? fmt(resumeAt) : "0:00"}
          restart={dict.player.restart}
          onJump={() => setResumeAt(null)}
        />

        <FillerBadge
          show={fillerEpisodes.includes(episode)}
          badge={dict.detail.fillerBadge}
          note={dict.watch.fillerNote}
        />

        <AutoplayNextCounter
          show={!!nextCountdown}
          seconds={nextCountdown}
          maxSeconds={5}
          countdownLabel={dict.player.autoplayNext}
          nextLabel={dict.watch.nextEpisode}
          cancelLabel={dict.player.cancel}
          fillerWarning={fillerEpisodes.includes(episode + 1)}
          fillerBadge={dict.detail.fillerBadge}
          onNow={() => {
            setNextCountdown(null);
            onNext?.();
          }}
          onCancel={() => setNextCountdown(null)}
        />

        <SkipButtons
          inIntro={!isWrap && inIntro}
          inOutro={!isWrap && inOutro}
          skipIntro={dict.player.skipIntro}
          skipOutro={dict.player.skipOutro}
          onSkip={skipTo}
        />
      </div>

      {/* Controls bar */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-30 flex flex-col gap-1.5 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-4 py-3 transition-opacity duration-300",
          isWrap ? "hidden" : showControls && !error ? "opacity-100" : "opacity-0 pointer-events-none"
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
            {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} className="rtl-flip" />}
          </button>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between text-[11px] text-neutral-400 mb-1">
              <span dir="ltr">{fmt(current)}</span>
              <span dir="ltr">{fmt(duration)}</span>
            </div>
            <ProgressBar current={current} duration={duration} buffered={buffered} onSeek={seekTo} />
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
              {muted || volume === 0 ? <VolumeMuteIcon size={18} /> : <VolumeHighIcon size={18} />}
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
              aria-label={dict.player.volume}
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
              {speed === 1 ? (
                <SpeedIcon size={18} />
              ) : (
                <span className="text-xs font-bold tabular-nums" dir="ltr">{speed}x</span>
              )}
            </button>

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
              <QualityIcon size={18} />
            </button>

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
              <SubtitlesIcon size={18} />
            </button>

            <button
              type="button"
              onClick={toggleTheater}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
              aria-label={dict.player.theaterMode}
              aria-pressed={theater}
            >
              {theater ? <ExitTheaterIcon size={18} /> : <TheaterIcon size={18} />}
            </button>

            <button
              type="button"
              onClick={pip}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
              aria-label={dict.player.pip}
              disabled={!pipSupported}
            >
              <PipIcon size={18} />
            </button>

            <button
              type="button"
              onClick={toggleFullscreen}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
              aria-label={fullscreen ? dict.player.exitFullscreen : dict.player.fullscreen}
              aria-pressed={fullscreen}
            >
              {fullscreen ? <ExitFullscreenIcon size={18} /> : <FullscreenIcon size={18} />}
            </button>
          </div>
        </div>
      </div>

      {/* Iframe-embedded Anipub player — played in its own frame; the embed page
          supplies its own controls. Shown when the active source is an
          iframe URL (no native <video> available for it). */}
      {isWrap && source?.kind === "iframe" && (
        <div className="absolute inset-0">
          <iframe
            key={`${source.id}:${source.url}:${loadAttempt}`}
            src={source.url}
            title={epTitle || "stream"}
            className="h-full w-full border-0 bg-black"
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer-when-downgrade"
            onLoad={() => setIframeLoading(false)}
          />
          {/* Loading hero — shown while the frame is blank (before onLoad). It
              carries a prominent CTA the moment the user sees an empty frame,
              because some third-party sites reject embeds and never finish
              "loading" in a usable way. */}
          {iframeLoading && (
            <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 bg-neutral-950/95 px-5 text-center">
              <span
                className="h-9 w-9 animate-spin rounded-full border-2 border-white/25 border-t-white"
                aria-hidden
              />
              {epTitle && (
                <h2 className="max-w-[28rem] break-words text-base font-semibold text-white/90">
                  {epTitle}
                </h2>
              )}
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="pointer-events-auto inline-flex flex-wrap items-center justify-center gap-2.5 rounded-xl bg-brand px-6 py-3.5 text-sm font-bold leading-tight text-neutral-950 shadow-[0_12px_40px_-12px] shadow-brand/60 ring-1 ring-white/25 transition hover:brightness-[1.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-white sm:text-base sm:px-7"
                dir="auto"
                aria-label={dict.player.openInNewTab}
              >
                <span className="font-bold">Watch on {source.name} (External)</span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M7 17 17 7" />
                  <path d="M7 7h10v10" />
                </svg>
              </a>
              <p className="max-w-[30rem] text-xs leading-relaxed text-white/55 sm:text-sm">
                This server opens in its own tab; some sites block in-page
                embedding, so use the button above to watch directly.
              </p>
            </div>
          )}
        </div>
      )}
      {!isWrap && panel === "speed" && (
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
                  "flex min-w-[92px] items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                  speed === s ? "bg-brand text-neutral-950" : "text-neutral-600 hover:bg-neutral-200"
                )}
              >
                <span dir="ltr">{s}x</span>
                {speed === s && <CheckIcon size={14} className="text-neutral-950" />}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quality selector panel */}
      {!isWrap && panel === "quality" && levels.length > 0 && (
        <div className="absolute top-12 right-4 z-40 rounded-xl bg-white/[0.95] text-neutral-950 shadow-xl shadow-black/60 p-2">
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => {
                setLevel(-1);
                setPanel(null);
              }}
              className={cn(
                "flex min-w-[92px] items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                level === -1 ? "bg-brand text-neutral-950" : "text-neutral-600 hover:bg-neutral-200"
              )}
            >
              <span>{dict.player.auto}</span>
              {level === -1 && <CheckIcon size={14} className="text-neutral-950" />}
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
                  "flex min-w-[92px] items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                  level === l.i ? "bg-brand text-neutral-950" : "text-neutral-600 hover:bg-neutral-200"
                )}
              >
                <span dir="ltr">{l.label}</span>
                {level === l.i && <CheckIcon size={14} className="text-neutral-950" />}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Subtitle selector panel */}
      {!isWrap && panel === "subs" && (
        <div className="absolute top-12 right-4 z-40 max-w-[240px] rounded-xl bg-white/[0.95] text-neutral-950 shadow-xl shadow-black/60 p-2">
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => {
                setSelectedSub("off");
                setPanel(null);
              }}
              className={cn(
                "flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                selectedSub === "off" ? "bg-brand text-neutral-950" : "text-neutral-600 hover:bg-neutral-200"
              )}
            >
              <span>{dict.player.subtitlesOff}</span>
              {selectedSub === "off" && <CheckIcon size={14} className="text-neutral-950" />}
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
                  "flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                  selectedSub === t.id ? "bg-brand text-neutral-950" : "text-neutral-600 hover:bg-neutral-200"
                )}
              >
                <span className="truncate">{t.label}</span>
                {selectedSub === t.id && <CheckIcon size={14} className="text-neutral-950" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
