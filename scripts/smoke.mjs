// End-to-end smoke test against a running Worker (wrangler dev, or production with DEV unset).
//   node scripts/smoke.mjs http://localhost:8787 [phase]
// phase "signin" prints a session token; phase "firm" (after the team is upgraded) runs the paid features.
import { readFileSync } from 'node:fs';

const base = process.argv[2] || 'http://localhost:8787';
const phase = process.argv[3] || 'signin';
const token = process.env.TOKEN;
const pdf = readFileSync(new URL('../test/samples/us_debit_credit.pdf', import.meta.url));
let failed = 0;
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' ' + extra : ''}`); if (!ok) failed++; };
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method, body: body instanceof Uint8Array || body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    headers: { ...(body && !(body instanceof Uint8Array) && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    redirect: 'manual',
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, res, data: type.includes('json') ? await res.json() : await res.text() };
};

if (phase === 'signin') {
  const home = await api('GET', '/');
  check(home.status === 200 && /Convert bank statement PDFs/.test(home.data), 'home page served');
  for (const p of ['/pricing/', '/login/', '/account/', '/upload/', '/docs/api/', '/embed.js', '/app.js', '/core/plans.js', '/sitemap.xml']) {
    const r = await api('GET', p);
    check(r.status === 200, `GET ${p}`);
  }
  const email = `smoke-${Date.now()}@example.com`;
  const s = await api('POST', '/api/auth/start', { email });
  check(s.status === 200 && s.data.dev?.code, 'sign-in email (dev code)');
  const v = await api('POST', '/api/auth/verify', { email, code: s.data.dev.code });
  check(v.status === 200 && /^ses_/.test(v.data.token), 'sign-in verify');
  console.log('TOKEN=' + v.data.token);
} else {
  const me = await api('GET', '/api/me');
  check(me.data.team?.plan === 'firm', 'team is on Firm', me.data.team?.plan);
  const key = await api('POST', '/api/keys', { name: 'smoke' });
  check(key.status === 201, 'API key created');
  const conv = await fetch(base + '/api/v1/convert?include=categories,lender,fraud', { method: 'POST', body: pdf, headers: { authorization: `Bearer ${key.data.key}`, 'content-type': 'application/pdf' } });
  const cj = await conv.json();
  check(conv.status === 200 && cj.check?.status === 'reconciled', 'API convert in the Workers runtime (unpdf)', `${conv.status} ${cj.check?.status} ${cj.transactions?.length} rows`);
  const xlsx = await fetch(base + '/api/v1/convert?format=xlsx', { method: 'POST', body: pdf, headers: { authorization: `Bearer ${key.data.key}` } });
  const xb = new Uint8Array(await xlsx.arrayBuffer());
  check(xlsx.status === 200 && xb[0] === 0x50 && xb[1] === 0x4b, 'API xlsx export');

  const c = await api('POST', '/api/clients', { name: 'Smoke Client' });
  check(c.status === 201, 'client created');
  const up = new URL(c.data.link).hash.slice(3);
  const fd = new FormData();
  fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'jan.pdf');
  const u = await fetch(`${base}/api/upload/${up}`, { method: 'POST', body: fd });
  check(u.status === 201, 'client upload to R2');
  const inbox = await api('GET', '/api/uploads');
  const dl = await fetch(`${base}/api/uploads/${inbox.data.uploads[0].id}/file`, { headers: { authorization: `Bearer ${token}` } });
  check(dl.status === 200 && (await dl.arrayBuffer()).byteLength === pdf.length, 'download from R2');

  const b = await api('PUT', '/api/branding', { brandName: 'Smoke CPA', embedOrigins: 'https://smoke.test' });
  check(b.status === 200 && b.data.embedKey, 'branding saved');
  const embed = await fetch(`${base}/embed/?k=${b.data.embedKey}`);
  check(/frame-ancestors https:\/\/smoke\.test/.test(embed.headers.get('content-security-policy') || ''), 'embed page frame-ancestors', embed.headers.get('content-security-policy'));
  const plain = await fetch(`${base}/`);
  check(/frame-ancestors 'none'/.test(plain.headers.get('content-security-policy') || ''), 'other pages cannot be framed');

  const rule = await api('POST', '/api/rules/learn', { description: 'HARBOR DESIGN STUDIO 8812', category: 'Professional Fees' });
  check(rule.status === 201, 'rule learned');
  const ai = await api('POST', '/api/categorize', { transactions: [{ description: 'HARBOR DESIGN STUDIO 1', amount: -100 }] });
  check(ai.status === 200 && ai.data.results[0].source === 'rule', 'categorize (rules first, AI loads in runtime)');
  const integ = await api('GET', '/api/integrations');
  check(integ.status === 200 && integ.data.integrations.length === 4, 'integrations list');
}
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
