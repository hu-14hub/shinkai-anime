/**
 * Nyaa.si torrent search route.
 *
 *   GET /api/torrent/search?query=<animeTitle>&episode=<epNum>[&limit=<n>]
 *
 * Scrapes the anime torrent listing at nyaa.si, parses the results table with
 * cheerio, scores + sorts the candidates, and returns the best-matching magnet
 * link(s) as JSON.
 *
 * NOTE: plain ESM JavaScript (not TypeScript) — the `anime-backend` package has
 * no TS toolchain and `index.js` is run directly with `node`.
 */
import { Router } from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import https from "node:https";
import { dohLookup } from "../util/doh.js";

const router = Router();

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

/**
 * Anime listing: c=1_2 → "Anime > (BD|Web)" (where per-episode releases live),
 * f=0 → any date. This is the exact base URL the scraper queries.
 */
const NYAA_BASE = "https://nyaa.si/";
const nyaaUrl = (searchText) =>
  `${NYAA_BASE}?f=0&c=1_2&q=${encodeURIComponent(searchText)}`;

/** Give up on Nyaa after this long → 504. Overridable via env. */
const SCRAPE_TIMEOUT_MS = Number(process.env.NYAA_TIMEOUT_MS) || 15_000;

/** Browsers send a real UA; some CDNs/WAFs block the bare "axios/x" UA with 403. */
const SCAN_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Release-group ranking. Lower index = more preferred. When several torrents
 * match, one whose title contains any of these sorts ahead of the rest; ties
 * are broken by higher seeders, then larger file.
 */
const PREFERRED_GROUPS = [
  "Erai-raws",
  "Erai.Raws",
  "VaryG",
  "NyaaSubs",
  "JBAV",
];

/** "1.2 GB" / "480.5 MB" / "320 KB" / "999 B" → bytes (0 if unparseable). */
export function sizeToBytes(size) {
  if (!size || typeof size !== "string") return 0;
  const m = size.match(/^\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)\s*$/i);
  if (!m) return 0;
  const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(parseFloat(m[1]) * units[m[2].toUpperCase()]);
}
/**
 * Parse the `<td class="digit">` cells of one result row.
 *
 * Nyaa's column order is Name, Size, Seeders, Leeches, (+ Date). We locate Size
 * by *content* (matches the "1.2 GB" pattern) rather than column index, so an
 * inserted/removed column won't mis-align things. Seeders = the first plain
 * integer that isn't the size; Leeches = the next plain integer after it.
 *
 * @returns {{ size: string, sizeBytes: number, seeders: number, leeches: number }}
 */
export function parseDigitCells($, $tr) {
  const cells = $tr.find("td.digit").map((_, el) => $(el).text().trim()).get();

  let size = "";
  let seeders = 0;
  let leeches = 0;

  // 1) Size = the first cell matching the "1.2 GB" style pattern.
  for (const text of cells) {
    if (!size && /^\s*\d+(?:\.\d+)?\s*(B|KB|MB|GB|TB)\s*$/i.test(text)) {
      size = text;
      break;
    }
  }
  const sizeBytes = sizeToBytes(size);

  // 2) Seeders/Leeches = plain integers that are not the size cell.
  const integers = cells.filter((text) => /^\d+$/.test(text) && text !== size);
  seeders = integers[0] ? parseInt(integers[0], 10) : 0;
  leeches = integers[1] ? parseInt(integers[1], 10) : 0;

  return { size, sizeBytes, seeders, leeches };
}

/** 0-indexed rank of the first PREFERRED_GROUPS name in the title, else last. */
function preferredGroupScore(title) {
  const t = (title || "").toLowerCase();
  for (let i = 0; i < PREFERRED_GROUPS.length; i++) {
    if (t.includes(PREFERRED_GROUPS[i].toLowerCase())) return i;
  }
  return PREFERRED_GROUPS.length;
}

/**
 * Parse a full Nyaa results page into a sorted array of results.
 *
 * Each returned item: { title, magnet, size, sizeBytes, seeders, leeches,
 * groupScore, downloadUrl }
 * Rows without a magnet link are dropped (we can only stream via magnet).
 *
 * Sort: known release-group rank, then more seeders, then larger file.
 */
export function parsePage(html) {
  if (!html || typeof html !== "string") return [];
  const $ = cheerio.load(html);

  const results = [];
  $(".torrent-list tbody tr").each(function () {
    const $tr = $(this);

    const magnet = $tr.find('a[href^="magnet:?"]').attr("href");
    if (!magnet || !magnet.startsWith("magnet:?")) return; // skip rows w/o magnet

    // Title: Nyaa's name anchor carries the anime title in its `title` attribute
    // (its `href` is the /view/<id> details page, so we deliberately avoid it).
    const nameAnchor = $tr.find(".detail a").first();
    const title = (
      nameAnchor.attr("title") ||
      nameAnchor.text() ||
      $tr.find(".detail").first().text() ||
      ""
    ).replace(/\s+/g, " ").trim();

    const digits = parseDigitCells($, $tr);
    const downloadUrl = nameAnchor.attr("href") || null;

    results.push({
      title,
      magnet,
      size: digits.size || null,
      sizeBytes: digits.sizeBytes,
      seeders: digits.seeders,
      leeches: digits.leeches,
      groupScore: preferredGroupScore(title),
      downloadUrl,
    });
  });

  results.sort((a, b) => {
    if (a.groupScore !== b.groupScore) return a.groupScore - b.groupScore;
    if (b.seeders !== a.seeders) return b.seeders - a.seeders;
    if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes;
    return 0;
  });

  return results;
}
/* ------------------------------------------------------------------ */
/* Fetch + parse                                                       */
/* ------------------------------------------------------------------ */

