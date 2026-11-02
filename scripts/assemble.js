// Final edit: my cleaned voice (1.1x) + face clips (background swapped) + visuals + powerful music + Infax intro/outro.
// Usage: node scripts/assemble.js <script.json> <work_dir>
//   work_dir holds: recording.mp4, edit.json (process.py), faces/take_*.mp4 (matte.py)
// Stages are resumable (each output is skipped when it already exists). Output: work_dir/final.mp4 + thumb.jpg
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT, log, aiJson, fluxImage } from './lib.js';

const [scriptPath, workArg] = process.argv.slice(2);
const work = path.resolve(workArg);                         // concat lists need absolute paths
const S = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const E = JSON.parse(fs.readFileSync(path.join(work, 'edit.json'), 'utf8'));
const REC = path.join(work, 'recording.mp4');
const SPEED = 1.1, FPS = 30, SHOT = 6;                      // a new visual about every 6 s (recording time)
const dirs = Object.fromEntries(['img', 'cards', 'clips', 'voice'].map(d => [d, path.join(work, d)]));
Object.values(dirs).forEach(d => fs.mkdirSync(d, { recursive: true }));
const ff = (args, opts = {}) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
const dur = f => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
const frames = s => Math.round(s * FPS);
const VENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
const statePath = path.join(work, 'assemble_state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 1));

// ---------- 1. shot plan ----------
const takes = E.takes.filter(t => t.ok);
if (!state.shots) {
  const shots = [];
  for (const t of takes) {
    const seg = S.segments[t.seg];
    const len = t.pieces.reduce((n, p) => n + p[1] - p[0], 0);
    if (seg.show === 'face' && t.faceOk) {
      t.pieces.forEach((p, i) => shots.push({ seg: t.seg, kind: 'face', file: `faces/take_${String(t.seg).padStart(3, '0')}_${i}.mp4`, frames: frames(p[1] - p[0]) }));
      continue;
    }
    // visual segment: first the planned graphic, then fresh images every ~6 s
    const n = Math.max(1, Math.round(len / SHOT));
    const total = t.pieces.reduce((k, p) => k + frames(p[1] - p[0]), 0);
    for (let i = 0; i < n; i++) {
      const kind = i === 0 && ['map', 'source', 'name'].includes(seg.show) ? seg.show : 'image';
      shots.push({ seg: t.seg, kind, frames: Math.floor(total / n) + (i < total % n ? 1 : 0), prompt: i === 0 && seg.show === 'image' ? seg.prompt : null });
    }
  }
  // images still without a prompt (extra shots, bad-face fallbacks, card backgrounds) get one per chapter call
  const need = shots.filter(s => (s.kind === 'image' && !s.prompt) || ['source', 'name'].includes(s.kind));
  const byCh = {};
  need.forEach(s => (byCh[S.segments[s.seg].chapter] ||= []).push(s));
  for (const [ch, list] of Object.entries(byCh)) {
    const { data } = await aiJson(`Documentary "${S.topic}". For each numbered narration line write ONE English image prompt for a
moody documentary illustration that shows what the line is about. Anonymous people only (faces turned away or in
shadow), never a real person's face, no text in the image, varied shots (wide, close detail, aerial, interior).
${list.map((s, i) => `${i + 1}. ${S.segments[s.seg].text}`).join('\n')}
Return JSON: {"prompts":["...", ...]} with exactly ${list.length} prompts in order.`,
    { check: d => { if (!(d.prompts?.length >= list.length)) throw new Error('too few prompts'); return d; } });
    list.forEach((s, i) => { s.prompt = data.prompts[i]; });
    log(`prompts chapter ${ch}: ${list.length}`);
  }
  shots.forEach((s, i) => { s.i = i; });
  state.shots = shots; save();
}
const shots = state.shots;
log(`shots: ${shots.length} (${shots.filter(s => s.kind === 'face').length} face)`);

// ---------- 2. images (FLUX; quota-aware: stops and resumes next run) ----------
for (const s of shots.filter(s => s.prompt)) {
  s.img = path.join('img', `${s.i}.jpg`);
  if (fs.existsSync(path.join(work, s.img))) continue;
  try { await fluxImage(s.prompt, path.join(work, s.img), { width: 1344, height: 768 }); }
  catch (e) {
    if (/4006|quota|daily|neuron/i.test(e.message)) { save(); log('image quota reached; resume on the next run'); process.exit(3); }
    throw e;
  }
}
save();

// ---------- 3. cards ----------
const jobs = [];
for (const s of shots.filter(s => ['map', 'source', 'name'].includes(s.kind))) {
  const seg = S.segments[s.seg];
  s.card = path.join('cards', `${s.i}.png`);
  const out = path.join(work, s.card), bg = s.img ? path.join(work, s.img) : null;
  if (s.kind === 'map' && seg.map?.lon != null) jobs.push({ type: 'map', out, lon: seg.map.lon, lat: seg.map.lat, label: seg.map.label || seg.map.place });
  else if (s.kind === 'source' && seg.card?.quote) jobs.push({ type: 'source', out, source: seg.card.source, quote: seg.card.quote, bg });
  else if (s.kind === 'name' && seg.card?.name) jobs.push({ type: 'name', out, name: seg.card.name, role: seg.card.role || '', bg });
  else s.card = null;                                      // plan incomplete → its picture is shown instead
}
fs.writeFileSync(path.join(work, 'cards.json'), JSON.stringify(jobs));
execFileSync('python', ['-I', path.join(ROOT, 'scripts', 'cards.py'), path.join(work, 'cards.json')], { stdio: 'inherit' });
save();

// ---------- 4. shot clips (exact frame counts) ----------
const MOVES = ['in', 'right', 'out', 'left'];
shots.forEach((s, k) => {
  const out = path.join(dirs.clips, `${String(k).padStart(4, '0')}.mp4`);
  s.clip = out;
  if (fs.existsSync(out)) return;
  const N = s.frames, d = (N / FPS).toFixed(3);
  if (s.kind === 'face') {
    const src = path.join(work, s.file);
    if (!fs.existsSync(src)) throw new Error(`missing face clip ${s.file} (matte step not finished)`);
    ff(['-i', src, '-vf', `fps=${FPS},tpad=stop_mode=clone:stop_duration=2`, '-frames:v', String(N), ...VENC, '-an', out + '.tmp.mp4']);
  } else {
    const still = path.join(work, s.card || s.img || '');
    if (!s.card && !s.img) throw new Error(`shot ${k} has no picture`);
    const mv = s.card ? 'card' : MOVES[k % MOVES.length];
    // slow push / pan (Ken Burns); cards get a gentle 4 % push only
    const z = mv === 'card' ? 0.04 : 0.1;
    const vf = mv === 'in' || mv === 'card' ? `scale=2304:1296,zoompan=z='1+${z}*on/${N}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${N}:s=1920x1080:fps=${FPS}`
      : mv === 'out' ? `scale=2304:1296,zoompan=z='1+${z}-${z}*on/${N}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${N}:s=1920x1080:fps=${FPS}`
      : `scale=2208:1242,crop=1920:1080:x='${mv === 'right' ? '' : '288-'}288*n/${N}':y=81`;
    ff(['-loop', '1', '-framerate', String(FPS), '-i', still, '-vf', `${vf},setsar=1,format=yuv420p`, '-frames:v', String(N), ...VENC, '-an', out + '.tmp.mp4']);
  }
  fs.renameSync(out + '.tmp.mp4', out);
});
log('clips ready');

// ---------- 5. voice: pieces in order, cleaned, loud, 1.1x ----------
const voice = path.join(work, 'voice.wav');
if (!fs.existsSync(voice)) {
  const list = [];
  let n = 0;
  for (const t of takes) for (const [a, b] of t.pieces) {
    const f = path.join(dirs.voice, `${String(n++).padStart(4, '0')}.wav`);
    if (!fs.existsSync(f)) ff(['-ss', a.toFixed(3), '-i', REC, '-t', ((frames(b - a)) / FPS).toFixed(3), '-vn', '-ac', '1', '-ar', '48000',
      '-af', 'afade=t=in:d=0.015,areverse,afade=t=in:d=0.02,areverse', f]);
    list.push(`file '${f.replace(/\\/g, '/')}'`);
  }
  fs.writeFileSync(path.join(work, 'voice_list.txt'), list.join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', path.join(work, 'voice_list.txt'),
    // noise clean → presence → punchy compression (loud like big Hindi explainer channels) → 1.1x (pitch kept)
    '-af', 'highpass=f=80,afftdn=nf=-25:tn=1,equalizer=f=200:t=q:w=1:g=-2,equalizer=f=3500:t=q:w=1.2:g=3,' +
    'acompressor=threshold=-22dB:ratio=4:attack=5:release=120:makeup=5,atempo=' + SPEED + ',alimiter=limit=0.95:level=false',
    voice + '.tmp.wav']);
  fs.renameSync(voice + '.tmp.wav', voice);
}

