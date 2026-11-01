/**
 * Route Handler: YouTube Recommendations Extractor (/recommendations/*)
 * Supports modern InnerTube `lockupViewModel`, `shortsLockupViewModel`, and legacy renderers.
 */

import { jsonResponse } from "../common.js";

const API_URL = "https://www.youtube.com/youtubei/v1/next?prettyPrint=false";
const CLIENT_VERSION = "2.20261001.00.00";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const VISITOR_ID = "CgtwclpTdlljOTc4VSjGzJzXBjIKCgJTRxIEGgAgaA%3D%3D";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const KNOWN_GENRES = new Set([
  "acoustic", "ambient", "blues", "classical", "country", "electronic", "folk",
  "hip hop", "house", "indie", "instrumental", "jazz", "latin", "lofi", "lo-fi",
  "metal", "orchestral", "piano", "pop", "punk", "r&b", "reggae", "rock", "sitar",
  "soul", "synthwave", "techno", "trap", "vocal", "chill", "meditation", "healing",
  "live", "remix", "cover", "unplugged", "soundtrack", "ost", "devotional"
]);

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
  if (!obj || typeof obj !== "object") return null;
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
    if (typeof node.url === "string" && (node.url.includes("ytimg.com/") || node.url.includes("ggpht.com/"))) {
      found.add(node.url);
    }
  }
  return Array.from(found);
}

function isShorts(node) {
  for (const [sub] of walk(node)) {
    for (const key of ["url", "webPageType", "iconType", "contentType"]) {
      if (typeof sub[key] === "string" && sub[key].toLowerCase().includes("short")) {
        return true;
      }
    }
  }
  return false;
}

function parseDurationSeconds(durationStr) {
  if (!durationStr || typeof durationStr !== "string") return null;
  const parts = durationStr.trim().split(":").map((p) => parseInt(p, 10));
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function extractVideoTags(title, badges = []) {
  const tags = new Set();

  for (const b of badges) {
    if (b && typeof b === "string" && b.length <= 20) {
      const cleanBadge = b.trim();
      if (!/^\d+:\d+$/.test(cleanBadge) && !cleanBadge.toLowerCase().includes("now playing")) {
        tags.add(cleanBadge);
      }
    }
  }

  if (typeof title === "string") {
    const hashMatches = title.match(/#([a-zA-Z0-9_-]+)/g);
    if (hashMatches) {
      for (const h of hashMatches) {
        tags.add(h.slice(1));
      }
    }

    const bracketMatches = title.match(/[(\[{]([^)\]}]+)[)\]}]/g);
    if (bracketMatches) {
      for (const m of bracketMatches) {
        const inner = m.slice(1, -1).trim();
        if (inner.length >= 3 && inner.length <= 22 && !/^\d+$/.test(inner)) {
          if (!inner.toLowerCase().startsWith("feat") && !inner.toLowerCase().startsWith("ft")) {
            tags.add(inner);
          }
        }
      }
    }

    const lower = title.toLowerCase();
    for (const genre of KNOWN_GENRES) {
      const regex = new RegExp(`\\b${genre}\\b`, "i");
      if (regex.test(lower)) {
        const formatted = genre.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
        tags.add(formatted);
      }
    }
  }

  return Array.from(tags).slice(0, 3);
}

/* --------------------------------------------------------------------------
 * Card Parsers: Lockup, Shorts & Legacy Renderers
 * -------------------------------------------------------------------------- */

