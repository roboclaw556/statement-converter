// Public API (/api/v1) and API key management.
import { json, readJson, readPdf, fail, str } from '../lib/http.js';
import { all, one, run, nowIso } from '../lib/db.js';
import { randomToken, randomId, sha256Hex } from '../lib/crypto.js';
import { requireUser, requireOwner, requireApiKey, requireFeature, useQuota, getUsage } from '../lib/auth.js';
import { convertBytes, loadRules } from '../lib/convert.js';
import { FORMATS, formatById } from '../../src/core/formats.js';

const MAX_PDF = 20 * 1024 * 1024;
const MAX_PAGES = 200;

export async function listKeys(ctx) {
  await requireUser(ctx);
  const keys = await all(ctx.env, 'SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE team_id = ? ORDER BY created_at DESC', ctx.team.id);
  return json({ keys });
}

export async function createKey(ctx) {
  await requireUser(ctx);
  requireOwner(ctx);
  requireFeature(ctx, 'apiPagesPerMonth');
  const name = str((await readJson(ctx.req)).name, 60) || 'API key';
  const active = await one(ctx.env, 'SELECT COUNT(*) AS n FROM api_keys WHERE team_id = ? AND revoked_at IS NULL', ctx.team.id);
  if (active.n >= 10) fail(409, 'too_many_keys', 'Revoke an old key first (10 active keys maximum)');
  const prefix = 'sk_' + randomToken(6).replace(/[-_]/g, 'x');
  const key = `${prefix}_${randomToken(24)}`;
  await run(ctx.env, 'INSERT INTO api_keys (id, team_id, name, key_hash, prefix) VALUES (?, ?, ?, ?, ?)',
    randomId('key_'), ctx.team.id, name, await sha256Hex(key), prefix);
  return json({ key, prefix, name, note: 'Copy this key now. It will not be shown again.' }, 201);
}

export async function revokeKey(ctx, id) {
  await requireUser(ctx);
  requireOwner(ctx);
  const r = await run(ctx.env, 'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND team_id = ? AND revoked_at IS NULL', nowIso(), id, ctx.team.id);
  if (!(r?.meta?.changes ?? 1)) fail(404, 'not_found', 'No such active key');
  return json({ ok: true });
}

/**
 * POST /api/v1/convert
 *   body: the PDF (Content-Type: application/pdf) or multipart with a "file" field
 *   ?format=json (default) | any id from GET /api/v1/formats
 *   ?include=categories,lender,fraud   ?date_order=MDY|DMY
 *   header X-PDF-Password for protected files
 * Usage is metered per PDF page.
 */
export async function v1Convert(ctx) {
  await requireApiKey(ctx);
  const { bytes, filename } = await readPdf(ctx.req, MAX_PDF);
  const q = ctx.url.searchParams;
  const format = q.get('format') || 'json';
  if (format !== 'json' && !formatById[format]) fail(400, 'bad_format', `Unknown format. See GET /api/v1/formats`);
  const include = new Set((q.get('include') || '').split(',').map((s) => s.trim()).filter(Boolean));
  for (const i of include) if (!['categories', 'lender', 'fraud'].includes(i)) fail(400, 'bad_include', `Unknown include "${i}"`);
  const dateOrder = ['MDY', 'DMY'].includes(q.get('date_order')) ? q.get('date_order') : undefined;

  const rules = include.has('categories') ? await loadRules(ctx.env, ctx.team.id) : [];
  const out = await convertBytes(bytes, { dateOrder, include, rules, password: ctx.req.headers.get('x-pdf-password') || undefined });
  if (out.error) fail(422, out.error, out.message);
  if (out.pages > MAX_PAGES) fail(413, 'too_many_pages', `PDFs over ${MAX_PAGES} pages are not supported`);
  await useQuota(ctx, 'api_pages', out.pages); // charged only after a successful read
  const r = out.result;

  if (format !== 'json') {
    const f = formatById[format];
    const body = f.build(r, { dateStyle: r.dateOrder === 'DMY' ? 'DMY' : 'MDY', currency: str(q.get('currency'), 3).toUpperCase() || 'USD' });
    return new Response(body, {
      headers: {
        'content-type': f.mime,
        'content-disposition': `attachment; filename="${filename.replace(/\.pdf$/i, '')}${f.ext}"`,
        'x-balance-check': r.status,
        'x-pages': String(out.pages),
      },
    });
  }
  return json({
    filename,
    pages: out.pages,
    check: { status: r.status, difference: r.difference, flaggedRows: r.flaggedCount, checks: r.checks },
    opening: r.opening, closing: r.closing, credits: r.credits, debits: r.debits,
    dateOrder: r.dateOrder,
    warnings: r.warnings,
    currencyUnit: 'cents',
    transactions: r.transactions.map((t) => ({
      date: t.date, description: t.description, amount: t.amount, balance: t.balance, flags: t.flags,
      ...(t.category ? { category: t.category } : {}),
    })),
    ...(out.lender ? { lender: out.lender } : {}),
    ...(out.fraud ? { fraud: out.fraud } : {}),
  });
}

export async function v1Usage(ctx) {
  await requireApiKey(ctx);
  return json({ plan: ctx.team.plan, limit: ctx.ent.apiPagesPerMonth, usage: await getUsage(ctx.env, ctx.team.id) });
}

export function v1Formats() {
  return json({ formats: FORMATS.map((f) => ({ id: f.id, label: f.label, extension: f.ext, mime: f.mime })) });
}
