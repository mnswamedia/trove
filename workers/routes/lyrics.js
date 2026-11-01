/**
 * Route Handler: Music Lyrics Extractor (/lyrics/*)
 */

import { jsonResponse } from "../common.js";

const YTM_BASE = "https://music.youtube.com/youtubei/v1";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const LRCLIB_BASE = "https://lrclib.net/api";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const VISITOR_ID = "CgtwclpTdlljOTc4VSjGzJzXBjIKCgJTRxIEGgAgaA%3D%3D";

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

function extractLyrics(obj) {
  if (!obj || typeof obj !== "object") return null;

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

  return null;
}

function cleanSyncedLyrics(synced) {
  if (!synced) return "";
  return synced
    .replace(/\[\d{2}:\d{2}(?:\.\d{1,3})?\]\s*/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

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

async function getLrclibLyrics(trackName, artistName, duration = null) {
  if (!trackName && !artistName) return null;

  const headers = {
    "User-Agent": "Trove-Media-Vault/1.0 (https://github.com/mnswa/trove)"
  };

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

  try {
    const cleanT = cleanSongTitle(trackName || "");
    const cleanA = cleanSongTitle(artistName || "");
    const query = [cleanT, cleanA].filter(Boolean).join(" ");
    if (!query) return null;

    const res = await fetch(`${LRCLIB_BASE}/search?q=${encodeURIComponent(query)}`, { headers });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length > 0) {
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

async function resolveLyrics({ videoId, title, artist, duration }) {
  let ytDetails = null;

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

  return {
    success: false,
    videoId: videoId || null,
    error: "Lyrics not available for this track."
  };
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

export async function handleLyrics(request, env, url) {
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

