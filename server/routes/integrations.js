// Integrations: QuickBooks Online and Xero (send transactions), Dropbox and Google Drive
// (drop PDFs in a folder, get converted files back). OAuth 2 with PKCE where supported;
// tokens are stored AES-GCM encrypted.
//
// QuickBooks/Xero sending is built but held behind "coming soon" until Intuit and Xero
// approve the app (set FEATURE_ACCOUNTINGPUSH=1 to open it). Google Drive needs Google's
// restricted-scope verification (FEATURE_GOOGLEDRIVE=1). Dropbox works as soon as its app key is set.
import { json, readJson, fail, str } from '../lib/http.js';
import { all, one, run, nowIso, isoIn } from '../lib/db.js';
import { randomId, randomToken, encrypt, decrypt, pkceChallenge } from '../lib/crypto.js';
import { requireUser, requireOwner, requireFeature, loadTeam } from '../lib/auth.js';
import { entitlementsFor, COMING_SOON } from '../../src/core/plans.js';
import { convertBytes, loadRules } from '../lib/convert.js';
import { toXlsx, toQuickBooksCsv, toXeroCsv } from '../../src/core/index.js';

export const PROVIDERS = {
  quickbooks: {
    label: 'QuickBooks Online', feature: 'accountingPush', comingSoon: 'accountingPush',
    authUrl: 'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    scope: () => 'com.intuit.quickbooks.accounting',
    creds: (env) => [env.QBO_CLIENT_ID, env.QBO_CLIENT_SECRET], basicAuth: true, pkce: false,
  },
  xero: {
    label: 'Xero', feature: 'accountingPush', comingSoon: 'accountingPush',
    authUrl: 'https://login.xero.com/identity/connect/authorize',
    tokenUrl: 'https://identity.xero.com/connect/token',
    scope: (env) => env.XERO_SCOPES || 'offline_access accounting.transactions accounting.settings.read',
    creds: (env) => [env.XERO_CLIENT_ID, env.XERO_CLIENT_SECRET], basicAuth: true, pkce: true,
  },
  dropbox: {
    label: 'Dropbox', feature: 'folderImport',
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scope: () => null, extra: { token_access_type: 'offline' },
    creds: (env) => [env.DROPBOX_APP_KEY, env.DROPBOX_APP_SECRET], basicAuth: false, pkce: true,
  },
  gdrive: {
    label: 'Google Drive', feature: 'folderImport', comingSoon: 'googleDrive',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: () => 'https://www.googleapis.com/auth/drive',
    extra: { access_type: 'offline', prompt: 'consent' },
    creds: (env) => [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET], basicAuth: false, pkce: true,
  },
};

const site = (ctx) => ctx.env.SITE_URL || ctx.url.origin;
const redirectUri = (ctx, p) => `${site(ctx)}/api/integrations/${p}/callback`;
const isOpen = (env, flag) => !flag || env[`FEATURE_${flag.toUpperCase()}`] === '1';

function provider(name) {
  const p = PROVIDERS[name];
  if (!p) fail(404, 'not_found', 'Unknown integration');
  return p;
}

function gate(ctx, name) {
  const p = provider(name);
  requireFeature(ctx, p.feature, { allowComingSoon: true });
  if (!isOpen(ctx.env, p.comingSoon)) fail(403, 'coming_soon', COMING_SOON[p.comingSoon], { comingSoon: true, feature: p.comingSoon });
  const [id, secret] = p.creds(ctx.env);
  if (!id || !secret) fail(503, 'not_configured', `${p.label} is not set up on this server yet`);
  return p;
}

export async function listIntegrations(ctx) {
  await requireUser(ctx);
  const rows = await all(ctx.env, 'SELECT provider, external_id, settings, created_at FROM integrations WHERE team_id = ?', ctx.team.id);
  const connected = Object.fromEntries(rows.map((r) => [r.provider, { since: r.created_at, settings: JSON.parse(r.settings || '{}') }]));
  return json({
    integrations: Object.entries(PROVIDERS).map(([id, p]) => ({
      id, label: p.label,
      included: !!ctx.ent[p.feature],
      comingSoon: !isOpen(ctx.env, p.comingSoon) ? COMING_SOON[p.comingSoon] : null,
      configured: p.creds(ctx.env).every(Boolean),
      connected: !!connected[id], ...(connected[id] || {}),
    })),
  });
}

