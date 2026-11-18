// Records the demo like a screen recording of a person reading the schema: one headless Chrome driven over the
// DevTools protocol, a real mouse (hover, Ctrl+wheel pinch, clicks) and a drawn cursor, 30 frames a second. Writes
// docs/screenshots/demo.mp4 (for posts) and demo.gif (for the readme) from examples/storefront/diagram.html.
//   node docs/screenshots/record-demo.mjs
// Needs Node 22+ (WebSocket), Google Chrome and ffmpeg. Time in the video is frame-counted, not wall-clock.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// The page runs on the video's clock: every frame moves time on by 1/FPS, runs the timers that fall due (the column
// tip's delay, the end of a gesture) and the animation frames that wait (drawing, the camera ride). However long a
// screenshot takes, what happens on screen keeps the same pace, so nothing lags and then jumps.
const CLOCK = `(() => {
  const realNow = performance.now.bind(performance), realFrame = window.requestAnimationFrame.bind(window);
  const realTimeout = window.setTimeout.bind(window), realClear = window.clearTimeout.bind(window);
  let nextTimer = 1e9;
  const clock = window.__clock = { manual: false, now: 0, frames: [], timers: new Map(),
    start() { this.now = realNow(); this.manual = true; },
    tick(ms) {
      const end = this.now + ms;
      for (;;) {                                   // timers due in this frame, earliest first
        let due = null;
        for (const entry of this.timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        this.timers.delete(due[0]);
        this.now = Math.max(this.now, due[1].at);
        due[1].run();
      }
      this.now = end;                              // twice: a frame's callbacks ask for the drawing in the next one
      for (let pass = 0; pass < 2; pass++) for (const callback of this.frames.splice(0)) callback(this.now);
    } };
  performance.now = () => (clock.manual ? clock.now : realNow());
  window.requestAnimationFrame = (callback) => (clock.manual ? (clock.frames.push(callback), 0) : realFrame(callback));
  window.setTimeout = (callback, ms = 0, ...args) => {
    if (!clock.manual) return realTimeout(callback, ms, ...args);
    const id = nextTimer++;
    clock.timers.set(id, { at: clock.now + ms, run: () => callback(...args) });
    return id;
  };
  window.clearTimeout = (id) => { if (!clock.timers.delete(id)) realClear(id); };
})();`;

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
// headless Chrome asks pages to reduce motion; the camera ride is part of the story
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK });
await send('Page.addScriptToEvaluateOnNewDocument', { source: CURSOR });
await send('Page.navigate', { url: PAGE });
await run('new Promise((r) => { const wait = () => (window.__diagram ? r() : setTimeout(wait, 50)); wait(); })');
await run('window.__clock.start()');

