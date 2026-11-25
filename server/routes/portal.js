// Client upload portal (Firm plan). A firm creates a client, sends them a private link,
// and the client drops statement PDFs there. Files land in R2 and show in the firm's inbox.
// Uploaded files are deleted automatically after 30 days (scheduled job).
import { json, readJson, fail, str, isEmail } from '../lib/http.js';
import { all, one, run, nowIso, isoIn, rateLimit } from '../lib/db.js';
import { randomId, randomToken, sha256Hex, encrypt, decrypt } from '../lib/crypto.js';
import { requireUser, requireFeature, loadTeam } from '../lib/auth.js';
import { entitlementsFor } from '../../src/core/plans.js';
import { sendMail } from '../lib/mail.js';

const MAX_FILE = 25 * 1024 * 1024;
const MAX_FILES_PER_POST = 10;
const RETENTION_DAYS = 30;

const site = (ctx) => ctx.env.SITE_URL || ctx.url.origin;
const linkFor = (ctx, token) => `${site(ctx)}/upload/#t=${token}`;

export async function listClients(ctx) {
  await requireUser(ctx);
  requireFeature(ctx, 'clientPortal');
  const rows = await all(ctx.env, `SELECT c.id, c.name, c.email, c.archived, c.created_at,
      (SELECT COUNT(*) FROM client_uploads u WHERE u.client_id = c.id AND u.status = 'new') AS new_uploads
    FROM clients c WHERE c.team_id = ? ORDER BY c.archived, c.name`, ctx.team.id);
  return json({ clients: rows });
}

export async function createClient(ctx) {
  await requireUser(ctx);
  requireFeature(ctx, 'clientPortal');
  const b = await readJson(ctx.req);
  const name = str(b.name, 100);
  if (!name) fail(400, 'name_required', 'Give the client a name');
  const email = b.email ? str(b.email, 254).toLowerCase() : null;
  if (email && !isEmail(email)) fail(400, 'bad_email', 'That email address is not valid');
  const n = await one(ctx.env, 'SELECT COUNT(*) AS n FROM clients WHERE team_id = ? AND archived = 0', ctx.team.id);
  if (n.n >= 2000) fail(409, 'too_many_clients', 'Archive some clients first');
  const token = 'up_' + randomToken(24);
  const id = randomId('cli_');
  await run(ctx.env, 'INSERT INTO clients (id, team_id, name, email, token_hash, token_enc) VALUES (?, ?, ?, ?, ?, ?)',
    id, ctx.team.id, name, email, await sha256Hex(token), await encrypt(ctx.env.ENC_KEY, token));
  return json({ client: { id, name, email }, link: linkFor(ctx, token) }, 201);
}

async function ownClient(ctx, id) {
  const c = await one(ctx.env, 'SELECT * FROM clients WHERE id = ? AND team_id = ?', id, ctx.team.id);
  if (!c) fail(404, 'not_found', 'No such client');
  return c;
}

export async function clientLink(ctx, id) {
  await requireUser(ctx);
  requireFeature(ctx, 'clientPortal');
  const c = await ownClient(ctx, id);
  return json({ link: linkFor(ctx, await decrypt(ctx.env.ENC_KEY, c.token_enc)) });
}

/** PATCH /api/clients/:id  {name?, email?, archived?, rotate?: true} */
export async function updateClient(ctx, id) {
  await requireUser(ctx);
  requireFeature(ctx, 'clientPortal');
  const c = await ownClient(ctx, id);
  const b = await readJson(ctx.req);
  if (b.name !== undefined) await run(ctx.env, 'UPDATE clients SET name = ? WHERE id = ?', str(b.name, 100) || c.name, id);
  if (b.email !== undefined) {
    const e = b.email ? str(b.email, 254).toLowerCase() : null;
    if (e && !isEmail(e)) fail(400, 'bad_email', 'That email address is not valid');
    await run(ctx.env, 'UPDATE clients SET email = ? WHERE id = ?', e, id);
  }
  if (b.archived !== undefined) await run(ctx.env, 'UPDATE clients SET archived = ? WHERE id = ?', b.archived ? 1 : 0, id);
  if (b.rotate) {
    const token = 'up_' + randomToken(24);
    await run(ctx.env, 'UPDATE clients SET token_hash = ?, token_enc = ? WHERE id = ?', await sha256Hex(token), await encrypt(ctx.env.ENC_KEY, token), id);
    return json({ ok: true, link: linkFor(ctx, token) });
  }
  return json({ ok: true });
}

