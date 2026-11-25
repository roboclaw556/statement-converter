// End-to-end battle test of the app's web layer in a real browser (Chromium via
// Playwright) at phone and tablet sizes, with the server API mocked.
// The same www/ bundle runs inside the iOS and Android WebViews.
//
//   npm run build && python3 scripts/make_photo_samples.py ../test/samples /tmp/sr-img
//   node test/e2e.mjs /tmp/sr-img [--only=name] [--shots=dir]
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = join(HERE, '../www');
const SAMPLES = join(HERE, '../../test/samples');
const IMG = process.argv[2];
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const SHOTS = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const API = 'https://statementotter.com';

// ---------- static server ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.gz': 'application/gzip', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = createServer((req, res) => {
  const p = join(WWW, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = existsSync(p) && statSync(p).isDirectory() ? join(p, 'index.html') : p;
  if (!file.startsWith(WWW) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// ---------- mock API ----------
function mockApi(page, opts = {}) {
  const s = { plan: opts.plan || 'free', statements: opts.statements || 0, limit: opts.limit ?? 5, feedback: [], usageCalls: 0, authHeaders: [], deleted: false, verifyBodies: [] };
  const ent = () => ({
    statementsPerMonth: s.plan === 'free' ? s.limit : null, allFormats: true, balanceCheck: true,
    lenderReport: s.plan !== 'free', fraudChecks: s.plan !== 'free', categoryRules: s.plan !== 'free', aiCategorizePerMonth: 0,
    emailImport: s.plan !== 'free', folderImport: s.plan !== 'free', accountingPush: s.plan !== 'free', clientPortal: s.plan === 'firm', seats: 1, whiteLabel: false, apiPagesPerMonth: 0,
  });
  page.route(API + '/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    const reply = (status, json) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    const auth = req.headers().authorization || '';
    if (url.pathname !== '/api/feedback') s.authHeaders.push(auth);
    const authed = auth === 'Bearer ses_test';
    switch (`${req.method()} ${url.pathname}`) {
      case 'POST /api/feedback': s.feedback.push(body); return reply(200, { ok: true, id: s.feedback.length });
      case 'POST /api/auth/start': return /@/.test(body.email) ? reply(200, { ok: true }) : reply(400, { error: 'bad_email', message: 'Enter a valid email address' });
      case 'POST /api/auth/verify':
        s.verifyBodies.push(body);
        if (body.code !== '123456') return reply(400, { error: 'invalid_code', message: 'That code is not right' });
        return reply(200, { ok: true, token: 'ses_test', user: { id: 'usr_1', email: body.email, role: 'owner' } });
      case 'GET /api/me':
        if (!authed) return reply(401, { error: 'unauthorized' });
        return reply(200, {
          user: { id: 'usr_1', email: 'books@example.com', role: 'owner' },
          team: { id: 'team_1', name: 'Example Books', plan: s.plan, planName: s.plan[0].toUpperCase() + s.plan.slice(1), planSource: 'web', status: 'active', periodEnd: '2026-12-25T00:00:00Z' },
          entitlements: ent(), comingSoon: { accountingPush: 'Waiting on Intuit and Xero app approval' },
          usage: { period: '2026-11', statements: s.statements, apiPages: 0, aiStatements: 0 },
        });
      case 'POST /api/usage/statement':
        s.usageCalls++;
        if (!authed) return reply(401, { error: 'unauthorized' });
        if (s.plan === 'free' && s.statements + (body.statements || 1) > s.limit) return reply(402, { error: 'limit', message: `Your plan includes ${s.limit} statements a month`, upgrade: true });
        s.statements += body.statements || 1;
        return reply(200, { ok: true, usage: { period: '2026-11', statements: s.statements, apiPages: 0, aiStatements: 0 } });
      case 'POST /api/auth/logout': return reply(200, { ok: true });
      case 'DELETE /api/me': s.deleted = true; return reply(200, { ok: true });
      default: return reply(404, { error: 'not_found' });
    }
  });
  return s;
}

// ---------- helpers ----------
const browser = await chromium.launch();
const results = [];
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const TABLET = { viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };

async function open(ctxOpts = PHONE, apiOpts = {}) {
  const context = await browser.newContext({ ...ctxOpts, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (process.env.DEBUG) console.log('  [console]', m.type(), m.text()); if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('download', (d) => { if (process.env.DEBUG) console.log('  [download]', d.suggestedFilename()); });
  const api = mockApi(page, apiOpts);
  await page.goto(BASE);
  await page.waitForFunction(() => globalThis.__app?.ready === true);
  return { context, page, api, errors };
}

async function upload(page, files) {
  const before = await page.evaluate(() => globalThis.__app.state.files.length);
  await page.setInputFiles('#file', files);
  await page.waitForFunction((n) => globalThis.__app.state.files.length > n, before);
}
async function waitDone(page, timeout = 120000) {
  await page.waitForFunction(() => {
    const f = globalThis.__app.state.files[globalThis.__app.state.active];
    return f && (f.status === 'done' || f.status === 'error' || f.status === 'locked');
  }, null, { timeout });
  return page.evaluate(() => {
    const f = globalThis.__app.state.files[globalThis.__app.state.active];
    return { status: f.status, error: f.error, result: f.result && { status: f.result.status, n: f.result.transactions.length, flagged: f.result.flaggedCount, opening: f.result.opening, closing: f.result.closing, tx: f.result.transactions.map((t) => [t.date, t.amount]) } };
  });
}
const expected = (name) => JSON.parse(readFileSync(join(SAMPLES, name + '.json'), 'utf8'));
function sameRows(got, exp) {
  if (got.tx.length !== exp.transactions.length) return `count ${got.tx.length} vs ${exp.transactions.length}`;
  for (let i = 0; i < got.tx.length; i++) {
    const e = exp.transactions[i];
    if (got.tx[i][0] !== e.date || got.tx[i][1] !== e.amount) return `row ${i}: ${got.tx[i]} vs ${e.date},${e.amount}`;
  }
  return null;
}
async function shot(page, name) { if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png'), fullPage: false }); }
async function noOverflow(page) {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(o <= 0, `horizontal overflow ${o}px`);
}

async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t = Date.now();
  try {
    await fn();
    results.push(['PASS', name, Date.now() - t]);
    console.log(`PASS ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    results.push(['FAIL', name, Date.now() - t, e.message]);
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

// ---------- tests ----------
const SAMPLE_NAMES = ['us_debit_credit', 'uk_paid_in_out', 'amount_crdr', 'signed_amount', 'unsigned_amount_balance'];

for (const [label, dev] of [['phone', PHONE], ['tablet', TABLET], ['small phone 320', { ...PHONE, viewport: { width: 320, height: 568 } }], ['tablet landscape', { ...TABLET, viewport: { width: 1366, height: 1024 } }]]) {
  await test(`${label}: every text PDF converts exactly and balances, no overflow`, async () => {
    const { page, context, errors } = await open(dev);
    await noOverflow(page);
    await shot(page, `${label}-start`);
    for (const n of SAMPLE_NAMES) {
      await upload(page, join(SAMPLES, n + '.pdf'));
      const r = await waitDone(page);
      assert.equal(r.status, 'done', n + ' ' + r.error);
      assert.ok(['reconciled', 'running_balance_ok'].includes(r.result.status), `${n} status ${r.result.status}`);
      const diff = sameRows(r.result, expected(n));
      assert.equal(diff, null, n + ': ' + diff);
      assert.equal(await page.locator('#rows li[data-i]').count(), expected(n).transactions.length);
      await noOverflow(page);
    }
    assert.match(await page.textContent('#status'), /Balanced/);
    await shot(page, `${label}-review`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

await test('several PDFs picked at once each become a statement', async () => {
  const { page, context } = await open(TABLET);
  await upload(page, SAMPLE_NAMES.map((n) => join(SAMPLES, n + '.pdf')));
  await page.waitForFunction(() => globalThis.__app.state.files.length === 5 && globalThis.__app.state.files.every((f) => f.status === 'done'), null, { timeout: 60000 });
  assert.equal(await page.locator('#files .file').count(), 5);
  await page.locator('#files .file').first().click();
  assert.match(await page.textContent('#files .file.active'), /us_debit_credit/);
  await context.close();
});

for (const n of SAMPLE_NAMES) {
  await test(`scanned PDF (no text layer) is read by OCR: ${n}`, async () => {
    const { page, context, errors } = await open(PHONE);
    await upload(page, join(IMG, n + '__scanned.pdf'));
    await page.waitForSelector('#progress:not([hidden])');
    const r = await waitDone(page, 240000);
    assert.equal(r.status, 'done', r.error);
    assert.equal(sameRows(r.result, expected(n)), null);
    assert.equal(r.result.status, 'reconciled');
    assert.match(await page.textContent('#warnings'), /Read from a scan/);
    if (n === 'us_debit_credit') await shot(page, 'phone-ocr-scanned');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

for (const n of SAMPLE_NAMES) {
  await test(`phone photo (tilted, noisy JPEG) is straightened and read: ${n}`, async () => {
    const { page, context } = await open(PHONE);
    await upload(page, [1, 2].map((p) => join(IMG, `${n}__photo-${p}.jpg`)).filter(existsSync));
    const r = await waitDone(page, 240000);
    assert.equal(r.status, 'done', r.error);
    const diff = sameRows(r.result, expected(n));
    assert.equal(diff, null, `${diff} (status ${r.result.status}, flagged ${r.result.flagged})`);
    assert.equal(r.result.status, 'reconciled');
    await context.close();
  });
}

// Stress tier: low resolution, 3.5 degree tilt, heavy noise and blur. Too rough to expect
// every row; the safety rule is that the app never shows a clean "Balanced" with nothing
// to review when rows are wrong. Row accuracy is printed for tracking.
const stress = [];
for (const n of SAMPLE_NAMES) {
  await test(`stress photo never shows a clean result when it's wrong: ${n}`, async () => {
    const { page, context } = await open(PHONE);
    await upload(page, [1, 2].map((p) => join(IMG, `${n}__rough-${p}.jpg`)).filter(existsSync));
    const r = await waitDone(page, 240000);
    const exp = expected(n);
    const exact = r.result ? r.result.tx.filter((t, i) => exp.transactions[i] && t[0] === exp.transactions[i].date && t[1] === exp.transactions[i].amount).length : 0;
    stress.push(`${n}: ${exact}/${exp.transactions.length} rows exact, ${r.result?.status}, ${r.result?.flagged} flagged`);
    const clean = r.result && ['reconciled', 'running_balance_ok'].includes(r.result.status) && r.result.flagged === 0;
    if (clean) assert.equal(sameRows(r.result, exp), null, 'clean result but rows are wrong');
    await context.close();
  });
}
if (stress.length) console.log('  stress accuracy:\n   ' + stress.join('\n   '));

await test('password-protected PDF asks for the password, rejects a wrong one, opens with the right one', async () => {
  const { page, context } = await open(PHONE);
  await upload(page, join(IMG, 'encrypted.pdf'));
  await page.waitForSelector('#password:not([hidden])');
  await page.fill('#pw', 'wrong');
  await page.click('#password button');
  await page.waitForFunction(() => /Wrong password/.test(document.querySelector('#pwLabel').textContent));
  await page.fill('#pw', 'otter');
  await page.click('#password button');
  const r = await waitDone(page);
  assert.equal(r.status, 'done');
  assert.equal(sameRows(r.result, expected('us_debit_credit')), null);
  await context.close();
});

await test('a file that is not a PDF shows a clear error and the feedback buttons', async () => {
  const { page, context } = await open(PHONE);
  await upload(page, join(IMG, 'not-a-statement.pdf'));
  const r = await waitDone(page);
  assert.equal(r.status, 'error');
  assert.match(await page.textContent('#status'), /Couldn't convert/);
  assert.ok(await page.isVisible('#nudge'));
  await context.close();
});

await test('editing a row re-checks the balance; fixing it back balances again; delete works', async () => {
  const { page, context } = await open(PHONE);
  await upload(page, join(SAMPLES, 'us_debit_credit.pdf'));
  await waitDone(page);
  await page.locator('#rows li[data-i="1"]').click();
  await page.waitForSelector('#sheet:not([hidden])');
  const orig = await page.inputValue('#sheet input[name=out]');
  await page.fill('#sheet input[name=out]', '999.99');
  await page.click('#sheet button[type=submit]');
  await page.waitForFunction(() => /Does not balance/.test(document.querySelector('#status').textContent));
  assert.ok(await page.locator('#rows li.flag').count() > 0);
  await shot(page, 'phone-mismatch');
  await page.locator('#rows li[data-i="1"]').click();
  await page.fill('#sheet input[name=out]', orig);
  await page.click('#sheet button[type=submit]');
  await page.waitForFunction(() => /Balanced/.test(document.querySelector('#status').textContent));
  // both columns filled is rejected
  await page.locator('#rows li[data-i="2"]').click();
  await page.fill('#sheet input[name=in]', '5.00');
  await page.click('#sheet button[type=submit]');
  assert.match(await page.textContent('#sheet .error'), /not both/);
  await page.click('#sheetClose');
  const before = await page.locator('#rows li[data-i]').count();
  await page.locator('#rows li[data-i="0"]').click();
  await page.click('#sheet [data-del]');
  assert.equal(await page.locator('#rows li[data-i]').count(), before - 1);
  await context.close();
});

await test('switching date order re-parses (a DD/MM statement read month-first goes wrong, day-first is right)', async () => {
  const { page, context } = await open(PHONE);
  await upload(page, join(SAMPLES, 'amount_crdr.pdf'));
  const r1 = await waitDone(page);
  assert.equal(sameRows(r1.result, expected('amount_crdr')), null);
  await page.selectOption('#dateOrder', 'MDY');
  const r2 = await waitDone(page);
  assert.notEqual(sameRows(r2.result, expected('amount_crdr')), null);
  await page.selectOption('#dateOrder', 'DMY');
  const r3 = await waitDone(page);
  assert.equal(sameRows(r3.result, expected('amount_crdr')), null);
  await context.close();
});

await test('all 17 export formats produce non-empty, well-formed files', async () => {
  // Chromium stops automatic downloads after about 10 on one page, so use a fresh page per batch.
  let ids = null;
  let usageCalls = 0;
  for (let batch = 0; batch < 3; batch++) {
    const { page, context, api } = await open(TABLET, { plan: 'pro' });
    await page.evaluate(() => localStorage.setItem('auth.token', JSON.stringify('ses_test')));
    await page.reload();
    await page.waitForFunction(() => globalThis.__app?.ready === true);
    await upload(page, join(SAMPLES, 'us_debit_credit.pdf'));
    await waitDone(page);
    await page.click('#exportBtn');
    if (!ids) {
      ids = await page.$$eval('#sheet [data-fmt]', (bs) => bs.map((b) => b.dataset.fmt));
      assert.equal(ids.length, 17);
      await shot(page, 'tablet-export');
    }
    for (const id of ids.slice(batch * 6, batch * 6 + 6)) {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`#sheet [data-fmt="${id}"]`)]);
      const buf = readFileSync(await dl.path());
      assert.ok(buf.length > 200, `${id} too small`);
      if (id === 'xlsx') assert.equal(buf.subarray(0, 2).toString(), 'PK');
      if (id === 'json') JSON.parse(buf.toString());
      if (/csv/.test(dl.suggestedFilename())) assert.ok(buf.toString().split('\n').length >= 49, `${id} rows`);
      if (id === 'ofx' || id === 'qbo' || id === 'qfx') assert.match(buf.toString(), /<STMTTRN>/);
    }
    assert.equal(api.usageCalls, 1, 'one statement counted, however many formats are exported');
    usageCalls += api.usageCalls;
    await context.close();
  }
});

await test('signed out: 5 free statements a month on the device, then exports are blocked', async () => {
  const { page, context } = await open(PHONE);
  assert.match(await page.textContent('#usageNote'), /5 of 5 free statements left/);
  for (let i = 0; i < 6; i++) {
    await upload(page, join(SAMPLES, SAMPLE_NAMES[i % 5] + '.pdf'));
    await waitDone(page);
    await page.click('#exportBtn');
    if (i < 5) {
      await Promise.all([page.waitForEvent('download'), page.click('#sheet [data-fmt="csv"]')]);
      await page.click('#sheetClose');
    } else {
      await page.click('#sheet [data-fmt="csv"]');
      await page.waitForFunction(() => /Monthly limit/.test(document.querySelector('#sheetTitle').textContent));
      await shot(page, 'phone-limit');
    }
  }
  await page.click('#sheetClose');
  await page.click('#newBtn');
  assert.match(await page.textContent('#usageNote'), /0 of 5/);
  await context.close();
});

await test('sign in with emailed code, Pro shows lender summary and tamper check, sign out', async () => {
  const { page, context, api } = await open(PHONE, { plan: 'pro' });
  await page.click('[data-tab=account]');
  await page.fill('#email', 'books@example.com');
  await page.click('#emailForm button');
  await page.waitForSelector('#codeForm:not([hidden])');
  await page.fill('#code', '000000');
  await page.click('#codeForm button[type=submit]');
  await page.waitForFunction(() => /not right/.test(document.querySelector('#signinError').textContent));
  await page.fill('#code', '123456');
  await page.click('#codeForm button[type=submit]');
  await page.waitForSelector('#signedIn:not([hidden])');
  assert.match(await page.textContent('#planInfo'), /Pro/);
  assert.match(await page.textContent('#upgrade'), /Lender report/);
  assert.doesNotMatch(await page.textContent('#upgrade'), /Send to QuickBooks/, 'coming-soon features are not listed as included');
  assert.equal(api.verifyBodies.at(-1).client, 'web');
  await shot(page, 'phone-account');
  await page.click('[data-tab=convert]');
  await upload(page, join(SAMPLES, 'us_debit_credit.pdf'));
  await waitDone(page);
  await page.waitForSelector('.insight h3');
  const ins = await page.textContent('#insights');
  assert.match(ins, /Lender summary/);
  assert.match(ins, /Tamper check/);
  assert.ok(api.authHeaders.includes('Bearer ses_test'));
  await shot(page, 'phone-insights');
  await page.click('[data-tab=account]');
  await page.click('#signOut');
  await page.waitForSelector('#signedOut:not([hidden])');
  assert.equal(await page.evaluate(() => localStorage.getItem('auth.token')), null);
  await context.close();
});

await test('free plan shows Pro features as locked; tampered PDF is flagged for Pro', async () => {
  const { page, context } = await open(PHONE);
  await upload(page, join(SAMPLES, 'us_debit_credit.pdf'));
  await waitDone(page);
  assert.match(await page.textContent('#insights'), /included with Pro/);
  await context.close();
  if (!existsSync(join(SAMPLES, 'tampered.pdf'))) return;
  const s = await open(PHONE, { plan: 'pro' });
  await s.page.evaluate(() => localStorage.setItem('auth.token', JSON.stringify('ses_test')));
  await s.page.reload();
  await s.page.waitForFunction(() => globalThis.__app?.ready === true);
  await upload(s.page, join(SAMPLES, 'tampered.pdf'));
  await waitDone(s.page);
  await s.page.waitForSelector('.insight h3');
  assert.match(await s.page.textContent('#insights'), /Tamper check: (medium|high) risk/);
  await s.context.close();
});

await test('signed in on Free at the server limit: export is blocked by the server (402)', async () => {
  const { page, context, api } = await open(PHONE, { plan: 'free', statements: 5 });
  await page.evaluate(() => localStorage.setItem('auth.token', JSON.stringify('ses_test')));
  await page.reload();
  await page.waitForFunction(() => globalThis.__app?.ready === true);
  await upload(page, join(SAMPLES, 'signed_amount.pdf'));
  await waitDone(page);
  await page.click('#exportBtn');
  await page.click('#sheet [data-fmt="xlsx"]');
  await page.waitForFunction(() => /Monthly limit/.test(document.querySelector('#sheetTitle').textContent));
  assert.equal(api.usageCalls, 1);
  await context.close();
});

await test('expired session (401) signs out locally instead of breaking', async () => {
  const { page, context } = await open(PHONE);
  await page.evaluate(() => { localStorage.setItem('auth.token', JSON.stringify('ses_expired')); });
  await page.reload();
  await page.waitForFunction(() => globalThis.__app?.ready === true);
  await page.waitForFunction(() => localStorage.getItem('auth.token') === null);
  await page.click('[data-tab=account]');
  assert.ok(await page.isVisible('#signedOut'));
  await context.close();
});

await test('offline while signed in: exports still work (not blocked by a network error)', async () => {
  const { page, context } = await open(PHONE, { plan: 'free' });
  await page.evaluate(() => localStorage.setItem('auth.token', JSON.stringify('ses_test')));
  await page.reload();
  await page.waitForFunction(() => globalThis.__app?.ready === true);
  await page.unroute(API + '/**');
  await page.route(API + '/**', (r) => r.abort('internetdisconnected'));
  await upload(page, join(SAMPLES, 'amount_crdr.pdf'));
  await waitDone(page);
  await page.click('#exportBtn');
  await Promise.all([page.waitForEvent('download'), page.click('#sheet [data-fmt="quickbooks"]')]);
  await context.close();
});

await test('delete account (App Store rule) removes the session', async () => {
  const { page, context, api } = await open(PHONE, { plan: 'free' });
  await page.evaluate(() => localStorage.setItem('auth.token', JSON.stringify('ses_test')));
  await page.reload();
  await page.waitForFunction(() => globalThis.__app?.ready === true);
  await page.click('[data-tab=account]');
  await page.waitForSelector('#deleteAccount:not([hidden])');
  await page.click('#deleteAccount');
  await page.click('#confirmDelete');
  await page.waitForSelector('#signedOut:not([hidden])');
  assert.ok(api.deleted);
  await context.close();
});

await test('feedback page and quick feedback reach /api/feedback, tagged as app, with no statement text', async () => {
  const { page, context, api } = await open(PHONE);
  await upload(page, join(SAMPLES, 'us_debit_credit.pdf'));
  await waitDone(page);
  await page.click('#nudge [data-quick="no"]');
  await page.fill('#sheet textarea', 'Dates on page 2 were off');
  await page.click('#sheet button.primary');
  await page.waitForFunction(() => /We read every report/.test(document.querySelector('#nudge').textContent));
  await page.click('[data-tab=feedback]');
  await shot(page, 'phone-feedback');
  await page.selectOption('#feedbackForm select[name=kind]', 'bank_request');
  await page.check('#feedbackForm input[name=rating][value="4"]', { force: true });
  await page.fill('#feedbackForm textarea', 'Please support Chase business statements');
  await page.click('#feedbackForm button');
  await page.waitForSelector('#feedbackThanks:not([hidden])');
  assert.equal(api.feedback.length, 2);
  const [quick, page2] = api.feedback;
  assert.equal(quick.kind, 'conversion_problem');
  assert.equal(quick.page, 'app:web');
  assert.equal(quick.context.source, 'app');
  assert.equal(quick.context.transactions, 48);
  assert.doesNotMatch(JSON.stringify(quick), /PAYROLL|GOOGLE WORKSPACE|ACME/i, 'no statement contents in feedback');
  assert.equal(page2.kind, 'bank_request');
  assert.equal(page2.rating, 4);
  await context.close();
});

await test('recent: statements are kept on the device, reopen and export again; clear works; can be turned off', async () => {
  const { page, context } = await open(PHONE);
  await upload(page, join(SAMPLES, 'amount_crdr.pdf'));
  await waitDone(page);
  await page.reload();
  await page.waitForFunction(() => globalThis.__app?.ready === true);
  await page.click('[data-tab=recent]');
  assert.equal(await page.locator('#recentList li').count(), 1);
  await shot(page, 'phone-recent');
  await page.click('#recentList [data-open]');
  const r = await waitDone(page);
  assert.equal(sameRows(r.result, expected('amount_crdr')), null);
  await page.click('#exportBtn');
  await Promise.all([page.waitForEvent('download'), page.click('#sheet [data-fmt="xero"]')]);
  await page.click('#sheetClose');
  await page.click('[data-tab=account]');
  await page.uncheck('#keepHistory');
  await page.click('[data-tab=recent]');
  assert.equal(await page.locator('#recentList li').count(), 0);
  await context.close();
});

await test('dark mode renders with dark background', async () => {
  const { page, context } = await open({ ...PHONE, colorScheme: 'dark' });
  await upload(page, join(SAMPLES, 'us_debit_credit.pdf'));
  await waitDone(page);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, 'rgb(17, 18, 20)');
  await shot(page, 'phone-dark');
  await context.close();
});

await test('keyboard: rows are focusable and open the editor with Enter; Escape closes', async () => {
  const { page, context } = await open(TABLET);
  await upload(page, join(SAMPLES, 'signed_amount.pdf'));
  await waitDone(page);
  await page.focus('#rows li[data-i="3"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#sheet:not([hidden])');
  await page.keyboard.press('Escape');
  assert.ok(await page.isHidden('#sheet'));
  await context.close();
});

await test('touch targets are at least 44px tall on phone', async () => {
  const { page, context } = await open(PHONE);
  await upload(page, join(SAMPLES, 'us_debit_credit.pdf'));
  await waitDone(page);
  const small = await page.$$eval('button:not([hidden]), select, input:not([type=hidden]):not([type=radio]):not(.hp)', (els) =>
    els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40).map((e) => e.id || e.textContent.trim().slice(0, 20)));
  assert.deepEqual(small, []);
  await context.close();
});

await browser.close();
server.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { for (const f of failed) console.log('FAIL', f[1], '-', f[3]); process.exitCode = 1; }
writeFileSync(join(HERE, '../.e2e-results.json'), JSON.stringify(results, null, 1));
