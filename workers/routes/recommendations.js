/**
 * Route Handler: YouTube Recommendations Extractor (/recommendations/*)
 */

import { jsonResponse } from "../common.js";

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
    if (Array.isArray(node.thumbnails)) {
      for (const t of node.thumbnails) {
        if (t && typeof t.url === "string") found.add(t.url);
      }
    }
    if (typeof node.url === "string" && node.url.includes("ytimg.com/")) {
      found.add(node.url);
    }
  }
  return Array.from(found);
}

function isShorts(node) {
  for (const [sub] of walk(node)) {
    for (const key of ["url", "webPageType", "iconType"]) {
      if (typeof sub[key] === "string" && sub[key].toLowerCase().includes("shorts")) {
        return true;
      }
    }
  }
  return false;
}

function normalizeVideo(node, rendererName) {
  const videoId =
    node.videoId ??
    getPath(node, "navigationEndpoint", "watchEndpoint", "videoId") ??
    getPath(node, "onTap", "innertubeCommand", "watchEndpoint", "videoId");

  if (!videoId || typeof videoId !== "string" || !VIDEO_ID_RE.test(videoId)) {
    return null;
  }

  const title =
    firstText(node, "title", "headline") ??
    firstText(getPath(node, "title") ?? {}, "runs", "simpleText");

  const channel =
    firstText(
      node,
      "ownerText",
      "shortBylineText",
      "longBylineText",
      "subtitle",
    ) ?? getPath(node, "channelTitle");

  const views = firstText(node, "viewCountText", "shortViewCountText");
  const duration = firstText(
    node,
    "lengthText",
    "thumbnailOverlays",
    "durationText",
  );
  const published = firstText(node, "publishedTimeText");
  const thumbs = getThumbnails(node);

  return {
    type: "video",
    id: videoId,
    title: title ?? null,
    channel: channel ?? null,
    view_count: views ?? null,
    duration: duration ?? null,
    published: published ?? null,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnails: thumbs,
    best_thumbnail: thumbs[thumbs.length - 1] ?? null,
    renderer: rendererName,
    is_short: isShorts(node),
  };
}

function normalizePlaylist(node, rendererName) {
  const playlistId =
    node.playlistId ??
    getPath(node, "navigationEndpoint", "watchEndpoint", "playlistId");

  if (!playlistId || typeof playlistId !== "string") return null;

  const title = firstText(node, "title", "headline");
  const channel = firstText(node, "longBylineText", "shortBylineText");
  const videoCount = firstText(node, "videoCountText", "videoCountShortText");
  const thumbs = getThumbnails(node);

  return {
    type: "playlist",
    id: playlistId,
    title: title ?? null,
    channel: channel ?? null,
    video_count: videoCount ?? null,
    url: `https://www.youtube.com/playlist?list=${playlistId}`,
    thumbnails: thumbs,
    best_thumbnail: thumbs[thumbs.length - 1] ?? null,
    renderer: rendererName,
  };
}

function parseRecommendations(data) {
  const seenIds = new Set();
  const videos = [];
  const playlists = [];

  for (const [node] of walk(data)) {
    for (const [key, val] of Object.entries(node)) {
      if (val === null || typeof val !== "object") continue;

      if (VIDEO_RENDERERS.has(key)) {
        const item = normalizeVideo(val, key);
        if (item && !seenIds.has(item.id)) {
          seenIds.add(item.id);
          videos.push(item);
        }
      } else if (PLAYLIST_RENDERERS.has(key)) {
        const item = normalizePlaylist(val, key);
        if (item && !seenIds.has(item.id)) {
          seenIds.add(item.id);
          playlists.push(item);
        }
      }
    }
  }

  return { videos, playlists };
}

function findContinuation(data) {
  for (const [node] of walk(data)) {
    if (node.continuationCommand && typeof node.continuationCommand.token === "string") {
      return node.continuationCommand.token;
    }
    if (typeof node.continuation === "string") {
      return node.continuation;
    }
  }
  return null;
}

