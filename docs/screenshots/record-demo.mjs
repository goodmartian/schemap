// Records the demo like a screen recording: one headless Chrome driven over the DevTools protocol, a real mouse
// (hover, Ctrl+wheel zoom, a click) and a drawn cursor, 30 frames a second. Writes docs/screenshots/demo.mp4
// (for posts) and demo.gif (for the readme) from examples/storefront/diagram.html.
//   node docs/screenshots/record-demo.mjs
// Needs Node 22+ (WebSocket), Google Chrome and ffmpeg. Time in the video is frame-counted, not wall-clock.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = pathToFileURL(join(ROOT, 'examples', 'storefront', 'diagram.html')).href;
const OUT = join(ROOT, 'docs', 'screenshots');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FPS = 30, WIDTH = 1280, HEIGHT = 800;
const frames = mkdtempSync(join(tmpdir(), 'schemap-demo-'));

// ---------- Chrome and the DevTools protocol ----------
const chrome = spawn('nice', ['-n', '10', CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', `--user-data-dir=${join(frames, 'profile')}`, '--remote-debugging-port=0', 'about:blank']);
const port = await new Promise((resolve, reject) => {
  let log = '';
  chrome.stderr.on('data', (chunk) => {
    log += chunk;
    const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(log);
    if (m) resolve(m[1]);
  });
  chrome.on('exit', () => reject(new Error(`Chrome exited:\n${log}`)));
});
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => { ws.onopen = resolve; });
let lastId = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (!pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++lastId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const run = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(`${expression}\n${exceptionDetails.exception?.description || exceptionDetails.text}`);
  return result.value;
};

// a cursor like macOS's, and a ring that spreads out on a click (its size is set per frame from here)
const CURSOR = `addEventListener('DOMContentLoaded', () => {
  const cursor = document.createElement('div'), ring = document.createElement('div');
  cursor.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5.5 3.2v15.6l4.2-4.1 2.7 6.1 2.6-1.1-2.7-6h5.9z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  Object.assign(cursor.style, { position: 'fixed', left: '-5.5px', top: '-3.2px', zIndex: 2147483647, pointerEvents: 'none',
    filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.35))' });
  Object.assign(ring.style, { position: 'fixed', left: 0, top: 0, width: '40px', height: '40px', marginLeft: '-20px', marginTop: '-20px',
    borderRadius: '50%', background: 'rgba(94,106,210,.25)', border: '2px solid rgba(94,106,210,.6)', zIndex: 2147483646,
    pointerEvents: 'none', opacity: 0 });
  ring.id = 'rec-ring';
  document.body.append(ring, cursor);
  const follow = (e) => { cursor.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; };
  addEventListener('pointermove', follow, true);
  addEventListener('pointerdown', follow, true);
});`;

// The page's animations (the camera riding along a line) run on its own clock. While a scene is filmed, that clock is
// the video's: each frame moves time on by 1/FPS and runs the animation frames that are waiting, so a 0.4 s ride is
// 0.4 s of video however long a screenshot takes.
const CLOCK = `(() => {
  const realNow = performance.now.bind(performance), realFrame = window.requestAnimationFrame.bind(window);
  const clock = window.__clock = { manual: false, now: 0, queue: [],
    start() { this.now = realNow(); this.manual = true; },
    stop() { this.manual = false; for (const callback of this.queue.splice(0)) realFrame(callback); },
    tick(ms) {                                     // twice: a frame's callbacks ask for the drawing in the next one
      this.now += ms;
      for (let pass = 0; pass < 2; pass++) for (const callback of this.queue.splice(0)) callback(this.now);
    } };
  performance.now = () => (clock.manual ? clock.now : realNow());
  window.requestAnimationFrame = (callback) => (clock.manual ? (clock.queue.push(callback), 0) : realFrame(callback));
})();`;

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
// headless Chrome asks pages to reduce motion; the camera ride is part of the story
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK });
await send('Page.addScriptToEvaluateOnNewDocument', { source: CURSOR });
await send('Page.navigate', { url: PAGE });
await run('new Promise((r) => { const wait = () => (window.__diagram ? r() : setTimeout(wait, 50)); wait(); })');

