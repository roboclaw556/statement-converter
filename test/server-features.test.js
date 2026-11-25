// Battle tests: rules, AI categorization, client portal, integrations, folder import,
// white-label, feedback, email routing, scheduled cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn, setPlan, sample, mockFetch, SITE } from './helpers.js';
import { runFolderImports } from '../server/routes/integrations.js';
import { cleanupUploads } from '../server/routes/portal.js';
import { routeEmail } from '../server/email.js';
import worker from '../server/index.js';

test('rules: plan gate, validation, learning, isolation', async () => {
  const env = makeEnv();
  const t = await signIn(env, 'r@example.com');
  assert.equal((await call(env, 'POST', '/api/rules', { token: t, body: { pattern: 'ACME', category: 'Income' } })).status, 402);
  await setPlan(env, t, 'pro');
  assert.equal((await call(env, 'POST', '/api/rules', { token: t, body: { pattern: '(a+)+$', matchType: 'regex', category: 'X' } })).status, 400);
  assert.equal((await call(env, 'POST', '/api/rules', { token: t, body: { pattern: '', category: 'X' } })).status, 400);
  const r = await call(env, 'POST', '/api/rules', { token: t, body: { pattern: 'ACME', category: 'Income' } });
  assert.equal(r.status, 201);
  // same pattern again updates instead of duplicating
  await call(env, 'POST', '/api/rules', { token: t, body: { pattern: 'ACME', category: 'Refunds' } });
  let list = (await call(env, 'GET', '/api/rules', { token: t })).data.rules;
  assert.equal(list.length, 1);
  assert.equal(list[0].category, 'Refunds');
  const learned = await call(env, 'POST', '/api/rules/learn', { token: t, body: { description: 'POS PURCHASE HARBOR DESIGN STUDIO #8812', category: 'Professional Fees' } });
  assert.equal(learned.data.rule.pattern, 'HARBOR DESIGN STUDIO');
  const other = await signIn(env, 'other@example.com');
  await setPlan(env, other, 'pro');
  assert.equal((await call(env, 'GET', '/api/rules', { token: other })).data.rules.length, 0);
  assert.equal((await call(env, 'DELETE', `/api/rules/${list[0].id}`, { token: other })).status, 404);
  assert.equal((await call(env, 'DELETE', `/api/rules/${list[0].id}`, { token: t })).status, 200);
  list = (await call(env, 'GET', '/api/rules', { token: t })).data.rules;
  assert.equal(list.length, 1);
});

function fakeClaude(reply) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        return typeof reply === 'function' ? reply(params) : reply;
      },
    },
  };
}