// ---------- 6. picture: concat → 1.1x → Infax logo ----------
const body = path.join(work, 'body_video.mp4');
if (!fs.existsSync(body)) {
  fs.writeFileSync(path.join(work, 'clips.txt'), shots.map(s => `file '${s.clip.replace(/\\/g, '/')}'`).join('\n'));
  // the logo input loops (a single PNG frame vanished from the overlay after ~20 s in the first test)
  ff(['-f', 'concat', '-safe', '0', '-i', path.join(work, 'clips.txt'), '-loop', '1', '-i', path.join(ROOT, 'brand', 'infax-logo.png'),
    '-filter_complex', `[0:v]setpts=PTS/${SPEED},fps=${FPS}[v];[1:v]scale=110:-1,format=rgba,colorchannelmixer=aa=0.8[l];[v][l]overlay=W-w-40:36:shortest=1[o]`,
    '-map', '[o]', ...VENC, body + '.tmp.mp4']);
  fs.renameSync(body + '.tmp.mp4', body);
}

// ---------- 7. music bed: powerful, ducked under the voice, louder in gaps ----------
const mix = path.join(work, 'mix.wav');
if (!fs.existsSync(mix)) {
  const tracks = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'music.json'), 'utf8')).sort(() => Math.random() - 0.5);
  const files = [];
  for (const t of tracks) {
    let f = t.file ? path.join(ROOT, t.file) : path.join(work, `music_${files.length}.mp3`);
    if (t.url && !fs.existsSync(f)) {
      try { const r = await fetch(t.url); if (!r.ok) continue; fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); } catch { continue; }
    }
    if (fs.existsSync(f)) files.push(f);
  }
  const total = dur(voice);
  const bed = []; let covered = 0;
  while (covered < total + 5) { const f = files[bed.length % files.length]; bed.push(f); covered += dur(f) - 3; }
  let g = bed.map((_, i) => `[${i + 1}:a]aresample=48000,loudnorm=I=-16:TP=-2,aformat=channel_layouts=stereo[m${i}]`).join(';') + ';';
  let last = '[m0]';
  for (let i = 1; i < bed.length; i++) { g += `${last}[m${i}]acrossfade=d=3[x${i}];`; last = `[x${i}]`; }
  g += `${last}atrim=0:${total.toFixed(2)},afade=t=out:st=${(total - 4).toFixed(2)}:d=4,volume=-11dB[m];` +
    `[0:a]aformat=channel_layouts=stereo,asplit[v1][v2];[m][v1]sidechaincompress=threshold=0.04:ratio=3:attack=30:release=500[md];` +
    `[v2][md]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=9[out]`;
  ff(['-i', voice, ...bed.flatMap(f => ['-i', f]), '-filter_complex', g, '-map', '[out]', '-ar', '48000', mix + '.tmp.wav']);
  fs.renameSync(mix + '.tmp.wav', mix);
  state.music = bed.map(f => path.basename(f)); save();
}

