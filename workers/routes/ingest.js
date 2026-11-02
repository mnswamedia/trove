/**
 * Route Handler: Ingestion Workflow Dispatcher & Live Sync (/ingest/*)
 * Manages discrete run batches (ingest_runs) and target items (ingest_items) in Cloudflare D1.
 */

import { jsonResponse } from "../common.js";
import { ensureSchema } from "../db.js";

function parseTargetsList(rawText) {
  if (Array.isArray(rawText)) return rawText;
  const tokens = String(rawText || "").split(/[\r\n\t ]+/);
  const targets = [];
  const seen = new Set();

  for (const token of tokens) {
    const clean = token.trim();
    if (!clean || clean.startsWith("#")) continue;

    let target = clean;
    const match = clean.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?(?:.*&)?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/i);
    if (match) {
      const vid = match[1];
      target = clean.toLowerCase().includes("/shorts/") 
        ? `https://www.youtube.com/shorts/${vid}` 
        : `https://www.youtube.com/watch?v=${vid}`;
    } else if (/^[a-zA-Z0-9_-]{11}$/.test(clean)) {
      target = `https://www.youtube.com/watch?v=${clean}`;
    } else if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      target = `https://${clean}`;
    }

    if (!seen.has(target)) {
      seen.add(target);
      targets.push(target);
    }
  }
  return targets;
}

function extractYouTubeId(urlOrId) {
  const m = String(urlOrId || "").match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?(?:.*&)?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/i);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) return urlOrId;
  return "";
}

