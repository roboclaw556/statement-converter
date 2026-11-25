// Browser app: reads PDFs locally with pdf.js, shows the checked rows, exports.
import * as pdfjs from './vendor/pdf.min.mjs';
import { sendFeedback } from './feedback.js';
import { extractLines, parseStatement, reconcile, formatCents,
  FORMATS, formatById } from './core/index.js';
import { categorize, DEFAULT_CATEGORIES } from './core/categorize.js';
import { lenderReport } from './core/lender.js';
import { fraudChecks } from './core/fraud.js';
import { PLANS, COMING_SOON } from './core/plans.js';
import { api, getMe, escapeHtml } from './api.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (s) => document.querySelector(s);
const tool = $('#tool');
const root = new URL('./', import.meta.url).pathname;
const state = { files: [], active: 0 };

// Plan and rules for the signed-in team; anonymous visitors get the Free plan.
const account = { me: null, ent: { ...PLANS.free.entitlements }, comingSoon: { ...COMING_SOON }, rules: [] };
const ready = getMe().then(async (me) => {
  if (!me) return;
  account.me = me;
  account.ent = me.entitlements;
  account.comingSoon = me.comingSoon || {};
  if (me.entitlements.categoryRules) account.rules = (await api.get('/api/rules').catch(() => ({ rules: [] }))).rules;
});

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
    entry.meta = await pdf.getMetadata().catch(() => null);
    entry.pages = pages;
    entry.scanned = !hasText;
    entry.dateOrder = undefined;
    run(entry);
    entry.status = 'done';
    await countUsage(entry);
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

// A client upload opened from the account page: /?upload=<id>
const uploadId = new URLSearchParams(location.search).get('upload');
if (uploadId && /^[\w-]{3,80}$/.test(uploadId)) {
  api.get(`/api/uploads/${uploadId}/file`, { raw: true }).then(async (res) => {
    const name = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '') || [])[1] || 'statement.pdf';
    await handleFiles([new File([await res.blob()], name, { type: 'application/pdf' })]);
    history.replaceState(null, '', location.pathname);
  }).catch(() => {});
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
  applyCategories(entry);
  recheck(entry);
}

/** Team rules first, then built-in rules. Categories someone picked by hand are kept. */
function applyCategories(entry) {
  const done = categorize(entry.st.transactions, account.rules);
  entry.st.transactions.forEach((t, i) => {
    if (t.categorySource === 'manual' || t.categorySource === 'ai') return;
    t.category = done[i].category;
    t.categorySource = done[i].categorySource;
  });
}

// ---------- plan limits ----------

const LIMIT_KEY = 'so_free_' + new Date().toISOString().slice(0, 7);

/** Counts a converted statement against the plan. Free: 5 a month. */
async function countUsage(entry) {
  if (entry.counted || !entry.result?.transactions.length) return;
  entry.counted = true;
  await ready;
  if (account.me) {
    try { await api.post('/api/usage/statement', { statements: 1 }); }
    catch (e) { if (e.status === 402) entry.blocked = e.message; }
    return;
  }
  let n = 0;
  try { n = Number(localStorage.getItem(LIMIT_KEY) || 0); localStorage.setItem(LIMIT_KEY, String(n + 1)); } catch {}
  if (n >= PLANS.free.entitlements.statementsPerMonth) entry.blocked = `You've converted ${n} statements this month on the free plan.`;
}

function limitNote(entry) {
  const el = $('#limitNote');
  el.hidden = !entry?.blocked;
  if (entry?.blocked) {
    el.innerHTML = `<strong>Free plan limit reached.</strong> ${escapeHtml(entry.blocked)} <a href="${root}pricing/">Go unlimited with Pro</a>${account.me ? '' : ` or <a href="${root}login/">sign in</a>`}.`;
  }
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
  limitNote(entry);

  const tbody = $('#table tbody');
  tbody.innerHTML = '';
  r.transactions.forEach((t, i) => {
    const tr = document.createElement('tr');
    if (t.flags.length) tr.className = 'flag';
    tr.innerHTML = `<td>${t.date}</td><td class="desc" contenteditable="plaintext-only"></td>
      <td class="num" contenteditable="plaintext-only">${t.amount < 0 ? formatCents(-t.amount) : ''}</td>
      <td class="num" contenteditable="plaintext-only">${t.amount > 0 ? formatCents(t.amount) : ''}</td>
      <td class="num">${t.balance === null ? '' : formatCents(t.balance)}</td>
      <td class="cat"><select aria-label="Category">${categoryOptions(t.category)}</select></td>
      <td class="check">${flagText(t.flags)}</td>`;
    tr.children[1].textContent = t.description;
    if (t.categorySource === 'ai') tr.children[5].title = 'Suggested by AI';
    tr.children[5].firstChild.addEventListener('change', (e) => setCategory(entry, i, e.target.value));
    tr.children[1].addEventListener('blur', (e) => { entry.st.transactions[i].description = e.target.textContent.trim(); });
    for (const [col, sign] of [[2, -1], [3, 1]]) {
      tr.children[col].addEventListener('blur', (e) => editAmount(entry, i, e.target.textContent, sign));
    }
    tbody.appendChild(tr);
  });
}

