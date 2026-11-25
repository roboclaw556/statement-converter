// StatementOtter for iOS and Android. Same converter as the web app (./core),
// run on the device: PDFs from Files/Mail/Drive, scanned PDFs and camera scans
// (on-device OCR), balance check, inline fixes, 17 export formats via the share sheet.
import * as pdfjs from './vendor/pdf.min.mjs';
import { extractLines, parseStatement, reconcile, formatCents, FORMATS, formatById } from './core/index.js';
import { categorize } from './core/categorize.js';
import { lenderReport } from './core/lender.js';
import { fraudChecks } from './core/fraud.js';
import { FEATURE_LABELS } from './core/plans.js';
import { CONFIG } from './config.js';
import * as P from './platform.js';
import * as acct from './account.js';
import * as history from './history.js';
import { purchasesAvailable, offerings, buy, restore, signOutPurchases } from './purchases.js';
import { sendFeedback } from './feedback.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const state = { files: [], active: -1, tab: 'convert', busy: 0 };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const OK_STATUSES = new Set(['reconciled', 'running_balance_ok']);

// Exposed for the automated tests (and handy when debugging in Safari/Chrome devtools).
globalThis.__app = { state, acct, history };

// ---------- tabs ----------

function showTab(tab) {
  state.tab = tab;
  for (const b of $$('.tabs button')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  for (const v of $$('.view')) v.hidden = v.id !== `view-${tab}`;
  if (tab === 'recent') renderRecent();
  if (tab === 'account') renderAccount();
  window.scrollTo(0, 0);
}
$('.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });

// ---------- toast + sheet ----------

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

let sheetOnClose = null;
function openSheet(title, body, onClose = null) {
  $('#sheetTitle').textContent = title;
  const el = $('#sheetBody');
  el.innerHTML = '';
  el.onclick = null;
  if (typeof body === 'string') el.innerHTML = body; else el.append(body);
  $('#sheet').hidden = false;
  $('#sheetBackdrop').hidden = false;
  sheetOnClose = onClose;
  setTimeout(() => ($('input, select, textarea', el) || $('#sheetClose')).focus({ preventScroll: true }), 50);
  return el;
}
function closeSheet() {
  if ($('#sheet').hidden) return false;
  $('#sheet').hidden = true;
  $('#sheetBackdrop').hidden = true;
  const fn = sheetOnClose;
  sheetOnClose = null;
  fn?.();
  return true;
}
$('#sheetClose').addEventListener('click', closeSheet);
$('#sheetBackdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// ---------- loading files ----------

$('#file').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  handleFiles(files);
});

/** PDFs open one per statement; photos picked together become one multi-page statement. */
async function handleFiles(files) {
  const pdfs = files.filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  const images = files.filter((f) => /^image\//i.test(f.type) || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
  const skipped = files.length - pdfs.length - images.length;
  if (skipped) toast(`${skipped} file(s) skipped: only PDFs and photos can be converted.`);
  for (const f of pdfs) await addPdf(f.name, new Uint8Array(await f.arrayBuffer()));
  if (images.length) await addImages(images.length === 1 ? images[0].name : `Photos (${images.length} pages)`, images);
}

function newEntry(name, kind) {
  const entry = { id: uid(), name, kind, status: 'reading', createdAt: new Date().toISOString(), counted: false };
  state.files.push(entry);
  state.active = state.files.length - 1;
  showTab('convert');
  renderFiles();
  render();
  return entry;
}

async function addPdf(name, bytes) {
  const entry = newEntry(name.replace(/\.pdf$/i, '') + '.pdf', 'pdf');
  entry.data = bytes;
  await openPdf(entry);
}

async function addImages(name, blobs) {
  const entry = newEntry(name, 'images');
  entry.blobs = blobs;
  await runOcr(entry, (onProgress) => import('./ocr-browser.js').then((m) => m.ocrBlobs(blobs, onProgress)));
}

async function openPdf(entry, password) {
  try {
    const pdf = await pdfjs.getDocument({ data: entry.data.slice(), password, verbosity: 0, isEvalSupported: false }).promise;
    entry.meta = await pdf.getMetadata().catch(() => null);
    const { pages, hasText } = await extractLines(pdf);
    if (!hasText) {
      await runOcr(entry, (onProgress) => import('./ocr-browser.js').then((m) => m.ocrScannedPdf(pdf, onProgress)));
      return;
    }
    entry.pages = pages;
    finish(entry);
  } catch (err) {
    if (err?.name === 'PasswordException') {
      entry.status = 'locked';
      askPassword(entry, err.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    } else {
      fail(entry, "Couldn't read this file. Is it a bank statement PDF?", err);
    }
  }
}

async function runOcr(entry, job) {
  entry.ocr = true;
  entry.status = 'reading';
  entry.progress = 'Reading the scan on this device…';
  render();
  try {
    const out = await job(({ page, pages, stage }) => {
      entry.progress = stage === 'done' ? 'Checking balances…' : `Reading page ${page} of ${pages}…`;
      if (state.files[state.active] === entry) $('#progressText').textContent = entry.progress;
    });
    if (!out.hasText) return fail(entry, "Couldn't find any text in this scan. Try again with the page flat, in good light, filling the frame.");
    entry.pages = out.pages;
    entry.ocrConfidence = out.confidence;
    finish(entry);
  } catch (err) {
    fail(entry, "Couldn't read this scan. Please try again.", err);
  }
}

function fail(entry, message, err) {
  if (err) console.error(err);
  entry.status = 'error';
  entry.error = message;
  renderFiles();
  render();
}

function askPassword(entry, wrong) {
  const form = $('#password');
  form.hidden = false;
  $('#pwLabel').textContent = wrong ? 'Wrong password. Try again:' : `"${entry.name}" is password protected. Enter its password:`;
  $('#pw').value = '';
  setTimeout(() => $('#pw').focus(), 50);
  form.onsubmit = async (e) => {
    e.preventDefault();
    form.hidden = true;
    entry.status = 'reading';
    render();
    await openPdf(entry, $('#pw').value);
  };
  render();
}

// ---------- parsing + checking ----------

async function finish(entry) {
  const preferred = entry.dateOrder || (await P.store.get('settings.dateOrder', '')) || undefined;
  entry.st = parseStatement(entry.pages, { dateOrder: entry.dateOrder });
  if (!entry.dateOrder && preferred && preferred !== entry.st.dateOrder && isAmbiguous(entry)) {
    entry.st = parseStatement(entry.pages, { dateOrder: preferred });
  }
  entry.dateOrder = entry.st.dateOrder;
  entry.currency = guessCurrency(entry.pages);
  recheck(entry);
  if (entry.kind === 'pdf' && !entry.ocr) {
    try { entry.fraud = fraudChecks(entry.meta, entry.data, entry.result); } catch (e) { console.warn('fraud checks', e); }
  }
  entry.status = 'done';
  renderFiles();
  render();
  saveHistory(entry);
}

function isAmbiguous(entry) {
  const a = parseStatement(entry.pages, { dateOrder: 'MDY' });
  const b = parseStatement(entry.pages, { dateOrder: 'DMY' });
  return a.transactions.length === b.transactions.length && reconcile(a).status === reconcile(b).status;
}

function recheck(entry) {
  entry.result = reconcile(entry.st);
  if (entry.ocr) flagCarriedDates(entry.result);
  entry.warnings = [...(entry.st.warnings || [])];
  if (entry.ocr) {
    entry.warnings.unshift('Read from a scan. Check the highlighted rows against the paper statement before exporting.');
  }
  if (!entry.result.transactions.length) {
    entry.warnings.unshift("No transactions were found. If this is a statement, send us a note from Feedback so we can add your bank's layout.");
  }
}

// On a scan, a row whose date wasn't read takes the date of the row above, and the
// balance check can't catch that. When most rows have their own date, flag the ones
// that don't. (Needs dateSource from the parser; does nothing without it.)
function flagCarriedDates(result) {
  const tx = result.transactions;
  const carried = tx.filter((t) => t.dateSource === 'carried');
  if (!carried.length || carried.length > tx.length * 0.25) return;
  for (const t of carried) if (!t.flags.includes('date_check')) t.flags = [...t.flags, 'date_check'];
  result.flaggedCount = tx.filter((t) => t.flags.length).length;
}

function guessCurrency(pages) {
  const text = pages.flat().map((l) => l.text).join(' ');
  if (/£|GBP|sort code/i.test(text)) return 'GBP';
  if (/€|EUR\b|IBAN/i.test(text)) return 'EUR';
  if (/\bCAD\b|Canada/i.test(text)) return 'CAD';
  if (/\bAUD\b|BSB/i.test(text)) return 'AUD';
  return 'USD';
}

$('#dateOrder').addEventListener('change', (e) => {
  const entry = current();
  if (!entry?.pages) return;
  entry.dateOrder = e.target.value;
  entry.st = parseStatement(entry.pages, { dateOrder: entry.dateOrder });
  recheck(entry);
  render();
  saveHistory(entry);
});

// ---------- rendering ----------

const current = () => state.files[state.active];

const STATUS = {
  reconciled: ['good', 'Balanced', 'Opening balance plus every transaction equals the closing balance.'],
  running_balance_ok: ['good', 'Balanced', 'Every row matches the running balance.'],
  mismatch: ['bad', 'Does not balance', 'The highlighted rows break the running balance. Tap them to fix before exporting.'],
  unverified: ['warn', 'Not verified', 'No opening or closing balance was found, so check the totals against the statement.'],
};

function renderFiles() {
  const el = $('#files');
  el.innerHTML = '';
  if (state.files.length < 2 && innerWidth <= 1180) return;
  state.files.forEach((f, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'file' + (i === state.active ? ' active' : '');
    const badge = f.status === 'done' ? (OK_STATUSES.has(f.result.status) ? '✓' : '!') : f.status === 'error' ? '✕' : '…';
    b.textContent = `${badge} ${f.name}`;
    b.onclick = () => { state.active = i; renderFiles(); render(); };
    el.appendChild(b);
  });
}

function render() {
  const entry = current();
  $('#start').hidden = !!entry;
  $('#work').hidden = !entry;
  $('#newBtn').hidden = !entry;
  if (!entry) { renderUsageNote(); return; }
  const reading = entry.status === 'reading';
  $('#progress').hidden = !reading;
  if (reading) $('#progressText').textContent = entry.progress || 'Reading…';
  if (entry.status !== 'locked') $('#password').hidden = true;
  const box = $('#result');
  if (reading || entry.status === 'locked') { box.hidden = true; return; }
  box.hidden = false;
  if (entry.status === 'error') {
    $('#status').className = 'status bad';
    $('#status').innerHTML = `<strong>Couldn't convert</strong><span>${esc(entry.error)}</span>`;
    for (const id of ['#totals', '#warnings', '#rows', '#insights']) $(id).innerHTML = '';
    $('.actions').hidden = true;
    $('#nudge').hidden = false;
    return;
  }
  $('.actions').hidden = false;
  const r = entry.result;
  const [cls, title, detail] = STATUS[r.status] || STATUS.unverified;
  $('#status').className = 'status ' + cls;
  $('#status').innerHTML = `<strong>${title}</strong><span>${detail}${r.difference ? ` Off by ${formatCents(r.difference)}.` : ''}
    ${r.transactions.length} transactions${r.flaggedCount ? `, ${r.flaggedCount} to review` : ''}.</span>`;
  const dd = (label, v) => `<div><dt>${label}</dt><dd>${v === null || v === undefined ? '—' : formatCents(v)}</dd></div>`;
  $('#totals').innerHTML = dd('Opening', r.opening) + dd('Money in', r.credits) + dd('Money out', r.debits) + dd('Closing', r.closing);
  $('#warnings').textContent = entry.warnings.join(' ');
  $('#dateOrder').value = entry.dateOrder || 'MDY';
  renderRows(entry);
  renderInsights(entry);
}

function renderRows(entry) {
  const ol = $('#rows');
  const cats = categorize(entry.result.transactions.map((t) => ({ ...t })));
  const rows = entry.result.transactions.map((t, i) => {
    const out = t.amount < 0 ? formatCents(-t.amount) : '';
    const inn = t.amount > 0 ? formatCents(t.amount) : '';
    const cat = cats[i]?.category && cats[i].categorySource !== 'none' ? `<span class="cat">${esc(cats[i].category)}</span>` : '';
    return `<li data-i="${i}" class="${t.flags.length ? 'flag' : ''}" tabindex="0" role="button" aria-label="Edit ${esc(t.date)} ${esc(t.description)}">
      <span class="m">${esc(t.date)}</span>
      <span class="d">${esc(t.description)}${cat}</span>
      <span class="a out">${out ? '−' + out : ''}</span>
      <span class="a in">${inn ? '+' + inn : ''}</span>
      <span class="b">${t.balance === null ? '' : formatCents(t.balance)}</span>
      ${t.flags.length ? `<span class="f">${t.flags.map(flagText).join(' · ')}</span>` : ''}
    </li>`;
  });
  ol.innerHTML = `<li class="head" aria-hidden="true"><span class="m">Date</span><span class="d">Description</span><span class="a out">Money out</span><span class="a in">Money in</span><span class="b">Balance</span></li>` + rows.join('');
}

const flagText = (f) => ({ balance_mismatch: 'Balance is off here', sign_guessed: 'In or out? Check', date_check: 'Date unclear on the scan. Check' })[f] || f;

$('#rows').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) editRow(Number(li.dataset.i));
});
$('#rows').addEventListener('keydown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); editRow(Number(li.dataset.i)); }
});

