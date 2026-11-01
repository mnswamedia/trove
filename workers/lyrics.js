/**
 * Cloudflare Worker — YouTube Music lyrics extractor
 *
 * Endpoints:
 *   GET  /?videoId=VIDEO_ID          → fetch lyrics for that video
 *   GET  /lyrics/VIDEO_ID            → same, path-style
 *   GET  /health                     → health check
 *   OPTIONS *                        → CORS preflight
 *
 * Response shape (success):
 *   { success: true, videoId, lyricsBrowseId, lyrics, source }
 *
 * Response shape (no lyrics / error):
 *   { success: false, videoId, error, [lyricsBrowseId], [raw] }
 *
 * Optional Worker secret:
 *   API_KEY   If set, require Authorization: Bearer <API_KEY>
 */

const YTM_BASE = "https://music.youtube.com/youtubei/v1";

const YTM_CONTEXT = {
  client: {
    clientName: "WEB_REMIX",
    clientVersion: "1.20260327.10.00",
    hl: "en",
    gl: "US",
  },
};

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const REQUEST_TIMEOUT_MS = 15_000;

/* --------------------------------------------------------------------------
 * HTTP helper
 * -------------------------------------------------------------------------- */
async function ytmRequest(endpoint, payload, retries = 2) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${YTM_BASE}/${endpoint}?prettyPrint=false`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://music.youtube.com",
        "Referer": "https://music.youtube.com/",
        // Adding a realistic User-Agent helps bypass bot detection
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        // Adding visitorData makes YouTube think it's a real user session
        "X-Goog-Visitor-Id": "CgtwclpTdlljOTc4VSjGzJzXBjIKCgJTRxIEGgAgaA%3D%3D"
      },
      body: JSON.stringify({ 
        context: {
          client: {
            clientName: "WEB_REMIX",
            clientVersion: "1.20260327.10.00",
            hl: "en",
            gl: "IN", // Changed to IN since your lyrics were in Hindi
            visitorData: "CgtwclpTdlljOTc4VSjGzJzXBjIKCgJTRxIEGgAgaA%3D%3D"
          }
        }, 
        ...payload 
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`YouTube returned HTTP ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    if (retries > 0) {
      // Wait 1 second and try again if it failed
      await new Promise(resolve => setTimeout(resolve, 1000));
      return ytmRequest(endpoint, payload, retries - 1);
    }
    throw err;
  }
}

/* --------------------------------------------------------------------------
 * Tree helpers
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

// Extract lyrics from a musicDescriptionShelfRenderer.
function extractLyrics(obj) {
  if (!obj || typeof obj !== "object") return null;

  // Case 1 — YouTube explicitly says there are no lyrics.
  if (obj.messageRenderer) {
    const mr = obj.messageRenderer;
    const text =
      mr.text?.runs?.map((r) => r.text || "").join("") ||
      mr.text?.simpleText ||
      "";
    const subtext =
      mr.subtext?.messageSubtextRenderer?.text?.runs
        ?.map((r) => r.text || "")
        .join("") || null;
    return { lyrics: null, message: text || "Lyrics not available", subtext };
  }

  // Case 2 — actual lyrics.
  if (obj.musicDescriptionShelfRenderer) {
    const renderer = obj.musicDescriptionShelfRenderer;
    const description = renderer.description;

    if (description?.runs && Array.isArray(description.runs)) {
      return {
        lyrics: description.runs.map((r) => r.text || "").join(""),
        source:
          renderer.footer?.runs?.map((r) => r.text || "").join("") || null,
      };
    }
    if (description?.simpleText) {
      return {
        lyrics: description.simpleText,
        source:
          renderer.footer?.runs?.map((r) => r.text || "").join("") || null,
      };
    }
  }

  for (const value of Object.values(obj)) {
    const result = extractLyrics(value);
    if (result) return result;
  }
  return null;
}

/* --------------------------------------------------------------------------
 * Main extraction logic
 * -------------------------------------------------------------------------- */

async function getYouTubeLyrics(videoId) {
  if (!VIDEO_ID_RE.test(videoId)) {
    throw Object.assign(new Error("Invalid YouTube video ID"), { status: 400 });
  }

  // Step 1 — get the lyrics browse ID from the watch-next response.
  const nextData = await ytmRequest("next", { videoId });
  const lyricsBrowseId = findLyricsBrowseId(nextData);

  if (!lyricsBrowseId) {
    return {
      success: false,
      videoId,
      error: "No lyrics available for this video",
    };
  }

  // Step 2 — fetch the lyrics using the browse ID.
  const lyricsData = await ytmRequest("browse", { browseId: lyricsBrowseId });
  const result = extractLyrics(lyricsData);

  // Truly unparseable — neither lyrics nor a message.
  if (!result) {
    return {
      success: false,
      videoId,
      lyricsBrowseId,
      error: "Could not parse lyrics response",
    };
  }

  // YouTube's explicit "no lyrics" response.
  if (!result.lyrics || !result.lyrics.trim()) {
    return {
      success: false,
      videoId,
      lyricsBrowseId,
      error: result.message || "Lyrics not available for this video",
      subtext: result.subtext || null,
    };
  }

  // Real lyrics.
  return {
    success: true,
    videoId,
    lyricsBrowseId,
    lyrics: result.lyrics,
    source: result.source,
  };
}

/* --------------------------------------------------------------------------
 * Response helpers
 * -------------------------------------------------------------------------- */

function jsonResponse(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

/* --------------------------------------------------------------------------
 * Worker entrypoint
 * -------------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const cors = corsHeaders();

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(
        { ok: true, service: "ytmusic-lyrics-extractor" },
        200,
        cors,
      );
    }

    if (request.method !== "GET") {
      return jsonResponse(
        { success: false, error: "Method not allowed. Use GET." },
        405,
        cors,
      );
    }

    // Optional authentication.
    if (env && env.API_KEY) {
      const supplied = request.headers.get("Authorization");
      if (supplied !== `Bearer ${env.API_KEY}`) {
        return jsonResponse(
          { success: false, error: "Unauthorized" },
          401,
          cors,
        );
      }
    }

    // Extract videoId from either ?videoId=… or /lyrics/<id>.
    let videoId = url.searchParams.get("videoId");

    if (!videoId && url.pathname.startsWith("/lyrics/")) {
      videoId = url.pathname.slice("/lyrics/".length);
    }

    if (!videoId) {
      return jsonResponse(
        {
          success: false,
          error:
            "Missing videoId. Use /?videoId=VIDEO_ID or /lyrics/VIDEO_ID",
        },
        400,
        cors,
      );
    }

    videoId = videoId.trim();

    if (!VIDEO_ID_RE.test(videoId)) {
      return jsonResponse(
        {
          success: false,
          videoId,
          error: "videoId must be an 11-character YouTube video ID",
        },
        400,
        cors,
      );
    }

    try {
      const result = await getYouTubeLyrics(videoId);
      return jsonResponse(result, 200, cors);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err?.status === 400 ? 400 : 502;
      return jsonResponse({ success: false, videoId, error: message }, status, cors);
    }
  },
};