export async function handleIngest(request, env, url) {
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

  // ===========================================================================
  // 1. POST /ingest/dispatch (or /ingest) — Dispatch Ingestion Workflow from UI
  // ===========================================================================
  if (request.method === "POST" && (pathname === "/ingest/dispatch" || pathname === "/ingest")) {
    try {
      const body = await request.json();
      const rawTargets = body.targets || "";
      const format = (body.format || "m4a").trim().toLowerCase();
      const bucketId = (body.bucket_id || "mnswa/trove_dataset").trim();
      const hfToken = (body.hf_token || "").trim();
      const ghToken = (body.gh_token || env.GH_TOKEN || env.GITHUB_TOKEN || "").trim();
      const owner = (body.owner || env.GH_OWNER || "mnswamedia").trim();
      const repo = (body.repo || env.GH_REPO || "trove").trim();
      const ref = (body.ref || "main").trim();
      const workflowFile = (body.workflow || "ingest.yml").trim();

      const targets = parseTargetsList(rawTargets);
      if (targets.length === 0 && !body.backfill) {
        return jsonResponse({ success: false, error: "Missing required 'targets' field" }, 400);
      }

      if (!ghToken) {
        return jsonResponse({
          success: false,
          error: "GitHub Token required. Provide 'gh_token' in request body or set GH_TOKEN in Worker."
        }, 400);
      }

      const runId = "run_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      const now = Date.now();
      const totalTracks = targets.length;

      // A. Pre-populate D1: 1 row in ingest_runs, N rows in ingest_items
      const statements = [
        env.DB.prepare(`
          INSERT INTO ingest_runs (id, github_run_id, status, total_tracks, succeeded_tracks, failed_tracks, format, bucket_id, created_at, updated_at)
          VALUES (?, '', 'queued', ?, 0, 0, ?, ?, ?, ?)
        `).bind(runId, totalTracks, format, bucketId, now, now)
      ];

      for (let i = 0; i < targets.length; i++) {
        const targetUrl = targets[i];
        const songId = extractYouTubeId(targetUrl);
        const itemId = `item_${runId}_${i + 1}`;
        const placeholderTitle = songId ? `YouTube (${songId})` : `Target #${i + 1}`;

        statements.push(
          env.DB.prepare(`
            INSERT INTO ingest_items (id, run_id, track_index, url, song_id, title, format, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          `).bind(itemId, runId, i + 1, targetUrl, songId, placeholderTitle, format, now, now)
        );
      }

      await env.DB.batch(statements);

      // B. Dispatch GitHub Actions Workflow
      const dispatchUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;
      const workerTelemetryUrl = `${url.origin}/ingest/update`;

      const ghResponse = await fetch(dispatchUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${ghToken}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Trove-Worker",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ref: ref,
          inputs: {
            targets: targets.join("\n"),
            format: format,
            bucket_id: bucketId,
            hf_token: hfToken,
            job_id: runId,
            worker_url: workerTelemetryUrl
          }
        })
      });

      if (!ghResponse.ok && ghResponse.status !== 204) {
        let errDetail = `GitHub dispatch failed with status ${ghResponse.status}`;
        try {
          const errData = await ghResponse.json();
          errDetail = errData.message || errDetail;
        } catch (_) {}

        await env.DB.prepare(`
          UPDATE ingest_runs SET status = 'failed', updated_at = ? WHERE id = ?
        `).bind(Date.now(), runId).run();

        return jsonResponse({ success: false, error: errDetail, run_id: runId }, ghResponse.status);
      }

      return jsonResponse({
        success: true,
        run_id: runId,
        total_tracks: totalTracks,
        message: "Workflow dispatched to GitHub Actions successfully"
      }, 200);

    } catch (err) {
      return jsonResponse({ success: false, error: "Failed to dispatch ingest run: " + err.message }, 500);
    }
  }

  // ===========================================================================
  // 2. POST /ingest/update (or /ingest/progress, /ingest/event) — State Updates from Actions Runner
  // ===========================================================================
  if (request.method === "POST" && (pathname === "/ingest/update" || pathname === "/ingest/progress" || pathname === "/ingest/event")) {
    try {
      const body = await request.json();
      const event = (body.event || "").trim().toLowerCase();
      const runId = (body.run_id || body.job_id || "").trim();
      const githubRunId = (body.github_run_id || body.run_id_gh || "").trim();
      const trackIndex = Number(body.track_index) || 0;
      const urlTarget = (body.url || "").trim();
      const songId = (body.song_id || "").trim();
      const title = (body.title || "").trim();
      const status = (body.status || "").trim().toLowerCase();
      const error = (body.error || "").trim();
      const sizeBytes = Number(body.size_bytes) || 0;
      const durationSeconds = Number(body.duration_seconds) || 0;
      const now = Date.now();

      if (!runId && !githubRunId) {
        return jsonResponse({ success: false, error: "run_id or github_run_id required" }, 400);
      }

      // Resolve runId if only githubRunId is known
      let activeRunId = runId;
      if (!activeRunId && githubRunId) {
        const found = await env.DB.prepare(`SELECT id FROM ingest_runs WHERE github_run_id = ?`).bind(githubRunId).first();
        if (found) activeRunId = found.id;
      }

      if (!activeRunId) {
        return jsonResponse({ success: false, error: "Run not found" }, 404);
      }

      // Case A: Entire Run Started
      if (event === "run_started" || status === "started") {
        await env.DB.prepare(`
          UPDATE ingest_runs
          SET status = 'in_progress',
              github_run_id = CASE WHEN ? != '' THEN ? ELSE github_run_id END,
              started_at = COALESCE(started_at, ?),
              updated_at = ?
          WHERE id = ?
        `).bind(githubRunId, githubRunId, now, now, activeRunId).run();
      }

      // Case B: Individual Item Started
      else if (event === "item_started" || status === "downloading") {
        await env.DB.prepare(`
          UPDATE ingest_items
          SET status = 'downloading',
              started_at = COALESCE(started_at, ?),
              updated_at = ?
          WHERE run_id = ? AND (track_index = ? OR url = ?)
        `).bind(now, now, activeRunId, trackIndex, urlTarget).run();

        await env.DB.prepare(`
          UPDATE ingest_runs
          SET status = 'in_progress',
              started_at = COALESCE(started_at, ?),
              updated_at = ?
          WHERE id = ? AND status = 'queued'
        `).bind(now, now, activeRunId).run();
      }

      // Case C: Individual Item Ended (Success, Failure, or Skipped)
      else if (event === "item_ended" || status === "succeeded" || status === "failed" || status === "skipped_archive") {
        const finalItemStatus = status === "succeeded" ? "succeeded" : (status === "skipped_archive" ? "skipped_archive" : "failed");

        await env.DB.prepare(`
          UPDATE ingest_items
          SET status = ?,
              title = CASE WHEN ? != '' THEN ? ELSE title END,
              song_id = CASE WHEN ? != '' THEN ? ELSE song_id END,
              size_bytes = CASE WHEN ? > 0 THEN ? ELSE size_bytes END,
              duration_seconds = CASE WHEN ? > 0 THEN ? ELSE duration_seconds END,
              error = ?,
              ended_at = ?,
              updated_at = ?
          WHERE run_id = ? AND (track_index = ? OR url = ?)
        `).bind(
          finalItemStatus,
          title, title,
          songId, songId,
          sizeBytes, sizeBytes,
          durationSeconds, durationSeconds,
          error,
          now,
          now,
          activeRunId,
          trackIndex,
          urlTarget
        ).run();

        // Increment counts on the parent run
        if (finalItemStatus === "succeeded" || finalItemStatus === "skipped_archive") {
          await env.DB.prepare(`
            UPDATE ingest_runs
            SET succeeded_tracks = succeeded_tracks + 1, updated_at = ?
            WHERE id = ?
          `).bind(now, activeRunId).run();
        } else {
          await env.DB.prepare(`
            UPDATE ingest_runs
            SET failed_tracks = failed_tracks + 1, updated_at = ?
            WHERE id = ?
          `).bind(now, activeRunId).run();
        }
      }

      // Case D: Entire Run Ended
      else if (event === "run_ended" || status === "completed" || status === "finished") {
        await env.DB.prepare(`
          UPDATE ingest_runs
          SET status = ?,
              ended_at = ?,
              updated_at = ?
          WHERE id = ?
        `).bind(status === "failed" ? "failed" : "completed", now, now, activeRunId).run();
      }

      return jsonResponse({ success: true, timestamp: now }, 200);

    } catch (err) {
      return jsonResponse({ success: false, error: "Failed to record update: " + err.message }, 500);
    }
  }

  // ===========================================================================
  // 3. GET /ingest/status (or /ingest/progress, /ingest) — Query Latest or Specific Run + Items
  // ===========================================================================
  if (request.method === "GET" && (pathname === "/ingest/status" || pathname === "/ingest/progress" || pathname === "/ingest")) {
    try {
      const runId = url.searchParams.get("run_id") || url.searchParams.get("job_id") || url.searchParams.get("id");
      const githubRunId = url.searchParams.get("github_run_id") || url.searchParams.get("run_id_gh");

      let run = null;
      if (runId) {
        run = await env.DB.prepare(`SELECT * FROM ingest_runs WHERE id = ?`).bind(runId).first();
      } else if (githubRunId) {
        run = await env.DB.prepare(`SELECT * FROM ingest_runs WHERE github_run_id = ?`).bind(githubRunId).first();
      }

      if (!run) {
        // Default / Fallback: return active running batch first, or the most recent run
        run = await env.DB.prepare(`
          SELECT * FROM ingest_runs
          ORDER BY
            CASE WHEN status IN ('in_progress', 'queued') THEN 0 ELSE 1 END ASC,
            created_at DESC
          LIMIT 1
        `).first();
      }

      if (!run) {
        return jsonResponse({
          success: true,
          run: null,
          items: [],
          message: "No ingestion runs found"
        });
      }

      const itemsResult = await env.DB.prepare(`
        SELECT * FROM ingest_items WHERE run_id = ? ORDER BY track_index ASC
      `).bind(run.id).all();

      return jsonResponse({
        success: true,
        run: run,
        items: itemsResult.results || []
      }, 200);

    } catch (err) {
      return jsonResponse({ success: false, error: "Failed to query status: " + err.message }, 500);
    }
  }

  // ===========================================================================
  // 4. GET /ingest/history — Query Recent Runs
  // ===========================================================================
  if (request.method === "GET" && pathname === "/ingest/history") {
    try {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 15)));
      const runsResult = await env.DB.prepare(`
        SELECT * FROM ingest_runs ORDER BY created_at DESC LIMIT ?
      `).bind(limit).all();

      return jsonResponse({
        success: true,
        runs: runsResult.results || []
      }, 200);

    } catch (err) {
      return jsonResponse({ success: false, error: "Failed to query history: " + err.message }, 500);
    }
  }

  return jsonResponse({ success: false, error: `Method ${request.method} or route ${pathname} not allowed` }, 405);
}
