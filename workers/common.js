/**
 * Shared Utilities for Trove Cloudflare Worker
 * CORS, JSON formatting, and Token Authentication
 */

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    "Access-Control-Max-Age": "86400"
  };
}

export function handleCors() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

export function jsonResponse(data, status = 200, cacheControl = "no-store") {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": typeof cacheControl === "number"
      ? (cacheControl > 0 ? `public, max-age=${cacheControl * 3600}, s-maxage=${cacheControl * 3600}` : "no-store")
      : cacheControl,
    ...corsHeaders()
  };

  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

export function checkAuth(request, env) {
  const authSecret = env?.API_KEY || env?.TOKEN || env?.WORKER_TOKEN;
  if (!authSecret) return true; // If no secret is configured, requests are public

  const url = new URL(request.url);
  const authHeader = request.headers.get("Authorization");
  const apiKeyHeader = request.headers.get("X-API-Key");
  const queryToken =
    url.searchParams.get("token") ||
    url.searchParams.get("key") ||
    url.searchParams.get("apiKey");

  const supplied =
    (authHeader ? authHeader.replace(/^Bearer\s+/i, "") : null) ||
    apiKeyHeader ||
    queryToken;

  return supplied === authSecret;
}

