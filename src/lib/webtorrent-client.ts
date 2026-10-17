/**
 * useWebTorrent -- WebTorrent 3.x wrapper for the browser.
 *
 * Design goals:
 *   1. Zero SSR cost: "webtorrent" is only reached via a client-only dynamic
 *      `await import("webtorrent")` inside this file's promise chains.
 *   2. One long-lived WebTorrent client per tab, reused across client-side
 *      navigations so the peer / DHT pool survives route changes.
 *   3. Progress-first: prefer progressive `file.streamTo(video)` (rangeable,
 *      real player seeking) served through the WebTorrent service worker.
 *      Fall back to `file.blob()` (whole-file download, no SW required).
 *   4. If the P2P path fails, the hook surfaces `status === "error"` so the
 *      caller can transparently fall back to HLS / MP4.
 *
 * Call it unconditionally -- it stays `idle` until `load()` is invoked.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { Torrent, TorrentClient, TorrentFile } from "webtorrent";

export type WebTorrentStatus =
  | "idle"
  | "connecting"
  | "downloading"
  | "ready"
  | "error";

export interface WebTorrentInfo {
  status: WebTorrentStatus;
  /** Human-facing reason for `status === "error"`. */
  error?: string;
  /** Active peer count for the current torrent. */
  peers: number;
  /** Download throughput in bytes/second. */
  downloadSpeed: number;
  /** 0..1 progress of the selected video file. */
  fileProgress: number;
  /** Total size of the selected video file in bytes (0 when unknown). */
  fileLength: number;
  /** Bytes of the selected video file downloaded so far. */
  fileDownloaded: number;
  /** Name of the selected video file ("" when unknown). */
  fileName: string;
  /** Which strategy produced the <video> src once `status === "ready"`. */
  strategy?: "stream" | "blob";
}

export interface UseWebTorrentResult extends WebTorrentInfo {
  /**
   * Load a P2P source into a target <video> element.
   * `source` may be a magnet URI, a bare info-hash, a .torrent URL, or a
   * .torrent body string. Resolves once the <video> element is streaming.
   */
  load: (source: string, videoEl: HTMLVideoElement) => Promise<void>;
  /** Tear down the current torrent and release any Blob URLs. */
  stop: () => void;
}
const WT_CLIENT_KEY = "__webtorrentSingletonClient" as const;
const WT_SW_KEY = "__webtorrentSwRegistration" as const;
const WT_SERVER_CREATED_KEY = "__webtorrentServerCreated" as const;

interface BrowserWindowWithWT extends Window {
  [WT_CLIENT_KEY]?: Promise<TorrentClient> | null;
  [WT_SW_KEY]?: Promise<ServiceWorkerRegistration | null> | null;
  [WT_SERVER_CREATED_KEY]?: boolean;
}

function browserWindow(): BrowserWindowWithWT {
  return window as unknown as BrowserWindowWithWT;
}

/**
 * Returns a module-scoped, tab-scoped WebTorrent client. The client is
 * created lazily and reused; it is only destroyed on beforeunload.
 */
async function getSharedClient(): Promise<TorrentClient> {
  const w = browserWindow();
  const existing = w[WT_CLIENT_KEY];
  if (existing) return existing;

  const p = (async () => {
    const mod: unknown = await import("webtorrent");
    const m = mod as { default?: unknown };
    const Ctor = (typeof m === "object" && m !== null && "default" in m
      ? m.default
      : m) as new (opts?: unknown) => TorrentClient;
    if (typeof Ctor !== "function") {
      throw new Error("webtorrent: unrecognised export shape");
    }
    const client = new Ctor();
    client.on("error", (err: unknown) => {
      console.warn("[WebTorrent] client error:", err);
    });
    return client;
  })();

  w[WT_CLIENT_KEY] = p;
  return p;
}
function isActiveWorkerSync(reg: ServiceWorkerRegistration): boolean {
  const s = (reg.active
    ? reg.active.state
    : reg.waiting
      ? reg.waiting.state
      : null) as
    | "activated"
    | "activating"
    | "installing"
    | "redundant"
    | "unregistered"
    | null;
  return s === "activated" || s === "activating";
}

function waitForActiveWorker(
  reg: ServiceWorkerRegistration,
  timeoutMs: number
): Promise<void> {
  if (isActiveWorkerSync(reg)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (isActiveWorkerSync(reg)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("service worker did not become active in time"));
      }
    }, 100);
  });
}

/**
 * Register (once) the WebTorrent service worker at root scope. Resolves
 * to `null` when SW is unsupported or registration fails -- callers then
 * use the Blob fallback path.
 */
function getSharedServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  const w = browserWindow();
  const existing = w[WT_SW_KEY];
  if (existing) return existing;

  const p = (async () => {
    try {
      if (!("serviceWorker" in navigator)) return null;
      let reg = await navigator.serviceWorker.getRegistration("/");
      if (!reg || !isActiveWorkerSync(reg)) {
        reg = await navigator.serviceWorker.register("/webtorrent-sw.js", {
          scope: "/",
        });
      }
      await waitForActiveWorker(reg, 5000);
      return reg;
    } catch (err) {
      console.warn("[WebTorrent] SW registration failed:", err);
      return null;
    }
  })();

  w[WT_SW_KEY] = p;
  return p;
}

/**
 * Create the WebTorrent in-page HTTP server exactly once. It proxies
 * `GET /webtorrent/<infoHash>/<fileId>` requests from the page to the
 * service worker.
 */
function ensureServer(
  client: TorrentClient,
  reg: ServiceWorkerRegistration
): void {
  const w = browserWindow();
  if (w[WT_SERVER_CREATED_KEY]) return;
  try {
    client.createServer({ controller: reg }, "browser");
    w[WT_SERVER_CREATED_KEY] = true;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    // Server already exists is benign (re-entrant call) but anything else
    // should surface to the caller.
    if (w[WT_SERVER_CREATED_KEY] === undefined || /already/i.test(msg)) {
      w[WT_SERVER_CREATED_KEY] = true;
      return;
    }
    throw err;
  }
}
const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|divx|ts)$/i;

