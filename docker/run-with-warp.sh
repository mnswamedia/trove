#!/usr/bin/env bash
# Usage: run-with-warp <command...>
# Starts wireproxy (WARP SOCKS5 on 127.0.0.1:$WARP_PORT) if WARP_WG_CONF is set,
# exports WARP_PROXY for ingest.py, runs the command, then cleans up.
set -uo pipefail

PORT="${WARP_PORT:-40000}"
WP_PID=""
TMP="$(mktemp -d)"

cleanup() {
  [ -n "$WP_PID" ] && kill "$WP_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ -n "${WARP_WG_CONF:-}" ]; then
  printf '%s\n' "$WARP_WG_CONF" > "$TMP/wg.conf"
  chmod 600 "$TMP/wg.conf"
  cat > "$TMP/wireproxy.conf" <<CONF
WGConfig = $TMP/wg.conf

[Socks5]
BindAddress = 127.0.0.1:$PORT
CONF

  wireproxy -s -c "$TMP/wireproxy.conf" &
  WP_PID=$!

  for _ in $(seq 1 50); do
    timeout 0.2 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/$PORT" 2>/dev/null && break
    sleep 0.1
  done

  if curl -s -o /dev/null -m 8 -x "socks5h://127.0.0.1:$PORT" https://www.youtube.com/generate_204; then
    export WARP_PROXY="socks5://127.0.0.1:$PORT"
    echo "--> WARP proxy up on $WARP_PROXY"
  else
    echo "--> WARNING: WARP proxy failed health check; continuing without it"
    kill "$WP_PID" 2>/dev/null || true
    WP_PID=""
    export WARP_PROXY=""
  fi
else
  echo "--> WARP_WG_CONF not set; running without WARP"
  export WARP_PROXY=""
fi

"$@"
exit $?

