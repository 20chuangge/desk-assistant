#!/usr/bin/env bash
# Desk Hub on Linux / macOS. Same server as the desktop app, but reachable
# from your laptop and phone. For a permanent install use desk-hub.service.
set -euo pipefail
cd "$(dirname "$0")/.."

export HOST="${HOST:-0.0.0.0}"
export ASSIST_ALLOW_REMOTE="${ASSIST_ALLOW_REMOTE:-1}"
export PORT="${PORT:-4390}"

# The browser tools need a display; on a headless box either run Xvfb or set
# BROWSER_HEADLESS=1 (the tools will then drive Chrome without a window).
if [ -z "${DISPLAY:-}" ] && [ -z "${BROWSER_HEADLESS:-}" ]; then
  echo "  no DISPLAY found -> BROWSER_HEADLESS=1 (browser runs without a window)"
  export BROWSER_HEADLESS=1
fi

echo
echo "  Desk Hub starting on port ${PORT} (LAN + pairing code below)"
echo
exec node src/server.mjs
