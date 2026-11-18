# Records the README animation (docs/screenshots/demo.gif) and a video for posts (docs/screenshots/demo.mp4) from
# examples/storefront/diagram.html with headless Chrome and ffmpeg, one Chrome run at a time:
#   bash docs/screenshots/make_demo.sh
# Frames are taken at twice the pixel density and scaled down, so the text stays sharp.
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
    --user-data-dir="$TMP/profile" --window-size=1280,800 --force-device-scale-factor=2 --virtual-time-budget=3000 \
    --screenshot="$TMP/$name.png" "file://$TMP/$name.html" >/dev/null 2>&1
  printf "file '%s'\nduration %s\n" "$TMP/$name.png" "$1" >> "$TMP/list.txt"
}
TABLE="k.openAddress('overview--orders-orders');"    # the orders table selected, framed for reading

frame 2.0 ''                                          # the whole store
for t in 0.08 0.16 0.25 0.34 0.43 0.52 0.61 0.7 0.79 0.87 0.94 1; do   # zoom from the whole store to the orders table
  frame 0.05 "$TABLE const b = { z: v.zoom, x: v.tx, y: v.ty }; k.select(-1); k.fit();
    const a = { z: v.zoom, x: v.tx, y: v.ty }, t = $t, e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    v.zoom = a.z * Math.pow(b.z / a.z, e); v.tx = a.x + (b.x - a.x) * e; v.ty = a.y + (b.y - a.y) * e; v.fitted = false; k.draw();"
done
frame 2.6 "$TABLE"                                    # its links light up, its columns in the panel
frame 2.2 "k.setMode('keys'); $TABLE k.fit();"        # keys only: the whole store fits, orders still selected
frame 2.4 "$TABLE document.getElementById('search-button').click();
  const s = document.getElementById('search'); s.value = 'pay'; s.dispatchEvent(new Event('input'));"
frame 2.0 "$TABLE document.getElementById('export-button').click();"
printf "file '%s'\n" "$TMP/001.png" >> "$TMP/list.txt"   # the concat list wants the last file once more

# GIF for the readme: 1280 wide, full palette, error-diffusion dither (no grid pattern on flat colours)
nice -n 10 ffmpeg -loglevel error -y -f concat -safe 0 -i "$TMP/list.txt" \
  -vf "fps=20,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a" \
  -loop 0 "$ROOT/docs/screenshots/demo.gif"
# video for Reddit and X: full 2560 frames scaled to 1920, H.264 that every player opens
nice -n 10 ffmpeg -loglevel error -y -f concat -safe 0 -i "$TMP/list.txt" \
  -vf "fps=30,scale=1920:-2:flags=lanczos,format=yuv420p" -c:v libx264 -preset slow -crf 18 -movflags +faststart \
  "$ROOT/docs/screenshots/demo.mp4"
for f in demo.gif demo.mp4; do echo "$f: $(wc -c < "$ROOT/docs/screenshots/$f" | tr -d ' ') bytes"; done
echo "$n frames"
