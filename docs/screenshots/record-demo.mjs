// Records the demo like a screen recording: one headless Chrome driven over the DevTools protocol, a real mouse
// (hover, Ctrl+wheel zoom, clicks, typing) and a drawn cursor, 30 frames a second. Writes docs/screenshots/demo.mp4
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

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: CURSOR });
await send('Page.navigate', { url: PAGE });
await run('new Promise((r) => { const wait = () => (window.__diagram ? r() : setTimeout(wait, 50)); wait(); })');

// ---------- frames ----------
let frame = 0, lastFile = null;
const settle = () => run('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
async function shoot() {                               // one new frame of whatever is on screen now
  await settle();
  const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  lastFile = join(frames, `${String(frame++).padStart(5, '0')}.jpg`);
  writeFileSync(lastFile, Buffer.from(data, 'base64'));
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
async function type(text) {
  for (const ch of text) {
    await send('Input.insertText', { text: ch });
    await hold(0.12);
  }
}

// ---------- where things are ----------
const centre = (selector) => run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
// a table's header or one of its rows, in window coordinates
const tableAt = (id, column = null) => run(`(() => {
  const v = window.__diagram.view, t = v.diagram.tables[v.diagram.indexById.get(${JSON.stringify(id)})];
  const row = ${JSON.stringify(column)} === null ? -1 : t.columns.findIndex((c) => c[0] === ${JSON.stringify(column)});
  const y = row < 0 ? t.y + LAYOUT.cardHead / 2 : t.y + LAYOUT.cardHead + (row + 0.5) * LAYOUT.row;
  return [(t.x + LAYOUT.cardW * 0.4) * v.zoom + v.tx, y * v.zoom + v.ty];
})()`);

// ---------- the story ----------
await pointer('mouseMoved');
await hold(1.0);                                       // the whole store
await moveTo(await tableAt('orders.orders'));
await zoomInTo(1);                                     // pinch into the orders table
await hold(0.3);
await moveTo(await tableAt('orders.orders', 'user_id'));   // a column row lights up its link
await hold(0.7);
await moveTo(await tableAt('orders.orders'));
await click();                                         // the table: its links and the panel
await hold(1.6);
await moveTo(await centre('#mode-button'));
await click();                                         // keys only
await moveTo(await centre('#zoom-fit'));
await click();                                         // the whole store fits
await hold(1.6);
await moveTo(await centre('#mode-button'));
await click();
await moveTo(await centre('#search-button'));
await click();
await type('pay');
await hold(0.5);
await moveTo(await centre('#results li:nth-child(2) button'));
await click();                                         // jump to the payments table
await hold(1.6);
await moveTo(await centre('#export-button'));
await click();                                         // export: copy or download DBML and SQL
await hold(1.4);

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