/** Optional: email the client their link (firm presses "Send link"). */
export async function emailClientLink(ctx, id) {
  await requireUser(ctx);
  requireFeature(ctx, 'clientPortal');
  const c = await ownClient(ctx, id);
  if (!c.email) fail(400, 'no_email', 'Add the client’s email first');
  if (!(await rateLimit(ctx.env, `clientmail:${ctx.team.id}`, 100, 86400))) fail(429, 'rate_limited', 'Too many emails today');
  const firm = ctx.team.brand_name || ctx.team.name || 'Your accountant';
  await sendMail(ctx.env, {
    to: c.email,
    subject: `${firm}: upload your bank statements here`,
    text: `Hi ${c.name},\n\n${firm} asked for your bank statements. Upload the PDFs here:\n\n${linkFor(ctx, await decrypt(ctx.env.ENC_KEY, c.token_enc))}\n\nThe link is private to you. Files go straight to ${firm}.`,
  });
  return json({ ok: true });
}

// ---------- public side (the client, no account) ----------

async function clientByToken(ctx, token) {
  if (!/^up_[\w-]{20,64}$/.test(token)) fail(404, 'not_found', 'This upload link is not valid');
  const c = await one(ctx.env, 'SELECT * FROM clients WHERE token_hash = ?', await sha256Hex(token));
  if (!c || c.archived) fail(404, 'not_found', 'This upload link is not valid any more. Ask your accountant for a new one.');
  const team = await loadTeam(ctx.env, c.team_id);
  if (!team || !entitlementsFor(team.plan, team.plan_status).clientPortal) fail(404, 'not_found', 'This upload link is not active');
  return { c, team };
}

/** GET /api/upload/:token : what the upload page shows (firm branding, client first name). */
export async function portalInfo(ctx, token) {
  const { c, team } = await clientByToken(ctx, token);
  return json({ firm: team.brand_name || team.name || 'Your accountant', color: team.brand_color, logo: team.brand_logo_url, client: c.name });
}