function parseMoney(text) {
  const cleaned = String(text || '').replace(/[^0-9.,-]/g, '');
  if (!cleaned) return null;
  const n = Math.round(parseFloat(cleaned.replace(/,/g, '')) * 100);
  return Number.isFinite(n) ? Math.abs(n) : NaN;
}

function editRow(i) {
  const entry = current();
  const t = entry.st.transactions[i];
  if (!t) return;
  const form = document.createElement('form');
  form.className = 'stack';
  form.innerHTML = `
    <label>Date <input name="date" type="date" required value="${esc(t.date)}"></label>
    <label>Description <input name="description" value="${esc(t.description)}" maxlength="300"></label>
    <label>Money out <input name="out" inputmode="decimal" value="${t.amount < 0 ? (-t.amount / 100).toFixed(2) : ''}" placeholder="0.00"></label>
    <label>Money in <input name="in" inputmode="decimal" value="${t.amount > 0 ? (t.amount / 100).toFixed(2) : ''}" placeholder="0.00"></label>
    <p class="error" role="alert"></p>
    <button class="primary" type="submit">Save</button>
    <button class="danger" type="button" data-del>Delete this row</button>`;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const out = parseMoney(fd.get('out'));
    const inn = parseMoney(fd.get('in'));
    const err = $('.error', form);
    if (Number.isNaN(out) || Number.isNaN(inn)) { err.textContent = 'Enter amounts as numbers, like 1,234.56'; return; }
    if (out && inn) { err.textContent = 'Fill in money out or money in, not both.'; return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fd.get('date'))) { err.textContent = 'Enter a valid date.'; return; }
    t.date = fd.get('date');
    t.description = String(fd.get('description')).trim();
    t.amount = out ? -out : inn || 0;
    t.signSource = 'column';
    recheck(entry);
    closeSheet();
    renderFiles();
    render();
    saveHistory(entry);
  });
  $('[data-del]', form).addEventListener('click', () => {
    entry.st.transactions.splice(i, 1);
    recheck(entry);
    closeSheet();
    render();
    saveHistory(entry);
    toast('Row deleted');
  });
  openSheet('Edit transaction', form);
}

