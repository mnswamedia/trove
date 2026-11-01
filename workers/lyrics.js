/**
 * Cloudflare Worker — Music Lyrics Extractor
 *
 * Endpoints:
 *   GET  /?videoId=ID&token=KEY       → fetch lyrics for YouTube videoId (or full YT/YTM URL)
 *   GET  /lyrics/ID                   → path-style lookup
 *   GET  /?title=TITLE&artist=ARTIST  → title/artist lookup (with LRCLIB search)
 *   GET  /?q=QUERY                    → general search query lookup
 *   POST / or /lyrics                 → JSON body: { videoId, title, artist, q }
 *   GET  /health                      → health check
 *   OPTIONS *                         → CORS preflight
 *
 * Multi-Source Fallback Strategy:
 *   1. YouTube Music InnerTube (browse with MPLYt browseId)
 *   2. LRCLIB database (synced & plain lyrics fallback by track/artist)
 *
 * Supported Auth (if API_KEY or TOKEN is set in Worker environment):
 *   - Header: Authorization: Bearer <TOKEN>
 *   - Header: X-API-Key: <TOKEN>
 *   - Query:  ?token=<TOKEN> or ?key=<TOKEN> or ?apiKey=<TOKEN>
 *   If no secret is set in Worker environment, requests are publicly allowed.
 */

const YTM_BASE = "https://music.youtube.com/youtubei/v1";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const LRCLIB_BASE = "https://lrclib.net/api";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const VISITOR_ID = "CgtwclpTdlljOTc4VSjGzJzXBjIKCgJTRxIEGgAgaA%3D%3D";

/* --------------------------------------------------------------------------
 * HTTP & YouTube Request Helpers
 * -------------------------------------------------------------------------- */

