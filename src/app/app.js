// Browser app: reads PDFs locally with pdf.js, shows the checked rows, exports.
import * as pdfjs from './vendor/pdf.min.mjs';
import { sendFeedback } from './feedback.js';
import { extractLines, parseStatement, reconcile, formatCents,
  FORMATS, formatById } from './core/index.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (s) => document.querySelector(s);
const tool = $('#tool');
const state = { files: [], active: 0 };

// ---------- loading ----------

$('#file').addEventListener('change', (e) => handleFiles([...e.target.files]));
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => handleFiles([...e.dataTransfer.files].filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name))));

async function handleFiles(files) {
  for (const file of files) {
    const entry = { name: file.name, status: 'reading', data: new Uint8Array(await file.arrayBuffer()) };
    state.files.push(entry);
    state.active = state.files.length - 1;
    renderFiles();
    await openEntry(entry);
  }
}

async function openEntry(entry, password) {
  try {
    const pdf = await pdfjs.getDocument({ data: entry.data.slice(), password, verbosity: 0 }).promise;
    const { pages, hasText } = await extractLines(pdf);
    entry.pages = pages;
    entry.scanned = !hasText;
    entry.dateOrder = undefined;
    run(entry);
    entry.status = 'done';
  } catch (err) {
    if (err?.name === 'PasswordException') {
      entry.status = 'locked';
      askPassword(entry, err.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    } else {
      entry.status = 'error';
      entry.error = 'Could not read this PDF. Is it a bank statement PDF (not a photo)?';
      console.error(err);
    }
  }
  renderFiles();
  render();
}

function askPassword(entry, wrong) {
  const form = $('#password');
  form.hidden = false;
  form.querySelector('label').firstChild.textContent = wrong
    ? 'Wrong password, try again: '
    : `"${entry.name}" is password protected. Enter its password: `;
  $('#pw').value = '';
  $('#pw').focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    form.hidden = true;
    await openEntry(entry, $('#pw').value);
  };
}

// ---------- parsing + checking ----------

function run(entry) {
  if (entry.scanned) {
    entry.st = { transactions: [], opening: null, closing: null, totalCredits: null, totalDebits: null, warnings: [], dateOrder: 'MDY' };
    entry.result = reconcile(entry.st);
    entry.warnings = ['This PDF has no text layer, so it looks scanned. Scanned statements need OCR, which is coming soon.'];
    return;
  }
  const preferred = entry.dateOrder || tool.dataset.defaultDateOrder || undefined;
  entry.st = parseStatement(entry.pages, { dateOrder: entry.dateOrder });
  // Use the page's country default only when the statement itself is ambiguous.
  if (!entry.dateOrder && preferred && preferred !== entry.st.dateOrder && isAmbiguous(entry)) {
    entry.st = parseStatement(entry.pages, { dateOrder: preferred });
  }
  entry.dateOrder = entry.st.dateOrder;
  entry.warnings = entry.st.warnings;
  recheck(entry);
}

function isAmbiguous(entry) {
  const a = parseStatement(entry.pages, { dateOrder: 'MDY' });
  const b = parseStatement(entry.pages, { dateOrder: 'DMY' });
  return a.transactions.length === b.transactions.length && reconcile(a).status === reconcile(b).status;
}

function recheck(entry) {
  entry.result = reconcile(entry.st);
}

// ---------- rendering ----------

const STATUS_DETAIL = {
  reconciled: 'Opening balance + every transaction = the closing balance on the statement.',
  running_balance_ok: 'Every row matches the running balance (the statement prints no closing balance).',
  mismatch: 'The highlighted rows break the running balance. Fix them below before exporting.',
  unverified: 'No opening or closing balance was found, so check the totals against the statement.',
};

function renderFiles() {
  const el = $('#files');
  el.hidden = state.files.length < 2;
  el.innerHTML = '';
  state.files.forEach((f, i) => {
    const b = document.createElement('button');
    b.className = 'file' + (i === state.active ? ' active' : '');
    const badge = f.result ? (f.result.status === 'reconciled' || f.result.status === 'running_balance_ok' ? '✓' : '!') : '…';
    b.textContent = `${badge} ${f.name}`;
    b.onclick = () => { state.active = i; renderFiles(); render(); };
    el.appendChild(b);
  });
}

function render() {
  const entry = state.files[state.active];
  const box = $('#result');
  if (!entry || entry.status === 'reading' || entry.status === 'locked') { box.hidden = true; return; }
  box.hidden = false;
  if (entry.status === 'error') {
    $('#status').className = 'status bad';
    $('#status').textContent = entry.error;
    $('#totals').innerHTML = '';
    $('#warnings').textContent = '';
    $('#table tbody').innerHTML = '';
    return;
  }
  const r = entry.result;
  const ok = r.status === 'reconciled' || r.status === 'running_balance_ok';
  $('#status').className = 'status ' + (ok ? 'good' : r.status === 'mismatch' ? 'bad' : 'warn');
  $('#status').innerHTML = `<strong>${ok ? 'Balanced' : r.status === 'mismatch' ? 'Does not balance' : 'Not verified'}</strong>
    <span>${STATUS_DETAIL[r.status]}${r.difference ? ` Off by ${formatCents(r.difference)}.` : ''}
    ${r.transactions.length} transactions${r.flaggedCount ? `, ${r.flaggedCount} to review` : ''}.</span>`;
  const dd = (label, v) => `<div><dt>${label}</dt><dd>${v === null ? '—' : formatCents(v)}</dd></div>`;
  $('#totals').innerHTML = dd('Opening', r.opening) + dd('Money in', r.credits) + dd('Money out', r.debits) + dd('Closing', r.closing);
  $('#warnings').textContent = entry.warnings.join(' ');
  $('#dateOrder').value = entry.dateOrder || 'MDY';

  const tbody = $('#table tbody');
  tbody.innerHTML = '';
  r.transactions.forEach((t, i) => {
    const tr = document.createElement('tr');
    if (t.flags.length) tr.className = 'flag';
    tr.innerHTML = `<td>${t.date}</td><td class="desc" contenteditable="plaintext-only"></td>
      <td class="num" contenteditable="plaintext-only">${t.amount < 0 ? formatCents(-t.amount) : ''}</td>
      <td class="num" contenteditable="plaintext-only">${t.amount > 0 ? formatCents(t.amount) : ''}</td>
      <td class="num">${t.balance === null ? '' : formatCents(t.balance)}</td>
      <td class="check">${flagText(t.flags)}</td>`;
    tr.children[1].textContent = t.description;
    tr.children[1].addEventListener('blur', (e) => { entry.st.transactions[i].description = e.target.textContent.trim(); });
    for (const [col, sign] of [[2, -1], [3, 1]]) {
      tr.children[col].addEventListener('blur', (e) => editAmount(entry, i, e.target.textContent, sign));
    }
    tbody.appendChild(tr);
  });
}

