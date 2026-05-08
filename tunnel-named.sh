#!/usr/bin/env bash
# Iron Yard — named Cloudflare Tunnel (stable URL).
# Prereq: TUNNEL.md "Option B" one-time setup must be done first
# (cloudflared tunnel login, create iron-yard, route dns, write config.yml).

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "ERROR: cloudflared not found. See TUNNEL.md."
  exit 1
fi

if ! cloudflared tunnel list 2>/dev/null | grep -q iron-yard; then
  echo "ERROR: tunnel 'iron-yard' not found. Run the one-time setup in TUNNEL.md:"
  echo "  cloudflared tunnel login"
  echo "  cloudflared tunnel create iron-yard"
  echo "  cloudflared tunnel route dns iron-yard play.yourdomain.com"
  echo "and create ~/.cloudflared/config.yml"
  exit 1
fi

echo "=== Building client ==="
npm --prefix client install --no-audit --no-fund
npm --prefix client run build

echo "=== Installing server deps ==="
npm --prefix server install --no-audit --no-fund

echo "=== Starting server on :8080 ==="
node server/src/index.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT INT TERM

sleep 2

echo "=== Running named tunnel 'iron-yard' ==="
echo "=== Game served at the hostname you configured (see TUNNEL.md) ==="
echo

cloudflared tunnel run iron-yard