/** POST /api/integrations/:p/start → {url} to open in the browser. */
export async function startOAuth(ctx, name) {
  await requireUser(ctx);
  requireOwner(ctx);
  const p = gate(ctx, name);
  const state = randomToken(24);
  const verifier = p.pkce ? randomToken(48) : null;
  await run(ctx.env, 'INSERT INTO oauth_states (state, team_id, user_id, provider, verifier) VALUES (?, ?, ?, ?, ?)',
    state, ctx.team.id, ctx.user.id, name, verifier);
  const q = new URLSearchParams({ client_id: p.creds(ctx.env)[0], response_type: 'code', redirect_uri: redirectUri(ctx, name), state, ...(p.extra || {}) });
  const scope = p.scope(ctx.env);
  if (scope) q.set('scope', scope);
  if (verifier) { q.set('code_challenge', await pkceChallenge(verifier)); q.set('code_challenge_method', 'S256'); }
  return json({ url: `${p.authUrl}?${q}` });
}

async function tokenRequest(env, p, params) {
  const [id, secret] = p.creds(env);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const body = new URLSearchParams(params);
  if (p.basicAuth) headers.authorization = 'Basic ' + btoa(`${id}:${secret}`);
  else { body.set('client_id', id); body.set('client_secret', secret); }
  const res = await fetch(p.tokenUrl, { method: 'POST', headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw Object.assign(new Error('token exchange failed'), { status: res.status, data });
  return data;
}

const back = (ctx, qs) => Response.redirect(`${site(ctx)}/account/?${qs}#integrations`, 302);

/** GET /api/integrations/:p/callback?code&state (browser redirect from the provider). */
export async function oauthCallback(ctx, name) {
  const p = provider(name);
  const q = ctx.url.searchParams;
  const state = str(q.get('state'), 100);
  const st = state && await one(ctx.env, 'SELECT * FROM oauth_states WHERE state = ? AND provider = ?', state, name);
  if (st) await run(ctx.env, 'DELETE FROM oauth_states WHERE state = ?', state); // single use
  if (!st || st.created_at < isoIn(-600)) return back(ctx, 'error=expired');
  // The browser that finishes must be the one that started.
  await requireUser(ctx).catch(() => null);
  if (!ctx.user || ctx.user.id !== st.user_id) return back(ctx, 'error=signed_out');
  if (q.get('error') || !q.get('code')) return back(ctx, 'error=denied');
  let tok;
  try {
    tok = await tokenRequest(ctx.env, p, {
      grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(ctx, name),
      ...(st.verifier ? { code_verifier: st.verifier } : {}),
    });
  } catch { return back(ctx, 'error=token'); }
  let externalId = null;
  const settings = {};
  if (name === 'quickbooks') externalId = str(q.get('realmId'), 40) || null;
  if (name === 'xero') {
    const r = await fetch('https://api.xero.com/connections', { headers: { authorization: `Bearer ${tok.access_token}` } });
    const conns = r.ok ? await r.json() : [];
    externalId = conns[0]?.tenantId || null;
    settings.orgName = conns[0]?.tenantName || null;
  }
  if (name === 'dropbox') Object.assign(settings, { inbox: '/Inbox', output: '/Converted' });
  if (name === 'gdrive') Object.assign(settings, await ensureDriveFolders(tok.access_token));
  const key = ctx.env.ENC_KEY;
  await run(ctx.env, `INSERT INTO integrations (id, team_id, provider, external_id, access_enc, refresh_enc, expires_at, settings)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (team_id, provider) DO UPDATE SET external_id = excluded.external_id, access_enc = excluded.access_enc,
      refresh_enc = excluded.refresh_enc, expires_at = excluded.expires_at, settings = excluded.settings`,
    randomId('int_'), st.team_id, name, externalId, await encrypt(key, tok.access_token),
    tok.refresh_token ? await encrypt(key, tok.refresh_token) : null,
    tok.expires_in ? isoIn(Number(tok.expires_in)) : null, JSON.stringify(settings));
  return back(ctx, `connected=${name}`);
}

export async function disconnect(ctx, name) {
  await requireUser(ctx);
  requireOwner(ctx);
  provider(name);
  await run(ctx.env, 'DELETE FROM integrations WHERE team_id = ? AND provider = ?', ctx.team.id, name);
  await run(ctx.env, 'DELETE FROM folder_files WHERE team_id = ? AND provider = ?', ctx.team.id, name);
  return json({ ok: true });
}

/** PATCH /api/integrations/:p/settings  (account mapping for QuickBooks/Xero) */
export async function updateSettings(ctx, name) {
  await requireUser(ctx);
  provider(name);
  const row = await one(ctx.env, 'SELECT settings FROM integrations WHERE team_id = ? AND provider = ?', ctx.team.id, name);
  if (!row) fail(404, 'not_connected', 'Connect it first');
  const b = await readJson(ctx.req);
  const cur = JSON.parse(row.settings || '{}');
  for (const k of ['bankAccount', 'defaultExpense', 'defaultIncome']) if (b[k] !== undefined) cur[k] = str(b[k], 64) || null;
  if (b.categoryMap && typeof b.categoryMap === 'object') {
    cur.categoryMap = Object.fromEntries(Object.entries(b.categoryMap).slice(0, 100).map(([k, v]) => [str(k, 60), str(v, 64)]).filter(([k, v]) => k && v));
  }
  await run(ctx.env, 'UPDATE integrations SET settings = ? WHERE team_id = ? AND provider = ?', JSON.stringify(cur), ctx.team.id, name);
  return json({ ok: true, settings: cur });
}

/** Returns a fresh access token, refreshing (and saving the new refresh token) when close to expiry. */
export async function accessToken(env, integ) {
  const p = PROVIDERS[integ.provider];
  if (integ.expires_at && integ.expires_at > isoIn(90)) return decrypt(env.ENC_KEY, integ.access_enc);
  if (!integ.refresh_enc) return decrypt(env.ENC_KEY, integ.access_enc);
  const tok = await tokenRequest(env, p, { grant_type: 'refresh_token', refresh_token: await decrypt(env.ENC_KEY, integ.refresh_enc) });
  await run(env, 'UPDATE integrations SET access_enc = ?, refresh_enc = COALESCE(?, refresh_enc), expires_at = ? WHERE id = ?',
    await encrypt(env.ENC_KEY, tok.access_token), tok.refresh_token ? await encrypt(env.ENC_KEY, tok.refresh_token) : null,
    tok.expires_in ? isoIn(Number(tok.expires_in)) : null, integ.id);
  return tok.access_token;
}

async function loadIntegration(ctx, name) {
  const integ = await one(ctx.env, 'SELECT * FROM integrations WHERE team_id = ? AND provider = ?', ctx.team.id, name);
  if (!integ) fail(404, 'not_connected', `Connect ${PROVIDERS[name].label} first`);
  return integ;
}

const qboBase = (env) => env.QBO_SANDBOX === '1' ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';

async function apiFetch(url, token, init = {}, extraHeaders = {}) {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...extraHeaders } });
  const data = await res.json().catch(() => null);
  if (!res.ok) fail(502, 'provider_error', `The accounting app answered ${res.status}`, { detail: JSON.stringify(data)?.slice(0, 500) });
  return data;
}

