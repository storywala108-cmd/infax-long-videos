// Thumbnail 1280x720: my best face frame (background already swapped) on the right + a big Hindi hook on the left.
// Rendered by headless Chrome (correct Devanagari shaping; Pillow lacks raqm). Text = 3-5 big words, digits 0-9.
// Usage: node scripts/thumb.js <script.json> <work_dir>   → work_dir/thumb.jpg
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, log, aiJson } from './lib.js';

const [scriptPath, workArg] = process.argv.slice(2);
const work = path.resolve(workArg);
const S = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const E = JSON.parse(fs.readFileSync(path.join(work, 'edit.json'), 'utf8'));

// face: middle frame of the take where my face looked best (fallback: first AI image)
const best = E.takes.filter(t => t.ok && t.faceOk).sort((a, b) => b.faceGood - a.faceGood)[0];
const face = path.join(work, 'thumb_face.jpg');
if (best) {
  const clip = path.join(work, 'faces', `take_${String(best.seg).padStart(3, '0')}_0.mp4`);
  if (fs.existsSync(clip)) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', '1.0', '-i', clip, '-frames:v', '1', '-q:v', '2', face]);
}
const img = fs.existsSync(face) ? face : path.join(work, 'img', fs.readdirSync(path.join(work, 'img'))[0]);

const { data } = await aiJson(`YouTube thumbnail text for a Hindi documentary titled "${S.title_hi}" (${S.topic}).
Write a curiosity hook of 3-5 BIG words in Hindi (Devanagari), may include one English word in Latin letters, numbers as
0-9 digits, must be true to the story (no clickbait lies). Mark the 1-2 most important words for yellow.
Return JSON: {"line1":"...","line2":"...","yellow":["word", ...]}`,
{ check: d => { if (!d.line1) throw new Error('no text'); return d; } });
const fix = s => String(s || '').replace(/[०-९]/g, d => '०१२३४५६७८९'.indexOf(d));
const paint = s => fix(s).split(' ').map(w => (data.yellow || []).some(y => w.includes(y)) ? `<span class="y">${w}</span>` : w).join(' ');

// font embedded as data: URL — a file:// font did not load (thin system fallback), and Linux runners have no Hindi font
const font = 'data:font/ttf;base64,' + fs.readFileSync(path.join(ROOT, 'fonts', 'Mukta-ExtraBold.ttf')).toString('base64');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:M;font-weight:800;src:url('${font}') format('truetype')}
html,body{margin:0;width:1280px;height:720px;overflow:hidden;background:#111}
.bg{position:absolute;inset:0;background:url('${pathToFileURL(img).href}') center/cover;transform:translateX(18%)}
.fade{position:absolute;inset:0;background:linear-gradient(90deg,#000 0%,rgba(0,0,0,.92) 38%,rgba(0,0,0,.25) 62%,rgba(0,0,0,0) 80%)}
.t{position:absolute;left:46px;top:50%;transform:translateY(-50%);width:640px;font-family:M;color:#fff;line-height:1.08;
  font-size:112px;font-weight:800;-webkit-text-stroke:4px #000;paint-order:stroke fill;text-shadow:0 6px 18px rgba(0,0,0,.8)}
.y{color:#ffd400}.bar{position:absolute;left:46px;bottom:52px;width:150px;height:12px;background:#e11d2a}
.logo{position:absolute;right:28px;top:24px;width:110px}
</style></head><body><div class="bg"></div><div class="fade"></div>
<div class="t">${paint(data.line1)}<br>${paint(data.line2)}</div><div class="bar"></div>
<img class="logo" src="${pathToFileURL(path.join(ROOT, 'brand', 'infax-logo.png')).href}"></body></html>`;
const htmlPath = path.join(work, 'thumb.html');
fs.writeFileSync(htmlPath, html);

const chrome = ['google-chrome', 'chromium', 'chromium-browser', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
  .find(c => { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
if (!chrome) { log('no Chrome → no thumbnail'); process.exit(0); }
const png = path.join(work, 'thumb.png');
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--window-size=1280,720',
  `--screenshot=${png}`, pathToFileURL(htmlPath).href], { stdio: 'ignore', timeout: 60000 });
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', png, '-q:v', '2', path.join(work, 'thumb.jpg')]);
log('thumbnail', fix(data.line1), '/', fix(data.line2));
