# Records the README animation (docs/screenshots/demo.gif) from examples/storefront/diagram.html with headless
# Chrome and ffmpeg, one Chrome run at a time:  bash docs/screenshots/make_demo.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/examples/storefront/diagram.html"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
: > "$TMP/list.txt"
n=0

# one frame: how long it stays, and a script that sets the view after the viewer started
frame() {  # seconds, script
  n=$((n + 1))
  local name; name=$(printf '%03d' "$n")
  { cat "$SRC"; echo "<script>addEventListener('load', () => { const k = window.__diagram, v = k.view; $2 })</script>"; } > "$TMP/$name.html"
  nice -n 10 "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --user-data-dir="$TMP/profile" --window-size=1280,800 --force-device-scale-factor=1 --virtual-time-budget=3000 \
    --screenshot="$TMP/$name.png" "file://$TMP/$name.html" >/dev/null 2>&1
  printf "file '%s'\nduration %s\n" "$TMP/$name.png" "$1" >> "$TMP/list.txt"
}
TABLE="k.openAddress('overview--orders-orders');"    # the orders table selected, framed for reading

frame 2.0 ''                                          # the whole store
for t in 0.15 0.3 0.45 0.6 0.75 0.9 1; do             # zoom from the whole store to the orders table
  frame 0.08 "$TABLE const b = { z: v.zoom, x: v.tx, y: v.ty }; k.select(-1); k.fit();
    const a = { z: v.zoom, x: v.tx, y: v.ty }, t = $t, e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    v.zoom = a.z * Math.pow(b.z / a.z, e); v.tx = a.x + (b.x - a.x) * e; v.ty = a.y + (b.y - a.y) * e; v.fitted = false; k.draw();"
done
frame 2.6 "$TABLE"                                    # its links light up, its columns in the panel
frame 2.2 "k.setMode('keys'); $TABLE k.fit();"        # keys only: the whole store fits, orders still selected
frame 2.4 "$TABLE document.getElementById('search-button').click();
  const s = document.getElementById('search'); s.value = 'pay'; s.dispatchEvent(new Event('input'));"
frame 2.0 "$TABLE document.getElementById('export-button').click();"
printf "file '%s'\n" "$TMP/001.png" >> "$TMP/list.txt"   # the concat list wants the last file once more

nice -n 10 ffmpeg -loglevel error -y -f concat -safe 0 -i "$TMP/list.txt" \
  -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" \
  -loop 0 "$ROOT/docs/screenshots/demo.gif"
echo "demo.gif: $(wc -c < "$ROOT/docs/screenshots/demo.gif" | tr -d ' ') bytes, $n frames"