// ---------- insights (Pro) ----------

function renderInsights(entry) {
  const el = $('#insights');
  const ent = acct.entitlements();
  const parts = [];
  const r = entry.result;
  if (!r.transactions.length) { el.innerHTML = ''; return; }
  if (ent.lenderReport) {
    try {
      const L = lenderReport(r);
      if (!L.empty) {
        const flags = (L.flags || []).filter((f) => f.level !== 'info');
        parts.push(`<div class="insight"><h3>Lender summary</h3>
          <div>${esc(L.period.from)} to ${esc(L.period.to)} · in ${formatCents(L.totalInflow)} · out ${formatCents(L.totalOutflow)}</div>
          ${L.averageDailyBalance !== null ? `<div>Average daily balance ${formatCents(L.averageDailyBalance)}${L.lowestBalance ? ` · lowest ${formatCents(L.lowestBalance.balance)} on ${esc(L.lowestBalance.date)}` : ''}</div>` : ''}
          ${L.recurringMonthlyIncome ? `<div>Recurring income about ${formatCents(L.recurringMonthlyIncome)} a month</div>` : ''}
          ${flags.length ? `<ul>${flags.map((f) => `<li class="lvl-${esc(f.level)}">${esc(f.message)}</li>`).join('')}</ul>` : '<div>No risk flags.</div>'}</div>`);
      }
    } catch (e) { console.warn('lender report', e); }
  }
  if (ent.fraudChecks && entry.fraud) {
    const F = entry.fraud;
    parts.push(`<div class="insight"><h3>Tamper check: <span class="lvl-${esc(F.level)}">${F.level === 'low' ? 'nothing unusual' : esc(F.level) + ' risk'}</span></h3>
      ${F.findings.length ? `<ul>${F.findings.map((f) => `<li class="lvl-${esc(f.level)}">${esc(f.message)}</li>`).join('')}</ul>` : ''}</div>`);
  }
  if (!ent.lenderReport || !ent.fraudChecks) {
    const missing = [!ent.lenderReport && FEATURE_LABELS.lenderReport, !ent.fraudChecks && FEATURE_LABELS.fraudChecks].filter(Boolean);
    const list = missing.map((m, i) => (i ? m[0].toLowerCase() + m.slice(1) : m)).join(' and ');
    parts.push(`<div class="insight locked">${esc(list)}: included with Pro.${upgradeLinkHtml()}</div>`);
  }
  el.innerHTML = parts.join('');
}

