# StatementOtter

Bank statement PDFs to 17 formats for bookkeepers: Excel, CSV, QuickBooks Online CSV, QuickBooks Desktop (.qbo), Xero, OFX, Quicken (.qfx), QIF, Sage, FreshBooks, Wave, Zoho Books, YNAB, Tally XML, MT940, CAMT.053 and JSON.
Every conversion is balance-checked: opening balance + transactions must equal the
closing balance, and rows that break the running balance are highlighted.

Statements are converted **in the browser**. Nothing from a statement is uploaded,
which is both the privacy pitch and the reason hosting costs nothing.

## What's here

| Path | What it is |
| --- | --- |
| `src/core/` | The converter: PDF text lines → transactions → balance check → exports. Shared by the site, the email worker and the tests. |
| `src/app/` | The web app (upload, review table with inline fixes, downloads, quick feedback) and page templates. |
| `src/core/formats.js` | The list of export formats. Add a format here and it appears in the app and the email worker. |
| `scripts/build.js` | Builds `dist/` (149 pages): home, 24 bank pages, 96 bank × format pages, 25 "PDF bank statement to <app or format>" pages, feedback, privacy, sitemap, robots. |
| `seo/banks.json`, `seo/site.json` | Banks to generate pages for, and the brand name and domain. Edit these, then `npm run build`. |
| `functions/api/feedback.js` | Feedback API (Cloudflare Pages Function + D1): public POST, token-protected export and status update. |
| `db/schema.sql` | Feedback table. |
| `scripts/weekly-feedback.mjs` | Pulls the last 7 days of feedback into `feedback/weekly/<date>.md` for the Friday review. |
| `worker/` | Email import: a Cloudflare Email Worker that replies with Excel + QuickBooks + Xero files. |
| `test/` | Five sample statement layouts (made-up banks) with expected results, plus feedback API tests. |

## Run it locally

```bash
npm install
npm test            # 17 tests: 5 statement layouts, all 17 export formats, balance check, feedback API
npm run build       # writes dist/
npx serve dist      # or: python3 -m http.server -d dist
```

The feedback form needs the Cloudflare function, so locally it shows "did not send";
everything else works.

## Deploy (free)

Everything below is on Cloudflare's free plan except where marked.

1. Create a Cloudflare account and install wrangler: `npm i -g wrangler && wrangler login`.
2. Create the database: `wrangler d1 create statement-converter`, paste the id into `wrangler.toml`
   (and `worker/wrangler.toml`), then `wrangler d1 execute statement-converter --remote --file db/schema.sql`.
3. Deploy the site: `npm run build && wrangler pages deploy dist`.
   (Or connect the GitHub repo in the Cloudflare Pages dashboard with build command `npm run build`.)
4. Set secrets: `wrangler pages secret put EXPORT_TOKEN` (a long random string) and `wrangler pages secret put IP_SALT`.
5. **Domain (about $10/year, paid):** buy one, set it in `seo/site.json`, rebuild, add it to the Pages project.
6. Add the domain to Google Search Console and submit `/sitemap.xml`.

### Email import (optional, $5/month)

PDF parsing needs more CPU than the Workers free plan allows (10 ms), so this needs Workers Paid.
It's listed as a Pro feature, so it should pay for itself.

```bash
cd worker && npm install && npm test && npx wrangler deploy
```

Then in Cloudflare Email Routing, route `statements@yourdomain` to the `statement-converter-email` worker.
Each sender is limited to 20 emails a day.

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
- **Payments**: everything is free during beta. Adding paid plans needs a payment provider account
  (Lemon Squeezy or Stripe, both free to open, fee per sale).
- **SEO pages** share a template. As real statements come in, add a real (anonymised) sample per bank
  so each page has unique, useful content. Thin near-duplicate pages rank poorly.
