/**
 * Cloudflare Worker — YouTube Recommendations & Related Content Extractor
 *
 * Endpoints:
 *   GET  /?videoId=ID&token=KEY      → fetch recommendations for videoId (or full YouTube/YTM URL)
 *   GET  /recommendations/ID         → path-style recommendation lookup
 *   GET  /extract?videoId=ID         → alias for query lookup
 *   POST / or /extract               → body: { videoId: "...", pages: 0, includeRaw: false, excludeShorts: false }
 *   GET  /health                     → health check
 *   OPTIONS *                        → CORS preflight
 *
 * Supported Auth (if API_KEY or TOKEN is set in Worker environment):
 *   - Header: Authorization: Bearer <TOKEN>
 *   - Header: X-API-Key: <TOKEN>
 *   - Query:  ?token=<TOKEN> or ?key=<TOKEN> or ?apiKey=<TOKEN>
 *   If no secret is set in Worker environment, requests are publicly allowed.
 *
 * CORS: allows requests from any browser origin (Access-Control-Allow-Origin: *).
 */

const API_URL = "https://www.youtube.com/youtubei/v1/next?prettyPrint=false";
const CLIENT_VERSION = "2.20261001.00.00";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const VISITOR_ID = "CgtwclpTdlljOTc4VSjGzJzXBjIKCgJTRxIEGgAgaA%3D%3D";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const VIDEO_RENDERERS = new Set([
  "videoRenderer",
  "compactVideoRenderer",
  "gridVideoRenderer",
  "playlistVideoRenderer",
  "reelItemRenderer",
  "tileRenderer",
]);

const PLAYLIST_RENDERERS = new Set([
  "playlistRenderer",
  "compactPlaylistRenderer",
  "gridPlaylistRenderer",
  "radioRenderer",
]);

/* --------------------------------------------------------------------------
 * Tree & Node Traversal Helpers
 * -------------------------------------------------------------------------- */

function* walk(value, path = "$", depth = 0) {
  if (depth > 100 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      yield* walk(value[i], `${path}[${i}]`, depth + 1);
    }
    return;
  }
  yield [value, path];
  for (const [key, child] of Object.entries(value)) {
    if (child !== null && typeof child === "object") {
      yield* walk(child, `${path}.${key}`, depth + 1);
    }
  }
}

function getPath(obj, ...keys) {
  for (const key of keys) {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      return undefined;
    }
    obj = obj[key];
  }
  return obj;
}

function asText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.content === "string") return value.content;
  if (typeof value.simpleText === "string") return value.simpleText;
  if (Array.isArray(value.runs)) {
    const result = value.runs
      .filter((x) => x && typeof x.text === "string")
      .map((x) => x.text)
      .join("")
      .trim();
    return result || null;
  }
  return null;
}

function firstText(obj, ...keys) {
  for (const key of keys) {
    const result = asText(obj[key]);
    if (result) return result;
  }
  return null;
}

function getThumbnails(value) {
  const found = new Set();
  for (const [node] of walk(value)) {
    const url = node?.url;
    if (
      typeof url === "string" &&
      (url.includes("ytimg.com") || url.includes("youtube.com") || url.includes("ggpht.com"))
    ) {
      found.add(url);
    }
  }
  return [...found];
}

