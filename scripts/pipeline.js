// Orchestrator for the cloud jobs. Script status: waiting-recording → processing → preview → approved → published.
//   node scripts/pipeline.js next                 → prints the id of a script whose recording has arrived ("" if none)
//   node scripts/pipeline.js fetch <id> <work>    → downloads my recording file(s), joins + normalises → work/recording.mp4,
//                                                    also puts it on Drive ("Infax Work") for the parallel matte jobs
//   node scripts/pipeline.js pull <id> <work>     → (matte jobs) download that normalised recording
//   node scripts/pipeline.js preview <id> <work>  → final.mp4 → Drive "Infax Previews" (link), status preview
//   node scripts/pipeline.js publish <id>         → approved preview → YouTube (Infax), status published
//   node scripts/pipeline.js fail <id> <reason>   → back to waiting-recording with the reason (retried next run)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, env, log } from './lib.js';
import * as drive from './drive.js';

const [cmd, id, workArg] = process.argv.slice(2);
const work = workArg && path.resolve(workArg);              // ffmpeg concat lists resolve paths from the list's folder
const SDIR = path.join(ROOT, 'state', 'scripts');
const load = i => JSON.parse(fs.readFileSync(path.join(SDIR, `${i}.json`), 'utf8'));
const store = s => fs.writeFileSync(path.join(SDIR, `${s.id}.json`), JSON.stringify(s, null, 1));
const ff = a => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
const VIDEO = /\.(mp4|mov|mkv|m4v|3gp|webm)$/i;

if (cmd === 'next') {
  for (const f of fs.readdirSync(SDIR).filter(f => f.endsWith('.json')).sort()) {
    const s = JSON.parse(fs.readFileSync(path.join(SDIR, f), 'utf8'));
    if (s.status !== 'waiting-recording' || !s.recordingFolder) continue;
    const files = (await drive.list(s.recordingFolder)).filter(x => VIDEO.test(x.name));
    // wait until the upload has settled (no new file for 20 min) so a half-uploaded part isn't used
    if (files.length && files.every(x => Date.now() - Date.parse(x.modifiedTime) > 20 * 60000)) { console.log(s.id); process.exit(0); }
  }
  console.log('');
} else if (cmd === 'fetch') {
  const s = load(id);
  fs.mkdirSync(work, { recursive: true });
  const files = (await drive.list(s.recordingFolder)).filter(x => VIDEO.test(x.name)).sort((a, b) => a.name.localeCompare(b.name));
  const parts = [];
  for (const [i, f] of files.entries()) {
    const p = path.join(work, `part${i}${path.extname(f.name)}`);
    if (!fs.existsSync(p)) await drive.download(f.id, p);
    // phone video: maybe HEVC / variable frame rate / rotated → 1080p 30 fps CFR H.264, audio 48 kHz
    const n = path.join(work, `norm${i}.mp4`);
    if (!fs.existsSync(n)) ff(['-i', p, '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,setsar=1',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-colorspace', 'bt709', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '1', n]);
    fs.rmSync(p); parts.push(n);
  }
  fs.writeFileSync(path.join(work, 'parts.txt'), parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', path.join(work, 'parts.txt'), '-c', 'copy', path.join(work, 'recording.mp4')]);
  parts.forEach(p => fs.rmSync(p));
  const wf = await drive.folder('Infax Work');
  const old = (await drive.list(wf)).filter(x => x.name === `${id}.mp4`);
  for (const o of old) await drive.remove(o.id);
  s.workFile = await drive.uploadFile(path.join(work, 'recording.mp4'), `${id}.mp4`, wf, 'video/mp4');
  s.status = 'processing'; s.processingSince = new Date().toISOString();
  store(s);
  log(`fetched ${files.length} file(s) → recording.mp4`);
} else if (cmd === 'pull') {
  const s = load(id);
  fs.mkdirSync(work, { recursive: true });
  await drive.download(s.workFile, path.join(work, 'recording.mp4'));
} else if (cmd === 'preview') {
  const s = load(id);
  const pf = await drive.folder(drive.PREVIEWS);
  const fid = await drive.uploadFile(path.join(work, 'final.mp4'), `${id} ${s.topic}.mp4`, pf, 'video/mp4', { infaxId: id });
  s.preview = { fileId: fid, url: await drive.shareLink(fid), at: new Date().toISOString(),
    ...JSON.parse(fs.readFileSync(path.join(work, 'assemble_state.json'), 'utf8')).final };
  if (fs.existsSync(path.join(work, 'edit.json'))) {
    const e = JSON.parse(fs.readFileSync(path.join(work, 'edit.json'), 'utf8'));
    s.preview.paragraphs = `${e.takes.filter(t => t.ok).length}/${e.takes.length}`;
    s.preview.dropped = e.takes.filter(t => !t.ok).map(t => t.seg + 1);
  }
  s.status = 'preview';
  store(s);
  if (s.workFile) await drive.remove(s.workFile).catch(() => {});
  log('preview', s.preview.url);
} else if (cmd === 'publish') {
  const s = load(id);
  // publish runs only from my Approve button (Rahul Studio → workflow_dispatch), so a preview becomes approved here
  if (!['preview', 'approved'].includes(s.status)) throw new Error(`${id} is ${s.status}, not a preview`);
  s.status = 'approved'; s.approvedAt = new Date().toISOString(); store(s);
  if (s.youtubeId) { log('already published', s.youtubeId); process.exit(0); }   // never twice
  if (env.YT_ENABLED !== 'true') { log('YT_ENABLED is not true → not uploading'); process.exit(0); }
  const { upload, setThumbnail } = await import('./yt.js');
  const f = path.join(ROOT, 'work', `${id}.mp4`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  await drive.download(s.preview.fileId, f);
  const chapters = [];
  const desc = [s.description_en || `${s.topic}. ${s.angle || ''}`, '', 'Sources:', ...(s.sources || []).map(x => `${x.name}: ${x.url}`),
    '', 'Visuals include AI-generated illustrations (no real people). Music: Mixkit (Mixkit Stock Music Free License).',
    '', '#Infax #Hindi #Documentary'].concat(chapters).join('\n');
  const v = await upload(f, { title: s.title_hi.slice(0, 100), description: desc.slice(0, 4900), tags: s.tags || ['Infax', 'Hindi documentary'],
    categoryId: '27', privacy: 'public', synthetic: true });
  s.youtubeId = v.id; s.status = 'published'; s.publishedAt = new Date().toISOString();
  store(s);
  if (s.thumb && fs.existsSync(path.join(ROOT, s.thumb))) await setThumbnail(v.id, path.join(ROOT, s.thumb)).catch(e => log('thumb', e.message));
  log('published https://youtu.be/' + v.id);
} else if (cmd === 'fail') {
  const s = load(id);
  s.status = 'waiting-recording'; s.lastError = { at: new Date().toISOString(), reason: process.argv[4] || 'unknown' };
  s.failures = (s.failures || 0) + 1;
  if (s.failures >= 3) s.status = 'needs-attention';             // stop retrying a broken recording forever
  store(s);
} else {
  console.error('usage: next | fetch | pull | preview | publish | fail');
  process.exit(1);
}