function upgradeLinkHtml() {
  if (!acct.signedIn()) return ' <button type="button" class="link" data-goto="account">Sign in</button>';
  return purchasesAvailable() ? ' <button type="button" class="link" data-goto="account">See plans</button>' : '';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-goto]');
  if (b) { closeSheet(); showTab(b.dataset.goto); }
});

// ---------- export ----------

$('#exportBtn').addEventListener('click', () => {
  const entry = current();
  if (!entry?.result) return;
  const quick = ['xlsx', 'quickbooks', 'xero', 'csv'];
  const rest = FORMATS.filter((f) => !quick.includes(f.id));
  const btn = (f, primary) => `<button type="button" data-fmt="${f.id}"${primary ? ' class="primary"' : ''}>${esc(f.label)}</button>`;
  const warn = OK_STATUSES.has(entry.result.status) ? '' : '<p class="warnings">This statement does not balance yet. You can still export, but check the highlighted rows first.</p>';
  const body = openSheet('Export', `${warn}<div class="formats">${quick.map((id, i) => btn(formatById[id], i === 0)).join('')}</div>
    <p class="hint">More formats</p><div class="formats">${rest.map((f) => btn(f)).join('')}</div>
    <p class="hint">The file opens in the share sheet: save it to Files, email it, or open it in QuickBooks, Xero or Excel.</p>`);
  // onclick, not addEventListener: the sheet body is reused, and a stacked listener
  // would export earlier statements too.
  body.onclick = (e) => { const b = e.target.closest('[data-fmt]'); if (b) exportAs(entry, b.dataset.fmt, b); };
});

