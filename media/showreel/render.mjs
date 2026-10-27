// Renders showreel.html frame by frame through headless Edge and encodes an MP4.
//
//   node render.mjs                     full render to ../hima-showreel.mp4
//   node render.mjs --stills 1,4.2,16   PNG stills (no motion blur) into ./stills
//   node render.mjs --sheet 0.5         contact sheet, one tile every 0.5 s
//   node render.mjs --from 12 --to 16 --out clip.mp4
//
// Each output frame is the average of several sub-frames spread over a 180°
// shutter, so fast moves get real motion blur. The number of sub-frames per
// frame comes from how far things move on screen (see measure() in the page).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..', '..');
const PAGE = '/media/showreel/showreel.html';
const W = 1920, H = 1080;

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));

const FPS = Number(args.fps || 60);
const SHUTTER = 0.5 / FPS;            // 180° shutter
const MAX_SUB = Number(args.maxsub || 24);
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FFMPEG = process.env.FFMPEG || 'C:/Program Files/BlueStacks_nxt/ffmpeg.exe';

// ---------- static server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------- minimal CDP client ----------
class CDP {
  constructor(url) {
    this.id = 0; this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        console.error('page error:', m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        console.log('page:', m.params.args.map(a => a.value ?? a.description).join(' '));
      }
    };
    this.open = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hima-reel-'));
  const proc = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`, '--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--run-all-compositor-stages-before-draw', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find(t => t.type === 'page');
    if (!target) await new Promise(r => setTimeout(r, 100));
  }
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.open;
  return { cdp, proc, profile };
}

// ---------- PNG decode / encode ----------
function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported png'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp) throw new Error('png color type ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.allocUnsafe(w * h * 3);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const off = y * (stride + 1), f = raw[off];
    for (let x = 0; x < stride; x++) {
      const v = raw[off + 1 + x];
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let r;
      switch (f) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        default: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      }
      cur[x] = r;
    }
    let o = y * w * 3;
    if (bpp === 3) out.set(cur, o);
    else for (let x = 0; x < w; x++) { out[o++] = cur[x * 4]; out[o++] = cur[x * 4 + 1]; out[o++] = cur[x * 4 + 2]; }
    const t = prev; prev = cur; cur = t;
  }
  return { w, h, rgb: out };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- linear-light accumulation ----------
const TO_LIN = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
const LUT_N = 16384;
const TO_SRGB = new Float32Array(LUT_N + 1).map((_, i) => { const c = i / LUT_N; return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); });
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const DITHER = new Float32Array(1 << 16).map(() => rnd() - rnd());   // triangular, ±1 LSB

function resolve(acc, n) {
  const out = Buffer.allocUnsafe(acc.length);
  const k = LUT_N / n;
  let d = (Math.random() * 65536) | 0;
  for (let i = 0; i < acc.length; i++) {
    let li = acc[i] * k; li = li < 0 ? 0 : li > LUT_N ? LUT_N : li;
    const v = TO_SRGB[li | 0] + DITHER[(d++) & 65535] * 0.5;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return out;
}

// ---------- main ----------
const srv = await serve();
const url = `http://127.0.0.1:${srv.address().port}${PAGE}`;
const { cdp, proc } = await launch();
const cleanup = () => { try { proc.kill(); } catch { } srv.close(); };
process.on('exit', cleanup);

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url });
for (let i = 0; i < 300; i++) {
  if (await cdp.eval('typeof window.seek === "function" && window.__ready === true').catch(() => false)) break;
  await new Promise(r => setTimeout(r, 100));
}
const DURATION = await cdp.eval('window.DURATION');
console.log('page ready, duration', DURATION);

async function grab(t) {
  await cdp.eval(`seek(${t})`);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false });
  return Buffer.from(r.data, 'base64');
}

async function frameAt(t, blur = true) {
  let n = 1;
  if (blur) {
    const disp = await cdp.eval(`measure(${t}, ${SHUTTER})`);
    n = Math.max(1, Math.min(MAX_SUB, Math.ceil(disp / 2.5) + (disp > 0.75 ? 1 : 0)));
  }
  if (n === 1) return { rgb: decodePNG(await grab(t)).rgb, n };
  const acc = new Float32Array(W * H * 3);
  for (let i = 0; i < n; i++) {
    const ts = t + (i / (n - 1) - 0.5) * SHUTTER;
    const { rgb } = decodePNG(await grab(ts));
    for (let j = 0; j < rgb.length; j++) acc[j] += TO_LIN[rgb[j]];
  }
  return { rgb: resolve(acc, n), n };
}