async function fetchNext(payload, retries = 2) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://www.youtube.com",
        Referer: "https://www.youtube.com/",
        "User-Agent": USER_AGENT,
        "X-Goog-Visitor-Id": VISITOR_ID,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`YouTube returned status ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 800));
      return fetchNext(payload, retries - 1);
    }
    throw err;
  }
}

async function runExtractor(videoId, pages = 0, includeRaw = false, options = {}) {
  const basePayload = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: CLIENT_VERSION,
        hl: "en",
        gl: "US",
        visitorData: VISITOR_ID,
      },
    },
    videoId,
  };

  const initial = await fetchNext(basePayload);
  const { videos, playlists } = parseRecommendations(initial);
  let continuation = findContinuation(initial);
  const rawPages = includeRaw ? [initial] : [];

  for (let page = 0; page < pages && continuation; page++) {
    try {
      const pageData = await fetchNext({
        context: basePayload.context,
        continuation,
      });
      if (includeRaw) rawPages.push(pageData);

      const parsed = parseRecommendations(pageData);
      const existingIds = new Set(videos.map((v) => v.id));
      for (const v of parsed.videos) {
        if (!existingIds.has(v.id)) {
          existingIds.add(v.id);
          videos.push(v);
        }
      }
      continuation = findContinuation(pageData);
    } catch {
      break;
    }
  }

  const finalVideos = options.excludeShorts ? videos.filter((v) => !v.is_short) : videos;

  return {
    success: true,
    videoId,
    video_count: finalVideos.length,
    playlist_count: playlists.length,
    videos: finalVideos,
    playlists,
    continuation_token: continuation,
    ...(includeRaw ? { raw: rawPages } : {}),
  };
}

function extractVideoId(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;

  const patterns = [
    /(?:v=|v\/|embed\/|youtu\.be\/|shorts\/|\/watch\?v=)([^#&?]{11})/,
    /^[A-Za-z0-9_-]{11}$/,
  ];
  for (const pat of patterns) {
    const m = trimmed.match(pat);
    if (m && m[1] && VIDEO_ID_RE.test(m[1])) return m[1];
  }
  return null;
}

export async function handleRecommendations(request, env, url) {
  let rawInput = null;
  let pages = 0;
  let includeRaw = false;
  let excludeShorts = false;

  if (request.method === "GET") {
    rawInput =
      url.searchParams.get("videoId") ||
      url.searchParams.get("video_id") ||
      url.searchParams.get("v") ||
      url.searchParams.get("url");

    if (!rawInput && url.pathname.includes("/recommendations/")) {
      rawInput = url.pathname.split("/recommendations/")[1];
    }

    pages = parseInt(url.searchParams.get("pages") || "0", 10);
    includeRaw = url.searchParams.get("includeRaw") === "true";
    excludeShorts = url.searchParams.get("excludeShorts") === "true";
  } else if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ success: false, error: "Request body must be valid JSON" }, 400);
    }

    rawInput = body?.videoId ?? body?.video_id ?? body?.v ?? body?.url;
    pages = body?.pages ?? 0;
    includeRaw = body?.includeRaw === true;
    excludeShorts = body?.excludeShorts === true;
  } else {
    return jsonResponse({ success: false, error: "Method not allowed. Use GET or POST." }, 405);
  }

  const videoId = extractVideoId(rawInput);
  if (!videoId) {
    return jsonResponse(
      {
        success: false,
        error: "Valid 11-character videoId or YouTube URL is required (e.g. ?videoId=dQw4w9WgXcQ)",
      },
      400
    );
  }

  try {
    const result = await runExtractor(videoId, pages, includeRaw, { excludeShorts });
    const isFresh = url.searchParams.get("nocache") === "1" || url.searchParams.get("fresh") === "1";
    const cacheControl = (request.method === "GET" && !isFresh)
      ? "public, max-age=900, s-maxage=3600, stale-while-revalidate=86400"
      : "no-store";

    return jsonResponse(result, 200, cacheControl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ success: false, error: message }, 502);
  }
}