async function exportAs(entry, id, button) {
  if (button) button.disabled = true;
  try {
    if (!entry.counted) {
      const gate = await acct.countStatement();
      if (!gate.ok) { showLimit(gate.message); return; }
      entry.counted = true;
      saveHistory(entry);
    }
    const f = formatById[id];
    const ctx = { dateStyle: entry.dateOrder === 'DMY' ? 'DMY' : 'MDY', currency: entry.currency || 'USD' };
    const base = entry.name.replace(/\.(pdf|jpe?g|png|heic)$/i, '').replace(/[()]/g, '').trim() || 'statement';
    const outcome = await P.shareFile(f.build(entry.result, ctx), base + f.ext, f.mime);
    if (outcome === 'downloaded') toast(`Saved ${base + f.ext}`);
  } catch (e) {
    console.error(e);
    toast("Couldn't export. Please try again.");
  } finally {
    if (button) button.disabled = false;
  }
}

function showLimit(message) {
  openSheet('Monthly limit reached', `<p>${esc(message)}</p>
    <p class="hint">Your converted statements stay here, so you can export them once your plan allows.</p>
    ${acct.signedIn() ? (purchasesAvailable() ? '<button type="button" class="primary" data-goto="account">See plans</button>' : '') : '<button type="button" class="primary" data-goto="account">Sign in</button>'}`);
}

// ---------- quick feedback after a conversion ----------

$('#nudge').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-quick]');
  if (!b) return;
  const entry = current();
  const context = entry?.result ? {
    status: entry.result.status, transactions: entry.result.transactions.length, flagged: entry.result.flaggedCount,
    dateOrder: entry.dateOrder, pages: entry.pages?.length ?? null, ocr: !!entry.ocr, ocrConfidence: entry.ocrConfidence ?? null,
  } : { status: 'error', ocr: !!entry?.ocr };
  if (b.dataset.quick === 'yes') {
    $('#nudge').innerHTML = '<span>Thanks! Glad it worked.</span>';
    sendFeedback({ kind: 'conversion_ok', rating: 5, message: '', context }).catch(() => {});
    return;
  }
  const form = document.createElement('form');
  form.className = 'stack';
  form.innerHTML = `<label>What went wrong? (Don't paste account numbers or statement text.)
      <textarea name="message" required maxlength="3000"></textarea></label>
    <label>Email, if you'd like a reply <input type="email" name="email" autocomplete="email"></label>
    <button class="primary">Send</button>`;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    try {
      await sendFeedback({ kind: 'conversion_problem', rating: 1, message: fd.get('message'), email: fd.get('email') || null, context });
      closeSheet();
      $('#nudge').innerHTML = '<span>Thanks. We read every report and fix the most common problems first.</span>';
    } catch {
      toast("That didn't send. Check your connection and try again.");
    }
  });
  openSheet('What went wrong?', form);
});