function categoryOptions(current) {
  const list = DEFAULT_CATEGORIES.includes(current) || !current ? DEFAULT_CATEGORIES : [current, ...DEFAULT_CATEGORIES];
  return list.map((c) => `<option${c === current ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
}

/** A correction. On Pro it becomes a rule, so the same payee is categorized next time. */
async function setCategory(entry, i, category) {
  const t = entry.st.transactions[i];
  t.category = category;
  t.categorySource = 'manual';
  recheck(entry);
  if (!account.ent.categoryRules) {
    showPanel(`<p>Category saved for this export. <a href="${root}pricing/">Pro</a> remembers it for this payee on every future statement.</p>`);
    return;
  }
  try {
    const { rule } = await api.post('/api/rules/learn', { description: t.description, category });
    if (rule) {
      account.rules = account.rules.filter((r) => r.id !== rule.id).concat(rule);
      applyCategories(entry);
      recheck(entry);
      render();
      showPanel(`<p>Saved: anything containing <strong>${escapeHtml(rule.pattern)}</strong> is now <strong>${escapeHtml(rule.category)}</strong>. Manage rules on your <a href="${root}account/#rules">account page</a>.</p>`);
    }
  } catch (e) { showPanel(`<p>${escapeHtml(e.message)}</p>`); }
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
  if (entry.blocked) { limitNote(entry); $('#limitNote').scrollIntoView({ block: 'center' }); return; }
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

// ---------- Pro tools: AI categories, lender report, tamper check, send to accounting ----------

function showPanel(html) {
  const p = $('#proPanel');
  p.hidden = !html;
  p.innerHTML = html || '';
}

const upgrade = (what, plan = 'Pro') => `<p><strong>${what}</strong> is part of the ${plan} plan. <a href="${root}pricing/">See plans</a>${account.me ? '' : ` or <a href="${root}login/">sign in</a>`}.</p>`;

$('#proBar').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pro]');
  const entry = state.files[state.active];
  if (!b || !entry?.result?.transactions.length) return;
  await ready;
  const kind = b.dataset.pro;
  try {
    if (kind === 'ai') return await runAi(entry, b);
    if (kind === 'lender') return showLender(entry);
    if (kind === 'fraud') return showFraud(entry);
    if (kind.startsWith('push-')) return await pushTo(entry, kind.slice(5), b);
  } catch (err) {
    showPanel(`<p>${escapeHtml(err.status === 402 ? err.message + '.' : err.message)}${err.status === 402 ? ` <a href="${root}pricing/">See plans</a>` : ''}</p>`);
  }
});

async function runAi(entry, button) {
  if (!account.ent.aiCategorizePerMonth) return showPanel(upgrade('AI categorization'));
  button.disabled = true;
  showPanel('<p>Categorizing… only descriptions and amounts are sent, never the PDF.</p>');
  try {
    const rows = entry.st.transactions;
    const { results, aiRows } = await api.post('/api/categorize', { transactions: rows.map((t) => ({ description: t.description, amount: t.amount })) });
    let changed = 0;
    results.forEach((r, i) => {
      if (r.source === 'ai' && rows[i].categorySource !== 'manual') { rows[i].category = r.category; rows[i].categorySource = 'ai'; changed++; }
    });
    recheck(entry);
    render();
    showPanel(`<p>${aiRows ? `AI categorized ${changed} of ${aiRows} rows your rules didn't cover.` : 'Your rules already covered every row.'} Change any category in the table and Pro will remember it.</p>`);
  } finally { button.disabled = false; }
}

const pct = (x) => x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`;

function showLender(entry) {
  if (!account.ent.lenderReport) return showPanel(upgrade('The lender report'));
  const r = lenderReport(entry.result);
  if (r.empty) return showPanel('<p>No transactions to analyse.</p>');
  const rows = r.monthly.map((m) => `<tr><td>${m.month}</td><td class="num">${formatCents(m.inflow)}</td><td class="num">${formatCents(m.outflow)}</td><td class="num">${formatCents(m.net)}</td></tr>`).join('');
  const list = (items) => items.length ? `<ul>${items.map((t) => `<li>${t.date} ${escapeHtml(t.description)} <span class="num">${formatCents(t.amount)}</span></li>`).join('')}</ul>` : '<p class="hint">None</p>';
  showPanel(`<h3>Lender report</h3>
    <dl class="totals">
      <div><dt>Average daily balance</dt><dd>${formatCents(r.averageDailyBalance)}</dd></div>
      <div><dt>Lowest balance</dt><dd>${formatCents(r.lowestBalance)}</dd></div>
      <div><dt>Recurring monthly income</dt><dd>${formatCents(r.recurringMonthlyIncome)}</dd></div>
      <div><dt>Debt payments / income</dt><dd>${pct(r.debtToIncome)}</dd></div>
    </dl>
    <p>${r.period.from} to ${r.period.to} · ${r.daysNegative} day(s) below zero · ${r.nsf.length} returned/NSF item(s)</p>
    ${r.flags.length ? `<ul class="flags">${r.flags.map((f) => `<li>${escapeHtml(typeof f === 'string' ? f : f.message)}</li>`).join('')}</ul>` : ''}
    <div class="table-wrap"><table><thead><tr><th>Month</th><th class="num">In</th><th class="num">Out</th><th class="num">Net</th></tr></thead><tbody>${rows}</tbody></table></div>
    <h4>Large deposits</h4>${list(r.largeDeposits)}
    <button type="button" id="lenderJson">Download report (JSON)</button>`);
  $('#lenderJson').onclick = () => save(JSON.stringify(r, null, 2), entry.name.replace(/\.pdf$/i, '') + '-lender-report.json', 'application/json');
}

function showFraud(entry) {
  if (!account.ent.fraudChecks) return showPanel(upgrade('The tamper check'));
  const f = fraudChecks(entry.meta, entry.data, entry.result);
  const label = { low: 'Low risk', medium: 'Worth a closer look', high: 'High risk' }[f.level];
  showPanel(`<h3>Tamper check: ${label}</h3>
    ${f.findings.length ? `<ul>${f.findings.map((x) => `<li class="lvl-${x.level}">${escapeHtml(x.message)}</li>`).join('')}</ul>` : '<p>Nothing unusual found in the file or the numbers.</p>'}
    <p class="hint">These are signals, not proof. Each one says what was seen so you can look closer.</p>`);
}

async function pushTo(entry, providerId, button) {
  const name = providerId === 'quickbooks' ? 'QuickBooks' : 'Xero';
  if (!account.ent.accountingPush) return showPanel(upgrade(`Sending to ${name}`));
  if (account.comingSoon.accountingPush) {
    return showPanel(`<p><span class="soon">Coming soon</span> Sending straight to ${name} opens as soon as ${name} approves our app. Until then, download the ${name} file above and import it.</p>`);
  }
  const { integrations } = await api.get('/api/integrations');
  const it = integrations.find((x) => x.id === providerId);
  if (!it?.connected) return showPanel(`<p>Connect ${name} on your <a href="${root}account/#integrations">account page</a> first.</p>`);
  button.disabled = true;
  try {
    const out = await api.post(`/api/integrations/${providerId}/push`, {
      transactions: entry.result.transactions.filter((t) => t.amount).map((t) => ({ date: t.date, description: t.description, amount: t.amount, category: t.category })),
    });
    showPanel(`<p>Sent ${out.sent} transaction(s) to ${name}.${out.skipped ? ` ${out.skipped} were already there and were skipped.` : ''}${out.failed ? ` ${out.failed} failed: ${escapeHtml(out.results.find((r) => r.status === 'failed')?.error || '')}` : ''}</p>`);
  } finally { button.disabled = false; }
}

// Mark Pro buttons that are coming soon or not in this plan.
ready.then(() => {
  for (const b of document.querySelectorAll('[data-pro]')) {
    const k = b.dataset.pro;
    if (k.startsWith('push-') && account.comingSoon.accountingPush) b.insertAdjacentHTML('beforeend', ' <span class="soon">Coming soon</span>');
    const feature = { ai: 'aiCategorizePerMonth', lender: 'lenderReport', fraud: 'fraudChecks' }[k] || 'accountingPush';
    if (!account.ent[feature]) b.classList.add('locked');
  }
});
