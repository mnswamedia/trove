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
 * Environment Secrets (Required — Fail-Closed):
 *   `API_KEY` (or `CF_WORKER_TOKEN` / `WORKER_TOKEN` / `TOKEN`)
 *   Checked strictly via `Authorization: Bearer <key>` or `X-API-Key: <key>` headers.
 */

import { handleCors, jsonResponse, verifyAuth } from "./common.js";
import { ensureSchema } from "./db.js";
import { handlePlaylists } from "./routes/playlists.js";
import { handleMetrics } from "./routes/metrics.js";
import { handleLyrics } from "./routes/lyrics.js";
import { handleRecommendations } from "./routes/recommendations.js";
import { handleIngest } from "./routes/ingest.js";

export default {
  async fetch(request, env, ctx) {
    // 1. CORS Preflight (required by browsers before sending auth headers)
    if (request.method === "OPTIONS") {
      return handleCors();
    }

    // 2. Mandatory Authentication Check across ALL endpoints (zero public exemptions)
    const auth = await verifyAuth(request, env);
    if (!auth.ok) {
      if (auth.misconfigured) {
        return jsonResponse(
          {
            success: false,
            error: auth.reason
          },
          503,
          "no-store"
        );
      }

      return jsonResponse(
        {
          success: false,
          error: auth.reason || "Unauthorized. Provide a valid Bearer token or X-API-Key header."
        },
        401,
        "no-store",
        { "WWW-Authenticate": 'Bearer realm="Trove API"' }
      );
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    // 3. Authenticated Health Check
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
        authenticated: true,
        service: "trove-unified-api",
        version: "2.1.0",
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
      return handleLyrics(request, env, url, ctx);
    }

    // Recommendations & Related Content
    if (
      pathname === "/recommendations" ||
      pathname.startsWith("/recommendations/") ||
      pathname === "/recs" ||
      pathname.startsWith("/recs/") ||
      pathname === "/extract"
    ) {
      return handleRecommendations(request, env, url, ctx);
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
        return handleLyrics(request, env, url, ctx);
      }
      return handleRecommendations(request, env, url, ctx);
    }

    return jsonResponse({
      success: false,
      error: `Route '${pathname}' not found. Available endpoints: /playlists, /metrics, /lyrics, /recommendations, /health`
    }, 404);
  }
};

