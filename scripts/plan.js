// Weekly planner: picks topics (India trends in the Infax niche) and writes one Hindi script per video.
// Each script → state/scripts/<id>.json (segments + visual plan) + a Google Doc for reading on camera
// + an empty Drive sub-folder "Infax Recordings/<id> <title>" where I drop my recording.
// Usage: node scripts/plan.js [count=VIDEOS_PER_WEEK] [--topic "..."] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, env, log, aiJson } from './lib.js';
import { topRecent } from './yt.js';
import * as drive from './drive.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const ti = args.indexOf('--topic');
const forced = ti >= 0 ? args[ti + 1] : null;
const count = Number(args.find(a => /^\d+$/.test(a)) || (forced ? 1 : env.VIDEOS_PER_WEEK || 3));

const STATE = path.join(ROOT, 'state');
const SDIR = path.join(STATE, 'scripts');
fs.mkdirSync(SDIR, { recursive: true });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const used = readJson(path.join(STATE, 'topics.json'), []);
// Titles of the style reference channel: we copy its format, never its topics.
const avoid = fs.existsSync(path.join(ROOT, 'avoid-topics.txt'))
  ? fs.readFileSync(path.join(ROOT, 'avoid-topics.txt'), 'utf8').split(/\r?\n/).filter(Boolean) : [];

// Infax niche = politics, history, myths & facts. Hindi + English queries, India, last 30 days.
const QUERIES = ['untold story hindi documentary', 'reality explained hindi', 'secret operation explained hindi',
  'scam explained hindi', 'history mystery hindi', 'geopolitics explained hindi', 'myth vs fact india',
  'indian army untold story', 'political controversy explained hindi'];

async function research() {
  const seen = new Map();
  for (const q of QUERIES.sort(() => Math.random() - 0.5).slice(0, 5)) {   // 5 searches = 500 quota units
    try {
      for (const v of await topRecent(q, 30, 20)) if (v.minutes >= 12 && !seen.has(v.id)) seen.set(v.id, v);
    } catch (e) { log('search failed:', q, e.message.slice(0, 120)); }
  }
  return [...seen.values()].sort((a, b) => b.perDay - a.perDay).slice(0, 40);
}

async function pickTopics(trends) {
  const { data } = await aiJson(`You plan videos for "Infax", a Hindi YouTube channel ("Information with facts": Indian and world
politics, history, myths vs facts, scams, intelligence and military operations, geopolitics). Format: a 22-30 minute
investigative documentary narrated on camera by the host, like the most-watched Hindi explainer channels.

Videos getting the most views per day in India right now (title | views/day):
${trends.map(t => `${t.title} | ${t.perDay}`).join('\n') || '(no data)'}

Already made by us (never repeat): ${used.map(u => u.topic).join('; ') || 'none'}
Topics of a channel we only take the STYLE from (never pick these or close variants): ${avoid.join('; ') || 'none'}
${forced ? `The owner asked for this exact topic: "${forced}". Return just that one.` : ''}

Pick ${count} DIFFERENT original topics with strong curiosity and real documented facts (court records, reports,
books, reputable news). Monetization-safe: no gore, never glorify terrorists, no hate, contested claims framed as an
evidence-based look at both sides, accused people called "alleged" unless convicted.
Return JSON: {"topics":[{"topic":"...","angle":"the hook/curiosity gap in one line","why":"demand signal"}]}`,
  { check: d => { if (!d.topics?.length) throw new Error('no topics'); return d; } });
  return data.topics.slice(0, count);
}

const SCRIPT_RULES = `Write in natural spoken Hindi (Devanagari), the way a sharp Indian YouTube host talks to camera:
short and long sentences mixed, direct questions to the viewer, own opinions, concrete names/dates/places/numbers,
suspense before each reveal. English words people really use (army, operation, file, court) may stay in Devanagari.
Numbers are written in Hindi WORDS (the host reads them aloud). No stock phrases like "आइए जानते हैं", "क्या आप
जानते हैं" more than once. No sponsor segment. Everything must be factually accurate; if unsure, leave it out.`;