function flagText(flags) {
  if (!flags.length) return '<span class="ok">✓</span>';
  return flags.map((f) => ({
    balance_mismatch: 'Balance off here',
    sign_guessed: 'In or out? Check',
  })[f] || f).join(', ');
}

function editAmount(entry, i, text, sign) {
  const t = entry.st.transactions[i];
  const cleaned = text.replace(/[^0-9.,-]/g, '');
  if (!cleaned) {
    // Clearing one side is fine as long as the other side holds the amount.
    return;
  }
  const n = Math.round(parseFloat(cleaned.replace(/,/g, '')) * 100);
  if (!Number.isFinite(n)) return;
  t.amount = sign * Math.abs(n);
  t.signSource = 'column';
  recheck(entry);
  render();
  renderFiles();
}

$('#dateOrder').addEventListener('change', (e) => {
  const entry = state.files[state.active];
  if (!entry?.pages) return;
  entry.dateOrder = e.target.value;
  entry.st = parseStatement(entry.pages, { dateOrder: entry.dateOrder });
  entry.warnings = entry.st.warnings;
  recheck(entry);
  render();
});

// ---------- exports ----------

// The page's own format (e.g. "to Sage" pages) goes first, then the big three.
const pageFormat = tool.dataset.defaultFormat;
const quickIds = [...new Set([pageFormat === 'excel' ? 'xlsx' : pageFormat, 'xlsx', 'quickbooks', 'xero'])]
  .filter((id) => id && formatById[id]).slice(0, 3);
$('#quickExports').innerHTML = quickIds.map((id, i) =>
  `<button type="button" data-export="${id}"${i === 0 ? ' class="primary"' : ''}>${formatById[id].label.replace(/ \((CSV|\.xlsx)\)$/, '')}</button>`).join(' ');
$('#moreFormat').innerHTML = FORMATS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('');
$('#quickExports').addEventListener('click', (e) => { const b = e.target.closest('[data-export]'); if (b) exportAs(b.dataset.export); });
$('#moreDownload').addEventListener('click', () => exportAs($('#moreFormat').value));

function exportAs(id) {
  const entry = state.files[state.active];
  if (!entry?.result) return;
  const f = formatById[id];
  const ctx = { dateStyle: entry.dateOrder === 'DMY' ? 'DMY' : 'MDY', currency: guessCurrency(entry) };
  save(f.build(entry.result, ctx), entry.name.replace(/\.pdf$/i, '') + f.ext, f.mime);
}

function guessCurrency(entry) {
  const text = entry.pages.flat().map((l) => l.text).join(' ');
  if (/£|GBP|sort code/i.test(text)) return 'GBP';
  if (/€|EUR\b|IBAN/i.test(text)) return 'EUR';
  if (/\bCAD\b|Canada/i.test(text)) return 'CAD';
  if (/\bAUD\b|BSB/i.test(text)) return 'AUD';
  return 'USD';
}

function save(content, filename, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- quick feedback after a conversion ----------

const nudge = $('#nudge');
nudge.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-quick]');
  if (!b) return;
  const entry = state.files[state.active];
  const context = entry?.result ? {
    status: entry.result.status,
    transactions: entry.result.transactions.length,
    flagged: entry.result.flaggedCount,
    dateOrder: entry.dateOrder,
    pages: entry.pages?.length ?? null,
    bank: tool.dataset.bank || null,
  } : null;
  if (b.dataset.quick === 'yes') {
    nudge.textContent = 'Thanks! Glad it worked.';
    sendFeedback({ kind: 'conversion_ok', rating: 5, message: '', context }).catch(() => {});
    return;
  }
  nudge.innerHTML = `<form class="feedback-form" style="width:100%">
    <label>What went wrong? (Do not paste account numbers or statement text.)
      <textarea name="message" required maxlength="3000"></textarea></label>
    <label>Email, if you'd like a reply <input type="email" name="email"></label>
    <div><button class="primary">Send</button></div></form>`;
  nudge.querySelector('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      await sendFeedback({ kind: 'conversion_problem', rating: 1, message: fd.get('message'), email: fd.get('email') || null, context });
      nudge.textContent = 'Thanks. We read every report and fix the most common problems first.';
    } catch {
      nudge.textContent = 'Sorry, that did not send. Please use the feedback page.';
    }
  });
});
