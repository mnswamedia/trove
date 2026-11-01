/**
 * Route Handler: Playlists & Queue (/playlists/*)
 */

import { jsonResponse } from "../common.js";
import { ensureSchema } from "../db.js";

export async function handlePlaylists(request, env, url) {
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

  const pathParts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  // pathParts[0] === 'playlists'
  const playlistId = pathParts.length > 1 ? decodeURIComponent(pathParts.slice(1).join("/")) : null;

  // 1. GET /playlists (List all playlists & active queue)
  if (request.method === "GET" && !playlistId) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT id, name, items, updated_at FROM playlists ORDER BY updated_at DESC"
      ).all();

      const playlists = (results || []).map(r => ({
        id: r.id,
        name: r.name,
        items: JSON.parse(r.items || "[]"),
        updatedAt: r.updated_at
      }));

      return jsonResponse({ success: true, count: playlists.length, playlists });
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // 2. GET /playlists/:id (Get single playlist by ID)
  if (request.method === "GET" && playlistId) {
    try {
      const row = await env.DB.prepare(
        "SELECT id, name, items, updated_at FROM playlists WHERE id = ?"
      ).bind(playlistId).first();

      if (!row) {
        return jsonResponse({ success: false, error: "Playlist not found" }, 404);
      }

      return jsonResponse({
        success: true,
        playlist: {
          id: row.id,
          name: row.name,
          items: JSON.parse(row.items || "[]"),
          updatedAt: row.updated_at
        }
      });
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // 3. POST /playlists or PUT /playlists/:id (Create or update playlist)
  if (request.method === "POST" || request.method === "PUT") {
    try {
      const body = await request.json();
      const id = (playlistId || body.id || "").trim();
      const name = (body.name || (id === "_queue" ? "Active Queue" : "Untitled Playlist")).trim();
      const items = Array.isArray(body.items) ? body.items : [];

      if (!id) {
        return jsonResponse({ success: false, error: "Missing playlist 'id'" }, 400);
      }

      const itemsJson = JSON.stringify(items);
      const updatedAt = Date.now();

      await env.DB.prepare(`
        INSERT INTO playlists (id, name, items, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          items = excluded.items,
          updated_at = excluded.updated_at
      `).bind(id, name, itemsJson, updatedAt).run();

      return jsonResponse({
        success: true,
        playlist: { id, name, items, updatedAt }
      }, 200);
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // 4. DELETE /playlists/:id (Delete a playlist)
  if (request.method === "DELETE" && playlistId) {
    try {
      await env.DB.prepare("DELETE FROM playlists WHERE id = ?").bind(playlistId).run();
      return jsonResponse({ success: true, deletedId: playlistId });
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  return jsonResponse({ success: false, error: "Playlists route not found" }, 404);
}

