#!/usr/bin/env bash
# Usage: run-with-warp <command...>
# Starts wireproxy (WARP SOCKS5 on 127.0.0.1:$WARP_PORT).
# Automatically registers/generates a fresh Cloudflare WARP WireGuard profile via wgcf,
# or uses WARP_WG_CONF if provided and healthy.
# Exports WARP_PROXY for ingest.py, runs the command, then cleans up.
set -uo pipefail

PORT="${WARP_PORT:-40000}"
WP_PID=""
TMP="$(mktemp -d)"

cleanup() {
  [ -n "$WP_PID" ] && kill "$WP_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

ensure_wireproxy() {
  if command -v wireproxy >/dev/null 2>&1; then
    echo "wireproxy"
    return 0
  fi
  local WP_PATH="$TMP/wireproxy"
  if [ ! -f "$WP_PATH" ]; then
    echo "--> Downloading wireproxy binary..." >&2
    curl -fsSL "https://github.com/pufferffish/wireproxy/releases/latest/download/wireproxy_linux_amd64.tar.gz" | tar -xz -C "$TMP" wireproxy
    chmod +x "$WP_PATH"
  fi
  echo "$WP_PATH"
}

ensure_wgcf() {
  if command -v wgcf >/dev/null 2>&1; then
    echo "wgcf"
    return 0
  fi
  local WGCF_PATH="$TMP/wgcf"
  if [ ! -f "$WGCF_PATH" ]; then
    echo "--> Downloading wgcf binary..." >&2
    curl -fsSL "https://github.com/ViRb3/wgcf/releases/download/v2.3.1/wgcf_2.3.1_linux_amd64" -o "$WGCF_PATH"
    chmod +x "$WGCF_PATH"
  fi
  echo "$WGCF_PATH"
}

generate_fresh_warp_conf() {
  echo "--> Auto-generating fresh Cloudflare WARP account via wgcf..." >&2
  local WGCF
  WGCF="$(ensure_wgcf)"
  (
    cd "$TMP"
    "$WGCF" register --accept-tos >/dev/null 2>&1 || true
    "$WGCF" generate >/dev/null 2>&1 || true
  )
  if [ -f "$TMP/wgcf-profile.conf" ]; then
    cp "$TMP/wgcf-profile.conf" "$TMP/wg.conf"
    # Prefer Cloudflare IPv4 anycast endpoint to avoid DNS resolution hangs on engage.cloudflareclient.com
    sed -i 's/engage.cloudflareclient.com/162.159.192.1/g' "$TMP/wg.conf" 2>/dev/null || true
    chmod 600 "$TMP/wg.conf"
    return 0
  fi
  return 1
}

start_and_verify_wireproxy() {
  local WP_BIN
  WP_BIN="$(ensure_wireproxy)"

  cat > "$TMP/wireproxy.conf" <<CONF
WGConfig = $TMP/wg.conf

[Socks5]
BindAddress = 127.0.0.1:$PORT
CONF

  "$WP_BIN" -s -c "$TMP/wireproxy.conf" &
  WP_PID=$!

  # Wait for SOCKS5 port to open (up to 5s)
  for _ in $(seq 1 50); do
    timeout 0.2 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/$PORT" 2>/dev/null && break
    sleep 0.1
  done

  # Test connectivity to YouTube lightweight ping endpoint
  if curl -s -o /dev/null -m 8 -x "socks5h://127.0.0.1:$PORT" https://www.youtube.com/generate_204; then
    export WARP_PROXY="socks5://127.0.0.1:$PORT"
    echo "--> Cloudflare WARP proxy verified active on $WARP_PROXY"
    return 0
  else
    kill "$WP_PID" 2>/dev/null || true
    WP_PID=""
    export WARP_PROXY=""
    return 1
  fi
}

WARP_SUCCESS=false

# 1. If WARP_WG_CONF is explicitly provided, try it first
if [ -n "${WARP_WG_CONF:-}" ]; then
  printf '%s\n' "$WARP_WG_CONF" > "$TMP/wg.conf"
  chmod 600 "$TMP/wg.conf"
  sed -i 's/engage.cloudflareclient.com/162.159.192.1/g' "$TMP/wg.conf" 2>/dev/null || true
  if start_and_verify_wireproxy; then
    WARP_SUCCESS=true
  else
    echo "--> WARNING: Existing WARP_WG_CONF failed health check; regenerating with wgcf..."
  fi
fi

# 2. If no WARP_WG_CONF or it failed, generate a fresh profile with wgcf
if [ "$WARP_SUCCESS" = false ]; then
  if generate_fresh_warp_conf; then
    if start_and_verify_wireproxy; then
      WARP_SUCCESS=true
    else
      echo "--> WARNING: Fresh wgcf WARP proxy failed connectivity test"
    fi
  else
    echo "--> WARNING: Failed to generate fresh WARP profile with wgcf"
  fi
fi

if [ "$WARP_SUCCESS" = false ]; then
  echo "--> Running without WARP (direct connection)"
  export WARP_PROXY=""
fi

"$@"
exit $?
