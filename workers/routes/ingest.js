/**
 * Route Handler: Ingest Workflow Dispatcher & Live Telemetry (/ingest/*)
 */

import { jsonResponse } from "../common.js";
import { ensureSchema } from "../db.js";

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

  // 1. POST /ingest/dispatch or POST /ingest — Dispatch GitHub Actions Workflow from Worker
  if (request.method === "POST" && (pathname === "/ingest/dispatch" || pathname === "/ingest")) {
    try {
      const body = await request.json();
      const targets = (body.targets || "").trim();
      const format = (body.format || "m4a").trim().toLowerCase();
      const bucketId = (body.bucket_id || "mnswa/trove_dataset").trim();
      const hfToken = (body.hf_token || "").trim();
      const ghToken = (body.gh_token || env.GH_TOKEN || env.GITHUB_TOKEN || "").trim();
      const owner = (body.owner || env.GH_OWNER || "mnswamedia").trim();
      const repo = (body.repo || env.GH_REPO || "trove").trim();
      const ref = (body.ref || "main").trim();
      const workflowFile = (body.workflow || "ingest.yml").trim();

      if (!targets && !body.backfill) {
        return jsonResponse({ success: false, error: "Missing required 'targets' field" }, 400);
      }

      if (!ghToken) {
        return jsonResponse({
          success: false,
          error: "GitHub Token required. Provide 'gh_token' in request body or set GH_TOKEN environment variable in worker."
        }, 400);
      }

      const jobId = "job_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      const now = Date.now();
      const targetsList = targets ? targets.split(/[\r\n\t ]+/).filter(t => t && !t.startsWith("#")) : [];
      const targetsCount = targetsList.length;

      // 1. Record job in D1
      await env.DB.prepare(`
        INSERT INTO ingest_jobs (id, run_id, status, targets_count, format, created_at, updated_at)
        VALUES (?, ?, 'queued', ?, ?, ?, ?)
      `).bind(jobId, "", targetsCount, format, now, now).run();

      // Record initial queued event
      await env.DB.prepare(`
        INSERT INTO ingest_events (job_id, song_id, url, title, status, error, timestamp)
        VALUES (?, '', '', 'Job Queued', 'queued', '', ?)
      `).bind(jobId, now).run();

      // 2. Dispatch to GitHub Actions
      const dispatchUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;
      const workerTelemetryUrl = `${url.origin}/ingest/progress`;

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
            targets: targets,
            format: format,
            bucket_id: bucketId,
            hf_token: hfToken,
            job_id: jobId,
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

        // Mark job as failed
        await env.DB.prepare(`
          UPDATE ingest_jobs SET status = 'failed', updated_at = ? WHERE id = ?
        `).bind(Date.now(), jobId).run();

        return jsonResponse({ success: false, error: errDetail, job_id: jobId }, ghResponse.status);
      }

      return jsonResponse({
        success: true,
        job_id: jobId,
        targets_count: targetsCount,
        message: "Workflow dispatched to GitHub Actions successfully"
      }, 200);
    } catch (err) {
      return jsonResponse({ success: false, error: "Failed to dispatch ingest job: " + err.message }, 500);
    }
  }

  // 2. POST /ingest/progress or POST /ingest/event — Telemetry Ping from GitHub Actions Runner
  if (request.method === "POST" && (pathname === "/ingest/progress" || pathname === "/ingest/event")) {
    try {
      const body = await request.json();
      const jobId = (body.job_id || "").trim();
      const runId = (body.run_id ? String(body.run_id) : "").trim();
      const songId = (body.song_id || "").trim();
      const songUrl = (body.url || "").trim();
      const title = (body.title || "").trim();
      const status = (body.status || "in_progress").trim().toLowerCase();
      const error = (body.error || "").trim();
      const now = Date.now();

      if (!jobId && !runId) {
        return jsonResponse({ success: false, error: "Either 'job_id' or 'run_id' is required" }, 400);
      }

      // If job_id not provided but run_id is, try looking up job by run_id
      let resolvedJobId = jobId;
      if (!resolvedJobId && runId) {
        const found = await env.DB.prepare(`SELECT id FROM ingest_jobs WHERE run_id = ?`).bind(runId).first();
        if (found) resolvedJobId = found.id;
      }

      if (resolvedJobId) {
        // Insert event
        await env.DB.prepare(`
          INSERT INTO ingest_events (job_id, song_id, url, title, status, error, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(resolvedJobId, songId, songUrl, title, status, error, now).run();

        // Update job
        const jobStatus = (status === "completed" || status === "finished") ? "completed" : "in_progress";
        await env.DB.prepare(`
          UPDATE ingest_jobs
          SET status = ?,
              run_id = CASE WHEN ? != '' THEN ? ELSE run_id END,
              updated_at = ?
          WHERE id = ?
        `).bind(jobStatus, runId, runId, now, resolvedJobId).run();
      }

      return jsonResponse({ success: true, timestamp: now }, 200);
    } catch (err) {
      return jsonResponse({ success: false, error: "Failed to record progress: " + err.message }, 500);
    }
  }

  // 3. GET /ingest/progress or GET /ingest/status or GET /ingest — Query Live Progress for UI
  if (request.method === "GET" && (pathname === "/ingest/progress" || pathname === "/ingest/status" || pathname === "/ingest")) {
    try {
      const jobId = url.searchParams.get("job_id") || url.searchParams.get("id");
      const runId = url.searchParams.get("run_id");

      let job = null;
      if (jobId) {
        job = await env.DB.prepare(`SELECT * FROM ingest_jobs WHERE id = ?`).bind(jobId).first();
      } else if (runId) {
        job = await env.DB.prepare(`SELECT * FROM ingest_jobs WHERE run_id = ?`).bind(runId).first();
      } else {
        // Fetch latest active or recent job
        job = await env.DB.prepare(`SELECT * FROM ingest_jobs ORDER BY created_at DESC LIMIT 1`).first();
      }

      if (!job) {
        return jsonResponse({
          success: true,
          job: null,
          events: [],
          message: "No matching ingest job found"
        });
      }

      const eventsResult = await env.DB.prepare(`
        SELECT * FROM ingest_events WHERE job_id = ? ORDER BY id ASC
      `).bind(job.id).all();

      return jsonResponse({
        success: true,
        job: job,
        events: eventsResult.results || []
      }, 200);
    } catch (err) {
      return jsonResponse({ success: false, error: "Failed to query progress: " + err.message }, 500);
    }
  }

  // 4. GET /ingest/history — Query Recent Ingestion Jobs
  if (request.method === "GET" && pathname === "/ingest/history") {
    try {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 15)));
      const jobsResult = await env.DB.prepare(`
        SELECT * FROM ingest_jobs ORDER BY created_at DESC LIMIT ?
      `).bind(limit).all();

      return jsonResponse({
        success: true,
        jobs: jobsResult.results || []
      }, 200);
    } catch (err) {
      return jsonResponse({ success: false, error: "Failed to query history: " + err.message }, 500);
    }
  }

  return jsonResponse({ success: false, error: `Method ${request.method} or route ${pathname} not allowed` }, 405);
}