/** GET /api/integrations/:p/accounts : the chart of accounts, for mapping. */
export async function listAccounts(ctx, name) {
  await requireUser(ctx);
  gate(ctx, name);
  if (!['quickbooks', 'xero'].includes(name)) fail(400, 'not_supported', 'Only QuickBooks and Xero have accounts');
  const integ = await loadIntegration(ctx, name);
  const token = await accessToken(ctx.env, integ);
  if (name === 'quickbooks') {
    const query = "select Id, Name, AccountType from Account where Active = true maxresults 1000";
    const d = await apiFetch(`${qboBase(ctx.env)}/v3/company/${integ.external_id}/query?minorversion=75&query=${encodeURIComponent(query)}`, token);
    return json({ accounts: (d?.QueryResponse?.Account || []).map((a) => ({ id: a.Id, name: a.Name, type: a.AccountType })) });
  }
  const d = await apiFetch('https://api.xero.com/api.xro/2.0/Accounts?where=Status%3D%3D%22ACTIVE%22', token, {}, { 'xero-tenant-id': integ.external_id });
  return json({ accounts: (d?.Accounts || []).map((a) => ({ id: a.Type === 'BANK' ? a.AccountID : a.Code, name: a.Name, type: a.Type, code: a.Code })) });
}

const fingerprint = (t) => `${t.date}|${t.amount}|${t.description}`.slice(0, 400);