function pickBestThumbnail(thumbnails, videoId) {
  if (Array.isArray(thumbnails) && thumbnails.length > 0) {
    const hq = thumbnails.find((u) => u.includes("hq720") || u.includes("maxresdefault"));
    if (hq) return hq;
    return thumbnails[thumbnails.length - 1];
  }
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/**
 * Extract YouTube 11-char video ID from either raw ID or any standard URL
 */
function extractVideoId(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;

  try {
    const parsed = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");

    if (host === "youtu.be") {
      const id = parsed.pathname.slice(1).split("/")[0].split("?")[0];
      if (VIDEO_ID_RE.test(id)) return id;
    }

    if (host === "youtube.com" || host === "music.youtube.com") {
      if (parsed.searchParams.has("v")) {
        const id = parsed.searchParams.get("v");
        if (VIDEO_ID_RE.test(id)) return id;
      }
      if (parsed.pathname.startsWith("/shorts/") || parsed.pathname.startsWith("/embed/")) {
        const id = parsed.pathname.split("/")[2]?.split("?")[0];
        if (VIDEO_ID_RE.test(id)) return id;
      }
    }
  } catch (_) {}

  const match = trimmed.match(/(?:youtu\.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=)([^#&?]{11})/);
  if (match && VIDEO_ID_RE.test(match[1])) return match[1];

  return null;
}

/* --------------------------------------------------------------------------
 * Video & Playlist Renderer Parsers
 * -------------------------------------------------------------------------- */

function lockupVideoData(lockup) {
  if (lockup.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return null;
  const videoId = lockup.contentId;
  if (typeof videoId !== "string" || !VIDEO_ID_RE.test(videoId)) return null;

  const metadata = getPath(lockup, "metadata", "lockupMetadataViewModel") ?? {};
  const title = asText(metadata.title);
  const rows =
    getPath(metadata, "metadata", "contentMetadataViewModel", "metadataRows") ?? [];

  let channel = null;
  let view_count = null;
  let published = null;
  let duration = null;

  if (Array.isArray(rows)) {
    for (const row of rows) {
      const parts = row?.metadataParts ?? [];
      for (const part of parts) {
        const text = asText(part?.text);
        if (text) {
          if (!channel) {
            channel = text;
          } else if (text.toLowerCase().includes("view")) {
            view_count = text;
          } else if (text.toLowerCase().includes("ago") || text.toLowerCase().includes("streamed")) {
            published = text;
          }
        }
      }
    }
  }

  // Extract duration from overlays or badges
  for (const [node] of walk(lockup)) {
    if (node?.thumbnailOverlayTimeStatusRenderer?.text) {
      duration = asText(node.thumbnailOverlayTimeStatusRenderer.text);
      if (duration) break;
    }
    if (node?.badgeShapeViewModel?.text) {
      const bText = asText(node.badgeShapeViewModel.text);
      if (bText && /^\d+:\d+(?::\d+)?$/.test(bText)) {
        duration = bText;
        break;
      }
    }
  }

  const image = getPath(lockup, "contentImage", "thumbnailViewModel");
  const thumbs = getThumbnails(image ?? lockup);
  const bestThumb = pickBestThumbnail(thumbs, videoId);

  return {
    id: videoId,
    title,
    channel,
    duration,
    view_count,
    published,
    thumbnail: bestThumb,
    thumbnails: thumbs,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    playlist_id: null,
    renderer: "lockupViewModel",
    is_short: false,
  };
}

function videoData(renderer, rendererName) {
  let videoId = renderer.videoId;
  if (typeof videoId !== "string") {
    videoId = getPath(renderer, "navigationEndpoint", "watchEndpoint", "videoId");
  }
  if (typeof videoId !== "string" || !VIDEO_ID_RE.test(videoId)) return null;

  const endpoint =
    getPath(renderer, "navigationEndpoint", "watchEndpoint") ?? {};

  let duration = firstText(renderer, "lengthText");
  if (!duration && renderer.thumbnailOverlays) {
    for (const [node] of walk(renderer.thumbnailOverlays)) {
      if (node?.thumbnailOverlayTimeStatusRenderer?.text) {
        duration = asText(node.thumbnailOverlayTimeStatusRenderer.text);
        if (duration) break;
      }
    }
  }

  const thumbs = getThumbnails(renderer.thumbnail ?? renderer);
  const bestThumb = pickBestThumbnail(thumbs, videoId);

  return {
    id: videoId,
    title: firstText(renderer, "title", "headline"),
    channel: firstText(
      renderer,
      "ownerText",
      "shortBylineText",
      "longBylineText",
      "authorText",
      "subtitle",
    ),
    duration,
    view_count: firstText(renderer, "viewCountText", "shortViewCountText"),
    published: firstText(renderer, "publishedTimeText"),
    thumbnail: bestThumb,
    thumbnails: thumbs,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    playlist_id: endpoint.playlistId ?? null,
    renderer: rendererName,
    is_short: rendererName === "reelItemRenderer",
  };
}

function playlistData(renderer, rendererName) {
  let playlistId = renderer.playlistId;

  if (typeof playlistId !== "string") {
    playlistId = getPath(
      renderer,
      "navigationEndpoint",
      "watchPlaylistEndpoint",
      "playlistId",
    );
  }

  if (typeof playlistId !== "string") {
    playlistId = getPath(
      renderer,
      "navigationEndpoint",
      "browseEndpoint",
      "browseId",
    );
    if (typeof playlistId === "string" && playlistId.startsWith("VL")) {
      playlistId = playlistId.slice(2);
    }
  }

  if (typeof playlistId !== "string" || !playlistId) return null;

  const thumbs = getThumbnails(renderer);
  return {
    id: playlistId,
    title: firstText(renderer, "title", "headline"),
    channel: firstText(renderer, "shortBylineText", "longBylineText", "ownerText"),
    video_count: firstText(renderer, "videoCountText", "videoCountShortText"),
    thumbnail: thumbs[thumbs.length - 1] ?? null,
    thumbnails: thumbs,
    url: `https://www.youtube.com/playlist?list=${playlistId}`,
    renderer: rendererName,
  };
}

function collect(tree, videos, playlists) {
  for (const [obj] of walk(tree)) {
    const lockup = obj.lockupViewModel;
    if (lockup && typeof lockup === "object") {
      const item = lockupVideoData(lockup);
      if (item) videos.set(item.id, videos.get(item.id) ?? item);
    }

    const shorts = obj.shortsLockupViewModel;
    if (shorts && typeof shorts === "object") {
      const videoId = getPath(
        shorts,
        "onTap",
        "innertubeCommand",
        "reelWatchEndpoint",
        "videoId",
      );
      if (typeof videoId === "string" && VIDEO_ID_RE.test(videoId)) {
        const thumbs = getThumbnails(shorts);
        const item = {
          id: videoId,
          title: asText(getPath(shorts, "overlayMetadata", "primaryText")),
          channel: null,
          duration: null,
          view_count: asText(getPath(shorts, "overlayMetadata", "secondaryText")),
          published: null,
          thumbnail: pickBestThumbnail(thumbs, videoId),
          thumbnails: thumbs,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          playlist_id: null,
          renderer: "shortsLockupViewModel",
          is_short: true,
        };
        if (!videos.has(videoId)) videos.set(videoId, item);
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;

      if (VIDEO_RENDERERS.has(key)) {
        const item = videoData(value, key);
        if (item && !videos.has(item.id)) videos.set(item.id, item);
      } else if (PLAYLIST_RENDERERS.has(key)) {
        const item = playlistData(value, key);
        if (item && !playlists.has(item.id)) playlists.set(item.id, item);
      }
    }
  }
}

function extractContinuations(tree, source) {
  const found = new Map();

  for (const [obj, path] of walk(tree)) {
    let token = getPath(
      obj,
      "continuationItemRenderer",
      "continuationEndpoint",
      "continuationCommand",
      "token",
    );

    if (!token) {
      token = getPath(
        obj,
        "button",
        "buttonRenderer",
        "command",
        "continuationCommand",
        "token",
      );
    }
    if (!token) {
      token = getPath(obj, "continuationEndpoint", "continuationCommand", "token");
    }
    if (!token) token = getPath(obj, "nextContinuationData", "continuation");
    if (!token) token = getPath(obj, "reloadContinuationData", "continuation");

    if (typeof token === "string" && token && !found.has(token)) {
      found.set(token, { token, source, path });
    }
  }

  return [...found.values()];
}

function recommendationRoots(response) {
  const twoCol = getPath(response, "contents", "twoColumnWatchNextResults");
  const roots = [];

  const secondary =
    twoCol && typeof twoCol === "object" ? twoCol.secondaryResults : null;

  if (secondary && typeof secondary === "object") {
    roots.push(["secondaryResults", secondary]);

    const secondaryVideos = secondary.secondaryVideoResults;
    if (secondaryVideos && typeof secondaryVideos === "object") {
      roots.push(["secondaryVideoResults", secondaryVideos]);
    }

    if (Array.isArray(secondary.results)) {
      roots.push(["secondaryResults.results", secondary.results]);
    }
  }

  const autoplay = twoCol && typeof twoCol === "object" ? twoCol.autoplay : null;
  if (autoplay) roots.push(["autoplay", autoplay]);

  if (roots.length === 0) roots.push(["full_response_fallback", response]);

  return roots;
}

function continuationItems(response) {
  for (const [obj] of walk(response)) {
    for (const actionName of [
      "appendContinuationItemsAction",
      "reloadContinuationItemsCommand",
    ]) {
      const action = obj[actionName];
      if (action && Array.isArray(action.continuationItems)) {
        return action.continuationItems;
      }
    }
  }

  for (const [obj] of walk(response)) {
    const grid = obj.gridContinuation;
    if (grid && Array.isArray(grid.items)) return grid.items;
  }

  return response;
}

function clientContext() {
  return {
    client: {
      clientName: "WEB",
      clientVersion: CLIENT_VERSION,
      hl: "en",
      gl: "IN",
      visitorData: VISITOR_ID,
    },
  };
}

/* --------------------------------------------------------------------------
 * YouTube InnerTube Network Request (with retry & session persistence)
 * -------------------------------------------------------------------------- */

async function postInnerTube(payload, retries = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://www.youtube.com",
        "Referer": "https://www.youtube.com/",
        "User-Agent": USER_AGENT,
        "X-Goog-Visitor-Id": VISITOR_ID,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 800));
      return postInnerTube(payload, retries - 1);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Network error: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();

  if (!response.ok) {
    if (retries > 0 && response.status >= 500) {
      await new Promise((r) => setTimeout(r, 800));
      return postInnerTube(payload, retries - 1);
    }
    throw new Error(`HTTP ${response.status}: ${raw.slice(0, 1200)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Non-JSON response: ${raw.slice(0, 500)}`);
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Unexpected JSON response type");
  }
  if (data.error) throw new Error(JSON.stringify(data.error));

  return data;
}

/* --------------------------------------------------------------------------
 * Main Extractor Pipeline
 * -------------------------------------------------------------------------- */

async function runExtractor(videoId, pages, includeRaw, options = {}) {
  const videos = new Map();
  const playlists = new Map();
  const continuations = [];
  const seenTokens = new Set();
  const debug = {};

  const initial = await postInnerTube({
    context: clientContext(),
    videoId,
  });

  if (includeRaw) debug.initial = initial;

  const roots = recommendationRoots(initial);

  for (const [name, root] of roots) {
    collect(root, videos, playlists);
    for (const info of extractContinuations(root, name)) {
      if (!seenTokens.has(info.token)) {
        seenTokens.add(info.token);
        continuations.push(info);
      }
    }
  }

  if (videos.size === 0 && playlists.size === 0) {
    collect(initial, videos, playlists);
    for (const info of extractContinuations(initial, "full_response_fallback")) {
      if (!seenTokens.has(info.token)) {
        seenTokens.add(info.token);
        continuations.push(info);
      }
    }
  }

  const queue = continuations.map((x) => x.token);
  let pagesFetched = 0;

  while (queue.length > 0 && pagesFetched < pages) {
    const token = queue.shift();
    const pageNumber = pagesFetched + 1;

    try {
      const page = await postInnerTube({
        context: clientContext(),
        continuation: token,
      });

      if (includeRaw) debug[`continuation_${pageNumber}`] = page;

      const items = continuationItems(page);
      collect(items, videos, playlists);

      const newTokens = extractContinuations(items, `continuation_${pageNumber}`);
      for (const info of newTokens) {
        if (!seenTokens.has(info.token)) {
          seenTokens.add(info.token);
          continuations.push(info);
          queue.push(info.token);
        }
      }
    } catch (pageErr) {
      // Continue with what we collected so far if a single continuation fails
      console.warn(`Continuation page ${pageNumber} failed:`, pageErr);
      break;
    }

    pagesFetched++;
  }

  let videoList = [...videos.values()];
  if (options.excludeShorts) {
    videoList = videoList.filter((v) => !v.is_short);
  }

  const result = {
    success: true,
    source: {
      video_id: videoId,
      watch_url: `https://www.youtube.com/watch?v=${videoId}`,
      endpoint: API_URL,
      client: "WEB",
      authenticated: false,
      client_version: CLIENT_VERSION,
      continuation_pages_fetched: pagesFetched,
    },
    summary: {
      video_count: videoList.length,
      playlist_count: playlists.size,
      continuation_count: continuations.length,
    },
    videos: videoList,
    playlists: [...playlists.values()],
    continuations,
    diagnostics: {
      recommendation_roots_found: roots.map(([name]) => name),
      initial_response_top_level_keys: Object.keys(initial),
      note:
        "If counts are zero, YouTube may not return watch-page recommendations for this video.",
    },
  };

  if (includeRaw) result.raw = debug;

  return result;
}

/* --------------------------------------------------------------------------
 * HTTP & Authentication Helpers
 * -------------------------------------------------------------------------- */

function jsonResponse(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function isAuthorized(request, env, url) {
  const secret = env?.API_KEY || env?.TOKEN || env?.AUTH_TOKEN;
  if (!secret) return true; // Open when no secret is configured

  // 1. Authorization: Bearer <secret>
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && (parts[0] === "Bearer" || parts[0] === "Token")) {
      if (parts[1] === secret) return true;
    }
    if (authHeader === secret) return true;
  }

  // 2. X-API-Key header
  const apiKeyHeader = request.headers.get("X-API-Key") || request.headers.get("x-api-key");
  if (apiKeyHeader === secret) return true;

  // 3. Query string token (?token=... or ?key=... or ?apiKey=...)
  const queryToken =
    url.searchParams.get("token") ||
    url.searchParams.get("key") ||
    url.searchParams.get("apiKey");
  if (queryToken === secret) return true;

  return false;
}

/* --------------------------------------------------------------------------
 * Cloudflare Worker Export
 * -------------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(
        { ok: true, service: "youtube-recommendations-extractor" },
        200,
        { ...corsHeaders, "Cache-Control": "no-store" },
      );
    }

    // Authenticate
    if (!isAuthorized(request, env, url)) {
      return jsonResponse(
        { success: false, error: "Unauthorized" },
        401,
        { ...corsHeaders, "Cache-Control": "no-store" },
      );
    }

    let rawInput = null;
    let pages = 0;
    let includeRaw = false;
    let excludeShorts = false;

    if (request.method === "GET") {
      // Support /?videoId=..., /?v=..., /?url=..., /recommendations/:id, /extract?videoId=...
      rawInput =
        url.searchParams.get("videoId") ||
        url.searchParams.get("video_id") ||
        url.searchParams.get("v") ||
        url.searchParams.get("url");

      if (!rawInput && url.pathname.startsWith("/recommendations/")) {
        rawInput = url.pathname.slice("/recommendations/".length);
      }

      pages = parseInt(url.searchParams.get("pages") || "0", 10);
      includeRaw = url.searchParams.get("includeRaw") === "true";
      excludeShorts = url.searchParams.get("excludeShorts") === "true";
    } else if (request.method === "POST") {
      if (
        url.pathname !== "/" &&
        url.pathname !== "/extract" &&
        url.pathname !== "/recommendations"
      ) {
        return jsonResponse(
          { success: false, error: "Use POST /extract, GET /?videoId=..., or GET /health" },
          404,
          { ...corsHeaders, "Cache-Control": "no-store" },
        );
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(
          { success: false, error: "Request body must be valid JSON" },
          400,
          { ...corsHeaders, "Cache-Control": "no-store" },
        );
      }

      rawInput = body?.videoId ?? body?.video_id ?? body?.v ?? body?.url;
      pages = body?.pages ?? 0;
      includeRaw = body?.includeRaw === true;
      excludeShorts = body?.excludeShorts === true;
    } else {
      return jsonResponse(
        { success: false, error: "Method not allowed. Use GET or POST." },
        405,
        { ...corsHeaders, "Cache-Control": "no-store" },
      );
    }

    const videoId = extractVideoId(rawInput);
    if (!videoId) {
      return jsonResponse(
        {
          success: false,
          error: "Valid 11-character videoId or YouTube URL is required (e.g. ?videoId=dQw4w9WgXcQ or /recommendations/dQw4w9WgXcQ)",
        },
        400,
        { ...corsHeaders, "Cache-Control": "no-store" },
      );
    }

    if (!Number.isInteger(pages) || pages < 0 || pages > 5) {
      return jsonResponse(
        { success: false, error: "pages must be an integer between 0 and 5" },
        400,
        { ...corsHeaders, "Cache-Control": "no-store" },
      );
    }

    try {
      const result = await runExtractor(videoId, pages, includeRaw, { excludeShorts });
      
      // Cache successful GET queries on CDN edge (1 hour) & browser (15 mins) unless nocache requested
      const isFresh = url.searchParams.get("nocache") === "1" || url.searchParams.get("fresh") === "1";
      const cacheControl = (request.method === "GET" && !isFresh)
        ? "public, max-age=900, s-maxage=3600, stale-while-revalidate=86400"
        : "no-store";

      return jsonResponse(result, 200, {
        ...corsHeaders,
        "Cache-Control": cacheControl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        502,
        { ...corsHeaders, "Cache-Control": "no-store" },
      );
    }
  },
};
