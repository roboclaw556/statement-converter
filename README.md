# StatementOtter

Bank statement PDFs to 17 formats for bookkeepers: Excel, CSV, QuickBooks Online CSV, QuickBooks Desktop (.qbo), Xero, OFX, Quicken (.qfx), QIF, Sage, FreshBooks, Wave, Zoho Books, YNAB, Tally XML, MT940, CAMT.053 and JSON.
Every conversion is balance-checked: opening balance + transactions must equal the
closing balance, and rows that break the running balance are highlighted.

Statements are converted **in the browser**. Nothing from a statement is uploaded unless the
person chooses a server feature (email import, folder import, client portal, API).

## Plans

Defined once in `src/core/plans.js` and used by the server (enforcement), the web app and the mobile app.

| | Free | Pro ($19/mo, $190/yr) | Firm ($99/mo, $990/yr) |
| --- | --- | --- | --- |
| Statements | 5 a month | Unlimited | Unlimited |
| All 17 formats, balance check | ✓ | ✓ | ✓ |
| Lender report, tamper check, learned category rules | | ✓ | ✓ |
| AI categorization | | 200 statements/mo | 2,000/mo |
| Email import, Dropbox / Google Drive folder import | | ✓ | ✓ |
| Send to QuickBooks / Xero (coming soon until approved) | | ✓ | ✓ |
| Client upload portal, white-label + embed, API (2,000 pages/mo) | | | ✓ |
| Seats | 1 | 1 | 5 |

## What's here

| Path | What it is |
| --- | --- |
| `src/core/` | Converter (PDF lines → transactions → balance check → 17 exports), plans, categories, lender report, tamper checks. Shared by browser, server and mobile. |
| `src/app/` | Web pages: converter (`app.js`), sign-in, account, pricing, client upload, embed, shared API client (`api.js`). |
| `scripts/build.js` | Builds `dist/`: 154 pages including 149 SEO pages, pricing, sign-in, account, upload, embed and API docs. |
| `server/index.js` | The Worker: router for `/api/*`, static assets, inbound email and scheduled jobs. |
| `server/routes/` | `account` (sign-in, team, usage), `billing` (Stripe, RevenueCat), `api` (keys, `/api/v1`), `rules` (rules + AI), `portal` (clients, uploads), `integrations` (QuickBooks, Xero, Dropbox, Google Drive), `branding` (white-label, embed), `feedback`. |
| `server/email.js` | Email import: team inbox addresses and `statements@`, plan checks, replies with Excel + QuickBooks + Xero files. |
| `db/schema.sql` | D1 schema (idempotent). |
| `test/` | 57 tests: parser samples, 300-statement fuzz, exports, auth/CSRF/seats/quotas, Stripe and RevenueCat webhooks, API, portal, integrations, white-label, email routing. |
| `scripts/smoke.mjs`, `scripts/e2e-browser.mjs` | Smoke test and Playwright run-through against a running Worker. |

## Run it locally

```bash
npm install
npm test                    # 57 tests, about 10 seconds
npm run build               # writes dist/
cp .dev.vars.example .dev.vars   # then fill ENC_KEY (see below)
npx wrangler d1 execute statementotter --local --file db/schema.sql
npx wrangler dev --local --test-scheduled
node scripts/smoke.mjs http://localhost:8787      # with DEV=1 sign-in codes come back in the response
```

## Deploy (Cloudflare Workers Paid, $5/month)

1. `npx wrangler login`
2. `npx wrangler d1 create statementotter` and paste the id into `wrangler.toml`, then
   `npx wrangler d1 execute statementotter --remote --file db/schema.sql`
3. `npx wrangler r2 bucket create statementotter-uploads`
4. Set the secrets below with `npx wrangler secret put NAME`.
5. `npm run build && npx wrangler deploy`, then add `statementotter.com` as a custom domain on the Worker.
6. Email Routing on the domain: catch-all → the `statementotter` Worker (team inboxes and `statements@`).
7. Stripe: create the Pro and Firm products with monthly and yearly prices, and a webhook to
   `https://statementotter.com/api/webhooks/stripe` for `checkout.session.completed`, `customer.subscription.*` and `invoice.payment_failed`.
8. RevenueCat (app stores): webhook to `/api/webhooks/revenuecat` with an Authorization header; the app logs in with `app_user_id` = team id.
9. Search Console: submit `/sitemap.xml`.

### Environment

| Secret | What for |
| --- | --- |
| `ENC_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts OAuth tokens and client links. Required. |
| `RESEND_API_KEY` | Sign-in and notification emails (free tier: 3,000/month). Verify the domain in Resend. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_{PRO,FIRM}_{MONTH,YEAR}` | Web billing. |
| `REVENUECAT_WEBHOOK_SECRET` | App store billing. |
| `ANTHROPIC_API_KEY` | AI categorization (Claude; only descriptions and amounts are sent). |
| `DROPBOX_APP_KEY/SECRET` | Dropbox folder import (app-folder access). Redirect URI `/api/integrations/dropbox/callback`. |
| `GOOGLE_CLIENT_ID/SECRET` | Google Drive import. Needs Google's restricted-scope verification; set `FEATURE_GOOGLEDRIVE=1` once approved. |
| `QBO_CLIENT_ID/SECRET`, `XERO_CLIENT_ID/SECRET` | Send to QuickBooks / Xero. Set `FEATURE_ACCOUNTINGPUSH=1` once Intuit and Xero approve the apps. |
| `EXPORT_TOKEN`, `IP_SALT` | Weekly feedback export and spam protection. |

Missing secrets switch the matching feature off with a clear message; nothing else breaks.

## The Friday feedback loop

Feedback comes from the `/feedback/` page and from the "Did this convert correctly?" buttons
after each conversion. Those buttons record only the outcome and counts (balanced or not,
number of rows, bank page). They never record statement contents.

The weekly job:

```bash
SITE_URL=https://yourdomain EXPORT_TOKEN=... node scripts/weekly-feedback.mjs
```

This writes `feedback/weekly/<date>.md`, grouped by type, with the conversion success rate at the top.
Claude Code reads that file, decides what to build, and can mark items handled:

```bash
curl -X PATCH https://yourdomain/api/feedback -H "authorization: Bearer $EXPORT_TOKEN" \
  -H 'content-type: application/json' -d '{"ids":[12,15],"status":"planned"}'
```

Feedback text is written by the public, so the export labels it as data to assess, not instructions.

## Known limits (next work)

- **Scanned PDFs**: these have no text layer and need OCR. Not supported yet.
- **Real statements**: the parser is tested on five synthetic layouts. The first real statements from users
  will expose bank-specific quirks. Every "Something was wrong" report is the signal for that.
- **QBO/QFX bank id**: Web Connect files carry an Intuit bank id (`INTU.BID`, default `3000`). If QuickBooks Desktop or Quicken rejects a file, change `bankId` in `src/core/formats.js`.
- **Import formats are built from each app's documented layout but not yet imported into the real apps.** Test each once with a free trial before promoting its page.
- **Credit card statements** probably work (same table shape) but are untested.
- **Approvals**: QuickBooks/Xero sending and Google Drive are built and tested against mocked APIs; they open when the providers approve the apps.
- **SEO pages** share a template. As real statements come in, add a real (anonymised) sample per bank
  so each page has unique, useful content. Thin near-duplicate pages rank poorly.