/**
 * POST /api/integrations/:p/push  {transactions: [{date: YYYY-MM-DD, description, amount (cents), category?}]}
 * Each transaction is sent once: the pushes table remembers what was already sent.
 */
export async function push(ctx, name) {
  await requireUser(ctx);
  gate(ctx, name);
  if (!['quickbooks', 'xero'].includes(name)) fail(400, 'not_supported', 'Sending is for QuickBooks and Xero');
  const integ = await loadIntegration(ctx, name);
  const s = JSON.parse(integ.settings || '{}');
  if (!s.bankAccount) fail(400, 'needs_mapping', 'Choose which bank account these go to first');
  const b = await readJson(ctx.req, 1024 * 1024);
  if (!Array.isArray(b.transactions) || !b.transactions.length) fail(400, 'no_transactions', 'Send transactions[]');
  if (b.transactions.length > 1000) fail(413, 'too_many', 'Up to 1,000 transactions at a time');
  const txs = b.transactions.map((t) => ({
    date: /^\d{4}-\d{2}-\d{2}$/.test(t?.date) ? t.date : null,
    description: str(t?.description, 200) || 'Bank transaction',
    amount: Number.isInteger(t?.amount) ? t.amount : NaN,
    category: str(t?.category, 60),
  }));
  if (txs.some((t) => !t.date || !Number.isFinite(t.amount) || t.amount === 0)) fail(400, 'bad_transaction', 'Every transaction needs a date and a non-zero amount in cents');
  const accountFor = (t) => (s.categoryMap || {})[t.category] || (t.amount < 0 ? s.defaultExpense : s.defaultIncome);
  if (txs.some((t) => !accountFor(t))) fail(400, 'needs_mapping', 'Choose a default income and expense account');

  const token = await accessToken(ctx.env, integ);
  const results = [];
  for (const t of txs) {
    const fp = fingerprint(t);
    const claim = await run(ctx.env, 'INSERT OR IGNORE INTO pushes (id, team_id, provider, fingerprint) VALUES (?, ?, ?, ?)', randomId('psh_'), ctx.team.id, name, fp);
    if (!(claim?.meta?.changes ?? 1)) { results.push({ ...t, status: 'skipped_duplicate' }); continue; }
    try {
      const id = name === 'quickbooks' ? await qboPost(ctx.env, integ, token, s, t, accountFor(t)) : await xeroPost(integ, token, s, t, accountFor(t));
      await run(ctx.env, 'UPDATE pushes SET external_id = ? WHERE team_id = ? AND provider = ? AND fingerprint = ?', id, ctx.team.id, name, fp);
      results.push({ ...t, status: 'sent', externalId: id });
    } catch (e) {
      await run(ctx.env, 'DELETE FROM pushes WHERE team_id = ? AND provider = ? AND fingerprint = ?', ctx.team.id, name, fp);
      results.push({ ...t, status: 'failed', error: e.message });
    }
  }
  return json({
    sent: results.filter((r) => r.status === 'sent').length,
    skipped: results.filter((r) => r.status === 'skipped_duplicate').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  });
}

