// Builds STATUS.html (yellow status panel) from state/status.json + live run info. Rerun every minute by a loop.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.js';

const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'status.json'), 'utf8'));
const scripts = fs.existsSync(path.join(ROOT, 'state', 'scripts')) ? fs.readdirSync(path.join(ROOT, 'state', 'scripts')).length : 0;
const total = Math.round(st.stages.reduce((n, s) => n + s.pct * s.weight, 0) / st.stages.reduce((n, s) => n + s.weight, 0));
const icon = p => (p >= 100 ? '✅' : p > 0 ? '⏳' : '⬜');
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="60">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Infax Long Video – Status</title>
<style>
body{margin:0;font-family:Poppins,Segoe UI,sans-serif;background:#fffbe6;color:#3a2f00;padding:16px}
h1{font-size:18px;margin:0 0 4px}.sub{font-size:12px;color:#7a6400;margin-bottom:14px}
.big{font-size:44px;font-weight:800;color:#b38600}.bar{height:14px;background:#fff1a8;border-radius:8px;overflow:hidden;margin:6px 0 18px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#ffd000,#ffb300)}
.st{background:#fff;border:1px solid #ffe066;border-radius:10px;padding:10px 12px;margin-bottom:8px}
.st b{font-size:14px}.st .p{float:right;font-weight:700;color:#b38600}.st .n{font-size:12px;color:#6b5a00;margin-top:4px}
.mini{height:6px;background:#fff1a8;border-radius:4px;margin-top:6px;overflow:hidden}.mini i{display:block;height:100%;background:#ffc400}
.foot{font-size:11px;color:#8a7400;margin-top:12px}
</style></head><body>
<h1>📺 Infax Long Video Automation</h1><div class="sub">Nitish-style documentary · cloud pipeline · updated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
<div class="big">${total}%</div><div class="bar"><i style="width:${total}%"></i></div>
${st.stages.map(s => `<div class="st"><b>${icon(s.pct)} ${esc(s.name)}</b><span class="p">${s.pct}%</span>
<div class="n">${esc(s.note || '')}</div><div class="mini"><i style="width:${s.pct}%"></i></div></div>`).join('\n')}
<div class="foot">Scripts written: ${scripts} · Now: ${esc(st.now || '')}</div>
</body></html>`;
fs.writeFileSync(path.join(ROOT, 'STATUS.html.tmp'), html);
fs.renameSync(path.join(ROOT, 'STATUS.html.tmp'), path.join(ROOT, 'STATUS.html'));