// ---------- new / scan ----------

$('#newBtn').addEventListener('click', () => {
  state.active = -1;
  state.files = state.files.filter((f) => f.status === 'reading');
  if (state.files.length) state.active = 0;
  renderFiles();
  render();
});

$('#scanBtn').addEventListener('click', async () => {
  let blobs;
  try {
    blobs = await P.scanPages();
  } catch (e) {
    console.error(e);
    toast("Couldn't open the camera. Check camera permission in Settings.");
    return;
  }
  if (blobs === null) {
    // browser: let the OS offer the camera
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.multiple = true;
    input.onchange = () => handleFiles([...input.files]);
    input.click();
    return;
  }
  if (!blobs.length) return;
  const name = `Scan ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  await addImages(name, blobs);
});

// ---------- recent ----------

async function saveHistory(entry) {
  if (entry.status !== 'done') return;
  const st = { ...entry.st, transactions: entry.st.transactions.map(({ evidence, ...t }) => t) };
  await history.save({
    id: entry.id, name: entry.name, createdAt: entry.createdAt, dateOrder: entry.dateOrder, currency: entry.currency,
    status: entry.result.status, count: entry.result.transactions.length, ocr: !!entry.ocr, counted: entry.counted, st, fraud: entry.fraud || null,
  });
}

async function renderRecent() {
  const items = await history.list();
  $('#recentEmpty').hidden = items.length > 0;
  $('#clearHistory').hidden = !items.length;
  $('#recentList').innerHTML = items.map((h) => `<li>
    <span class="grow"><span class="title">${OK_STATUSES.has(h.status) ? '✓' : '!'} ${esc(h.name)}</span>
    <small>${new Date(h.createdAt).toLocaleDateString()} · ${h.count} transactions${h.ocr ? ' · scan' : ''}</small></span>
    <button type="button" data-open="${esc(h.id)}">Open</button>
    <button type="button" class="link" data-remove="${esc(h.id)}" aria-label="Remove ${esc(h.name)}">Remove</button></li>`).join('');
}

$('#recentList').addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open]');
  const rm = e.target.closest('[data-remove]');
  if (rm) { await history.remove(rm.dataset.remove); renderRecent(); return; }
  if (!open) return;
  const h = (await history.list()).find((x) => x.id === open.dataset.open);
  if (!h) return;
  const existing = state.files.findIndex((f) => f.id === h.id);
  if (existing >= 0) { state.active = existing; } else {
    const entry = { id: h.id, name: h.name, kind: 'history', status: 'done', createdAt: h.createdAt, dateOrder: h.dateOrder, currency: h.currency,
      st: h.st, ocr: h.ocr, counted: h.counted, fraud: h.fraud, pages: null };
    recheck(entry);
    state.files.push(entry);
    state.active = state.files.length - 1;
  }
  showTab('convert');
  renderFiles();
  render();
});

$('#clearHistory').addEventListener('click', async () => {
  openSheet('Clear recent statements?', `<p>This removes every converted statement saved on this device.</p>
    <button type="button" class="danger" id="confirmClear">Clear all</button>`);
  $('#confirmClear').addEventListener('click', async () => { await history.clear(); closeSheet(); renderRecent(); toast('Cleared'); });
});

// ---------- account ----------

let pendingEmail = '';
$('#emailForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#email').value.trim();
  const btn = $('button', e.target);
  btn.disabled = true;
  $('#signinError').textContent = '';
  try {
    await acct.startSignIn(email);
    pendingEmail = email;
    $('#emailForm').hidden = true;
    $('#codeForm').hidden = false;
    $('#codeLabel').textContent = `Enter the 6-digit code we emailed to ${email}`;
    setTimeout(() => $('#code').focus(), 50);
  } catch (err) {
    $('#signinError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
$('#codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('button[type=submit]', e.target);
  btn.disabled = true;
  $('#signinError').textContent = '';
  try {
    await acct.verifyCode(pendingEmail, $('#code').value.trim());
    $('#code').value = '';
    $('#codeForm').hidden = true;
    $('#emailForm').hidden = false;
    toast('Signed in');
  } catch (err) {
    $('#signinError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
$('#codeBack').addEventListener('click', () => { $('#codeForm').hidden = true; $('#emailForm').hidden = false; $('#signinError').textContent = ''; });
$('#signOut').addEventListener('click', async () => { await acct.signOut(); await signOutPurchases(); toast('Signed out'); });
$('#refreshPlan').addEventListener('click', async () => {
  try { await acct.refresh(); toast('Plan updated'); } catch (e) { toast(e.message); }
});
$('#restoreBtn').addEventListener('click', async () => {
  try { await restore(acct.account()?.team?.id); await acct.refresh(); toast('Purchases restored'); } catch (e) { toast(e.message || 'Restore failed'); }
});
$('#deleteAccount').addEventListener('click', () => {
  openSheet('Delete your account?', `<p>This deletes your ${esc(CONFIG.brand)} account and, if you're the only member, your team's saved data on our servers. Statements on this device are not affected.</p>
    <p class="hint">An app store subscription must be cancelled separately in your Apple or Google account settings.</p>
    <p class="error" id="deleteError" role="alert"></p>
    <button type="button" class="danger" id="confirmDelete">Delete my account</button>`);
  $('#confirmDelete').addEventListener('click', async () => {
    try { await acct.deleteAccount(); await signOutPurchases(); closeSheet(); toast('Account deleted'); } catch (e) { $('#deleteError').textContent = e.message; }
  });
});
$('#keepHistory').addEventListener('change', async (e) => { await history.setEnabled(e.target.checked); if (!e.target.checked) toast('Recent statements cleared and no longer kept'); });
$('#defaultDateOrder').addEventListener('change', (e) => P.store.set('settings.dateOrder', e.target.value));
$('#privacyLink').addEventListener('click', (e) => { e.preventDefault(); window.open(CONFIG.site + '/privacy/', '_blank'); });

const SOURCE = { web: 'Billed through your web account', apple: 'Billed through the App Store', google: 'Billed through Google Play' };
const MANAGE = { apple: 'Manage or cancel in Settings › your name › Subscriptions.', google: 'Manage or cancel in Google Play › Payments & subscriptions.' };

async function renderAccount() {
  const me = acct.account();
  const signed = acct.signedIn();
  $('#signedOut').hidden = signed;
  $('#signedIn').hidden = !signed;
  $('#deleteAccount').hidden = !signed;
  $('#keepHistory').checked = await history.enabled();
  $('#defaultDateOrder').value = await P.store.get('settings.dateOrder', '');
  $('#version').textContent = `${CONFIG.brand} ${CONFIG.version} (${P.platform})`;
  if (!signed) return;
  const t = me?.team || {};
  const ent = acct.entitlements();
  const u = await acct.usage();
  const limit = ent.statementsPerMonth;
  $('#acctEmail').textContent = me?.user?.email || 'Signed in';
  const rows = [
    ['Plan', `${esc(t.planName || acct.PLANS[t.plan || 'free']?.name || 'Free')}${t.status && t.status !== 'active' ? ` (${esc(t.status)})` : ''}`],
    ['This month', `${u.statements} statement${u.statements === 1 ? '' : 's'}${limit ? ` of ${limit}` : ''}`],
  ];
  if (t.periodEnd) rows.push(['Renews', new Date(t.periodEnd).toLocaleDateString()]);
  if (t.planSource && t.plan !== 'free') rows.push(['Billing', esc(SOURCE[t.planSource] || t.planSource)]);
  if (t.name) rows.push(['Team', esc(t.name)]);
  $('#planInfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const included = Object.entries(ent).filter(([k, v]) => v && FEATURE_LABELS[k] && !acct.comingSoon()[k] && !['allFormats', 'balanceCheck', 'statementsPerMonth', 'seats'].includes(k));
  let up = included.length ? `<p class="hint">Included: ${included.map(([k]) => esc(FEATURE_LABELS[k])).join(', ')}.</p>` : '';
  if (MANAGE[t.planSource] && t.plan !== 'free') up += `<p class="hint">${MANAGE[t.planSource]}</p>`;
  $('#restoreBtn').hidden = !purchasesAvailable();
  $('#upgrade').innerHTML = up;
  if (purchasesAvailable() && t.plan !== 'firm' && (t.planSource !== 'web' || t.plan === 'free')) {
    try {
      const pkgs = await offerings(t.id);
      const want = pkgs.filter((p) => t.plan === 'free' || p.plan === 'firm');
      if (want.length) {
        $('#upgrade').insertAdjacentHTML('beforeend', `<h2>Upgrade</h2><div class="plans">${want.map((p, i) =>
          `<button type="button" class="plan-btn" data-pkg="${i}"><span>${esc(acct.PLANS[p.plan].name)} · ${p.period === 'year' ? 'yearly' : 'monthly'}</span><strong>${esc(p.price)}</strong></button>`).join('')}</div>
          <p class="hint">Payment is charged to your ${P.platform === 'ios' ? 'Apple' : 'Google'} account. Subscriptions renew automatically unless cancelled at least 24 hours before the end of the period. <a href="#" data-legal="terms">Terms</a> · <a href="#" data-legal="privacy">Privacy</a></p>`);
        $('#upgrade').onclick = async (e) => {
          const legal = e.target.closest('[data-legal]');
          if (legal) { e.preventDefault(); window.open(`${CONFIG.site}/${legal.dataset.legal}/`, '_blank'); return; }
          const b = e.target.closest('[data-pkg]');
          if (!b) return;
          b.disabled = true;
          try {
            const res = await buy(t.id, want[Number(b.dataset.pkg)]);
            if (res === 'purchased') { toast('Thanks! Updating your plan…'); await waitForPlan(t.plan); }
          } catch (err) { toast(err.message || 'Purchase failed'); } finally { b.disabled = false; }
        };
      }
    } catch (e) { console.warn('offerings', e); }
  }
}

// The webhook updates the plan a moment after the store confirms the purchase.
async function waitForPlan(oldPlan) {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const me = await acct.refresh().catch(() => null);
    if (me?.team?.plan && me.team.plan !== oldPlan) { toast(`You're on ${me.team.planName || me.team.plan}`); return; }
  }
  toast('Purchase received. Your plan will update in a minute; tap Refresh plan.');
}