// ---------- 8. intro + body + outro ----------
const final = path.join(work, 'final.mp4');
if (!fs.existsSync(final)) {
  const bodyAv = path.join(work, 'body.mp4');
  ff(['-i', body, '-i', mix, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest', bodyAv]);
  const norm = (src, dst) => { if (!fs.existsSync(dst)) ff(['-i', src, '-vf', `scale=1920:1080,fps=${FPS},setsar=1`, ...VENC, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', dst]); };
  norm(path.join(ROOT, 'assets', 'intro.mp4'), path.join(work, 'intro_n.mp4'));
  norm(path.join(ROOT, 'assets', 'outro.mp4'), path.join(work, 'outro_n.mp4'));
  fs.writeFileSync(path.join(work, 'final.txt'), ['intro_n.mp4', 'body.mp4', 'outro_n.mp4'].map(f => `file '${path.join(work, f).replace(/\\/g, '/')}'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', path.join(work, 'final.txt'), '-c', 'copy', '-movflags', '+faststart', final + '.tmp.mp4']);
  fs.renameSync(final + '.tmp.mp4', final);
}

// ---------- 9. preflight ----------
const L = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', final, '-af', 'ebur128', '-f', 'null', '-']).stderr.toString();
const lufs = [...L.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop()?.[1];
state.final = { minutes: +(dur(final) / 60).toFixed(2), lufs: lufs ? +lufs : null, sizeMB: Math.round(fs.statSync(final).size / 1e6) };
save();
log('FINAL', JSON.stringify(state.final));
