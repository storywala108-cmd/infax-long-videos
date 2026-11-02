// One-time YouTube OAuth: opens a local loopback server, prints the consent URL,
// exchanges the code and writes YT_REFRESH_TOKEN into .env (never printed).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const env = Object.fromEntries(
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).filter(l => /^\w+=/.test(l))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
);

// Google refuses YouTube + Drive scopes in one consent, so Drive gets its own token:
//   node scripts/yt_auth.js         → YT_REFRESH_TOKEN
//   node scripts/yt_auth.js drive   → DRIVE_REFRESH_TOKEN (drive.file + drive.readonly: my uploaded recordings)
const DRIVE = process.argv[2] === 'drive';
const TOKEN_KEY = DRIVE ? 'DRIVE_REFRESH_TOKEN' : 'YT_REFRESH_TOKEN';
const SCOPES = (DRIVE
  ? ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.readonly']
  : ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/yt-analytics.readonly']).join(' ');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const code = url.searchParams.get('code');
  if (!code) { res.end('Waiting for Google...'); return; }
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET,
      redirect_uri: redirect, grant_type: 'authorization_code',
    }),
  });
  const tok = await r.json();
  if (!tok.refresh_token) {
    res.end('No refresh token received: ' + (tok.error || 'unknown'));
    console.log('FAILED:', tok.error, tok.error_description);
    process.exit(1);
  }
  const who = DRIVE
    ? (await fetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers: { authorization: `Bearer ${tok.access_token}` } })
      .then(x => x.json())).user?.emailAddress
    : (await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: `Bearer ${tok.access_token}` } })
      .then(x => x.json())).items?.[0]?.snippet?.title;
  let text = fs.readFileSync(envPath, 'utf8').replace(new RegExp(`^${TOKEN_KEY}=.*\\r?\\n?`, 'm'), '');
  if (!text.endsWith('\n')) text += '\n';
  fs.writeFileSync(envPath, text + `${TOKEN_KEY}=${tok.refresh_token}\n`);
  res.end(`Connected: ${who || '?'}. You can close this tab.`);
  console.log(`CONNECTED ${DRIVE ? 'drive' : 'channel'}="${who}"; ${TOKEN_KEY} saved to .env`);
  process.exit(0);
});

server.listen(0, '127.0.0.1', () => {
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: env.YT_CLIENT_ID, redirect_uri: redirect, response_type: 'code',
    scope: SCOPES, access_type: 'offline', prompt: 'consent',
  });
  console.log('AUTH_URL ' + auth);
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 15 * 60 * 1000);