async function renderUsageNote() {
  const note = $('#usageNote');
  const left = await acct.remaining();
  if (left === Infinity) { note.textContent = ''; return; }
  note.textContent = acct.signedIn()
    ? `${left} free statement${left === 1 ? '' : 's'} left this month on your plan.`
    : `${left} of ${acct.PLANS.free.entitlements.statementsPerMonth} free statements left this month. Sign in to use your plan.`;
}

acct.onAccountChange(() => {
  if (state.tab === 'account') renderAccount();
  if (current()?.status === 'done') renderInsights(current());
  renderUsageNote();
});

// ---------- feedback page ----------

$('#feedbackForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = new FormData(form);
  const button = $('button', form);
  button.disabled = true;
  try {
    await sendFeedback({
      kind: data.get('kind'),
      rating: data.get('rating') ? Number(data.get('rating')) : null,
      message: data.get('message'),
      email: data.get('email') || null,
      website: data.get('website'),
      context: { signedIn: acct.signedIn(), plan: acct.planId() },
    });
    form.hidden = true;
    $('#feedbackThanks').hidden = false;
    form.reset();
    setTimeout(() => { form.hidden = false; $('#feedbackThanks').hidden = true; }, 8000);
  } catch {
    toast("That didn't send. Check your connection and try again.");
  } finally {
    button.disabled = false;
  }
});