test('AI categorization: rules first, structured output, refusals, quota', async () => {
  const claude = fakeClaude((p) => {
    const ids = [...p.messages[0].content.matchAll(/^(\d+)\t/gm)].map((m) => Number(m[1]));
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items: ids.map((i) => ({ i, category: 'Professional Fees' })).concat([{ i: 0, category: 'Taxes' }, { i: 99, category: 'Income' }]) }) }] };
  });
  const env = makeEnv({ __anthropic: claude });
  const t = await signIn(env, 'ai@example.com');
  const tx = [
    { description: 'ACME RETAINER', amount: -50000 },
    { description: 'HARBOR DESIGN STUDIO 8812', amount: -12000 },
    { description: 'STARBUCKS 1123', amount: -450 },
  ];
  assert.equal((await call(env, 'POST', '/api/categorize', { token: t, body: { transactions: tx } })).status, 402);
  await setPlan(env, t, 'pro');
  await call(env, 'POST', '/api/rules', { token: t, body: { pattern: 'ACME', category: 'Rent & Lease' } });
  const r = await call(env, 'POST', '/api/categorize', { token: t, body: { transactions: tx } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.results.map((x) => x.category), ['Rent & Lease', 'Professional Fees', 'Meals & Entertainment']);
  assert.deepEqual(r.data.results.map((x) => x.source), ['rule', 'ai', 'builtin']);
  assert.equal(r.data.aiRows, 1);
  const sent = claude.calls[0];
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.ok(sent.output_config.format.schema.properties.items.items.properties.category.enum.includes('Uncategorized'));
  assert.doesNotMatch(sent.messages[0].content, /ACME|STARBUCKS/, 'rows covered by rules are not sent');
  assert.equal((await call(env, 'GET', '/api/me', { token: t })).data.usage.aiStatements, 1);

  // nothing left for AI → no call and no quota used
  await call(env, 'POST', '/api/categorize', { token: t, body: { transactions: [tx[0], tx[2]] } });
  assert.equal(claude.calls.length, 1);

  // refusal and truncation
  const env2 = makeEnv({ __anthropic: fakeClaude({ stop_reason: 'refusal', content: [] }) });
  const t2 = await signIn(env2, 'ai2@example.com');
  await setPlan(env2, t2, 'pro');
  assert.equal((await call(env2, 'POST', '/api/categorize', { token: t2, body: { transactions: [tx[1]] } })).status, 422);
  env2.__anthropic = fakeClaude({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"items":[' }] });
  assert.equal((await call(env2, 'POST', '/api/categorize', { token: t2, body: { transactions: [tx[1]] } })).status, 502);
  env2.__anthropic = { messages: { create: async () => { throw Object.assign(new Error('overloaded'), { status: 529 }); } } };
  assert.equal((await call(env2, 'POST', '/api/categorize', { token: t2, body: { transactions: [tx[1]] } })).status, 503);
  assert.equal((await call(env2, 'GET', '/api/me', { token: t2 })).data.usage.aiStatements, 0, 'failed AI calls are not charged');

  // monthly quota
  env.DB.raw.prepare("UPDATE usage SET count = 200 WHERE kind = 'ai_statements'").run();
  assert.equal((await call(env, 'POST', '/api/categorize', { token: t, body: { transactions: [tx[1]] } })).status, 402);
  // input limits
  assert.equal((await call(env, 'POST', '/api/categorize', { token: t, body: { transactions: Array(601).fill(tx[1]) } })).status, 413);
  assert.equal((await call(env, 'POST', '/api/categorize', { token: t, body: { transactions: 'x' } })).status, 400);
});

test('AI categorization without an API key says so', async () => {
  const env = makeEnv();
  const t = await signIn(env, 'nokey@example.com');
  await setPlan(env, t, 'pro');
  const r = await call(env, 'POST', '/api/categorize', { token: t, body: { transactions: [{ description: 'HARBOR DESIGN', amount: -100 }] } });
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'ai_unavailable');
});

const pdfForm = (...files) => {
  const fd = new FormData();
  for (const [name, bytes] of files) fd.append('file', new Blob([bytes]), name);
  return fd;
};

test('client portal: links, uploads, inbox, isolation, plan changes', async () => {
  const env = makeEnv();
  const firm = await signIn(env, 'firm@cpa.test');
  assert.equal((await call(env, 'POST', '/api/clients', { token: firm, body: { name: 'Bob' } })).status, 402);
  await setPlan(env, firm, 'firm');
  await call(env, 'PUT', '/api/branding', { token: firm, body: { brandName: 'Smith CPA', brandColor: '#112233' } });
  const c = await call(env, 'POST', '/api/clients', { token: firm, body: { name: 'Bob’s Bakery', email: 'bob@bakery.test' } });
  assert.equal(c.status, 201);
  const token = new URL(c.data.link).hash.slice(3);
  assert.match(token, /^up_/);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM clients WHERE token_enc LIKE ?').get('%' + token + '%').n, 0, 'link stored encrypted');
  assert.equal((await call(env, 'GET', `/api/clients/${c.data.client.id}/link`, { token: firm })).data.link, c.data.link);

  const info = await call(env, 'GET', `/api/upload/${token}`);
  assert.deepEqual([info.data.firm, info.data.client, info.data.color], ['Smith CPA', 'Bob’s Bakery', '#112233']);
  assert.equal((await call(env, 'GET', '/api/upload/up_wrongwrongwrongwrongwrong')).status, 404);

  const pdf = sample('us_debit_credit.pdf');
  const up = await call(env, 'POST', `/api/upload/${token}`, { body: pdfForm(['jan.pdf', pdf], ['evil.html', new TextEncoder().encode('<script>alert(1)</script>')], ['../../etc/passwd.pdf', pdf]) });
  assert.equal(up.status, 201);
  assert.equal(up.data.saved.length, 2);
  assert.equal(up.data.rejected[0].reason, 'Not a PDF');
  assert.ok(up.data.saved.every((s) => !s.name.includes('/')));
  assert.ok([...env.FILES.store.keys()].every((k) => k.startsWith('uploads/team_')));
  assert.ok(env.__outbox.some((m) => m.to === 'firm@cpa.test' && /uploaded 2 statements/.test(m.subject)));

  const inbox = await call(env, 'GET', '/api/uploads', { token: firm });
  assert.equal(inbox.data.uploads.length, 2);
  const id = inbox.data.uploads[0].id;
  const dl = await call(env, 'GET', `/api/uploads/${id}/file`, { token: firm });
  assert.equal(dl.status, 200);
  assert.equal(new Uint8Array(await dl.res.arrayBuffer()).length, pdf.length);
  assert.match(dl.res.headers.get('content-disposition'), /attachment/);

  // another firm sees nothing and can't fetch, mark or delete
  const rival = await signIn(env, 'rival@cpa.test');
  await setPlan(env, rival, 'firm');
  assert.equal((await call(env, 'GET', '/api/uploads', { token: rival })).data.uploads.length, 0);
  assert.equal((await call(env, 'GET', `/api/uploads/${id}/file`, { token: rival })).status, 404);
  assert.equal((await call(env, 'DELETE', `/api/uploads/${id}`, { token: rival })).status, 404);
  assert.equal((await call(env, 'GET', `/api/clients/${c.data.client.id}/link`, { token: rival })).status, 404);
  assert.equal((await call(env, 'PATCH', `/api/clients/${c.data.client.id}`, { token: rival, body: { archived: true } })).status, 404);

  assert.equal((await call(env, 'PATCH', `/api/uploads/${id}`, { token: firm, body: { status: 'converted' } })).status, 200);
  assert.equal((await call(env, 'GET', '/api/uploads?status=new', { token: firm })).data.uploads.length, 1);
  assert.equal((await call(env, 'DELETE', `/api/uploads/${id}`, { token: firm })).status, 200);
  assert.equal(env.FILES.store.size, 1);

  // email the link
  assert.equal((await call(env, 'POST', `/api/clients/${c.data.client.id}/send-link`, { token: firm })).status, 200);
  assert.ok(env.__outbox.some((m) => m.to === 'bob@bakery.test' && m.text.includes(token)));

  // a new link kills the old one
  const rot = await call(env, 'PATCH', `/api/clients/${c.data.client.id}`, { token: firm, body: { rotate: true } });
  assert.equal((await call(env, 'GET', `/api/upload/${token}`)).status, 404);
  const token2 = new URL(rot.data.link).hash.slice(3);
  assert.equal((await call(env, 'GET', `/api/upload/${token2}`)).status, 200);

  // downgrade: links stop working, files stay for the firm until cleanup
  await setPlan(env, firm, 'pro');
  assert.equal((await call(env, 'GET', `/api/upload/${token2}`)).status, 404);
  await setPlan(env, firm, 'firm');
  await call(env, 'PATCH', `/api/clients/${c.data.client.id}`, { token: firm, body: { archived: true } });
  assert.equal((await call(env, 'POST', `/api/upload/${token2}`, { body: pdfForm(['x.pdf', pdf]) })).status, 404);
});

test('scheduled cleanup deletes uploads after 30 days and expired rows', async () => {
  const env = makeEnv();
  const firm = await signIn(env, 'clean@cpa.test');
  await setPlan(env, firm, 'firm');
  const c = await call(env, 'POST', '/api/clients', { token: firm, body: { name: 'C' } });
  const token = new URL(c.data.link).hash.slice(3);
  await call(env, 'POST', `/api/upload/${token}`, { body: pdfForm(['a.pdf', sample('signed_amount.pdf')], ['b.pdf', sample('signed_amount.pdf')]) });
  env.DB.raw.prepare("UPDATE client_uploads SET created_at = '2020-01-01T00:00:00Z' WHERE filename = 'a.pdf'").run();
  env.DB.raw.prepare("UPDATE sessions SET expires_at = '2020-01-01T00:00:00Z'").run();
  const out = await cleanupUploads(env);
  assert.equal(out.deleted, 1);
  assert.equal(env.FILES.store.size, 1);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('integrations: gates, OAuth state, encrypted tokens, push with dedupe', async () => {
  const env = makeEnv({ QBO_CLIENT_ID: 'qid', QBO_CLIENT_SECRET: 'qsecret', DROPBOX_APP_KEY: 'dk', DROPBOX_APP_SECRET: 'ds' });
  const t = await signIn(env, 'books@example.com');
  assert.equal((await call(env, 'POST', '/api/integrations/dropbox/start', { token: t })).status, 402);
  await setPlan(env, t, 'pro');
  const qb = await call(env, 'POST', '/api/integrations/quickbooks/start', { token: t });
  assert.equal(qb.status, 403);
  assert.equal(qb.data.comingSoon, true);
  assert.equal((await call(env, 'POST', '/api/integrations/xero/start', { token: t })).status, 403);
  assert.equal((await call(env, 'POST', '/api/integrations/myspace/start', { token: t })).status, 404);
  const list = (await call(env, 'GET', '/api/integrations', { token: t })).data.integrations;
  assert.equal(list.find((i) => i.id === 'quickbooks').comingSoon, 'Waiting on Intuit and Xero app approval');
  assert.equal(list.find((i) => i.id === 'dropbox').configured, true);
  assert.equal(list.find((i) => i.id === 'xero').configured, false);

  env.FEATURE_ACCOUNTINGPUSH = '1';
  const start = await call(env, 'POST', '/api/integrations/quickbooks/start', { token: t });
  assert.equal(start.status, 200);
  const authUrl = new URL(start.data.url);
  assert.equal(authUrl.host, 'appcenter.intuit.com');
  assert.equal(authUrl.searchParams.get('redirect_uri'), `${SITE}/api/integrations/quickbooks/callback`);
  const state = authUrl.searchParams.get('state');

  // callback from a different signed-in user is refused, and burns the state
  const intruder = await signIn(env, 'intruder@example.com');
  const bad = await call(env, 'GET', `/api/integrations/quickbooks/callback?code=c&state=${state}&realmId=123`, { cookie: intruder });
  assert.equal(bad.status, 302);
  assert.match(bad.res.headers.get('location'), /error=signed_out/);
  const replay = await call(env, 'GET', `/api/integrations/quickbooks/callback?code=c&state=${state}&realmId=123`, { cookie: t });
  assert.match(replay.res.headers.get('location'), /error=expired/);

  const state2 = new URL((await call(env, 'POST', '/api/integrations/quickbooks/start', { token: t })).data.url).searchParams.get('state');
  let f = mockFetch([[/oauth2\/v1\/tokens\/bearer/, (u, init) => {
    assert.match(init.headers.authorization, /^Basic /);
    return { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600 };
  }]]);
  try {
    const ok = await call(env, 'GET', `/api/integrations/quickbooks/callback?code=c&state=${state2}&realmId=4620816365`, { cookie: t });
    assert.match(ok.res.headers.get('location'), /connected=quickbooks/);
  } finally { f.restore(); }
  const row = env.DB.raw.prepare('SELECT * FROM integrations').get();
  assert.equal(row.external_id, '4620816365');
  assert.doesNotMatch(row.access_enc + row.refresh_enc, /AT-1|RT-1/);

  const tx = [{ date: '2026-01-05', description: 'OFFICE DEPOT', amount: -4820, category: 'Office Supplies' }, { date: '2026-01-06', description: 'CLIENT PAYMENT', amount: 125000 }];
  assert.equal((await call(env, 'POST', '/api/integrations/quickbooks/push', { token: t, body: { transactions: tx } })).data.error, 'needs_mapping');
  await call(env, 'PATCH', '/api/integrations/quickbooks/settings', { token: t, body: { bankAccount: '35', defaultExpense: '7', defaultIncome: '79', categoryMap: { 'Office Supplies': '9' } } });
  const posted = [];
  f = mockFetch([[/quickbooks\.api\.intuit\.com\/v3\/company\/4620816365\/(purchase|deposit)/, (u, init) => {
    posted.push({ u, body: JSON.parse(init.body) });
    return /purchase/.test(u) ? { Purchase: { Id: 'P1' } } : { Deposit: { Id: 'D1' } };
  }]]);
  try {
    const p1 = await call(env, 'POST', '/api/integrations/quickbooks/push', { token: t, body: { transactions: tx } });
    assert.equal(p1.data.sent, 2, JSON.stringify(p1.data));
    assert.equal(posted[0].body.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, '9', 'category mapping used');
    assert.equal(posted[0].body.Line[0].Amount, 48.2);
    assert.equal(posted[1].body.DepositToAccountRef.value, '35');
    const p2 = await call(env, 'POST', '/api/integrations/quickbooks/push', { token: t, body: { transactions: tx } });
    assert.equal(p2.data.skipped, 2, 'never double-posts');
    assert.equal(posted.length, 2);
  } finally { f.restore(); }
  assert.equal((await call(env, 'POST', '/api/integrations/quickbooks/push', { token: t, body: { transactions: [{ date: 'yesterday', amount: 5 }] } })).status, 400);

  // a failed send is released so it can be retried
  f = mockFetch([[/purchase/, () => new Response('{"Fault":{}}', { status: 400 })]]);
  try {
    const p3 = await call(env, 'POST', '/api/integrations/quickbooks/push', { token: t, body: { transactions: [{ date: '2026-02-01', description: 'X', amount: -100 }] } });
    assert.equal(p3.data.failed, 1);
    assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM pushes WHERE fingerprint LIKE '2026-02-01%'").get().n, 0);
  } finally { f.restore(); }

  // expired access token is refreshed, and the new refresh token saved
  env.DB.raw.prepare("UPDATE integrations SET expires_at = '2020-01-01T00:00:00Z'").run();
  f = mockFetch([
    [/tokens\/bearer/, (u, init) => { assert.match(String(init.body), /grant_type=refresh_token/); return { access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 3600 }; }],
    [/query/, (u, init) => { assert.equal(init.headers.authorization, 'Bearer AT-2'); return { QueryResponse: { Account: [{ Id: '35', Name: 'Checking', AccountType: 'Bank' }] } }; }],
  ]);
  try {
    const acc = await call(env, 'GET', '/api/integrations/quickbooks/accounts', { token: t });
    assert.equal(acc.data.accounts[0].name, 'Checking');
  } finally { f.restore(); }

  assert.equal((await call(env, 'DELETE', '/api/integrations/quickbooks', { token: t })).status, 200);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get().n, 0);
});

test('dropbox folder import converts new PDFs once and writes three files back', async () => {
  const env = makeEnv({ DROPBOX_APP_KEY: 'dk', DROPBOX_APP_SECRET: 'ds' });
  const t = await signIn(env, 'folder@example.com');
  const teamId = await setPlan(env, t, 'pro');
  const { encrypt } = await import('../server/lib/crypto.js');
  env.DB.raw.prepare('INSERT INTO integrations (id, team_id, provider, access_enc, expires_at, settings) VALUES (?, ?, ?, ?, ?, ?)')
    .run('int_1', teamId, 'dropbox', await encrypt(env.ENC_KEY, 'DBX'), '2999-01-01T00:00:00Z', JSON.stringify({ inbox: '/Inbox', output: '/Converted' }));
  const uploads = [];
  const pdf = sample('uk_paid_in_out.pdf');
  const routes = [
    [/list_folder/, () => ({ entries: [
      { '.tag': 'file', id: 'id:1', rev: 'r1', name: 'March.pdf', path_lower: '/inbox/march.pdf', size: pdf.length },
      { '.tag': 'file', id: 'id:2', rev: 'r1', name: 'notes.txt', path_lower: '/inbox/notes.txt', size: 10 },
      { '.tag': 'file', id: 'id:3', rev: 'r1', name: 'broken.pdf', path_lower: '/inbox/broken.pdf', size: 10 },
    ] })],
    [/files\/download/, (u, init) => new Response(JSON.parse(init.headers['Dropbox-API-Arg']).path === '/inbox/march.pdf' ? pdf : new TextEncoder().encode('%PDF-nope'))],
    [/files\/upload/, (u, init) => { uploads.push(JSON.parse(init.headers['Dropbox-API-Arg']).path); return {}; }],
  ];
  let f = mockFetch(routes);
  try {
    const report = await runFolderImports(env);
    assert.deepEqual(report.map((r) => r.status).sort(), ['converted', 'failed']);
    assert.deepEqual(uploads.sort(), ['/Converted/March-quickbooks.csv', '/Converted/March-xero.csv', '/Converted/March.xlsx']);
    assert.equal((await runFolderImports(env)).length, 0, 'already processed');
  } finally { f.restore(); }
  // downgraded teams are skipped
  await setPlan(env, t, 'free');
  f = mockFetch([]);
  try { assert.equal((await runFolderImports(env)).length, 0); } finally { f.restore(); }
  const act = await call(env, 'GET', '/api/integrations/dropbox/files', { token: t });
  assert.equal(act.data.files.length, 2);
});

test('white-label: validation, embed config, frame-ancestors', async () => {
  const env = makeEnv();
  const t = await signIn(env, 'brand@cpa.test');
  await setPlan(env, t, 'pro');
  assert.equal((await call(env, 'PUT', '/api/branding', { token: t, body: { brandName: 'X' } })).status, 402);
  await setPlan(env, t, 'firm');
  assert.equal((await call(env, 'PUT', '/api/branding', { token: t, body: { brandColor: 'red;}' } })).status, 400);
  assert.equal((await call(env, 'PUT', '/api/branding', { token: t, body: { brandLogoUrl: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await call(env, 'PUT', '/api/branding', { token: t, body: { brandLogoUrl: 'http://insecure.test/logo.png' } })).status, 400);
  assert.equal((await call(env, 'PUT', '/api/branding', { token: t, body: { embedOrigins: 'ftp://x' } })).status, 400);
  const ok = await call(env, 'PUT', '/api/branding', { token: t, body: { brandName: 'Smith CPA', brandColor: '#123456', brandLogoUrl: 'https://cdn.smith.test/logo.png', embedOrigins: 'https://smith.test/about, https://www.smith.test' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.embedOrigins, ['https://smith.test', 'https://www.smith.test']);
  const key = ok.data.embedKey;
  assert.match(ok.data.snippet, new RegExp(key));
  const cfg = await call(env, 'GET', `/api/embed/${key}`, { origin: 'https://smith.test' });
  assert.equal(cfg.data.brand, 'Smith CPA');
  assert.equal(cfg.res.headers.get('access-control-allow-origin'), '*');

  const assets = { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" } }) };
  const page = await worker.fetch(new Request(`${SITE}/embed/?k=${key}`), { ...env, ASSETS: assets });
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors https:\/\/smith\.test https:\/\/www\.smith\.test$/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /'none'/);
  const unknown = await worker.fetch(new Request(`${SITE}/embed/?k=emb_doesnotexist123`), { ...env, ASSETS: assets });
  assert.match(unknown.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  const rotated = await call(env, 'POST', '/api/branding/rotate-key', { token: t });
  assert.notEqual(rotated.data.embedKey, key);
  assert.equal((await call(env, 'GET', `/api/embed/${key}`)).status, 404);
  await setPlan(env, t, 'pro');
  assert.equal((await call(env, 'GET', `/api/embed/${rotated.data.embedKey}`)).status, 404, 'stops when the plan lapses');
});

test('feedback goes through the main router', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'POST', '/api/feedback', { body: { kind: 'idea', message: 'Add Wise' } })).status, 200);
  assert.equal((await call(env, 'GET', '/api/feedback')).status, 401);
  const r = await call(env, 'GET', '/api/feedback?since=2000-01-01&format=json', { token: 'export-token-abc' });
  assert.equal(r.data.count, 1);
});

test('email import routing: team inbox, shared address, plans, strangers', async () => {
  const env = makeEnv();
  const t = await signIn(env, 'mail@cpa.test');
  const me = (await call(env, 'GET', '/api/me', { token: t })).data;
  const inbox = me.team.inboxAddress;
  assert.equal((await routeEmail(env, { from: 'mail@cpa.test', to: inbox })).reason, 'upgrade');
  await setPlan(env, t, 'pro');
  assert.equal((await routeEmail(env, { from: 'MAIL@cpa.test', to: inbox })).action, 'convert');
  assert.equal((await routeEmail(env, { from: 'mail@cpa.test', to: 'statements@so.test' })).action, 'convert');
  assert.equal((await routeEmail(env, { from: 'stranger@x.test', to: inbox })).reason, 'not_member');
  assert.equal((await routeEmail(env, { from: 'stranger@x.test', to: 'statements@so.test' })).reason, 'no_account');
  assert.equal((await routeEmail(env, { from: 'mail@cpa.test', to: 'nosuchbox@so.test' })).action, 'reject');
  for (let i = 0; i < 48; i++) await routeEmail(env, { from: 'mail@cpa.test', to: inbox });
  assert.equal((await routeEmail(env, { from: 'mail@cpa.test', to: inbox })).action, 'reject', 'daily limit');
});
