/**
 * Route Handler: Playback Metrics (/metrics/*)
 */

import { jsonResponse } from "../common.js";
import { ensureSchema } from "../db.js";

export async function handleMetrics(request, env, url) {
  if (!env || !env.DB) {
    return jsonResponse({
      success: false,
      error: "D1 database binding 'DB' is missing. Please bind your D1 database in Cloudflare Worker settings."
    }, 500);
  }

  try {
    await ensureSchema(env.DB);
  } catch (err) {
    return jsonResponse({ success: false, error: "Database schema error: " + err.message }, 500);
  }

  const pathname = url.pathname.replace(/\/+$/, "");

  // 1. POST /metrics/play or POST /play
  if (request.method === "POST" && (pathname === "/metrics/play" || pathname === "/play")) {
    try {
      const body = await request.json();
      const path = (body.path || body.id || "").trim();
      if (!path) {
        return jsonResponse({ success: false, error: "Missing required 'path' field" }, 400);
      }

      const title = body.title || "";
      const artist = body.artist || "";
      const duration = Number(body.duration) || 0;
      const now = Date.now();
      const dateObj = new Date(now);
      const hourOfDay = dateObj.getHours();
      const dayOfWeek = dateObj.getDay();

      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO track_metrics (
            path, title, artist, duration, play_count, complete_count, first_played_at, last_played_at, total_play_time
          ) VALUES (?, ?, ?, ?, 1, 0, ?, ?, 0)
          ON CONFLICT(path) DO UPDATE SET
            play_count = play_count + 1,
            last_played_at = excluded.last_played_at,
            title = CASE WHEN excluded.title != '' THEN excluded.title ELSE title END,
            artist = CASE WHEN excluded.artist != '' THEN excluded.artist ELSE artist END,
            duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE duration END
        `).bind(path, title, artist, duration, now, now),

        env.DB.prepare(`
          INSERT INTO play_history (path, played_at, hour_of_day, day_of_week)
          VALUES (?, ?, ?, ?)
        `).bind(path, now, hourOfDay, dayOfWeek)
      ]);

      return jsonResponse({ success: true, path, playedAt: now }, 201);
    } catch (err) {
      return jsonResponse({ success: false, error: "Failed to record play: " + err.message }, 500);
    }
  }

  // 2. POST /metrics/complete or POST /complete
  if (request.method === "POST" && (pathname === "/metrics/complete" || pathname === "/complete")) {
    try {
      const body = await request.json();
      const path = (body.path || body.id || "").trim();
      const secondsListened = Math.max(0, Number(body.secondsListened || body.duration) || 0);

      if (!path) {
        return jsonResponse({ success: false, error: "Missing required 'path' field" }, 400);
      }

      await env.DB.prepare(`
        UPDATE track_metrics SET
          complete_count = complete_count + 1,
          total_play_time = total_play_time + ?
        WHERE path = ?
      `).bind(secondsListened, path).run();

      return jsonResponse({ success: true, path, completeCountUpdated: true });
    } catch (err) {
      return jsonResponse({ success: false, error: "Failed to record completion: " + err.message }, 500);
    }
  }

  // 3. GET /metrics/summary
  if (request.method === "GET" && (pathname === "/metrics/summary" || pathname === "/summary")) {
    try {
      const totalTracksRes = await env.DB.prepare(
        "SELECT COUNT(*) as count, SUM(play_count) as total_plays, SUM(total_play_time) as total_time FROM track_metrics"
      ).first();
      const topTrack = await env.DB.prepare(
        "SELECT path, title, artist, play_count FROM track_metrics ORDER BY play_count DESC LIMIT 1"
      ).first();
      const recentTracks = await env.DB.prepare(
        "SELECT path, title, artist, play_count, last_played_at FROM track_metrics ORDER BY last_played_at DESC LIMIT 10"
      ).all();

      const peakHourRes = await env.DB.prepare(`
        SELECT hour_of_day, COUNT(*) as frequency 
        FROM play_history 
        GROUP BY hour_of_day 
        ORDER BY frequency DESC 
        LIMIT 1
      `).first();

      return jsonResponse({
        success: true,
        summary: {
          uniqueTracksPlayed: totalTracksRes?.count || 0,
          totalPlays: totalTracksRes?.total_plays || 0,
          totalListeningSeconds: Math.round(totalTracksRes?.total_time || 0),
          mostPlayedTrack: topTrack || null,
          peakHour: peakHourRes ? peakHourRes.hour_of_day : null,
          recentlyPlayed: recentTracks?.results || []
        }
      });
    } catch (err) {
      return jsonResponse({ success: false, error: "Failed to fetch summary: " + err.message }, 500);
    }
  }

  // 4. GET /metrics/:path (Single track lookup)
  if (request.method === "GET" && pathname.startsWith("/metrics/") && pathname !== "/metrics/summary") {
    const targetPath = decodeURIComponent(pathname.slice("/metrics/".length));
    if (targetPath) {
      try {
        const item = await env.DB.prepare(
          "SELECT path, title, artist, duration, play_count, complete_count, first_played_at, last_played_at, total_play_time FROM track_metrics WHERE path = ?"
        ).bind(targetPath).first();

        if (!item) {
          return jsonResponse({ success: false, error: "No metrics recorded for track" }, 404);
        }

        return jsonResponse({ success: true, metrics: item });
      } catch (err) {
        return jsonResponse({ success: false, error: "Failed to fetch track metrics: " + err.message }, 500);
      }
    }
  }

  // 5. GET /metrics (All track metrics with sorting & pagination)
  if (request.method === "GET" && pathname === "/metrics") {
    try {
      const sort = (url.searchParams.get("sort") || "plays").toLowerCase();
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10)));
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));

      let orderBy = "play_count DESC";
      if (sort === "recent") orderBy = "last_played_at DESC";
      else if (sort === "completes") orderBy = "complete_count DESC";
      else if (sort === "time") orderBy = "total_play_time DESC";

      const rows = await env.DB.prepare(`
        SELECT path, title, artist, duration, play_count, complete_count, first_played_at, last_played_at, total_play_time
        FROM track_metrics
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `).bind(limit, offset).all();

      return jsonResponse({
        success: true,
        count: rows.results ? rows.results.length : 0,
        metrics: rows.results || []
      });
    } catch (err) {
      return jsonResponse({ success: false, error: "Failed to fetch metrics: " + err.message }, 500);
    }
  }

  return jsonResponse({ success: false, error: "Metrics route not found" }, 404);
}

