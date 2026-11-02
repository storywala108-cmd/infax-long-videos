// Shared helpers: env, HTTP with retries, Gemini/Groq JSON with fallback chain, Gemini TTS.
// Secrets are read from .env (or process.env on GitHub) and never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const f = path.join(ROOT, '.env');
  const out = {};
  if (fs.existsSync(f)) {
    // Strip a UTF-8 BOM: PowerShell 5.1 `Set-Content -Encoding utf8` adds one and it hid the first key.
    for (const l of fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const i = l.indexOf('=');
      if (i > 0 && /^\w+$/.test(l.slice(0, i))) out[l.slice(0, i)] = l.slice(i + 1).trim();
    }
  }
  // process.env only fills keys .env lacks (GitHub Actions); on the laptop it could hold other projects' keys.
  for (const [k, v] of Object.entries(process.env)) if (v && !(k in out)) out[k] = v.trim();
  return out;
}
export const env = loadEnv();

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Retries network errors, 429 and 5xx with backoff (honours Retry-After).
export async function httpJson(url, opts = {}, { tries = 3, timeoutMs = 120000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      const text = await r.text();
      if (r.ok) return JSON.parse(text);
      last = new Error(`HTTP ${r.status}: ${text.slice(0, 200)}${/PerDay/.test(text) ? ' [daily quota]' : ''}`);
      if (r.status !== 429 && r.status < 500) throw last;
      // a long Retry-After (daily free limit) must not freeze the run for hours: fail fast, next model takes over
      const ra = Number(r.headers.get('retry-after'));
      if (ra > 30) { last.message += ` (retry-after ${ra}s)`; throw last; }
      await sleep((ra > 0 ? ra * 1000 : 4000 * (i + 1)));
    } catch (e) {
      last = e;
      if (/^HTTP 4(?!29)|retry-after \d+s/.test(e.message)) throw e;
      await sleep(4000 * (i + 1));
    }
  }
  throw last;
}

const GEMINI_TEXT = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'];
// llama-3.3-70b-versatile no longer exists on Groq (404, 2026-11-01); checked list: gpt-oss-120b/20b, qwen3.8-27b
const GROQ_TEXT = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];

export function parseJson(s) {
  const t = String(s || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const body = t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  try { return JSON.parse(body); } catch (e) {
    // two JSON objects back to back ("...}\n{...") → keep the first complete one
    let depth = 0, inStr = false, esc = false;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) return JSON.parse(body.slice(0, i + 1));
    }
    throw e;
  }
}

// Circuit breaker: a model that times out / is overloaded is skipped for 20 min (a dry run lost ~4 min per
// chapter waiting on busy Gemini models, 2026-11-01). Bad JSON doesn't trip it.
const benched = new Map();
const isBenched = m => (benched.get(m) || 0) > Date.now();
const bench = (m, e) => { if (/abort|timeout|HTTP (429|5\d\d)|fetch failed|ECONN/i.test(e.message)) benched.set(m, Date.now() + 20 * 60000); };

// Ask for a JSON object; tries each Gemini model, then Groq. `check` validates/normalises the reply.
// A broken JSON reply gets one more try on the same model; if every model fails, wait 90 s and go round again
// (twice) before giving up — the pipeline then resumes from its saved stage on the next run.
export async function aiJson(prompt, opts = {}) {
  for (let round = 0; ; round++) {
    try { return await aiJsonOnce(prompt, opts); } catch (e) {
      if (round >= 2) throw e;
      log(`all AI models busy (round ${round + 1}), waiting 90 s…`);
      benched.clear();
      await sleep(90000);
    }
  }
}

async function aiJsonOnce(prompt, { check = x => x, temperature = 0.9, system } = {}) {
  const errors = [];
  for (const model of GEMINI_TEXT) {
    for (let attempt = 0; attempt < 2 && !isBenched(model); attempt++) {
      try {
        const d = await httpJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          body: JSON.stringify({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: attempt ? 0.4 : temperature, responseMimeType: 'application/json' },
          }),
        }, { tries: 1, timeoutMs: 100000 });
        return { model, data: check(parseJson(d.candidates?.[0]?.content?.parts?.map(p => p.text).join(''))) };
      } catch (e) {
        bench(model, e); errors.push(`${model}: ${e.message.slice(0, 120)}`);
        if (!/JSON|no |too few|empty/i.test(e.message)) break;   // only bad-JSON replies are worth a second try
      }
    }
  }
  for (const model of GROQ_TEXT) {
    if (isBenched(model)) continue;
    try {
      const d = await httpJson('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model, temperature, response_format: { type: 'json_object' },
          messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
        }),
      }, { tries: 2 });
      return { model, data: check(parseJson(d.choices?.[0]?.message?.content)) };
    } catch (e) { bench(model, e); errors.push(`${model}: ${e.message.slice(0, 120)}`); }
  }
  if (!errors.length) { benched.clear(); return aiJson(prompt, { check, temperature, system }); }  // all benched: retry everything
  throw new Error('All AI models failed:\n' + errors.join('\n'));
}

