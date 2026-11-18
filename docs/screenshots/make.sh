#!/bin/bash
# Retakes the README screenshots from examples/storefront/diagram.html with headless Chrome (macOS path),
# one Chrome run at a time:  bash docs/screenshots/make.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/docs/screenshots"
SRC="$ROOT/examples/storefront/diagram.html"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# a copy of the page with a script that runs after the viewer started: sets a view the address cannot
variant() {  # name, script
  sed "s#</body>#<script>$2</script></body>#" "$SRC" > "$TMP/$1.html"
}
# a table selected, framed with its whole module at a readable zoom (the address alone would centre the card)
frame() { echo "const k=window.__diagram,v=k.view;k.openAddress('$1');v.zoom=0.85;v.tx=40;v.ty=96;v.fitted=false;k.draw();"; }
variant base ''
variant keys "window.__diagram.setMode('keys')"
variant table "$(frame orders--orders-orders)"
variant product "$(frame catalog--catalog-products)"

shot() {  # file, page, extra flags
  nice -n 10 "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --user-data-dir="$TMP/profile" --window-size=1440,900 --force-device-scale-factor=2 --virtual-time-budget=3000 \
    ${3:-} --screenshot="$OUT/$1" "file://$TMP/$2.html" >/dev/null 2>&1
  echo "$1: $(wc -c < "$OUT/$1" | tr -d ' ') bytes"
}
shot overview.png base
shot table.png table
shot keys.png keys
shot dark.png product --force-dark-mode