/**
 * Fetch and parse one Nyaa search page.
 * @returns {Promise<Array>} sorted results (may be empty when Nyaa finds nothing)
 */
/**
 * HTTP(S) agent used for the nyaa.si scrape. Two non-default options:
 *
 *   lookup: dohLookup
 *     Replaces Node's `dns.lookup` for this agent's connections. It is a
 *     narrow shim that routes nyaa.si (and sub-domains) through a public
 *     DoH resolver *only when the system resolver fails* — leaving all
 *     other DNS traffic untouched. See src/util/doh.js for details,
 *     error handling and logging.
 *
 *   family: 4
 *     DoH (A records) returns IPv4 only; forcing family 4 keeps the agent
 *     consistent with what `dohLookup` returns, regardless of OS default
 *     (IPv4-preferred on Windows, IPv6-preferred on Linux/macOS).
 *
 * IMPORTANT (axios v1): the Node adapter selects the agent via `httpsAgent`
 * for https:// requests (see `lib/adapters/http.js` — it reads
 * `own('httpsAgent')`, NOT the generic `agent`). Passing `agent:` alone is
 * ignored for HTTPS and silently falls back to `https.globalAgent` (system
 * DNS). We therefore pass `httpsAgent:` (and `httpAgent:` for the http
 * edge-case) so this custom lookup is actually used.
 */
const NYAA_HTTPS_AGENT = new https.Agent({
  lookup: dohLookup,
  family: 4,
});

async function fetchAndParse(query) {
  const { data } = await axios.get(nyaaUrl(query), {
    headers: SCAN_HEADERS,
    timeout: SCRAPE_TIMEOUT_MS,
    responseType: "text",
    httpsAgent: NYAA_HTTPS_AGENT,
    httpAgent: NYAA_HTTPS_AGENT,
  });
  return parsePage(data);
}

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

/**
 * GET /api/torrent/search?query=<title>&episode=<n>[&limit=<n>]
 *
 * query   — anime title (required)
 * episode — episode number ("1") or range ("15-16"), optional; appended so the
 *           search targets that episode's release
 * limit   — max results to return (clamped to 1..20, default 5)
 */
router.get("/search", async (req, res) => {
  const query = (req.query.query || "").trim();
  if (!query) {
    return res
      .status(400)
      .json({ error: "Missing required 'query' search parameter." });
  }

  const episode = (req.query.episode || "").trim();
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 5));

  // Combine title + episode the way a user would search.
  const searchText = episode ? `${query} ${episode}` : query;

  let results;
  try {
    results = await fetchAndParse(searchText);
  } catch (err) {
    return handleSearchError(err, res);
  }

  if (results.length === 0) {
    return res.status(404).json({
      error: `No torrents found for "${searchText}".`,
      query,
      episode: episode || null,
      results: [],
    });
  }

  const top = results.slice(0, limit).map((r) => ({
    title: r.title,
    seeders: r.seeders,
    leeches: r.leeches,
    size: r.size,
    sizeBytes: r.sizeBytes,
    magnet: r.magnet,
    url: r.downloadUrl,
  }));

  return res.json({
    query,
    episode: episode || null,
    count: top.length,
    total: results.length,
    // Convenience: the single best match for callers wanting just one magnet.
    best: top[0],
    results: top,
  });
});

/** Map axios/network failures to sensible JSON responses. */
function handleSearchError(err, res) {
  const status = err.response ? err.response.status : null;

  if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
    return res
      .status(504)
      .json({ error: "Timed out while contacting nyaa.si. Try again later." });
  }
  if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN" || err.code === "ENETUNREACH") {
    return res
      .status(502)
      .json({ error: `Could not reach nyaa.si (DNS/network): ${err.code}` });
  }
  // 403/429 → Nyaa's WAF blocking us (common for data-center IPs / bad UA).
  if (status === 403 || status === 429) {
    return res
      .status(503)
      .json({
        error:
          "Nyaa.si blocked this request (HTTP " +
          status +
          "). The server IP or User-Agent may be rate-limited; try again later.",
      });
  }
  if (status) {
    return res
      .status(502)
      .json({ error: `nyaa.si responded with HTTP ${status}.` });
  }
  console.error("[torrent/search] Unexpected error:", err.message);
  return res.status(502).json({ error: `Search failed: ${err.message}` });
}

export default router;