function extractLockupVideo(lockup, seedVideoId) {
  if (!lockup || typeof lockup !== "object") return null;

  let videoId = lockup.contentId;
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    videoId = getPath(lockup, "rendererContext", "commandContext", "onTap", "innertubeCommand", "watchEndpoint", "videoId");
  }
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    videoId = getPath(lockup, "contentImage", "thumbnailViewModel", "overlays", 0, "thumbnailBottomOverlayViewModel", "badges", 0, "thumbnailBadgeViewModel", "animationActivationTargetId");
  }

  if (!videoId || !VIDEO_ID_RE.test(videoId) || videoId === seedVideoId) {
    return null;
  }

  const title = getPath(lockup, "metadata", "lockupMetadataViewModel", "title", "content") ||
    firstText(lockup.metadata?.lockupMetadataViewModel?.title) ||
    "Untitled Track";

  const metaRows = getPath(lockup, "metadata", "lockupMetadataViewModel", "metadata", "contentMetadataViewModel", "metadataRows") || [];
  let channel = null;
  let views = null;
  let published = null;
  const badges = [];

  for (const row of metaRows) {
    const parts = row.metadataParts || [];
    for (const p of parts) {
      const txt = p?.text?.content || "";
      const a11y = p?.accessibilityLabel || "";
      if (!txt && !a11y) continue;

      if (!channel && txt) {
        channel = txt;
        const attach = p?.text?.attachmentRuns || [];
        for (const at of attach) {
          const imgName = at?.element?.type?.imageType?.image?.sources?.[0]?.clientResource?.imageName;
          if (imgName === "AUDIO_BADGE") badges.push("Music");
        }
      } else if (a11y && a11y.toLowerCase().includes("view")) {
        views = a11y;
      } else if (txt.toLowerCase().includes("view") || p?.leadingIcon?.name === "PLAY_ARROW_OUTLINED") {
        views = txt.includes("view") ? txt : `${txt} views`;
      } else if (txt.toLowerCase().includes("ago") || a11y.toLowerCase().includes("ago") || txt.toLowerCase().includes("streamed")) {
        published = a11y || txt;
      }
    }
  }

  const tvm = getPath(lockup, "contentImage", "thumbnailViewModel") || {};
  let duration = null;
  const overlays = tvm.overlays || [];
  for (const ov of overlays) {
    const bList = ov?.thumbnailBottomOverlayViewModel?.badges || [];
    for (const b of bList) {
      const dur = b?.thumbnailBadgeViewModel?.text;
      if (dur && /^\d+:\d+(:\d+)?$/.test(dur.trim())) {
        duration = dur.trim();
        break;
      }
      const icon = b?.thumbnailBadgeViewModel?.icon?.sources?.[0]?.clientResource?.imageName;
      if (icon === "MUSIC") badges.push("Music");
    }
    if (duration) break;
  }

  if (!duration) {
    for (const [node] of walk(overlays)) {
      if (typeof node?.text === "string" && /^\d+:\d+(:\d+)?$/.test(node.text.trim())) {
        duration = node.text.trim();
        break;
      }
    }
  }

  const sources = tvm.image?.sources || [];
  const thumbs = sources.map((s) => s.url).filter(Boolean);
  const bestThumbnail = thumbs[thumbs.length - 1] || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const isShort = lockup.contentType === "LOCKUP_CONTENT_TYPE_SHORTS" || isShorts(lockup);
  const videoTags = extractVideoTags(title, badges);

  return {
    type: "video",
    id: videoId,
    title,
    channel: channel || "YouTube",
    duration: duration || null,
    duration_seconds: parseDurationSeconds(duration),
    views: views || null,
    published: published || null,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnails: thumbs.length > 0 ? thumbs : [bestThumbnail],
    thumbnail: bestThumbnail,
    best_thumbnail: bestThumbnail,
    tags: videoTags,
    is_short: isShort,
  };
}

function extractLegacyVideo(renderer, rendererName, seedVideoId) {
  let videoId = renderer.videoId;
  if (!videoId || typeof videoId !== "string") {
    videoId = getPath(renderer, "navigationEndpoint", "watchEndpoint", "videoId");
  }
  if (!videoId || !VIDEO_ID_RE.test(videoId) || videoId === seedVideoId) return null;

  const title = firstText(renderer, "title", "headline") || "Untitled Track";
  const channel = firstText(renderer, "shortBylineText", "longBylineText", "ownerText") || "YouTube";
  let duration = firstText(renderer, "lengthText");

  if (!duration && renderer.thumbnailOverlays) {
    for (const [node] of walk(renderer.thumbnailOverlays)) {
      if (node?.thumbnailOverlayTimeStatusRenderer?.text) {
        duration = asText(node.thumbnailOverlayTimeStatusRenderer.text);
        if (duration) break;
      }
      if (typeof node?.text === "string" && /^\d+:\d+/.test(node.text.trim())) {
        duration = node.text.trim();
        break;
      }
    }
  }

  const views = firstText(renderer, "viewCountText", "shortViewCountText");
  const published = firstText(renderer, "publishedTimeText");
  const thumbs = getThumbnails(renderer);
  const bestThumbnail = thumbs[thumbs.length - 1] || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const isShort = isShorts(renderer);
  const videoTags = extractVideoTags(title);

  return {
    type: "video",
    id: videoId,
    title,
    channel,
    duration: duration || null,
    duration_seconds: parseDurationSeconds(duration),
    views: views || null,
    published: published || null,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnails: thumbs.length > 0 ? thumbs : [bestThumbnail],
    thumbnail: bestThumbnail,
    best_thumbnail: bestThumbnail,
    tags: videoTags,
    is_short: isShort,
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
    thumbnail: thumbs[thumbs.length - 1] ?? null,
    best_thumbnail: thumbs[thumbs.length - 1] ?? null,
    renderer: rendererName,
  };
}

