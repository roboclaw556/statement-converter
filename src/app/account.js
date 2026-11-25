// Account page: plan and usage, billing, team, email import, rules, integrations,
// clients and uploads, branding, API keys. Sections appear according to the plan.
import { api, getMe, markSignedIn, escapeHtml as h } from './api.js';

const $ = (s, el = document) => el.querySelector(s);
const root = document.querySelector('#account');
const me = await getMe();
if (!me) location.replace('../login/?next=/account/');

const ent = me.entitlements;
const owner = me.user.role === 'owner';
const soon = me.comingSoon || {};
const params = new URLSearchParams(location.search);

const card = (id, title, body) => `<section class="card" id="${id}"><h2>${title}</h2>${body}</section>`;
const upsell = (what, plan) => `<p class="muted">${what} is included in ${plan}. <a href="../pricing/">See plans</a></p>`;
const flash = (el, text, bad) => { el.innerHTML = `<span class="${bad ? 'error' : 'ok-text'}">${h(text)}</span>`; };
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString() : '');

function render() {
  const t = me.team, u = me.usage;
  const limit = (v) => (v === null ? 'unlimited' : v);
  const notice = params.get('checkout') === 'success' ? '<p class="ok-text">Thanks! Your plan is updating; it can take a few seconds.</p>' : '';
  root.innerHTML = `
  <nav class="tabs">${['plan', 'team', 'email', 'rules', 'integrations', 'clients', 'branding', 'api', 'danger'].map((x) => `<a href="#${x}">${x === 'api' ? 'API' : x === 'danger' ? 'Account' : x[0].toUpperCase() + x.slice(1)}</a>`).join('')}</nav>
  ${card('plan', 'Plan and usage', `${notice}
    <p>Signed in as <strong>${h(me.user.email)}</strong>. Plan: <strong>${h(t.planName || t.plan)}</strong>${t.status !== 'active' ? ` (${h(t.status)})` : ''}${t.interval ? `, billed ${t.interval === 'year' ? 'yearly' : 'monthly'}` : ''}${t.periodEnd ? `, renews ${fmtDate(t.periodEnd)}` : ''}${t.planSource !== 'web' && t.plan !== 'free' ? ` through the ${t.planSource === 'google' ? 'Google Play' : 'App Store'}` : ''}.</p>
    <ul>
      <li>Statements this month: ${u.statements} of ${limit(ent.statementsPerMonth)}</li>
      ${ent.aiCategorizePerMonth ? `<li>AI categorization: ${u.aiStatements} of ${ent.aiCategorizePerMonth}</li>` : ''}
      ${ent.apiPagesPerMonth ? `<li>API pages: ${u.apiPages} of ${ent.apiPagesPerMonth}</li>` : ''}
    </ul>
    <div class="row">${t.plan === 'free' ? '<a class="button" href="../pricing/"><button class="primary" type="button">Upgrade</button></a>' : ''}
    ${owner && t.planSource === 'web' && t.plan !== 'free' ? '<button type="button" id="billing">Manage billing, invoices and plan</button>' : ''}
    ${t.plan === 'pro' ? '<a href="../pricing/"><button type="button">Switch to Firm</button></a>' : ''}</div><p id="billMsg"></p>`)}
  ${card('team', 'Team', '<div id="teamBody" class="muted">Loading…</div>')}
  ${card('email', 'Email import', ent.emailImport
    ? (t.inboxAddress
      ? `<p>Forward or send statement PDFs to <strong><code>${h(t.inboxAddress)}</code></strong> from your team's email addresses. You get Excel, QuickBooks and Xero files back in a minute.</p>`
      : '<p class="muted">Email import is not set up on this server yet.</p>')
    : upsell('Email import', 'Pro and Firm'))}
  ${card('rules', 'Category rules', ent.categoryRules ? '<div id="rulesBody" class="muted">Loading…</div>' : upsell('Rules that learn from your corrections', 'Pro and Firm'))}
  ${card('integrations', 'Connected apps', '<div id="intBody" class="muted">Loading…</div>')}
  ${card('clients', 'Clients and uploads', ent.clientPortal ? '<div id="clientsBody" class="muted">Loading…</div>' : upsell('The client upload portal', 'Firm'))}
  ${card('branding', 'White-label', ent.whiteLabel ? '<div id="brandBody" class="muted">Loading…</div>' : upsell('White-label branding and the embeddable converter', 'Firm'))}
  ${card('api', 'API keys', ent.apiPagesPerMonth ? '<div id="keysBody" class="muted">Loading…</div>' : upsell('The API', 'Firm'))}
  ${card('danger', 'Account', `<div class="row"><button type="button" id="logout">Sign out</button><button type="button" id="deleteMe">Delete my account</button></div><p id="dangerMsg"></p>`)}`;

  $('#billing')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { location.href = (await api.post('/api/billing/portal')).url; } catch (err) { flash($('#billMsg'), err.message, true); e.target.disabled = false; }
  });
  $('#logout').addEventListener('click', async () => { await api.post('/api/auth/logout').catch(() => {}); markSignedIn(false); location.href = '../'; });
  $('#deleteMe').addEventListener('click', async () => {
    const typed = prompt('This deletes your account and, if you are the only member, all of your team\'s data. Type DELETE to confirm.');
    if (typed !== 'DELETE') return;
    try { await api.del('/api/me'); markSignedIn(false); location.href = '../'; } catch (err) { flash($('#dangerMsg'), err.message, true); }
  });

  loadTeam(); if (ent.categoryRules) loadRules(); loadIntegrations();
  if (ent.clientPortal) loadClients(); if (ent.whiteLabel) loadBranding(); if (ent.apiPagesPerMonth) loadKeys();
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}

async function loadTeam() {
  const el = $('#teamBody');
  const { members, invites, seats } = await api.get('/api/team');
  el.className = '';
  el.innerHTML = `<p class="muted">${members.length + invites.length} of ${seats} seat${seats > 1 ? 's' : ''} used.</p>
    <ul class="list">${members.map((m) => `<li><span>${h(m.email)} <span class="muted">${m.role}</span></span>${owner && m.id !== me.user.id ? `<button type="button" data-remove-member="${h(m.id)}">Remove</button>` : ''}</li>`).join('')}
    ${invites.map((i) => `<li><span>${h(i.email)} <span class="muted">invited</span></span>${owner ? `<button type="button" data-remove-invite="${h(i.id)}">Cancel</button>` : ''}</li>`).join('')}</ul>
    ${owner && members.length + invites.length < seats ? `<form class="row" id="inviteForm"><input type="email" required placeholder="colleague@firm.com" aria-label="Email to invite"><button>Invite</button></form>` : ''}
    ${owner && seats === 1 ? upsell('Team seats', 'Firm (5 seats)') : ''}<p id="teamMsg"></p>`;
  $('#inviteForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.post('/api/team/invites', { email: e.target[0].value }); loadTeam(); } catch (err) { flash($('#teamMsg'), err.message, true); }
  });
  el.onclick = async (e) => {
    const m = e.target.dataset.removeMember, i = e.target.dataset.removeInvite;
    if (m && confirm('Remove this person from the team?')) await api.del(`/api/team/members/${m}`).then(loadTeam).catch((err) => flash($('#teamMsg'), err.message, true));
    if (i) await api.del(`/api/team/invites/${i}`).then(loadTeam);
  };
}

async function loadRules() {
  const el = $('#rulesBody');
  const { rules, categories } = await api.get('/api/rules');
  el.className = '';
  el.innerHTML = `<p class="muted">When you change a category in the converter, a rule is saved here so that payee is categorized automatically next time.</p>
    <ul class="list">${rules.map((r) => `<li><span><code>${h(r.pattern)}</code>${r.matchType === 'regex' ? ' <span class="muted">(pattern)</span>' : ''} → ${h(r.category)}</span><button type="button" data-del-rule="${h(r.id)}">Delete</button></li>`).join('') || '<li class="muted">No rules yet.</li>'}</ul>
    <form class="row" id="ruleForm"><input required maxlength="120" placeholder="Description contains…" aria-label="Pattern">
      <select aria-label="Category">${categories.map((c) => `<option>${h(c)}</option>`).join('')}</select><button>Add rule</button></form><p id="ruleMsg"></p>`;
  $('#ruleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.post('/api/rules', { pattern: e.target[0].value, category: e.target[1].value }); loadRules(); } catch (err) { flash($('#ruleMsg'), err.message, true); }
  });
  el.onclick = async (e) => { const id = e.target.dataset.delRule; if (id) await api.del(`/api/rules/${id}`).then(loadRules); };
}

async function loadIntegrations() {
  const el = $('#intBody');
  const { integrations } = await api.get('/api/integrations');
  el.className = '';
  const err = params.get('error'), ok = params.get('connected');
  el.innerHTML = `${ok ? `<p class="ok-text">Connected ${h(ok)}.</p>` : ''}${err ? `<p class="error">Connecting did not finish (${h(err)}). Try again.</p>` : ''}
    <ul class="list">${integrations.map((i) => `<li><span><strong>${h(i.label)}</strong>
      ${i.comingSoon ? ` <span class="soon">Coming soon</span>` : ''}
      ${i.connected ? ` <span class="ok-text">connected${i.settings?.orgName ? ` to ${h(i.settings.orgName)}` : ''}</span>` : ''}
      <br><span class="muted">${i.id === 'dropbox' || i.id === 'gdrive' ? 'Drop PDFs in the StatementOtter/Inbox folder; converted files appear in Converted.' : 'Send checked transactions straight into your books.'}</span></span>
      <span>${!i.included ? '<a href="../pricing/">Upgrade</a>' : i.comingSoon ? '' : i.connected
        ? `${['quickbooks', 'xero'].includes(i.id) ? `<button type="button" data-map="${i.id}">Accounts</button> ` : ''}${owner ? `<button type="button" data-disconnect="${i.id}">Disconnect</button>` : ''}`
        : !i.configured ? '<span class="muted">Not set up yet</span>' : owner ? `<button type="button" class="primary" data-connect="${i.id}">Connect</button>` : '<span class="muted">Ask the owner to connect</span>'}</span></li>`).join('')}</ul>
    <div id="mapBody"></div><p id="intMsg"></p>`;
  el.onclick = async (e) => {
    const c = e.target.dataset.connect, d = e.target.dataset.disconnect, m = e.target.dataset.map;
    try {
      if (c) location.href = (await api.post(`/api/integrations/${c}/start`)).url;
      if (d && confirm('Disconnect?')) { await api.del(`/api/integrations/${d}`); loadIntegrations(); }
      if (m) await showMapping(m, integrations.find((i) => i.id === m));
    } catch (er) { flash($('#intMsg'), er.message, true); }
  };
}

async function showMapping(provider, integ) {
  const { accounts } = await api.get(`/api/integrations/${provider}/accounts`);
  const s = integ.settings || {};
  const opts = (sel, filter) => `<option value="">Choose…</option>${accounts.filter(filter).map((a) => `<option value="${h(a.id)}"${a.id === sel ? ' selected' : ''}>${h(a.name)} (${h(a.type)})</option>`).join('')}`;
  const isBank = (a) => /bank|credit card/i.test(a.type);
  const box = $('#mapBody');
  box.innerHTML = `<form class="stack" id="mapForm"><h3>Where should transactions go?</h3>
    <label>Bank account<select name="bankAccount">${opts(s.bankAccount, isBank)}</select></label>
    <label>Default expense account<select name="defaultExpense">${opts(s.defaultExpense, (a) => !isBank(a))}</select></label>
    <label>Default income account<select name="defaultIncome">${opts(s.defaultIncome, (a) => !isBank(a))}</select></label>
    <div><button class="primary">Save</button></div></form>`;
  $('#mapForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    await api.patch(`/api/integrations/${provider}/settings`, fd).then(() => flash($('#intMsg'), 'Saved.')).catch((er) => flash($('#intMsg'), er.message, true));
  });
}

async function loadClients() {
  const el = $('#clientsBody');
  const [{ clients }, { uploads, retentionDays }] = await Promise.all([api.get('/api/clients'), api.get('/api/uploads')]);
  el.className = '';
  el.innerHTML = `<p class="muted">Give each client a private link. Their PDFs land here and are deleted after ${retentionDays} days.</p>
    <form class="row" id="clientForm"><input required maxlength="100" placeholder="Client name" aria-label="Client name"><input type="email" placeholder="Client email (optional)" aria-label="Client email"><button>Add client</button></form>
    <ul class="list">${clients.filter((c) => !c.archived).map((c) => `<li><span><strong>${h(c.name)}</strong> ${c.new_uploads ? `<span class="soon">${c.new_uploads} new</span>` : ''}<br><span class="muted">${h(c.email || '')}</span></span>
      <span><button type="button" data-copy="${h(c.id)}">Copy link</button> ${c.email ? `<button type="button" data-send="${h(c.id)}">Email link</button> ` : ''}<button type="button" data-rotate="${h(c.id)}">New link</button> <button type="button" data-archive="${h(c.id)}">Archive</button></span></li>`).join('') || '<li class="muted">No clients yet.</li>'}</ul>
    <h3>Inbox</h3>
    <ul class="list">${uploads.map((u) => `<li><span>${h(u.filename)} <span class="muted">from ${h(u.client_name)}, ${fmtDate(u.created_at)}, ${Math.ceil(u.size / 1024)} KB</span>${u.status === 'new' ? ' <span class="soon">new</span>' : ''}</span>
      <span><a href="/api/uploads/${h(u.id)}/file" data-open="${h(u.id)}">Download</a> <button type="button" data-convert="${h(u.id)}">Open in converter</button> <button type="button" data-del-upload="${h(u.id)}">Delete</button></span></li>`).join('') || '<li class="muted">Nothing uploaded yet.</li>'}</ul><p id="clientMsg"></p>`;
  $('#clientForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { link } = await api.post('/api/clients', { name: e.target[0].value, email: e.target[1].value || null });
      await navigator.clipboard?.writeText(link).catch(() => {});
      await loadClients();
      flash($('#clientMsg'), 'Client added. Their upload link is copied to your clipboard.');
    } catch (er) { flash($('#clientMsg'), er.message, true); }
  });
  el.onclick = async (e) => {
    const d = e.target.dataset;
    try {
      if (d.copy) { const { link } = await api.get(`/api/clients/${d.copy}/link`); await navigator.clipboard.writeText(link); flash($('#clientMsg'), 'Link copied.'); }
      if (d.send) { await api.post(`/api/clients/${d.send}/send-link`); flash($('#clientMsg'), 'Link emailed.'); }
      if (d.rotate && confirm('Make a new link? The old one stops working.')) { const { link } = await api.patch(`/api/clients/${d.rotate}`, { rotate: true }); await navigator.clipboard?.writeText(link).catch(() => {}); flash($('#clientMsg'), 'New link copied.'); }
      if (d.archive) { await api.patch(`/api/clients/${d.archive}`, { archived: true }); loadClients(); }
      if (d.delUpload && confirm('Delete this file?')) { await api.del(`/api/uploads/${d.delUpload}`); loadClients(); }
      if (d.convert) {
        await api.patch(`/api/uploads/${d.convert}`, { status: 'converted' });
        location.href = `../?upload=${encodeURIComponent(d.convert)}`;
      }
    } catch (er) { flash($('#clientMsg'), er.message, true); }
  };
}

async function loadBranding() {
  const el = $('#brandBody');
  const b = await api.get('/api/branding');
  el.className = '';
  el.innerHTML = `<form class="stack" id="brandForm">
      <label>Firm name shown to clients<input name="brandName" maxlength="80" value="${h(b.brandName || '')}"></label>
      <label>Brand colour<input name="brandColor" type="color" value="${h(b.brandColor || '#1f6f4a')}"></label>
      <label>Logo address (https://…)<input name="brandLogoUrl" type="url" value="${h(b.brandLogoUrl || '')}"></label>
      <label>Websites allowed to embed the converter (one per line, blank = any)<textarea name="embedOrigins" rows="3">${h(b.embedOrigins.join('\n'))}</textarea></label>
      ${owner ? '<div><button class="primary">Save</button></div>' : ''}</form>
    ${b.snippet ? `<h3>Put the converter on your website</h3><p class="muted">Paste this where it should appear. Statements are converted in your visitor's browser.</p><pre>${h(b.snippet)}</pre>${owner ? '<button type="button" id="rotateKey">Make a new key</button>' : ''}` : '<p class="muted">Save once to get your embed code.</p>'}<p id="brandMsg"></p>`;
  $('#brandForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try { await api.put('/api/branding', fd); await loadBranding(); flash($('#brandMsg'), 'Saved.'); } catch (er) { flash($('#brandMsg'), er.message, true); }
  });
  $('#rotateKey')?.addEventListener('click', async () => { if (confirm('The old embed code stops working. Continue?')) { await api.post('/api/branding/rotate-key'); loadBranding(); } });
}

async function loadKeys() {
  const el = $('#keysBody');
  const { keys } = await api.get('/api/keys');
  el.className = '';
  el.innerHTML = `<p class="muted">Use these with the <a href="../docs/api/">API</a>. Usage is counted per PDF page.</p>
    <ul class="list">${keys.map((k) => `<li><span><code>${h(k.prefix)}_…</code> ${h(k.name)} <span class="muted">${k.revoked_at ? 'revoked' : k.last_used_at ? 'last used ' + fmtDate(k.last_used_at) : 'never used'}</span></span>${!k.revoked_at && owner ? `<button type="button" data-revoke="${h(k.id)}">Revoke</button>` : ''}</li>`).join('') || '<li class="muted">No keys yet.</li>'}</ul>
    ${owner ? '<form class="row" id="keyForm"><input maxlength="60" placeholder="Key name, e.g. Zapier" aria-label="Key name"><button>Create key</button></form>' : ''}<div id="newKey"></div>`;
  $('#keyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { key, note } = await api.post('/api/keys', { name: e.target[0].value });
      await loadKeys();
      $('#newKey').innerHTML = `<p>${h(note)}</p><pre>${h(key)}</pre>`;
    } catch (er) { $('#newKey').innerHTML = `<p class="error">${h(er.message)}</p>`; }
  });
  el.onclick = async (e) => { const id = e.target.dataset.revoke; if (id && confirm('Revoke this key?')) await api.del(`/api/keys/${id}`).then(loadKeys); };
}

if (me) render();
