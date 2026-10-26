/**
 * Shinkai Anime — WebTorrent streaming + Nyaa search backend.
 *
 * Endpoints:
 *   GET /api/torrent/search?query=<title>&episode=<n>[&limit=<n>]  (→ magnet links)
 *   GET /api/torrent/stream?magnet=<BASE64-or-plain-magnet-link>
 *   GET /health
 *
 * Why a separate Node process:
 *   WebTorrent spins up BitTorrent peer connections, DHT, UDP sockets, etc.
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
import torrentSearchRouter from "./src/routes/torrent.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
/** Max seconds to wait for metadata before returning 504. */
const METADATA_TIMEOUT_MS = 120_000;

const app = express();
app.use(cors());

// Nyaa.si search → magnet links. Mounted so the public path is
//   GET /api/torrent/search?query=<title>&episode=<n>
// The router only owns "/search"; other /api/torrent/* paths (e.g. /stream)
// are registered directly on `app` below.
app.use("/api/torrent", torrentSearchRouter);

// Single shared WebTorrent instance — reuses the same DHT / peer pool across
// requests. `noWebRTC: true` avoids a native-binary hang in headless envs and
// TCP + DHT + trackers is fully sufficient for a single-server streamer.
const client = new WebTorrent({ noWebRTC: true });

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Accept a magnet link plain, or base64 (standard / URL-safe) encoded. */
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

/** Index of the largest video file (or largest file if none match). -1 if empty. */
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
 * Stream a WebTorrentFile with full HTTP Range support.
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

  res.writeHead(isPartial ? 206 : 200, {
    ...(isPartial ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
    "Accept-Ranges": "bytes",
    "Content-Length": isPartial ? end - start + 1 : total,
    "Content-Type": "video/mp4",
    "Access-Control-Allow-Origin": "*",
  });

  const stream = wtFile.createReadStream({ start, end: isPartial ? end : undefined });
  stream.pipe(res);
  stream.on("error", (err) => console.error("[stream] file error:", err.message));
  req.on("close", () => stream.destroy());
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

// Capture the server handle so the EADDRINUSE handler below can react to it
// (see "Graceful port already in use handling" further down).
const server = app.listen(PORT, () => {
  console.log(`\n🎬 Shinkai WebTorrent backend → http://localhost:${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/health`);
  console.log(
    `   Search:  http://localhost:${PORT}/api/torrent/search?query=…&episode=…`
  );
  console.log(`   Stream:  http://localhost:${PORT}/api/torrent/stream?magnet=…\n`);
});

/* ------------------------------------------------------------------ */
/* Graceful "port already in use" handling                            */
/* ------------------------------------------------------------------ */
// Without this, a second instance (or a stale one still bound) throws an
// unhandled `EADDRINUSE` and the process dies with a long, confusing stack.
// We catch that specific code and exit with a short, actionable message
// instead. `npm start` / `npm run dev` run `scripts/freeport.mjs` first
// (see package.json `prestart` / `predev`) to clear the port, so this is the
// safety net for manual or parallel runs.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n❌ Port ${PORT} is already in use by another process.\n` +
        `   A previous backend (or another service) is still holding it.\n` +
        `   Fix:  cd anime-backend && npm run freeport    # frees port ${PORT}\n` +
        `   then start again (plain \`npm start\` / \`dev\` already clears it first).\n`
    );
    process.exit(1);
  }
  throw err; // re-throw anything non-EADDRINUSE — it's a genuine bug.
});