function pickVideoFile(files: TorrentFile[]): TorrentFile | null {
  if (!files || files.length === 0) return null;
  const bySize = (a: TorrentFile, b: TorrentFile) => b.length - a.length;
  const videos = files.filter(
    (f) => VIDEO_EXT.test(f.name) || /^video\//.test(f.type || "")
  );
  const pool = videos.length > 0 ? videos : files;
  return pool.slice().sort(bySize)[0] ?? null;
}
function readPeers(t: Torrent | null | undefined): number {
  try {
    return t ? t.numPeers : 0;
  } catch {
    return 0;
  }
}
function readSpeed(t: Torrent | null | undefined): number {
  try {
    return t ? t.downloadSpeed : 0;
  } catch {
    return 0;
  }
}
function readProgress(f: TorrentFile | null | undefined): number {
  try {
    return f ? f.progress : 0;
  } catch {
    return 0;
  }
}
function readLength(f: TorrentFile | null | undefined): number {
  try {
    return f ? f.length : 0;
  } catch {
    return 0;
  }
}
function readDownloaded(f: TorrentFile | null | undefined): number {
  try {
    return f ? f.downloaded : 0;
  } catch {
    return 0;
  }
}
export function useWebTorrent(): UseWebTorrentResult {
  const [status, setStatus] = useState<WebTorrentStatus>("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const [peers, setPeers] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState(0);
  const [fileProgress, setFileProgress] = useState(0);
  const [fileLength, setFileLength] = useState(0);
  const [fileDownloaded, setFileDownloaded] = useState(0);
  const [fileName, setFileName] = useState("");
  const [strategy, setStrategy] = useState<"stream" | "blob" | undefined>(
    undefined
  );

  const torrentRef = useRef<Torrent | null>(null);
  const selectedFileRef = useRef<TorrentFile | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef(0);

  const stopStats = useCallback(() => {
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
  }, []);

  const startStats = useCallback(
    (torrent: Torrent, file: TorrentFile | null, session: number) => {
      stopStats();
      // Prime synchronous metrics on the first tick so the HUD has data
      // immediately rather than waiting for the first interval fire.
      setFileLength(readLength(file));
      setFileDownloaded(readDownloaded(file));
      statsTimerRef.current = setInterval(() => {
        if (sessionRef.current !== session) return stopStats();
        setPeers(readPeers(torrent));
        setDownloadSpeed(readSpeed(torrent));
        setFileProgress(readProgress(file));
        setFileLength(readLength(file));
        setFileDownloaded(readDownloaded(file));
      }, 1000);
    },
    [stopStats]
  );

  const teardown = useCallback(() => {
    sessionRef.current += 1;
    stopStats();
    if (blobUrlRef.current) {
      try {
        URL.revokeObjectURL(blobUrlRef.current);
      } catch {
        /* ignore */
      }
      blobUrlRef.current = null;
    }
    const t = torrentRef.current;
    torrentRef.current = null;
    selectedFileRef.current = null;
    if (t) {
      try {
        t.destroy();
      } catch {
        /* ignore */
      }
    }
  }, [stopStats]);
const load = useCallback(
    async (source: string, videoEl: HTMLVideoElement): Promise<void> => {
      teardown();
      const session = ++sessionRef.current;

      setStatus("connecting");
      setError(undefined);
      setPeers(0);
      setDownloadSpeed(0);
      setFileProgress(0);
      setFileLength(0);
      setFileDownloaded(0);
      setFileName("");
      setStrategy(undefined);

      try {
        const client = await getSharedClient();
        if (sessionRef.current !== session) return;

        const reg = await getSharedServiceWorker();
        if (sessionRef.current !== session) return;

        let swReady = false;
        if (reg) {
          try {
            ensureServer(client, reg);
            swReady = true;
          } catch (err) {
            console.warn(
              "[WebTorrent] createServer failed, using Blob fallback",
              err
            );
          }
        }

        const torrent = await new Promise<Torrent>((resolve, reject) => {
          client.add(source, (err, t) => {
            if (err || !t) {
              reject(err ?? new Error("client.add returned no torrent"));
            } else {
              resolve(t);
            }
          });
        });
        if (sessionRef.current !== session) {
          try {
            torrent.destroy();
          } catch {
            /* ignore */
          }
          return;
        }

        torrentRef.current = torrent;
        setFileName(torrent.name || "");

        torrent.on("error", (err: unknown) => {
          if (sessionRef.current !== session) return;
          setStatus("error");
          setError(
            err instanceof Error ? err.message : String(err)
          );
        });
        torrent.on("warning", () => {
          /* non-fatal */
        });
        torrent.on("noPeers", () => {
          /* surfaced via stats */
        });
        torrent.on("done", () => {
          /* video already streaming */
        });

        setPeers(readPeers(torrent));
        setDownloadSpeed(readSpeed(torrent));

        // Wait for metadata (full file list).
        await new Promise<void>((resolve, reject) => {
          if (torrent.files && torrent.files.length > 0) {
            resolve();
            return;
          }
          const onErr = (e: unknown) => {
            torrent.off("ready", onOk);
            reject(e);
          };
          const onOk = () => {
            torrent.off("error", onErr);
            resolve();
          };
          torrent.once("ready", onOk);
          torrent.once("error", onErr);
        });
        if (sessionRef.current !== session) return;

        const file = pickVideoFile(torrent.files);
        if (!file) {
          setStatus("error");
          setError("No playable video file found in this torrent");
          return;
        }
        selectedFileRef.current = file;
        setFileName(file.name);
        startStats(torrent, file, session);

        // Download only the target file to conserve bandwidth.
        torrent.deselect();
        file.select();
        setStatus("downloading");

        videoEl.pause();
        try {
          videoEl.removeAttribute("src");
          videoEl.load();
        } catch {
          /* ignore */
        }

        let streamed = false;
        if (swReady) {
          try {
            file.streamTo(videoEl);
            streamed = true;
          } catch (err) {
            console.warn(
              "[WebTorrent] streamTo failed, using Blob fallback",
              err
            );
          }
        }

        if (streamed) {
          setStrategy("stream");
          setStatus("ready");
          videoEl.play().catch(() => {
            /* autoplay policy */
          });
        } else {
          setStrategy("blob");
          try {
            const blob = await file.blob();
            if (sessionRef.current !== session) return;
            const url = URL.createObjectURL(blob);
            blobUrlRef.current = url;
            videoEl.src = url;
            videoEl.load();
            setStatus("ready");
            videoEl.play().catch(() => {
              /* autoplay policy */
            });
          } catch (err) {
            setStatus("error");
            setError(err instanceof Error ? err.message : String(err));
          }
        }
      } catch (err) {
        if (sessionRef.current !== session) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [teardown, startStats]
  );
const stop = useCallback(() => {
    teardown();
    setStatus("idle");
    setError(undefined);
    setPeers(0);
    setDownloadSpeed(0);
    setFileProgress(0);
    setFileLength(0);
    setFileDownloaded(0);
    setFileName("");
    setStrategy(undefined);
  }, [teardown]);

  // Tear down the per-torrent state when this hook unmounts. The shared
  // client / SW / browser server are intentionally left alive for other
  // pages in the same tab.
  useEffect(() => {
    return () => {
      teardown();
    };
  }, [teardown]);

  // Best-effort destroy of the shared client on page close.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onBeforeUnload = () => {
      const w = browserWindow();
      const p = w[WT_CLIENT_KEY];
      if (p) {
        p.then((c: TorrentClient) => {
          try {
            c.destroy();
          } catch {
            /* ignore */
          }
          w[WT_CLIENT_KEY] = null;
          w[WT_SERVER_CREATED_KEY] = false;
        });
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  return {
    status,
    error,
    peers,
    downloadSpeed,
    fileProgress,
    fileLength,
    fileDownloaded,
    fileName,
    strategy,
    load,
    stop,
  };
}