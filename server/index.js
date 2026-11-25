// The whole backend is one Cloudflare Worker: static site (dist/ via the ASSETS binding),
// JSON API under /api, inbound email, and scheduled jobs.
import { HttpError, json } from './lib/http.js';
import * as account from './routes/account.js';
import * as billing from './routes/billing.js';
import * as api from './routes/api.js';
import * as rules from './routes/rules.js';
import * as portal from './routes/portal.js';
import * as integ from './routes/integrations.js';
import * as branding from './routes/branding.js';
import * as feedback from './routes/feedback.js';
import { handleEmail } from './email.js';
import { PLANS, COMING_SOON, FEATURE_LABELS } from '../src/core/plans.js';

const ID = '([\\w-]{3,80})';
const P = '(quickbooks|xero|dropbox|gdrive)';
const pages = (f) => (ctx) => f({ request: ctx.req, env: ctx.env });

/** [method, path regex, handler(ctx, ...captures)] */
export const ROUTES = [
  ['POST', '/api/auth/start', account.startLogin],
  ['POST', '/api/auth/verify', account.verifyLogin],
  ['POST', '/api/auth/logout', account.logout],
  ['GET', '/api/me', account.me],
  ['DELETE', '/api/me', account.deleteMe],
  ['GET', '/api/team', account.getTeam],
  ['PATCH', '/api/team', account.updateTeam],
  ['POST', '/api/team/invites', account.invite],
  ['DELETE', `/api/team/invites/${ID}`, account.removeInvite],
  ['DELETE', `/api/team/members/${ID}`, account.removeMember],
  ['POST', '/api/usage/statement', account.countStatement],

  ['GET', '/api/plans', () => json({ plans: PLANS, comingSoon: COMING_SOON, labels: FEATURE_LABELS }, 200, { 'cache-control': 'public, max-age=300' })],
  ['POST', '/api/billing/checkout', billing.checkout],
  ['POST', '/api/billing/portal', billing.portal],
  ['POST', '/api/webhooks/stripe', billing.stripeWebhook],
  ['POST', '/api/webhooks/revenuecat', billing.revenuecatWebhook],

  ['GET', '/api/keys', api.listKeys],
  ['POST', '/api/keys', api.createKey],
  ['DELETE', `/api/keys/${ID}`, api.revokeKey],
  ['POST', '/api/v1/convert', api.v1Convert],
  ['GET', '/api/v1/usage', api.v1Usage],
  ['GET', '/api/v1/formats', api.v1Formats],

  ['GET', '/api/rules', rules.listRules],
  ['POST', '/api/rules', rules.createRule],
  ['POST', '/api/rules/learn', rules.learnRule],
  ['DELETE', `/api/rules/${ID}`, rules.deleteRule],
  ['POST', '/api/categorize', rules.aiCategorize],

  ['GET', '/api/clients', portal.listClients],
  ['POST', '/api/clients', portal.createClient],
  ['PATCH', `/api/clients/${ID}`, portal.updateClient],
  ['GET', `/api/clients/${ID}/link`, portal.clientLink],
  ['POST', `/api/clients/${ID}/send-link`, portal.emailClientLink],
  ['GET', '/api/uploads', portal.listUploads],
  ['GET', `/api/uploads/${ID}/file`, portal.downloadUpload],
  ['PATCH', `/api/uploads/${ID}`, portal.markUpload],
  ['DELETE', `/api/uploads/${ID}`, portal.deleteUpload],
  ['GET', `/api/upload/${ID}`, portal.portalInfo],
  ['POST', `/api/upload/${ID}`, portal.portalUpload],

  ['GET', '/api/integrations', integ.listIntegrations],
  ['POST', `/api/integrations/${P}/start`, integ.startOAuth],
  ['GET', `/api/integrations/${P}/callback`, integ.oauthCallback],
  ['DELETE', `/api/integrations/${P}`, integ.disconnect],
  ['PATCH', `/api/integrations/${P}/settings`, integ.updateSettings],
  ['GET', `/api/integrations/${P}/accounts`, integ.listAccounts],
  ['POST', `/api/integrations/${P}/push`, integ.push],
  ['GET', `/api/integrations/${P}/files`, integ.folderActivity],

  ['GET', '/api/branding', branding.getBranding],
  ['PUT', '/api/branding', branding.updateBranding],
  ['POST', '/api/branding/rotate-key', branding.rotateEmbedKey],
  ['GET', `/api/embed/${ID}`, branding.embedConfig],

  ['POST', '/api/feedback', pages(feedback.onRequestPost)],
  ['GET', '/api/feedback', pages(feedback.onRequestGet)],
  ['PATCH', '/api/feedback', pages(feedback.onRequestPatch)],
].map(([m, p, h]) => [m, new RegExp(`^${p}$`), h]);

// The mobile app (Capacitor) calls the API from these origins with a Bearer session token.
const APP_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost']);

function corsHeaders(req, path) {
  const origin = req.headers.get('origin');
  if (!origin) return {};
  // /api/v1 is called server-to-server with API keys; /api/embed is read by firms' sites.
  if (path.startsWith('/api/v1/') || path.startsWith('/api/embed/')) return { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-pdf-password, x-filename', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  if (APP_ORIGINS.has(origin)) return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'access-control-max-age': '600' };
  return {};
}

export async function handleApi(req, env, url) {
  const ctx = { req, env, url, ip: req.headers.get('cf-connecting-ip') || '0.0.0.0' };
  const cors = corsHeaders(req, url.pathname);
  let res;
  if (req.method === 'OPTIONS') res = new Response(null, { status: 204 });
  else {
    try {
      let matched = false, allowed = [];
      for (const [m, re, h] of ROUTES) {
        const hit = re.exec(url.pathname);
        if (!hit) continue;
        if (m !== req.method) { allowed.push(m); continue; }
        matched = true;
        res = await h(ctx, ...hit.slice(1));
        break;
      }
      if (!matched) res = allowed.length ? json({ error: 'method_not_allowed' }, 405, { allow: allowed.join(', ') }) : json({ error: 'not_found' }, 404);
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.code, message: e.message, ...e.extra }, e.status);
      else {
        console.error('unhandled', url.pathname, e?.stack || e);
        res = json({ error: 'server_error', message: 'Something went wrong on our side' }, 500);
      }
    }
  }
  if (Object.keys(cors).length) {
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    res = new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
  return res;
}

async function serveAsset(req, env, url) {
  if (!env.ASSETS) return new Response('Not found', { status: 404 });
  let res = await env.ASSETS.fetch(req);
  // The embeddable converter may be framed only by the firm's own sites.
  if (url.pathname === '/embed/' || url.pathname === '/embed/index.html') {
    const fa = await branding.embedFrameAncestors(env, url.searchParams.get('k'));
    const h = new Headers(res.headers);
    const csp = (h.get('content-security-policy') || '').replace(/frame-ancestors [^;]*;?\s*/g, '');
    h.set('content-security-policy', `${csp}${csp && !csp.trim().endsWith(';') ? '; ' : ''}frame-ancestors ${fa}`);
    h.delete('x-frame-options');
    res = new Response(res.body, { status: res.status, headers: h });
  }
  return res;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env, url);
    return serveAsset(req, env, url);
  },
  async email(message, env) {
    return handleEmail(message, env);
  },
  async scheduled(event, env, ctx) {
    if (event.cron === '*/15 * * * *') ctx.waitUntil(integ.runFolderImports(env).then((r) => r.length && console.log('folder import', JSON.stringify(r))));
    else ctx.waitUntil(portal.cleanupUploads(env).then((r) => console.log('cleanup', JSON.stringify(r))));
  },
};
