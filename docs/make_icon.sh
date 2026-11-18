#!/bin/bash
# Renders docs/icon.svg to .claude-plugin/icon.png (1024×1024) with headless Chrome:  bash docs/make_icon.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
{ echo '<!doctype html><style>html,body{margin:0}svg{display:block;width:512px;height:512px}</style>'; cat "$ROOT/docs/icon.svg"; } > "$TMP/icon.html"
nice -n 10 "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
  --user-data-dir="$TMP/profile" --window-size=512,512 --force-device-scale-factor=2 \
  --screenshot="$ROOT/.claude-plugin/icon.png" "file://$TMP/icon.html" >/dev/null 2>&1
file "$ROOT/.claude-plugin/icon.png"
