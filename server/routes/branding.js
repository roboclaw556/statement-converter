// White-label (Firm plan): the firm's name, colour and logo on the client portal and on an
// embeddable converter the firm puts on its own website with one <script> tag.
import { json, readJson, fail, str } from '../lib/http.js';
import { one, run } from '../lib/db.js';
import { randomToken } from '../lib/crypto.js';
import { requireUser, requireOwner, requireFeature, loadTeam } from '../lib/auth.js';
import { entitlementsFor } from '../../src/core/plans.js';

const site = (ctx) => ctx.env.SITE_URL || ctx.url.origin;

function cleanOrigins(v) {
  const list = String(v || '').split(/[\s,]+/).filter(Boolean).slice(0, 10);
  const out = [];
  for (const o of list) {
    let u;
    try { u = new URL(o); } catch { fail(400, 'bad_origin', `"${o.slice(0, 60)}" is not a web address`); }
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') fail(400, 'bad_origin', 'Sites must start with https://');
    out.push(u.origin);
  }
  return [...new Set(out)].join(',');
}

export async function getBranding(ctx) {
  await requireUser(ctx);
  return json(view(ctx));
}

function view(ctx) {
  const t = ctx.team;
  return {
    brandName: t.brand_name, brandColor: t.brand_color, brandLogoUrl: t.brand_logo_url,
    embedOrigins: t.embed_origins ? t.embed_origins.split(',') : [],
    embedKey: ctx.ent.whiteLabel ? t.embed_key : null,
    snippet: ctx.ent.whiteLabel && t.embed_key
      ? `<div id="statementotter"></div>\n<script src="${site(ctx)}/embed.js" data-key="${t.embed_key}" async></script>`
      : null,
    included: ctx.ent.whiteLabel,
  };
}

/** PUT /api/branding  {brandName, brandColor: #rrggbb, brandLogoUrl: https://..., embedOrigins: "https://a.com, https://b.com"} */
export async function updateBranding(ctx) {
  await requireUser(ctx);
  requireOwner(ctx);
  requireFeature(ctx, 'whiteLabel');
  const b = await readJson(ctx.req);
  const name = b.brandName === undefined ? ctx.team.brand_name : str(b.brandName, 80) || null;
  let color = b.brandColor === undefined ? ctx.team.brand_color : str(b.brandColor, 7) || null;
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) fail(400, 'bad_color', 'Use a colour like #1f6feb');
  let logo = b.brandLogoUrl === undefined ? ctx.team.brand_logo_url : str(b.brandLogoUrl, 500) || null;
  if (logo) {
    let u;
    try { u = new URL(logo); } catch { fail(400, 'bad_logo', 'The logo must be a web address'); }
    if (u.protocol !== 'https:') fail(400, 'bad_logo', 'The logo address must start with https://');
    logo = u.href;
  }
  const origins = b.embedOrigins === undefined ? ctx.team.embed_origins : cleanOrigins(Array.isArray(b.embedOrigins) ? b.embedOrigins.join(',') : b.embedOrigins) || null;
  const key = ctx.team.embed_key || 'emb_' + randomToken(16);
  await run(ctx.env, 'UPDATE teams SET brand_name = ?, brand_color = ?, brand_logo_url = ?, embed_origins = ?, embed_key = ? WHERE id = ?',
    name, color, logo, origins, key, ctx.team.id);
  ctx.team = await loadTeam(ctx.env, ctx.team.id);
  return json(view(ctx));
}

export async function rotateEmbedKey(ctx) {
  await requireUser(ctx);
  requireOwner(ctx);
  requireFeature(ctx, 'whiteLabel');
  await run(ctx.env, 'UPDATE teams SET embed_key = ? WHERE id = ?', 'emb_' + randomToken(16), ctx.team.id);
  ctx.team = await loadTeam(ctx.env, ctx.team.id);
  return json(view(ctx));
}

/** Team for an embed key, if it still has white-label. */
export async function embedTeam(env, key) {
  if (!/^emb_[\w-]{10,40}$/.test(key || '')) return null;
  const t = await one(env, 'SELECT * FROM teams WHERE embed_key = ?', key);
  if (!t || !entitlementsFor(t.plan, t.plan_status).whiteLabel) return null;
  return t;
}

/** GET /api/embed/:key : branding for the embedded converter. Public, cacheable for a few minutes. */
export async function embedConfig(ctx, key) {
  const t = await embedTeam(ctx.env, key);
  if (!t) fail(404, 'not_found', 'This converter is not active');
  return json({ brand: t.brand_name || t.name || '', color: t.brand_color, logo: t.brand_logo_url }, 200, { 'cache-control': 'public, max-age=300' });
}

/** frame-ancestors for /embed/?k=KEY : only the firm's own sites may frame it, when it has listed them. */
export async function embedFrameAncestors(env, key) {
  const t = await embedTeam(env, key);
  if (!t) return "'none'";
  return t.embed_origins ? t.embed_origins.split(',').join(' ') : '*';
}