// ---------- frames ----------
let frame = 0;
async function shoot() {                               // the page moves on by one frame, then a screenshot of it
  await run(`window.__clock.tick(${1000 / FPS})`);
  const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  writeFileSync(join(frames, `${String(frame++).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64'));
}

// ---------- the hand ----------
// A person's hand: each move starts and ends at rest (minimum-jerk speed), bows a little, takes longer the farther it
// goes (Fitts), a long one overshoots and comes back; while reading, the hand is never perfectly still.
let seed = 11;
const random = () => {                                 // the same walk on every run
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const smooth = (t) => t * t * t * (10 + t * (6 * t - 15));
const mouse = { x: WIDTH - 160, y: HEIGHT - 140 };
const pointer = (type, extra = {}) => send('Input.dispatchMouseEvent', { type, x: mouse.x, y: mouse.y, button: 'none', ...extra });
async function glide([x, y], seconds, bow) {
  const from = { ...mouse }, dx = x - from.x, dy = y - from.y, distance = Math.hypot(dx, dy) || 1;
  const cx = from.x + dx / 2 - (dy / distance) * bow, cy = from.y + dy / 2 + (dx / distance) * bow;
  const steps = Math.max(2, Math.round(seconds * FPS));
  for (let i = 1; i <= steps; i++) {
    const t = smooth(i / steps), u = 1 - t;
    mouse.x = u * u * from.x + 2 * u * t * cx + t * t * x;
    mouse.y = u * u * from.y + 2 * u * t * cy + t * t * y;
    await pointer('mouseMoved');
    await shoot();
  }
}
async function moveTo([x, y]) {
  const dx = x - mouse.x, dy = y - mouse.y, distance = Math.hypot(dx, dy);
  if (distance < 1) return;
  const seconds = 0.22 + 0.1 * Math.log2(1 + distance / 12);
  const bow = (random() - 0.5) * 0.25 * distance;
  if (distance < 220) return glide([x, y], seconds, bow);
  const over = Math.min(12, distance * 0.02);          // a little past the target, then back onto it
  await glide([x + (dx / distance) * over, y + (dy / distance) * over], seconds, bow);
  await glide([x, y], 0.18, 0);
}
async function hold(seconds, sway = 1.2) {             // rest on a spot: the hand drifts a pixel or so
  const base = { ...mouse }, a = random() * 6.3, b = random() * 6.3;
  for (let i = 1; i <= Math.round(seconds * FPS); i++) {
    const t = i / FPS;
    mouse.x = base.x + sway * (Math.sin(1.7 * t + a) - Math.sin(a));
    mouse.y = base.y + sway * (Math.sin(1.1 * t + b) - Math.sin(b));
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
// Ctrl+wheel like a trackpad pinch: eased, a little every frame. The viewer zooms by e^(−deltaY/100), but Chrome
// scales a synthetic wheel's delta (by the device pixel ratio here), so each step corrects by what the last one did.
async function pinch(zoom, seconds) {
  const from = await run('window.__diagram.view.zoom'), total = Math.log(zoom / from), steps = Math.round(seconds * FPS);
  let gain = 1;
  for (let i = 1; i <= steps; i++) {
    const before = await run('window.__diagram.view.zoom'), want = Math.log((from * Math.exp(total * smooth(i / steps))) / before);
    await pointer('mouseWheel', { deltaX: 0, deltaY: -want * 100 * gain, modifiers: 2 });
    const got = Math.log((await run('window.__diagram.view.zoom')) / before);
    if (Math.abs(got) > 1e-4 && Math.abs(want) > 1e-4) gain *= want / got;
    await shoot();
  }
}

// ---------- where things are ----------
const centre = (selector) => run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width * 0.35, r.y + r.height / 2]; })()`);
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
// Someone opens the store's schema and reads it: looks over the modules, pinches into orders, reads a few columns,
// clicks it, skims who points at it, then follows one line to users and looks around there.
await pointer('mouseMoved');
await hold(0.8);                                       // the whole store
for (const [id, rest] of [['accounts.users', 0.5], ['catalog.products', 0.4], ['shipping.shipments', 0.4], ['payments.payments', 0.3]]) {
  await moveTo(await tableAt(id));                     // looking the modules over
  await hold(rest);
}
await moveTo(await tableAt('orders.orders'));
await hold(0.4);
await pinch(0.62, 1.1);                                // into orders, until its columns read
await hold(0.3);
for (const [column, rest] of [['number', 1.1], ['user_id', 0.9], ['status', 1.1]]) {
  await moveTo(await tableAt('orders.orders', column)); // reading down the rows: notes, and a key's line
  await hold(rest);
}
await moveTo(await tableAt('orders.orders'));
await click();                                         // orders: all its links light up, the panel opens
await hold(0.6);
for (const [n, rest] of [[1, 0.3], [4, 0.35], [6, 0.5]]) {
  await moveTo(await centre(`#details-incoming li:nth-child(${n}) button`));   // skimming who points at orders
  await hold(rest);
}
await moveTo(await lineFrom('orders.orders', 'user_id', 60));   // back on the canvas, onto the line to users
await hold(1.3, 0.6);                                  // it thickens; the tip says where it leads
await click();                                         // the camera rides the line to users
await hold(0.6, 0.6);
await moveTo(await tableAt('accounts.teams'));          // looking around users: its neighbours and lines
await hold(0.5);
await moveTo(await tableAt('accounts.users', 'email'));
await hold(2.0);

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
