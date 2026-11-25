// Client upload page: a firm's client drops statement PDFs here. No account needed.
import { escapeHtml } from './api.js';

const $ = (s) => document.querySelector(s);
const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
const base = `/api/upload/${encodeURIComponent(token)}`;
const msg = (h) => { $('#upMsg').innerHTML = h; };

async function init() {
  if (!token) return msg('<span class="error">This link is missing its code. Ask your accountant to send it again.</span>');
  const res = await fetch(base);
  const info = await res.json().catch(() => ({}));
  if (!res.ok) { $('#upForm').hidden = true; return msg(`<span class="error">${escapeHtml(info.message || 'This link is not valid.')}</span>`); }
  document.title = `Upload statements for ${info.firm}`;
  $('#firm').textContent = info.firm;
  $('#client').textContent = info.client;
  if (info.logo) { const img = new Image(); img.src = info.logo; img.alt = info.firm; img.referrerPolicy = 'no-referrer'; $('#logo').replaceChildren(img); }
  if (info.color) document.documentElement.style.setProperty('--accent', info.color);
  $('#upForm').hidden = false;
}

$('#upForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = [...$('#upFiles').files];
  if (!files.length) return msg('Choose at least one PDF.');
  const b = e.submitter; if (b) b.disabled = true;
  msg('Uploading…');
  let saved = 0; const problems = [];
  for (let i = 0; i < files.length; i += 5) {
    const fd = new FormData();
    files.slice(i, i + 5).forEach((f) => fd.append('file', f));
    const res = await fetch(base, { method: 'POST', body: fd });
    const out = await res.json().catch(() => ({}));
    saved += out.saved?.length || 0;
    for (const r of out.rejected || []) problems.push(`${r.name}: ${r.reason}`);
    if (!res.ok && !out.rejected) problems.push(out.message || 'Upload failed');
  }
  if (b) b.disabled = false;
  $('#upFiles').value = '';
  msg(`${saved ? `<span class="ok-text">Sent ${saved} file${saved > 1 ? 's' : ''}. Thank you!</span>` : ''}${problems.length ? `<ul class="error">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : ''}`);
});

init().catch(() => msg('<span class="error">Could not load this page. Check your connection.</span>'));