async function qboPost(env, integ, token, s, t, account) {
  const amt = Math.abs(t.amount) / 100;
  const base = `${qboBase(env)}/v3/company/${integ.external_id}`;
  if (t.amount < 0) {
    const d = await apiFetch(`${base}/purchase?minorversion=75`, token, { method: 'POST', body: JSON.stringify({
      PaymentType: 'Cash', AccountRef: { value: s.bankAccount }, TxnDate: t.date, PrivateNote: t.description,
      Line: [{ Amount: amt, DetailType: 'AccountBasedExpenseLineDetail', Description: t.description, AccountBasedExpenseLineDetail: { AccountRef: { value: account } } }],
    }) });
    return d?.Purchase?.Id || null;
  }
  const d = await apiFetch(`${base}/deposit?minorversion=75`, token, { method: 'POST', body: JSON.stringify({
    DepositToAccountRef: { value: s.bankAccount }, TxnDate: t.date, PrivateNote: t.description,
    Line: [{ Amount: amt, DetailType: 'DepositLineDetail', Description: t.description, DepositLineDetail: { AccountRef: { value: account } } }],
  }) });
  return d?.Deposit?.Id || null;
}

async function xeroPost(integ, token, s, t, accountCode) {
  const d = await apiFetch('https://api.xero.com/api.xro/2.0/BankTransactions', token, { method: 'PUT', body: JSON.stringify({
    BankTransactions: [{
      Type: t.amount < 0 ? 'SPEND' : 'RECEIVE',
      Contact: { Name: t.description.slice(0, 255) },
      BankAccount: { AccountID: s.bankAccount },
      Date: t.date,
      Reference: t.description.slice(0, 255),
      LineAmountTypes: 'NoTax',
      LineItems: [{ Description: t.description, Quantity: 1, UnitAmount: Math.abs(t.amount) / 100, AccountCode: accountCode }],
    }],
  }) }, { 'xero-tenant-id': integ.external_id });
  return d?.BankTransactions?.[0]?.BankTransactionID || null;
}

// ---------- folder import (scheduled) ----------