// Gemini TTS often appends a loud ~0.1 s static burst (TV-snow "shhh") after the last word, sometimes before the
// first one (found 2026-11-01). Any loud window that follows/precedes near-silence at a clip edge is cut, and
// isolated loud noise bursts inside the clip are muted. Returns { pcm, cut } with 16-bit mono PCM.
export function cleanTtsPcm(pcm, sr = 24000) {
  const x = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
  const win = Math.round(sr * 0.01), nw = Math.floor(x.length / win);
  const rms = [], zcr = [];
  for (let w = 0; w < nw; w++) {
    let s = 0, z = 0;
    for (let i = w * win; i < (w + 1) * win; i++) {
      s += (x[i] / 32768) ** 2;
      if (i > w * win && (x[i] >= 0) !== (x[i - 1] >= 0)) z++;
    }
    rms.push(Math.sqrt(s / win)); zcr.push(z / win);
  }
  const quiet = w => rms[w] < 0.02;
  const burst = w => rms[w] > 0.25 && zcr[w] > 0.1;
  let end = nw, start = 0, cut = 0;
  // tail: walk back over burst windows; if they sit after ≥0.1 s of quiet, cut from the quiet
  let w = nw - 1;
  while (w > 0 && (burst(w) || rms[w] > 0.25)) w--;
  if (w < nw - 1) { let q = 0; while (w - q > 0 && quiet(w - q)) q++; if (q >= 10) { end = w - q + 5; cut++; } }
  // head: same, forwards
  w = 0;
  while (w < nw - 1 && burst(w)) w++;
  if (w > 0) { let q = 0; while (w + q < nw && quiet(w + q)) q++; if (q >= 10) { start = w + q - 5; cut++; } }
  // inside: a burst of ≤0.25 s with quiet on both sides is muted
  for (let i = start + 10; i < end - 10; i++) {
    if (!burst(i) || !quiet(i - 1)) continue;
    let j = i; while (j < end && !quiet(j) && j - i < 26) j++;
    if (j - i < 26 && quiet(j)) { x.fill(0, i * win, j * win); cut++; i = j; }
  }
  const out = x.slice(start * win, Math.min(x.length, end * win));
  const f = Math.min(out.length >> 1, Math.round(sr * 0.015));   // 15 ms fades, no clicks
  for (let i = 0; i < f; i++) { out[i] = out[i] * i / f; out[out.length - 1 - i] = out[out.length - 1 - i] * i / f; }
  return { pcm: Buffer.from(out.buffer), cut };
}

export function writeWav(file, pcm, sr = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

// Gemini TTS → 24 kHz mono WAV. Only the spoken text is sent (style lines would be read aloud).
// Free tier = 10 requests/day per TTS model (found 2026-11-01), so callers send ~450-word chunks and keep ONE
// model per video (voices differ slightly between models). A daily-quota error is thrown with e.quota = true.
export const TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview'];
export async function tts(text, wavPath, { voice = 'Charon', models = TTS_MODELS } = {}) {
  let last;
  for (const model of models) {
    try {
      const d = await httpJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
        }),
      }, { tries: 2, timeoutMs: 180000 });
      const { pcm, cut } = cleanTtsPcm(Buffer.from(d.candidates[0].content.parts[0].inlineData.data, 'base64'));
      writeWav(wavPath, pcm);
      return { model, seconds: pcm.length / 48000, cut };
    } catch (e) { last = e; if (/daily quota|HTTP 429/.test(e.message)) e.quota = true; }
  }
  throw last;
}

// Infax documentary look: moody film-still style digital painting (dark, warm/teal grade). Added to every image prompt.
// The word "realistic" trips FLUX klein's filter (code 3030), so the look is described without it.
export const INK_STYLE = 'documentary film still, detailed digital matte painting, moody dramatic lighting, deep shadows, ' +
  'teal and amber color grade, shallow depth of field, gritty texture, anonymous people with faces turned away or in shadow, ' +
  'no text, no letters, no words, no numbers, no logos';

// Model-written prompts sometimes carry words that trip the safety filter (code 3030) or fight our style.
const stripStyle = p => p.replace(/,?\s*\b(hyper)?realistic( style)?|photo\w*|cinematic|4k|8k/gi, '').trim();
const softPrompt = p => p.replace(/\b(blood\w*|dead|death|die\w*|kill\w*|corpse|bod(y|ies)|crush\w*|drown\w*|gore|weapon|gun|violence|violent)\b/gi, '')
  .replace(/\s{2,}/g, ' ');

// Cloudflare Workers AI: FLUX.2 klein 4B (Apache-2.0, multipart), FLUX.1 schnell as fallback → JPG/PNG file.
export async function fluxImage(prompt, outPath, { width = 1344, height = 768 } = {}) {
  const base = stripStyle(prompt);
  const tries = [base, softPrompt(base), 'a dark empty government office at night with files on a desk under a single lamp'];
  let last;
  for (const [i, p] of tries.entries()) {
    try {
      const fd = new FormData();
      fd.append('prompt', `${p}. ${INK_STYLE}`); fd.append('width', String(width)); fd.append('height', String(height));
      const d = await httpJson(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`,
        { method: 'POST', headers: { authorization: `Bearer ${env.CF_API_TOKEN}` }, body: fd }, { tries: 2, timeoutMs: 180000 });
      if (!d.result?.image) throw new Error('no image');
      fs.writeFileSync(outPath, Buffer.from(d.result.image, 'base64'));
      return { model: 'flux-2-klein-4b', attempt: i + 1 };
    } catch (e) { last = e; }
  }
  const d = await httpJson(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: JSON.stringify({ prompt: `${softPrompt(base)}. ${INK_STYLE}`, steps: 6 }),
  }, { tries: 2, timeoutMs: 90000 }).catch(e => { throw new Error(`klein: ${last?.message} | schnell: ${e.message}`); });
  fs.writeFileSync(outPath, Buffer.from(d.result.image, 'base64'));
  return { model: 'flux-1-schnell', attempt: 4 };
}