// ---------- files opened from other apps ----------

P.onIncomingFile(async ({ url, name }) => {
  try {
    const bytes = await P.readUrl(url);
    const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
    if (isPdf) await addPdf(/\.pdf$/i.test(name) ? name : 'Shared statement.pdf', bytes);
    else await addImages(name, [new Blob([bytes])]);
  } catch (e) {
    console.error(e);
    toast("Couldn't open that file.");
  }
});

// Android back button: close the sheet, then go back to Convert, then leave.
const AppPlugin = P.native('App');
AppPlugin?.addListener('backButton', () => {
  if (closeSheet()) return;
  if (state.tab !== 'convert') { showTab('convert'); return; }
  AppPlugin.minimizeApp?.();
});
AppPlugin?.addListener('appStateChange', ({ isActive }) => {
  if (!isActive && !state.files.some((f) => f.status === 'reading')) import('./ocr-browser.js').then((m) => m.releaseOcr()).catch(() => {});
  if (isActive && acct.signedIn()) acct.refresh().catch(() => {});
});

// ---------- start ----------

addEventListener('resize', () => renderFiles());
P.setStatusBar(matchMedia('(prefers-color-scheme: dark)').matches);
await acct.loadAccount();
render();
P.hideSplash();
globalThis.__app.ready = true;
globalThis.__app.handleFiles = handleFiles;
