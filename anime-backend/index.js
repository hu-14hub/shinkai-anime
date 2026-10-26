/**
 * Shinkai Anime — WebTorrent streaming backend.
 *
 * Endpoints:
 *   GET /api/torrent/stream?magnet=<BASE64-or-plain-magnet-link>
 *   GET /health
 *
 * Flow:
 *   1. Parse the magnet link from the query string (plain or base64-encoded).
 *   2. Add the torrent to a shared WebTorrent instance and wait for metadata.
 *   3. Pick the largest video file from the torrent.
 *   4. Stream that file back with full HTTP Range support so the browser's
 *      <video> element can seek without re-buffering from zero.
 *
 * Why a separate Node process:
 *   WebTorrent spins up BitTorrent peer connections, DHT, UDP sockets, etc.
 *   It cannot (or should not) be run inside a Vercel / serverless function —
 *   those have execution limits, no persistent connections, and no UDP.
 *   This backend must run as a long-lived Node.js process.
 *
 * Run:
 *   cd anime-backend
 *   npm install
 *   npm start            # or  npm run dev  for --watch
 */

import express from "express";
import cors from "cors";
import WebTorrent from "webtorrent";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
/** Max seconds to wait for metadata before returning 504. */
const METADATA_TIMEOUT_MS = 120_000;

const app = express();
app.use(cors());

// Single shared WebTorrent instance — reuses the same DHT / peer pool across
// requests, so the torrent stays alive and a second request for the same
// magnet hits the peer cache instead of re-discovering everything.
//
// `noWebRTC: true` is required: WebRTC peer discovery (node-datachannel)
// hangs in environments where the native binary is unavailable.
// BT over TCP + DHT + trackers is fully sufficient for a single-server
// streaming backend and avoids that hang entirely.
const client = new WebTorrent({ noWebRTC: true });
/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Accept magnet links in any of these forms:
 *   - plain:  "magnet:?xt=urn:btih:…"
 *   - base64  (standard or URL-safe):  Buffer.from(b64).toString("utf8")
 */
function decodeMagnet(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.startsWith("magnet:?")) return s;
  const toStd = (x) => x.replace(/-/g, "+").replace(/_/g, "/");
  for (const enc of [toStd, (x) => x]) {
    try {
      const dec = Buffer.from(enc(s), "base64").toString("utf8");
      if (dec.startsWith("magnet:?")) return dec;
    } catch {
      /* try next encoding */
    }
  }
  return null;
}

const VIDEO_RE = /\.(mp4|mkv|webm|m4v|avi|mov|flv|wmv|ts)$/i;

/**
 * Return the index of the largest video file, or the largest file at all
 * if no extension matches.  Returns -1 when the torrent has no files.
 */
function bestVideoIndex(meta) {
  let bestIdx = -1;
  let bestSize = -1;
  let sawVideo = false;
  for (let i = 0; i < meta.files.length; i++) {
    const f = meta.files[i];
    if (VIDEO_RE.test((f.name || "").toLowerCase()) && f.length > bestSize) {
      bestSize = f.length;
      bestIdx = i;
      sawVideo = true;
    }
  }
  if (!sawVideo) {
    for (let i = 0; i < meta.files.length; i++) {
      if (meta.files[i].length > bestSize) {
        bestSize = meta.files[i].length;
        bestIdx = i;
      }
    }
  }
  return bestIdx;
}

/**
 * Stream a WebTorrentFile with full HTTP Range request support.
 *   - No Range header (or bytes=0-)  → 200 + full file
 *   - bytes=START-END                → 206 + that byte range
 */
function streamFile(wtFile, req, res) {
  const total = wtFile.length;

  let start = 0;
  let end = total - 1;
  let isPartial = false;

  if (req.headers.range) {
    const m = req.headers.range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      if (m[1] !== "") start = parseInt(m[1], 10);
      if (m[2] !== "") end = parseInt(m[2], 10);
      if (end >= total) end = total - 1;
      if (start > end || start >= total) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        return res.end();
      }
      isPartial = start > 0 || end < total - 1;
    }
  }

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

app.get("/api/torrent/stream", (req, res) => {
  const magnet = decodeMagnet(req.query.magnet);
  if (!magnet) {
    return res
      .status(400)
      .json({ error: "Invalid or missing 'magnet' query parameter." });
  }

  console.log(
    `[torrent] Request: ${magnet.slice(0, 100)}${magnet.length > 100 ? "…" : ""}`
  );

  const torrent = client.add(magnet);

  const timeout = setTimeout(() => {
    if (!torrent.ready) {
      console.warn("[torrent] Metadata timeout — destroying torrent.");
      torrent.destroy();
      if (!res.headersSent) {
        res.status(504).json({
          error:
            "Timed out waiting for torrent metadata. " +
            "The torrent may be private or have no peers online.",
        });
      }
    }
  }, METADATA_TIMEOUT_MS);

  torrent.on("ready", () => {
    clearTimeout(timeout);
    if (res.headersSent) return;

    const idx = bestVideoIndex(torrent);
    if (idx === -1) {
      return res.status(404).json({
        error: "No video file found in this torrent.",
        files: torrent.files.map((f) => f.name),
      });
    }

    const file = torrent.files[idx];
    console.log(
      `[torrent] Ready → "${file.name}" (${(file.length / 1e6).toFixed(1)} MB)`
    );

    streamFile(file, req, res);
  });

  torrent.on("error", (err) => {
    clearTimeout(timeout);
    console.error("[torrent] Error:", err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: `Torrent error: ${err.message}` });
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, activeTorrents: client.torrents.length });
});

app.listen(PORT, () => {
  console.log(`\n🎬 Shinkai WebTorrent backend → http://localhost:${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/health`);
  console.log(`   Stream:  http://localhost:${PORT}/api/torrent/stream?magnet=…\n`);
});