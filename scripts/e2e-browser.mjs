// Browser run-through against a running Worker (wrangler dev with DEV=1).
//   node scripts/e2e-browser.mjs http://localhost:8787 <screenshot dir>
// Signs up through the UI, converts a statement, uses the Pro tools, the account page,
// pricing, the client upload page and the embedded converter. Fails on any page error.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] || 'http://localhost:8787';
const shots = process.argv[3] || '/tmp';
const sample = fileURLToPath(new URL('../test/samples/us_debit_credit.pdf', import.meta.url));
let failed = 0;
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
const d1 = (sql) => execSync(`npx wrangler d1 execute statementotter --local --command "${sql}"`, { stdio: 'pipe' });

const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1200, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

// 1. Anonymous conversion
await page.goto(base + '/');
await page.setInputFiles('#file', sample);
await page.waitForSelector('#status.good', { timeout: 20000 });
check(/Balanced/.test(await page.textContent('#status')), 'anonymous conversion balances');
const cats = await page.$$eval('td.cat select', (s) => s.map((x) => x.value));
check(cats.length > 10 && cats.some((c) => c !== 'Uncategorized'), 'category column filled by built-in rules', `${cats.length} rows`);
await page.click('[data-pro="lender"]');
check(/part of the Pro plan/.test(await page.textContent('#proPanel')), 'lender report is gated for anonymous visitors');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="xlsx"]')]);
check(/\.xlsx$/.test(dl.suggestedFilename()), 'Excel download');
await page.screenshot({ path: `${shots}/1-converter.png` });

// 2. Sign up through the UI
const email = `e2e-${Date.now()}@example.com`;
await page.goto(base + '/login/');
let code = null;
page.on('response', async (r) => { if (r.url().endsWith('/api/auth/start')) code = (await r.json()).dev?.code; });
await page.fill('#email', email);
await page.click('#emailForm button');
await page.waitForSelector('#codeForm:not([hidden])');
await page.fill('#code', code);
await Promise.all([page.waitForURL(/\/account\//), page.click('#codeForm button.primary')]);
await page.waitForSelector('#plan');
check(/Plan: Free/.test(await page.textContent('#plan')), 'signed in, account page shows Free');
check((await page.textContent('header nav')).includes('Account'), 'header shows Account');

// 3. Upgrade (as a Stripe webhook would) and use the Pro/Firm tools
d1(`UPDATE teams SET plan='firm', plan_status='active' WHERE id IN (SELECT team_id FROM users WHERE email='${email}')`);
await page.reload();
await page.waitForSelector('#clientsBody form');
check(/Plan: Firm/.test(await page.textContent('#plan')), 'account page shows Firm after upgrade');
check(/@/.test(await page.textContent('#email')), 'email import address shown');
await page.fill('#clientForm input:nth-of-type(1)', 'Bakery Ltd');
await page.click('#clientForm button');
await page.waitForSelector('#clientsBody li >> text=Bakery Ltd');
await page.fill('#brandForm [name=brandName]', 'E2E CPA');
await page.click('#brandForm button');
await page.waitForSelector('#brandBody pre');
const snippet = await page.textContent('#brandBody pre');
const embedKey = /data-key="([^"]+)"/.exec(snippet)?.[1];
check(!!embedKey, 'embed snippet issued');
await page.fill('#keyForm input', 'e2e');
await page.click('#keyForm button');
await page.waitForSelector('#newKey pre');
check(/^sk_/.test(await page.textContent('#newKey pre')), 'API key shown once');
await page.screenshot({ path: `${shots}/2-account.png`, fullPage: true });

await page.goto(base + '/');
await page.setInputFiles('#file', sample);
await page.waitForSelector('#status.good', { timeout: 20000 });
await page.click('[data-pro="lender"]');
check(/Average daily balance/.test(await page.textContent('#proPanel')), 'lender report for Firm');
await page.click('[data-pro="fraud"]');
check(/Tamper check/.test(await page.textContent('#proPanel')), 'tamper check for Firm');
await page.click('[data-pro="push-quickbooks"]');
check(/Coming soon/.test(await page.textContent('#proPanel')), 'QuickBooks send shows Coming soon');
const firstSelect = page.locator('td.cat select').first();
await firstSelect.selectOption('Professional Fees');
await page.waitForFunction(() => /now|Saved/.test(document.querySelector('#proPanel').textContent));
check(/is now/.test(await page.textContent('#proPanel')), 'correction saved as a rule');
await page.screenshot({ path: `${shots}/3-pro-tools.png` });

// 4. Pricing
await page.goto(base + '/pricing/');
check((await page.$$('.plan')).length === 3, 'three plans listed');
await page.click('[data-interval="year"]');
check(/\$190/.test(await page.textContent('.plans')), 'yearly prices');
await page.click('button[data-plan="pro"]');
await page.waitForFunction(() => document.querySelector('#payMsg').textContent.length > 0);
check(/not set up/.test(await page.textContent('#payMsg')), 'checkout explains billing is not configured locally');
await page.screenshot({ path: `${shots}/4-pricing.png`, fullPage: true });

// 5. Client upload page (as the client, in a fresh browser with no session)
const link = await page.evaluate(async () => {
  const { clients } = await (await fetch('/api/clients')).json();
  return (await (await fetch(`/api/clients/${clients[0].id}/link`)).json()).link;
});
const client = await (await browser.newContext()).newPage();
client.on('pageerror', (e) => errors.push(e.message));
await client.goto(link.replace(/^https?:\/\/[^/]+/, base));
await client.waitForSelector('#upForm:not([hidden])');
check(/E2E CPA/.test(await client.textContent('#firm')), 'upload page shows the firm’s brand');
await client.setInputFiles('#upFiles', sample);
await client.click('#upForm button');
await client.waitForSelector('#upMsg .ok-text');
check(/Sent 1 file/.test(await client.textContent('#upMsg')), 'client upload works');
await client.screenshot({ path: `${shots}/5-upload.png` });

// 6. Firm opens the upload in the converter
await page.goto(base + '/account/#clients');
await page.waitForSelector('[data-convert]');
await Promise.all([page.waitForURL(/\?upload=|\/$/), page.click('[data-convert]')]);
await page.waitForSelector('#status.good', { timeout: 20000 });
check(true, 'client upload opens in the converter');

// 7. Embedded converter on a firm's site
const host = await (await browser.newContext()).newPage();
host.on('pageerror', (e) => errors.push(e.message));
await host.goto(`${base}/embed/?k=${embedKey}`);
await host.waitForFunction(() => document.querySelector('#embedBrand').textContent.includes('E2E CPA'));
await host.setInputFiles('#file', sample);
await host.waitForSelector('#status.good', { timeout: 20000 });
check(true, 'embedded converter converts with firm branding');
await host.screenshot({ path: `${shots}/6-embed.png` });

// 8. Phone width
const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
for (const p of ['/', '/pricing/', '/login/']) {
  await phone.goto(base + p);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `no sideways scroll on phones: ${p}`, `${overflow}px`);
}

check(errors.length === 0, 'no JavaScript errors', errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