async function ensureDriveFolders(token) {
  const mk = async (name, parent) => {
    const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parent ? ` and '${parent}' in parents` : ''}`;
    const found = await (await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, { headers: { authorization: `Bearer ${token}` } })).json().catch(() => ({}));
    if (found.files?.[0]) return found.files[0].id;
    const r = await fetch('https://www.googleapis.com/drive/v3/files', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) }) });
    return (await r.json()).id;
  };
  const root = await mk('StatementOtter');
  return { root, inbox: await mk('Inbox', root), output: await mk('Converted', root) };
}

const FOLDER = {
  dropbox: {
    async list(token, s) {
      const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: s.inbox, limit: 100 }) });
      if (r.status === 409) { // folder missing: create it
        await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: s.inbox }) });
        return [];
      }
      if (!r.ok) throw new Error(`dropbox list ${r.status}`);
      return ((await r.json()).entries || []).filter((e) => e['.tag'] === 'file' && /\.pdf$/i.test(e.name) && e.size <= 25 * 1048576).map((e) => ({ id: e.id + ':' + e.rev, path: e.path_lower, name: e.name }));
    },
    async download(token, f) {
      const r = await fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path: f.path }) } });
      if (!r.ok) throw new Error(`dropbox download ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async upload(token, s, name, bytes) {
      const r = await fetch('https://content.dropboxapi.com/2/files/upload', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path: `${s.output}/${name}`, mode: 'overwrite', mute: true }).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) }, body: bytes });
      if (!r.ok) throw new Error(`dropbox upload ${r.status}`);
    },
  },
  gdrive: {
    async list(token, s) {
      const q = `'${s.inbox}' in parents and mimeType='application/pdf' and trashed=false`;
      const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,md5Checksum)&pageSize=100`, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`drive list ${r.status}`);
      return ((await r.json()).files || []).filter((f) => Number(f.size || 0) <= 25 * 1048576).map((f) => ({ id: f.id + ':' + (f.md5Checksum || ''), fileId: f.id, name: f.name }));
    },
    async download(token, f) {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${f.fileId}?alt=media`, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`drive download ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async upload(token, s, name, bytes, mime) {
      const boundary = 'so' + randomToken(8);
      const meta = JSON.stringify({ name, parents: [s.output] });
      const head = new TextEncoder().encode(`--${boundary}\r\ncontent-type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`);
      const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(head.length + bytes.length + tail.length);
      body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
      const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` }, body });
      if (!r.ok) throw new Error(`drive upload ${r.status}`);
    },
  },
};

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Scheduled every 15 minutes: convert new PDFs in each connected Inbox folder. */
export async function runFolderImports(env, { perTeam = 10 } = {}) {
  const rows = await all(env, "SELECT * FROM integrations WHERE provider IN ('dropbox', 'gdrive')");
  const report = [];
  for (const integ of rows) {
    if (!isOpen(env, PROVIDERS[integ.provider].comingSoon)) continue;
    const team = await loadTeam(env, integ.team_id);
    if (!team || !entitlementsFor(team.plan, team.plan_status).folderImport) continue;
    const io = FOLDER[integ.provider];
    const s = JSON.parse(integ.settings || '{}');
    let token, files;
    try { token = await accessToken(env, integ); files = await io.list(token, s); }
    catch (e) { report.push({ team: team.id, provider: integ.provider, error: e.message }); continue; }
    let done = 0;
    for (const f of files) {
      if (done >= perTeam) break;
      const seen = await one(env, 'SELECT 1 AS x FROM folder_files WHERE team_id = ? AND provider = ? AND file_id = ?', team.id, integ.provider, f.id);
      if (seen) continue;
      done++;
      let status = 'converted', detail = null;
      try {
        const bytes = await io.download(token, f);
        const out = await convertBytes(bytes, { include: new Set(['categories']), rules: await loadRules(env, team.id) });
        if (out.error) throw new Error(out.message);
        const r = out.result;
        if (!r.transactions.length) throw new Error(r.warnings?.[0] || 'No transactions found');
        const base = f.name.replace(/\.pdf$/i, '');
        const style = r.dateOrder === 'DMY' ? 'DMY' : 'MDY';
        await io.upload(token, s, `${base}.xlsx`, toXlsx(r), XLSX);
        await io.upload(token, s, `${base}-quickbooks.csv`, new TextEncoder().encode(toQuickBooksCsv(r, style)), 'text/csv');
        await io.upload(token, s, `${base}-xero.csv`, new TextEncoder().encode(toXeroCsv(r, style)), 'text/csv');
        detail = `${r.transactions.length} transactions, ${r.status}`;
        await run(env, `INSERT INTO usage (team_id, period, kind, count) VALUES (?, ?, 'statements', 1)
          ON CONFLICT (team_id, period, kind) DO UPDATE SET count = count + 1`, team.id, nowIso().slice(0, 7));
      } catch (e) { status = 'failed'; detail = String(e.message).slice(0, 300); }
      await run(env, 'INSERT OR REPLACE INTO folder_files (team_id, provider, file_id, status, detail) VALUES (?, ?, ?, ?, ?)', team.id, integ.provider, f.id, status, detail);
      report.push({ team: team.id, provider: integ.provider, file: f.name, status, detail });
    }
  }
  return report;
}

/** GET /api/integrations/:p/files : recent folder-import results. */
export async function folderActivity(ctx, name) {
  await requireUser(ctx);
  provider(name);
  const rows = await all(ctx.env, 'SELECT file_id, status, detail, processed_at FROM folder_files WHERE team_id = ? AND provider = ? ORDER BY processed_at DESC LIMIT 50', ctx.team.id, name);
  return json({ files: rows });
}