/* --------------------------------------------------------------------------
 * Main Recommendations Parser
 * -------------------------------------------------------------------------- */

function parseRecommendations(data, seedVideoId) {
  const seenIds = new Set();
  const videos = [];
  const playlists = [];
  const globalTags = new Map();

  // Specifically scope to secondaryResults (the recommendation sidebar)
  const sec =
    getPath(data, "contents", "twoColumnWatchNextResults", "secondaryResults", "secondaryResults", "results") ||
    getPath(data, "contents", "twoColumnWatchNextResults", "secondaryResults", "results") ||
    [];

  // Look for continuation items in onResponseReceivedEndpoints
  const contItems = [];
  const eps = data?.onResponseReceivedEndpoints || [];
  for (const ep of eps) {
    const items = ep?.appendContinuationItemsAction?.continuationItems ||
      ep?.reloadContinuationItemsCommand?.continuationItems || [];
    for (const it of items) contItems.push(it);
  }

  const itemsToParse = sec.length > 0 ? sec : (contItems.length > 0 ? contItems : (Array.isArray(data) ? data : [data]));

  for (const item of itemsToParse) {
    if (!item || typeof item !== "object") continue;

    // 1. Modern lockupViewModel
    if (item.lockupViewModel) {
      const v = extractLockupVideo(item.lockupViewModel, seedVideoId);
      if (v && !seenIds.has(v.id)) {
        seenIds.add(v.id);
        videos.push(v);
        v.tags.forEach((t) => globalTags.set(t, (globalTags.get(t) || 0) + 1));
      }
      continue;
    }

    // 2. Legacy renderers inside item
    for (const [key, val] of Object.entries(item)) {
      if (val === null || typeof val !== "object") continue;

      if (VIDEO_RENDERERS.has(key)) {
        const v = extractLegacyVideo(val, key, seedVideoId);
        if (v && !seenIds.has(v.id)) {
          seenIds.add(v.id);
          videos.push(v);
          v.tags.forEach((t) => globalTags.set(t, (globalTags.get(t) || 0) + 1));
        }
      } else if (PLAYLIST_RENDERERS.has(key)) {
        const p = normalizePlaylist(val, key);
        if (p && !seenIds.has(p.id)) {
          seenIds.add(p.id);
          playlists.push(p);
        }
      }
    }
  }

  // Fallback: if secondaryResults was empty, walk the whole response
  if (videos.length === 0) {
    for (const [node] of walk(data)) {
      if (!node || typeof node !== "object") continue;
      if (node.lockupViewModel) {
        const v = extractLockupVideo(node.lockupViewModel, seedVideoId);
        if (v && !seenIds.has(v.id)) {
          seenIds.add(v.id);
          videos.push(v);
          v.tags.forEach((t) => globalTags.set(t, (globalTags.get(t) || 0) + 1));
        }
      } else {
        for (const [key, val] of Object.entries(node)) {
          if (VIDEO_RENDERERS.has(key)) {
            const v = extractLegacyVideo(val, key, seedVideoId);
            if (v && !seenIds.has(v.id)) {
              seenIds.add(v.id);
              videos.push(v);
              v.tags.forEach((t) => globalTags.set(t, (globalTags.get(t) || 0) + 1));
            }
          }
        }
      }
    }
  }

  const sortedTags = Array.from(globalTags.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, 8);

  return { videos, playlists, tags: sortedTags };
}

