#!/usr/bin/env bash
# Iron Yard — host on your PC + Cloudflare Quick Tunnel.
# No Cloudflare account / no domain required. Each run gets a fresh
# random https://*.trycloudflare.com URL. Share that URL with friends.
#
# First-time setup: install cloudflared:
#   macOS:  brew install cloudflare/cloudflare/cloudflared
#   Linux:  https://github.com/cloudflare/cloudflared/releases  (download binary, chmod +x, drop in PATH)

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "ERROR: cloudflared not found."
  echo "  macOS: brew install cloudflare/cloudflare/cloudflared"
  echo "  Linux: download from https://github.com/cloudflare/cloudflared/releases"
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

echo "=== Opening Cloudflare Quick Tunnel ==="
echo "=== Look for the https://*.trycloudflare.com URL below ==="
echo

cloudflared tunnel --url http://localhost:8080 --no-autoupdate
