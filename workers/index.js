/**
 * Cloudflare Worker — Trove Unified Backend API Gateway
 *
 * Consolidates all Trove media backend capabilities into a single worker:
 *   - Playlists & Active Queue (D1 SQLite)
 *   - Playback Metrics & Listening Analytics (D1 SQLite)
 *   - Music Lyrics Extraction (YouTube Music InnerTube + LRCLIB)
 *   - Recommendations & Related Content (YouTube InnerTube)
 *
 * D1 Database Binding:
 *   Bind your D1 database (`trove-db`) with variable name `DB`.
 *
 * Environment Secrets (Optional):
 *   `API_KEY` or `TOKEN` (Checks Authorization: Bearer, X-API-Key, or ?token=)
 */

import { handleCors, jsonResponse, checkAuth } from "./common.js";
import { ensureSchema } from "./db.js";
import { handlePlaylists } from "./routes/playlists.js";
import { handleMetrics } from "./routes/metrics.js";
import { handleLyrics } from "./routes/lyrics.js";
import { handleRecommendations } from "./routes/recommendations.js";
import { handleIngest } from "./routes/ingest.js";

export default {
  async fetch(request, env) {
    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return handleCors();
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    // 2. Global Health Check
    if (pathname === "/health") {
      const hasDb = Boolean(env && env.DB);
      let dbReady = false;
      if (hasDb) {
        try {
          await ensureSchema(env.DB);
          dbReady = true;
        } catch (_) {}
      }

      return jsonResponse({
        ok: true,
        service: "trove-unified-api",
        version: "2.0.0",
        d1Configured: hasDb,
        databaseReady: dbReady,
        routes: [
          "/playlists",
          "/metrics",
          "/lyrics",
          "/recommendations",
          "/ingest",
          "/health"
        ],
        timestamp: Date.now()
      });
    }

    // 3. Optional Authentication Check
    if (!checkAuth(request, env)) {
      return jsonResponse({
        success: false,
        error: "Unauthorized. Provide a valid Bearer token, X-API-Key header, or ?token= parameter."
      }, 401);
    }

    // 4. Route Dispatch
    // Playlists & Queue
    if (pathname === "/playlists" || pathname.startsWith("/playlists/")) {
      return handlePlaylists(request, env, url);
    }

    // Playback Metrics & Telemetry
    if (
      pathname === "/metrics" ||
      pathname.startsWith("/metrics/") ||
      pathname === "/play" ||
      pathname === "/complete"
    ) {
      return handleMetrics(request, env, url);
    }

    // Music Lyrics
    if (pathname === "/lyrics" || pathname.startsWith("/lyrics/")) {
      return handleLyrics(request, env, url);
    }

    // Recommendations & Related Content
    if (
      pathname === "/recommendations" ||
      pathname.startsWith("/recommendations/") ||
      pathname === "/recs" ||
      pathname.startsWith("/recs/") ||
      pathname === "/extract"
    ) {
      return handleRecommendations(request, env, url);
    }

    // Ingestion Telemetry & Workflow Dispatch
    if (pathname === "/ingest" || pathname.startsWith("/ingest/")) {
      return handleIngest(request, env, url);
    }

    // 5. Root & Legacy Parameter Fallback
    // If called at root '/' with videoId parameter:
    if (pathname === "/" && url.searchParams.has("videoId")) {
      // If title or lyrics parameter exists, route to lyrics, else recommendations
      if (url.searchParams.has("title") || url.searchParams.has("lyrics")) {
        return handleLyrics(request, env, url);
      }
      return handleRecommendations(request, env, url);
    }

    return jsonResponse({
      success: false,
      error: `Route '${pathname}' not found. Available endpoints: /playlists, /metrics, /lyrics, /recommendations, /health`
    }, 404);
  }
};