function findContinuation(data) {
  // 1. Restrict continuation search strictly to secondaryResults (avoid comments section)
  const sec = getPath(data, "contents", "twoColumnWatchNextResults", "secondaryResults");
  if (sec) {
    for (const [node] of walk(sec)) {
      const token =
        node?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
        node?.continuationEndpoint?.continuationCommand?.token ||
        node?.nextContinuationData?.continuation;
      if (typeof token === "string" && token) {
        return token;
      }
    }
  }

  // 2. Check onResponseReceivedEndpoints (for continuation page responses)
  const eps = data?.onResponseReceivedEndpoints || [];
  for (const ep of eps) {
    const items = ep?.appendContinuationItemsAction?.continuationItems ||
      ep?.reloadContinuationItemsCommand?.continuationItems || [];
    for (const item of items) {
      const token = item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
        item?.continuationEndpoint?.continuationCommand?.token;
      if (typeof token === "string" && token) {
        return token;
      }
    }
  }

  return null;
}

async function fetchNext(payload, retries = 2) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

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
  const parsed = parseRecommendations(initial, videoId);
  const videos = [...parsed.videos];
  const playlists = [...parsed.playlists];
  let continuation = findContinuation(initial);
  const rawPages = includeRaw ? [initial] : [];

  for (let page = 0; page < pages && continuation; page++) {
    try {
      const pageData = await fetchNext({
        context: basePayload.context,
        continuation,
      });
      if (includeRaw) rawPages.push(pageData);

      const nextParsed = parseRecommendations(pageData, videoId);
      const existingIds = new Set(videos.map((v) => v.id));
      for (const v of nextParsed.videos) {
        if (!existingIds.has(v.id)) {
          existingIds.add(v.id);
          videos.push(v);
        }
      }
      for (const p of nextParsed.playlists) {
        if (!playlists.some((pl) => pl.id === p.id)) {
          playlists.push(p);
        }
      }
      continuation = findContinuation(pageData);
    } catch {
      break;
    }
  }

  const finalVideos = options.excludeShorts
    ? videos.filter((v) => !v.is_short)
    : videos;

  return {
    success: true,
    videoId,
    tags: parsed.tags,
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
  let continuation = null;

  if (request.method === "GET") {
    rawInput =
      url.searchParams.get("videoId") ||
      url.searchParams.get("video_id") ||
      url.searchParams.get("v") ||
      url.searchParams.get("url");

    if (!rawInput && url.pathname.includes("/recommendations/")) {
      rawInput = url.pathname.split("/recommendations/")[1];
    }

    continuation = url.searchParams.get("continuation") || url.searchParams.get("continuation_token");
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
    continuation = body?.continuation ?? body?.continuation_token;
    pages = body?.pages ?? 0;
    includeRaw = body?.includeRaw === true;
    excludeShorts = body?.excludeShorts === true;
  } else {
    return jsonResponse({ success: false, error: "Method not allowed. Use GET or POST." }, 405);
  }

  // If a continuation cursor is provided, load the next page directly
  if (continuation) {
    try {
      const pageData = await fetchNext({
        context: {
          client: {
            clientName: "WEB",
            clientVersion: CLIENT_VERSION,
            hl: "en",
            gl: "US",
            visitorData: VISITOR_ID,
          },
        },
        continuation,
      });

      const seedVideoId = extractVideoId(rawInput);
      const parsed = parseRecommendations(pageData, seedVideoId);
      const nextContinuation = findContinuation(pageData);
      const finalVideos = excludeShorts
        ? parsed.videos.filter((v) => !v.is_short)
        : parsed.videos;

      return jsonResponse(
        {
          success: true,
          videoId: seedVideoId || null,
          is_continuation: true,
          video_count: finalVideos.length,
          playlist_count: parsed.playlists.length,
          videos: finalVideos,
          playlists: parsed.playlists,
          tags: parsed.tags,
          continuation_token: nextContinuation,
        },
        200,
        "no-store"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ success: false, error: message }, 502);
    }
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
