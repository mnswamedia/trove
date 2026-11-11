/**
 * Shared Utilities for Trove Cloudflare Worker
 * CORS, JSON formatting, Constant-Time Token Authentication, and Authorized Edge Cache
 */

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    "Access-Control-Expose-Headers": "X-Trove-Cache",
    "Access-Control-Max-Age": "86400"
  };
}

export function handleCors() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function sanitizeCacheControl(cacheControl, status) {
  if (status >= 400) {
    return "no-store";
  }
  if (typeof cacheControl === "number") {
    return cacheControl > 0
      ? `private, max-age=${Math.round(cacheControl * 3600)}, must-revalidate`
      : "no-store";
  }
  const raw = String(cacheControl || "no-store").trim();
  if (!raw || raw.toLowerCase() === "no-store") {
    return "no-store";
  }
  let sanitized = raw
    .replace(/\bpublic\b,?\s*/gi, "")
    .replace(/\bs-maxage=\d+\b,?\s*/gi, "")
    .trim()
    .replace(/^,+|,+$/g, "")
    .replace(/,\s*,/g, ",");
  if (!/\bprivate\b/i.test(sanitized)) {
    sanitized = sanitized ? `private, ${sanitized}` : "private";
  }
  return sanitized;
}

export function jsonResponse(data, status = 200, cacheControl = "no-store", extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": sanitizeCacheControl(cacheControl, status),
    "Vary": "Authorization, X-API-Key",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(),
    ...extraHeaders
  };

  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

function getConfiguredSecret(env) {
  const raw = env?.API_KEY || env?.CF_WORKER_TOKEN || env?.WORKER_TOKEN || env?.TOKEN || "";
  return String(raw).trim();
}

async function sha256Bytes(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

async function timingSafeStringEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) {
    return false;
  }
  const [hashA, hashB] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < hashA.length; i++) {
    diff |= hashA[i] ^ hashB[i];
  }
  return diff === 0;
}

export async function verifyAuth(request, env) {
  const authSecret = getConfiguredSecret(env);
  // Fail-closed: refuse all requests unless a Worker secret is configured
  if (!authSecret) {
    return {
      ok: false,
      misconfigured: true,
      reason: "Server authentication secret (API_KEY) is not configured in Cloudflare Worker secrets."
    };
  }

  const authHeader = (request.headers.get("Authorization") || "").trim();
  const apiKeyHeader = (request.headers.get("X-API-Key") || "").trim();

  let bearerToken = "";
  if (authHeader) {
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) {
      bearerToken = m[1].trim();
    }
  }

  const supplied = bearerToken || apiKeyHeader;
  if (!supplied) {
    const url = new URL(request.url);
    const hasQueryToken = url.searchParams.has("token") || url.searchParams.has("key") || url.searchParams.has("apiKey");
    return {
      ok: false,
      misconfigured: false,
      reason: hasQueryToken
        ? "Query parameter authentication (?token=) is disabled. Send your key in Authorization: Bearer or X-API-Key header."
        : "Missing authentication key. Provide Authorization: Bearer <key> or X-API-Key header."
    };
  }

  const bearerOrPrimaryOk = await timingSafeStringEqual(supplied, authSecret);
  if (!bearerOrPrimaryOk) {
    return { ok: false, misconfigured: false, reason: "Invalid API key." };
  }

  if (bearerToken && apiKeyHeader) {
    const apiKeyOk = await timingSafeStringEqual(apiKeyHeader, authSecret);
    if (!apiKeyOk) {
      return { ok: false, misconfigured: false, reason: "Invalid X-API-Key header." };
    }
  }

  return { ok: true, misconfigured: false };
}

export async function checkAuth(request, env) {
  const res = await verifyAuth(request, env);
  return res.ok;
}

async function getEdgeCacheNamespace(env) {
  const secret = getConfiguredSecret(env);
  if (!secret) return "unconfigured";
  const digest = await sha256Bytes(`trove-cache-ns:${secret}`);
  return Array.from(digest.slice(0, 6))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Authorized Edge Cache Read (caches.default)
 * Must only be invoked after verifyAuth() has succeeded.
 */
export async function getAuthorizedEdgeCache(cachePathAndQuery, env, origin = "https://trove-edge-cache.internal") {
  try {
    if (typeof caches === "undefined" || !caches.default) return null;
    const ns = await getEdgeCacheNamespace(env);
    const cleanOrigin = String(origin || "https://trove-edge-cache.internal").replace(/\/+$/, "");
    const cleanPath = cachePathAndQuery.startsWith("/") ? cachePathAndQuery : `/${cachePathAndQuery}`;
    const cacheKey = new Request(`${cleanOrigin}/__trove_cache/v1/${ns}${cleanPath}`, { method: "GET" });
    const cached = await caches.default.match(cacheKey);
    if (!cached || !cached.ok) return null;
    return await cached.json();
  } catch (_) {
    return null;
  }
}

/**
 * Authorized Edge Cache Write (caches.default)
 * Stores data under a secret-namespaced internal path on the worker origin, only reachable after verifyAuth().
 */
export function putAuthorizedEdgeCache(cachePathAndQuery, data, ttlSeconds = 3600, ctx = null, env = null, origin = "https://trove-edge-cache.internal") {
  try {
    if (typeof caches === "undefined" || !caches.default || !data || ttlSeconds <= 0) return;
    const nsPromise = getEdgeCacheNamespace(env);
    const cleanOrigin = String(origin || "https://trove-edge-cache.internal").replace(/\/+$/, "");
    const cleanPath = cachePathAndQuery.startsWith("/") ? cachePathAndQuery : `/${cachePathAndQuery}`;
    const writePromise = (async () => {
      const ns = await nsPromise;
      const cacheKey = new Request(`${cleanOrigin}/__trove_cache/v1/${ns}${cleanPath}`, { method: "GET" });
      const cacheRes = new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": `public, max-age=${Math.round(ttlSeconds)}`
        }
      });
      await caches.default.put(cacheKey, cacheRes);
    })().catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(writePromise);
    }
  } catch (_) {}
}

