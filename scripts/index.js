// state/index.json: one small summary of every script, read by the Rahul Studio "Long Video" tab
// (raw.githubusercontent.com, no API rate limit). Rebuilt before every state commit.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.js';

const dir = path.join(ROOT, 'state', 'scripts');
const items = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('TEST')).map(f => {
  const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  return {
    id: s.id, topic: s.topic, title: s.title_hi, status: s.status, created: s.created, words: s.words,
    doc: s.docUrl || null, folder: s.recordingFolder ? `https://drive.google.com/drive/folders/${s.recordingFolder}` : null,
    preview: s.preview ? { url: s.preview.url, embed: `https://drive.google.com/file/d/${s.preview.fileId}/preview`, minutes: s.preview.minutes,
      lufs: s.preview.lufs, paragraphs: s.preview.paragraphs, dropped: s.preview.dropped } : null,
    youtube: s.youtubeId ? `https://youtu.be/${s.youtubeId}` : null, error: s.lastError || null,
  };
}).sort((a, b) => String(b.created).localeCompare(String(a.created)));
fs.writeFileSync(path.join(ROOT, 'state', 'index.json'), JSON.stringify({ updated: new Date().toISOString(), items }, null, 1));