async function ytmRequest(endpoint, payload, retries = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(`${YTM_BASE}/${endpoint}?prettyPrint=false`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://music.youtube.com",
        "Referer": "https://music.youtube.com/",
        "User-Agent": USER_AGENT,
        "X-Goog-Visitor-Id": VISITOR_ID
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB_REMIX",
            clientVersion: "1.20260327.10.00",
            hl: "en",
            gl: "US",
            visitorData: VISITOR_ID
          }
        },
        ...payload
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`YouTube returned HTTP ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    clearTimeout(timeout);
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 600));
      return ytmRequest(endpoint, payload, retries - 1);
    }
    throw err;
  }
}

/* --------------------------------------------------------------------------
 * Tree & Node Parsers
 * -------------------------------------------------------------------------- */

// Recursively find the lyrics browse ID (starts with "MPLYt").
function findLyricsBrowseId(obj) {
  if (!obj || typeof obj !== "object") return null;

  if (typeof obj.browseId === "string" && obj.browseId.startsWith("MPLYt")) {
    return obj.browseId;
  }

  for (const value of Object.values(obj)) {
    const result = findLyricsBrowseId(value);
    if (result) return result;
  }
  return null;
}

// Find track title and artist name from watch-next data for LRCLIB fallback
function findTrackInfo(obj) {
  if (!obj || typeof obj !== "object") return null;

  if (obj.videoDetails && typeof obj.videoDetails === "object") {
    const title = obj.videoDetails.title || null;
    const author = obj.videoDetails.author || null;
    if (title) return { title, author };
  }

  for (const value of Object.values(obj)) {
    const res = findTrackInfo(value);
    if (res) return res;
  }
  return null;
}

// Extract lyrics from musicDescriptionShelfRenderer.
function extractLyrics(obj) {
  if (!obj || typeof obj !== "object") return null;

  // Search specifically for musicDescriptionShelfRenderer first
  function findShelf(node) {
    if (!node || typeof node !== "object") return null;
    if (node.musicDescriptionShelfRenderer) {
      return node.musicDescriptionShelfRenderer;
    }
    for (const val of Object.values(node)) {
      const found = findShelf(val);
      if (found) return found;
    }
    return null;
  }

  const shelf = findShelf(obj);
  if (shelf) {
    const description = shelf.description;
    let lyricsText = "";

    if (description?.runs && Array.isArray(description.runs)) {
      lyricsText = description.runs.map(r => r.text || "").join("");
    } else if (description?.simpleText) {
      lyricsText = description.simpleText;
    }

    if (lyricsText && lyricsText.trim()) {
      const source = shelf.footer?.runs?.map(r => r.text || "").join("") || "YouTube Music";
      return {
        lyrics: lyricsText.trim(),
        plainLyrics: lyricsText.trim(),
        source
      };
    }
  }

  // Check if YouTube returned a messageRenderer saying lyrics are unavailable
  function findMessage(node) {
    if (!node || typeof node !== "object") return null;
    if (node.messageRenderer) {
      const mr = node.messageRenderer;
      const text = mr.text?.runs?.map(r => r.text || "").join("") || mr.text?.simpleText || "";
      if (text) return text;
    }
    for (const val of Object.values(node)) {
      const msg = findMessage(val);
      if (msg) return msg;
    }
    return null;
  }

  const message = findMessage(obj);
  if (message) {
    return { lyrics: null, message };
  }

  return null;
}

// Strip timestamps [mm:ss.xx] from synced LRC to obtain plain text
function cleanSyncedLyrics(synced) {
  if (!synced) return "";
  return synced
    .replace(/\[\d{2}:\d{2}(?:\.\d{1,3})?\]\s*/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

// Clean title string for better LRCLIB matching
function cleanSongTitle(str) {
  if (!str) return "";
  return str
    .replace(/\.[a-zA-Z0-9]+$/, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/official\s+video|official\s+audio|lyrics|lyric\s+video|audio|video|visualizer/gi, "")
    .replace(/ft\..*|feat\..*/gi, "")
    .replace(/[^\w\s\u0600-\u06FF\u0900-\u097F\u4e00-\u9fa5-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* --------------------------------------------------------------------------
 * LRCLIB Fallback Provider
 * -------------------------------------------------------------------------- */

async function getLrclibLyrics(trackName, artistName, duration = null) {
  if (!trackName && !artistName) return null;

  const headers = {
    "User-Agent": "Trove-Media-Vault/1.0 (https://github.com/mnswa/trove)"
  };

  // Attempt 1: Direct /api/get if both track and artist are known
  if (trackName && artistName) {
    try {
      const params = new URLSearchParams();
      params.set("track_name", cleanSongTitle(trackName));
      params.set("artist_name", cleanSongTitle(artistName));
      if (duration && Number(duration) > 0) {
        params.set("duration", Math.round(Number(duration)).toString());
      }

      const res = await fetch(`${LRCLIB_BASE}/get?${params.toString()}`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (data && (data.plainLyrics || data.syncedLyrics)) {
          const plain = data.plainLyrics || cleanSyncedLyrics(data.syncedLyrics);
          return {
            lyrics: plain,
            plainLyrics: plain,
            syncedLyrics: data.syncedLyrics || null,
            trackName: data.trackName || trackName,
            artistName: data.artistName || artistName,
            source: "LRCLIB"
          };
        }
      }
    } catch (_) {}
  }

  // Attempt 2: Search endpoint with track / combined query
  try {
    const cleanT = cleanSongTitle(trackName || "");
    const cleanA = cleanSongTitle(artistName || "");
    const query = [cleanT, cleanA].filter(Boolean).join(" ");
    if (!query) return null;

    const res = await fetch(`${LRCLIB_BASE}/search?q=${encodeURIComponent(query)}`, { headers });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length > 0) {
        // Pick first item with lyrics
        const match = list.find(x => x.plainLyrics || x.syncedLyrics) || list[0];
        if (match && (match.plainLyrics || match.syncedLyrics)) {
          const plain = match.plainLyrics || cleanSyncedLyrics(match.syncedLyrics);
          return {
            lyrics: plain,
            plainLyrics: plain,
            syncedLyrics: match.syncedLyrics || null,
            trackName: match.trackName || trackName,
            artistName: match.artistName || artistName,
            source: "LRCLIB"
          };
        }
      }
    }
  } catch (_) {}

  return null;
}

/* --------------------------------------------------------------------------
 * Main Lyrics Extraction Pipeline
 * -------------------------------------------------------------------------- */

async function resolveLyrics({ videoId, title, artist, duration }) {
  let ytDetails = null;

  // Step 1: If valid YouTube videoId, try YouTube Music InnerTube
  if (videoId && VIDEO_ID_RE.test(videoId)) {
    try {
      const nextData = await ytmRequest("next", { videoId });
      ytDetails = findTrackInfo(nextData);
      const lyricsBrowseId = findLyricsBrowseId(nextData);

      if (lyricsBrowseId) {
        const lyricsData = await ytmRequest("browse", { browseId: lyricsBrowseId });
        const extracted = extractLyrics(lyricsData);

        if (extracted && extracted.lyrics && extracted.lyrics.trim()) {
          return {
            success: true,
            videoId,
            lyricsBrowseId,
            lyrics: extracted.lyrics,
            plainLyrics: extracted.plainLyrics || extracted.lyrics,
            syncedLyrics: null,
            source: extracted.source || "YouTube Music",
            trackName: ytDetails?.title || title || null,
            artistName: ytDetails?.author || artist || null
          };
        }
      }
    } catch (err) {
      console.warn("YouTube Music lyrics extraction warning:", err);
    }
  }

  // Step 2: Fallback to LRCLIB
  const queryTitle = title || ytDetails?.title || null;
  const queryArtist = artist || ytDetails?.author || null;

  if (queryTitle || queryArtist) {
    const lrclibResult = await getLrclibLyrics(queryTitle, queryArtist, duration);
    if (lrclibResult && lrclibResult.lyrics) {
      return {
        success: true,
        videoId: videoId || null,
        lyrics: lrclibResult.lyrics,
        plainLyrics: lrclibResult.plainLyrics,
        syncedLyrics: lrclibResult.syncedLyrics,
        source: lrclibResult.source,
        trackName: lrclibResult.trackName || queryTitle,
        artistName: lrclibResult.artistName || queryArtist
      };
    }
  }

  // Step 3: No lyrics found in either provider
  return {
    success: false,
    videoId: videoId || null,
    error: "Lyrics not available for this track."
  };
}

/* --------------------------------------------------------------------------
 * Response & CORS Helpers
 * -------------------------------------------------------------------------- */

function jsonResponse(data, status = 200, cacheHours = 0) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key"
  };

  if (cacheHours > 0) {
    headers["Cache-Control"] = `public, max-age=${cacheHours * 3600}, s-maxage=${cacheHours * 3600}`;
  } else {
    headers["Cache-Control"] = "no-store";
  }

  return new Response(JSON.stringify(data), { status, headers });
}

function extractVideoId(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;

  const urlMatch = trimmed.match(/(?:v=|youtu\.be\/|embed\/|music\.youtube\.com\/watch\?v=)([^#&?]{11})/);
  if (urlMatch && VIDEO_ID_RE.test(urlMatch[1])) {
    return urlMatch[1];
  }
  return null;
}

/* --------------------------------------------------------------------------
 * Worker Entrypoint
 * -------------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "trove-lyrics-worker" }, 200);
    }

    // Optional Authentication
    const authSecret = env?.API_KEY || env?.TOKEN || env?.WORKER_TOKEN;
    if (authSecret) {
      const authHeader = request.headers.get("Authorization");
      const apiKeyHeader = request.headers.get("X-API-Key");
      const queryToken =
        url.searchParams.get("token") ||
        url.searchParams.get("key") ||
        url.searchParams.get("apiKey");

      const supplied =
        (authHeader ? authHeader.replace(/^Bearer\s+/i, "") : null) ||
        apiKeyHeader ||
        queryToken;

      if (supplied !== authSecret) {
        return jsonResponse(
          { success: false, error: "Unauthorized. Provide valid Bearer token or ?token= query parameter." },
          401
        );
      }
    }

    let videoId = null;
    let title = null;
    let artist = null;
    let duration = null;

    if (request.method === "POST") {
      try {
        const body = await request.json();
        videoId = extractVideoId(body.videoId || body.id || body.v || body.url);
        title = body.title || body.trackName || body.name || null;
        artist = body.artist || body.artistName || null;
        duration = body.duration || null;
      } catch (_) {
        return jsonResponse({ success: false, error: "Invalid JSON body in POST request." }, 400);
      }
    } else if (request.method === "GET") {
      // Path-style: /lyrics/<id> or /<id>
      if (url.pathname.startsWith("/lyrics/")) {
        videoId = extractVideoId(url.pathname.slice("/lyrics/".length));
      }

      if (!videoId) {
        videoId = extractVideoId(
          url.searchParams.get("videoId") ||
          url.searchParams.get("v") ||
          url.searchParams.get("id") ||
          url.searchParams.get("url")
        );
      }

      title = url.searchParams.get("title") || url.searchParams.get("track") || url.searchParams.get("name") || null;
      artist = url.searchParams.get("artist") || url.searchParams.get("author") || null;
      duration = url.searchParams.get("duration") || null;

      // Single query search ?q=...
      const q = url.searchParams.get("q");
      if (q && !title) {
        title = q;
      }
    } else {
      return jsonResponse({ success: false, error: "Method not allowed. Use GET or POST." }, 405);
    }

    if (!videoId && !title && !artist) {
      return jsonResponse(
        {
          success: false,
          error: "Missing search criteria. Provide videoId (e.g. ?videoId=...) or title/artist (e.g. ?title=...&artist=...)."
        },
        400
      );
    }

    try {
      const result = await resolveLyrics({ videoId, title, artist, duration });
      const cacheHours = result.success ? 24 : 0;
      return jsonResponse(result, result.success ? 200 : 404, cacheHours);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ success: false, error: message }, 502);
    }
  }
};