// ---------- frames ----------
let frame = 0, lastFile = null;
const settle = () => run(`window.__clock.manual ? window.__clock.tick(${1000 / FPS})
  : new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
async function shoot() {                               // one new frame of whatever is on screen now
  await settle();
  const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  lastFile = join(frames, `${String(frame++).padStart(5, '0')}.jpg`);
  writeFileSync(lastFile, Buffer.from(data, 'base64'));
}
async function film(seconds) {                         // the screen moves on its own: a shot for every frame
  for (let i = 0; i < Math.round(seconds * FPS); i++) await shoot();
}
async function hold(seconds) {                         // the screen stays: one shot, then copies of it
  await new Promise((r) => setTimeout(r, 200));        // let hover and gesture timers in the page settle first
  await shoot();
  for (let i = 1; i < Math.round(seconds * FPS); i++) copyFileSync(lastFile, join(frames, `${String(frame++).padStart(5, '0')}.jpg`));
}

// ---------- the mouse ----------
const mouse = { x: WIDTH - 140, y: HEIGHT - 120 };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const pointer = (type, extra = {}) => send('Input.dispatchMouseEvent', { type, x: mouse.x, y: mouse.y, button: 'none', ...extra });
async function moveTo([x, y]) {                        // eased, along a slight arc, slower over longer distances
  const from = { ...mouse }, distance = Math.hypot(x - from.x, y - from.y);
  const steps = Math.max(6, Math.round((0.3 + distance / 1600) * FPS));
  const bend = { x: -(y - from.y) * 0.12, y: (x - from.x) * 0.12 };
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps), arc = Math.sin(Math.PI * t);
    mouse.x = from.x + (x - from.x) * t + bend.x * arc;
    mouse.y = from.y + (y - from.y) * t + bend.y * arc;
    await pointer('mouseMoved');
    await shoot();
  }
}
async function click() {
  await pointer('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
  await pointer('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
  for (let i = 1; i <= 8; i++) {                       // the ring spreads and fades over 8 frames
    await run(`(() => { const r = document.getElementById('rec-ring'); r.style.transform = 'translate(${mouse.x}px, ${mouse.y}px) scale(${0.4 + i * 0.09})'; r.style.opacity = ${(1 - i / 8).toFixed(2)}; })()`);
    await shoot();
  }
}
async function zoomInTo(zoom) {                        // Ctrl+wheel, like a trackpad pinch, until the view reaches zoom
  for (let i = 0; i < 40 && (await run('window.__diagram.view.zoom')) < zoom; i++) {
    await pointer('mouseWheel', { deltaX: 0, deltaY: -9 - 6 * Math.sin(Math.min(1, i / 10) * Math.PI), modifiers: 2 });
    await shoot();
  }
}
// ---------- where things are ----------
// a table's header or one of its rows, in window coordinates
const tableAt = (id, column = null) => run(`(() => {
  const v = window.__diagram.view, t = v.diagram.tables[v.diagram.indexById.get(${JSON.stringify(id)})];
  const row = ${JSON.stringify(column)} === null ? -1 : t.columns.findIndex((c) => c[0] === ${JSON.stringify(column)});
  const y = row < 0 ? t.y + LAYOUT.cardHead / 2 : t.y + LAYOUT.cardHead + (row + 0.5) * LAYOUT.row;
  return [(t.x + LAYOUT.cardW * 0.4) * v.zoom + v.tx, y * v.zoom + v.ty];
})()`);

// a point on the reference line of a foreign key column, px screen pixels along it from its card
const lineFrom = (id, column, px) => run(`(() => {
  const v = window.__diagram.view, d = v.diagram, t = d.tables[d.indexById.get(${JSON.stringify(id)})];
  const p = d.edges[t.rowEdges[t.columns.findIndex((c) => c[0] === ${JSON.stringify(column)})][0]].path;   // starts at the key
  let left = ${px} / v.zoom;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const length = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
    if (left <= length) {
      const k = left / length, x = p[i] + (p[i + 2] - p[i]) * k, y = p[i + 1] + (p[i + 3] - p[i + 1]) * k;
      return [x * v.zoom + v.tx, y * v.zoom + v.ty];
    }
    left -= length;
  }
  throw new Error('the line is shorter than ${px} px');
})()`);

// ---------- the story ----------
// One walk: the whole store, a pinch towards orders, its links, then along one line to the table it points at.
await pointer('mouseMoved');
await hold(1.5);                                       // the whole store
await moveTo(await tableAt('orders.orders'));
await zoomInTo(0.62);                                  // a pinch towards orders, until its columns read
await hold(0.3);
await click();                                         // orders: its links light up, the panel opens
await hold(1.4);
await moveTo(await lineFrom('orders.orders', 'user_id', 60));   // onto the line to users
await new Promise((r) => setTimeout(r, 400));          // the tip comes after a moment
await hold(1.4);                                       // the line thickens, the tip says where it leads
await run('window.__clock.start()');
await click();                                         // the camera rides the line to users
await film(0.4);
await run('window.__clock.stop()');
await hold(3.0);                                       // users and every table that points at it

ws.close();
chrome.kill();

// ---------- video ----------
const ffmpeg = (...args) => execFileSync('nice', ['-n', '10', 'ffmpeg', '-loglevel', 'error', '-y', '-framerate', String(FPS),
  '-i', join(frames, '%05d.jpg'), ...args], { stdio: 'inherit' });
ffmpeg('-vf', 'scale=1920:-2:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
  '-movflags', '+faststart', join(OUT, 'demo.mp4'));
ffmpeg('-vf', 'fps=15,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a',
  '-loop', '0', join(OUT, 'demo.gif'));
rmSync(frames, { recursive: true, force: true });
console.log(`${frame} frames, ${(frame / FPS).toFixed(1)} s`);