/** POST /api/upload/:token  multipart, one or more "file" fields (PDF only). */
export async function portalUpload(ctx, token) {
  const { c, team } = await clientByToken(ctx, token);
  if (!ctx.env.FILES) fail(503, 'storage_unavailable', 'Uploads are not configured');
  if (!(await rateLimit(ctx.env, `upload:${c.id}`, 60, 86400)) || !(await rateLimit(ctx.env, `upload-ip:${ctx.ip}`, 100, 86400))) {
    fail(429, 'rate_limited', 'Too many uploads today. Try again tomorrow.');
  }
  const len = Number(ctx.req.headers.get('content-length') || 0);
  if (len > MAX_FILE * MAX_FILES_PER_POST) fail(413, 'too_large', 'Upload fewer files at once');
  const type = ctx.req.headers.get('content-type') || '';
  if (!type.startsWith('multipart/form-data')) fail(400, 'bad_upload', 'Send the files as a form upload');
  const form = await ctx.req.formData();
  const files = form.getAll('file').filter((f) => f && typeof f !== 'string').slice(0, MAX_FILES_PER_POST);
  if (!files.length) fail(400, 'no_file', 'Choose at least one PDF');
  const saved = [], rejected = [];
  for (const f of files) {
    const name = (f.name || 'statement.pdf').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    if (f.size > MAX_FILE) { rejected.push({ name, reason: 'Larger than 25 MB' }); continue; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') { rejected.push({ name, reason: 'Not a PDF' }); continue; }
    const id = randomId('upl_');
    const key = `uploads/${team.id}/${c.id}/${id}.pdf`;
    await ctx.env.FILES.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
    await run(ctx.env, 'INSERT INTO client_uploads (id, team_id, client_id, r2_key, filename, size) VALUES (?, ?, ?, ?, ?, ?)',
      id, team.id, c.id, key, name, bytes.length);
    saved.push({ name, size: bytes.length });
  }
  if (saved.length && (await rateLimit(ctx.env, `upload-notify:${c.id}`, 1, 3600))) {
    const owners = await all(ctx.env, "SELECT email FROM users WHERE team_id = ? AND role = 'owner'", team.id);
    for (const o of owners) {
      await sendMail(ctx.env, {
        to: o.email,
        subject: `${c.name} uploaded ${saved.length} statement${saved.length > 1 ? 's' : ''}`,
        text: `${c.name} uploaded:\n${saved.map((s) => '- ' + s.name).join('\n')}\n\nOpen your inbox: ${site(ctx)}/account/#clients`,
      }).catch(() => {});
    }
  }
  return json({ ok: true, saved, rejected }, saved.length ? 201 : 400);
}

// ---------- firm inbox ----------

export async function listUploads(ctx) {
  await requireUser(ctx);
  requireFeature(ctx, 'clientPortal');
  const status = ctx.url.searchParams.get('status');
  const rows = await all(ctx.env, `SELECT u.id, u.filename, u.size, u.status, u.created_at, u.client_id, c.name AS client_name
    FROM client_uploads u JOIN clients c ON c.id = u.client_id
    WHERE u.team_id = ? ${status === 'new' || status === 'converted' ? 'AND u.status = ?' : ''}
    ORDER BY u.created_at DESC LIMIT 500`, ...(status === 'new' || status === 'converted' ? [ctx.team.id, status] : [ctx.team.id]));
  return json({ uploads: rows, retentionDays: RETENTION_DAYS });
}

async function ownUpload(ctx, id) {
  const u = await one(ctx.env, 'SELECT * FROM client_uploads WHERE id = ? AND team_id = ?', id, ctx.team.id);
  if (!u) fail(404, 'not_found', 'No such upload');
  return u;
}

export async function downloadUpload(ctx, id) {
  await requireUser(ctx);
  requireFeature(ctx, 'clientPortal');
  const u = await ownUpload(ctx, id);
  const obj = await ctx.env.FILES.get(u.r2_key);
  if (!obj) fail(410, 'gone', 'This file was deleted');
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${u.filename.replace(/"/g, '')}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function markUpload(ctx, id) {
  await requireUser(ctx);
  requireFeature(ctx, 'clientPortal');
  await ownUpload(ctx, id);
  const b = await readJson(ctx.req);
  const status = b.status === 'new' ? 'new' : 'converted';
  await run(ctx.env, 'UPDATE client_uploads SET status = ? WHERE id = ?', status, id);
  return json({ ok: true });
}

export async function deleteUpload(ctx, id) {
  await requireUser(ctx);
  const u = await ownUpload(ctx, id);
  await ctx.env.FILES?.delete(u.r2_key);
  await run(ctx.env, 'DELETE FROM client_uploads WHERE id = ?', id);
  return json({ ok: true });
}

/** Scheduled: delete uploads older than 30 days. */
export async function cleanupUploads(env) {
  const old = await all(env, 'SELECT id, r2_key FROM client_uploads WHERE created_at < ? LIMIT 1000', isoIn(-RETENTION_DAYS * 86400));
  for (const u of old) {
    await env.FILES?.delete(u.r2_key);
    await run(env, 'DELETE FROM client_uploads WHERE id = ?', u.id);
  }
  await run(env, 'DELETE FROM rate_events WHERE created_at < ?', isoIn(-2 * 86400));
  await run(env, 'DELETE FROM login_codes WHERE expires_at < ?', isoIn(-86400));
  await run(env, 'DELETE FROM sessions WHERE expires_at < ?', nowIso());
  await run(env, 'DELETE FROM oauth_states WHERE created_at < ?', isoIn(-3600));
  return { deleted: old.length };
}