async function writeScript(t) {
  // 1) outline
  const { data: o } = await aiJson(`${SCRIPT_RULES}
Topic: ${t.topic}. Hook: ${t.angle}.
Make an outline for a 24-28 minute documentary: a cold open (strong hook, 60-90 s), then 8-10 chapters building to a
climax, and a closing with a sharp takeaway line and a one-line ask to subscribe to Infax.
Return JSON: {"title_hi":"YouTube title: Hindi in Devanagari + 1-2 English keywords","chapters":[{"name_en":"short English chapter title","beats":["..."]}],
"sources":[{"name":"publication or book","url":"https://..."}]}`,
  { check: d => { if (!d.chapters?.length) throw new Error('no chapters'); return d; } });

  // 2) chapters → segments of 1-3 spoken sentences, each with what the viewer sees
  const segments = [];
  for (const [ci, ch] of o.chapters.entries()) {
    const prev = segments.slice(-3).map(s => s.text).join(' ');
    const { data } = await aiJson(`${SCRIPT_RULES}
Documentary "${t.topic}". Chapter ${ci + 1}/${o.chapters.length}: "${ch.name_en}". Beats: ${ch.beats.join(' | ')}.
${prev ? `Last lines before this chapter: ${prev}` : 'This is the cold open: start with the strongest hook.'}
Write ~${ci === 0 ? 200 : 380} Hindi words for this chapter as segments of 1-3 sentences.
For each segment choose what is on screen:
- "face": the host on camera (use for hooks, opinions, questions, transitions; about 35% of segments)
- "image": an illustration. Give an English image prompt of an anonymous scene (no real person's face, no text).
- "map": a place. Give {"place":"English name","lon":..,"lat":..,"label":"SHORT LABEL"}.
- "source": a quote card from a real report/book/news. Give {"source":"publication","quote":"short English quote/paraphrase"}.
- "name": a person/organisation card. Give {"name":"English name","role":"short English role"}.
Return JSON: {"segments":[{"text":"Hindi","show":"face|image|map|source|name","prompt":"","map":null,"card":null}]}`,
    { check: d => { if (!(d.segments?.length >= 3)) throw new Error('too few segments'); return d; } });
    for (const s of data.segments) segments.push({ chapter: ci, chapterName: ch.name_en, ...s });
  }
  return { ...o, segments };
}

// Teleprompter text: chapter headings + numbered paragraphs (the numbers help me restart a paragraph after a mistake).
function teleprompter(id, t, s) {
  const lines = [`${id} — ${s.title_hi}`, '', 'Recording tips: landscape 1080p 30fps, camera at eye level, plain wall ~1 m behind you,',
    'light from the front. If you make a mistake, pause 2 seconds and read the WHOLE paragraph again —', 'the editor keeps your last good take.', ''];
  let ch = -1;
  s.segments.forEach((g, i) => {
    if (g.chapter !== ch) { ch = g.chapter; lines.push('', `=== ${g.chapterName} ===`, ''); }
    lines.push(`[${i + 1}] ${g.text}`, '');
  });
  return lines.join('\n');
}

const trends = forced ? [] : await research();
log(`trends: ${trends.length}`);
const topics = await pickTopics(trends);
const week = new Date().toISOString().slice(0, 10).replace(/-/g, '');
for (const [i, t] of topics.entries()) {
  const id = `INF-${week}-${i + 1}`;
  log(`writing ${id}: ${t.topic}`);
  const s = await writeScript(t);
  // titles/on-screen text always use 0-9 digits (my rule), even though the spoken script writes numbers in words
  s.title_hi = String(s.title_hi || t.topic).replace(/[०-९]/g, d => '०१२३४५६७८९'.indexOf(d));
  const words = s.segments.reduce((n, g) => n + g.text.split(/\s+/).length, 0);
  const rec = { id, created: new Date().toISOString(), topic: t.topic, angle: t.angle, words, status: 'waiting-recording', ...s };
  if (!DRY) {
    const scriptsF = await drive.folder(drive.SCRIPTS);
    const doc = await drive.createDoc(`${id} ${t.topic}`, teleprompter(id, t, s), scriptsF);
    const recF = await drive.folder(`${id} ${t.topic}`.slice(0, 120), await drive.folder(drive.RECORDINGS));
    Object.assign(rec, { docUrl: doc.url, recordingFolder: recF });
    used.push({ id, topic: t.topic, date: rec.created });
  }
  fs.writeFileSync(path.join(SDIR, `${id}.json`), JSON.stringify(rec, null, 1));
  log(`${id}: ${s.segments.length} segments, ${words} words${rec.docUrl ? ' → ' + rec.docUrl : ''}`);
}
if (!DRY) fs.writeFileSync(path.join(STATE, 'topics.json'), JSON.stringify(used, null, 1));