if (args.bench) {
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) await grab(i * 0.1);
  const t1 = performance.now();
  const png = await grab(1);
  const t2 = performance.now();
  for (let i = 0; i < 10; i++) decodePNG(png);
  const t3 = performance.now();
  console.log(`grab ${((t1 - t0) / 20).toFixed(1)} ms, png ${(png.length / 1e6).toFixed(2)} MB, decode ${((t3 - t2) / 10).toFixed(1)} ms`);
  process.exit(0);
}

if (args.stills) {
  const dir = path.join(HERE, 'stills'); fs.mkdirSync(dir, { recursive: true });
  for (const s of String(args.stills).split(',')) {
    const t = Number(s);
    const { rgb } = await frameAt(t, !!args.blur);
    const file = path.join(dir, `still-${t.toFixed(2)}.png`);
    fs.writeFileSync(file, encodePNG(rgb, W, H));
    console.log('wrote', file);
  }
  process.exit(0);
}

if (args.sheet) {
  // Contact sheet: tiles of 384x216, 5 per row.
  const step = Number(args.sheet), from = Number(args.from || 0), to = Number(args.to || DURATION);
  const times = []; for (let t = from; t < to - 1e-6; t += step) times.push(+t.toFixed(4));
  const tw = 384, th = 216, cols = 5, rows = Math.ceil(times.length / cols), pad = 4;
  const SW = cols * (tw + pad) + pad, SH = rows * (th + pad + 18) + pad;
  const sheet = Buffer.alloc(SW * SH * 3, 40);
  for (let k = 0; k < times.length; k++) {
    const { rgb } = await frameAt(times[k], false);
    const ox = pad + (k % cols) * (tw + pad), oy = pad + Math.floor(k / cols) * (th + pad + 18) + 18;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < 5; sy++) for (let sx = 0; sx < 5; sx++) { const i = ((y * 5 + sy) * W + x * 5 + sx) * 3; r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; }
      const o = ((oy + y) * SW + ox + x) * 3; sheet[o] = r / 25; sheet[o + 1] = g / 25; sheet[o + 2] = b / 25;
    }
    // time label as a little bar code of bright pixels: one 4px tick per 0.5 s
    const ticks = Math.round(times[k] / 0.5);
    for (let q = 0; q < ticks; q++) for (let y = oy - 14; y < oy - 4; y++) for (let x = ox + q * 6; x < ox + q * 6 + 4 && x < ox + tw; x++) { const o = (y * SW + x) * 3; sheet[o] = q % 2 ? 255 : 255; sheet[o + 1] = q % 4 === 3 ? 200 : 255; sheet[o + 2] = q % 4 === 3 ? 61 : 255; }
  }
  const file = path.join(HERE, 'stills', `sheet-${from}-${to}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(sheet, SW, SH));
  console.log('wrote', file, times.length, 'tiles');
  process.exit(0);
}

// Full render
const from = Number(args.from || 0), to = Number(args.to || DURATION);
const out = path.resolve(HERE, args.out || path.join('..', 'hima-showreel.mp4'));
const audio = args.audio === 'none' ? null : path.resolve(HERE, args.audio || 'soundtrack.wav');
const ffArgs = ['-hide_banner', '-loglevel', 'warning', '-y',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0'];
if (audio && fs.existsSync(audio)) ffArgs.push('-ss', String(from), '-t', String(to - from), '-i', audio);
ffArgs.push(
  '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
  '-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-profile:v', 'high', '-rc', 'vbr', '-cq', '15', '-b:v', '0',
  '-maxrate', '45M', '-bufsize', '90M', '-bf', '3', '-spatial-aq', '1', '-temporal-aq', '1', '-g', String(FPS),
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
if (audio && fs.existsSync(audio)) ffArgs.push('-c:a', 'aac', '-b:a', '256k', '-ar', '48000');
ffArgs.push('-movflags', '+faststart', out);
const ff = spawn(FFMPEG, ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
const ffDone = new Promise(r => ff.on('close', r));

const total = Math.round((to - from) * FPS);
const started = performance.now();
let subTotal = 0;
for (let k = 0; k < total; k++) {
  const t = from + k / FPS;
  const { rgb, n } = await frameAt(t, !args['no-blur']);
  subTotal += n;
  if (!ff.stdin.write(rgb)) await new Promise(r => ff.stdin.once('drain', r));
  if (k % 30 === 0 || k === total - 1) {
    const el = (performance.now() - started) / 1000;
    process.stdout.write(`frame ${k + 1}/${total}  t=${t.toFixed(2)}s  sub=${n}  avg sub ${(subTotal / (k + 1)).toFixed(2)}  ${el.toFixed(0)}s elapsed, ~${(el / (k + 1) * (total - k - 1)).toFixed(0)}s left\n`);
  }
}
ff.stdin.end();
const code = await ffDone;
console.log(code === 0 ? `done: ${out}` : `ffmpeg exited with ${code}`);
process.exit(code || 0);
