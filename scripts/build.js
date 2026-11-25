// Builds the static site into dist/: the converter home page, one page per
// bank and per bank + export format, a bank index, feedback and privacy
// pages, sitemap.xml and robots.txt. No framework, no build dependencies.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatById } from '../src/core/formats.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const site = JSON.parse(readFileSync(join(ROOT, 'seo/site.json'), 'utf8'));
const banks = JSON.parse(readFileSync(join(ROOT, 'seo/banks.json'), 'utf8'));
const shell = readFileSync(join(ROOT, 'src/app/shell.html'), 'utf8');
const toolHtml = readFileSync(join(ROOT, 'src/app/tool.html'), 'utf8');

const COUNTRY = {
  US: { label: 'United States', dateOrder: 'MDY', dateExample: '01/31/2026', currency: 'USD', symbol: '$' },
  UK: { label: 'United Kingdom', dateOrder: 'DMY', dateExample: '31/01/2026', currency: 'GBP', symbol: '£' },
  CA: { label: 'Canada', dateOrder: 'MDY', dateExample: '01/31/2026', currency: 'CAD', symbol: '$' },
  AU: { label: 'Australia', dateOrder: 'DMY', dateExample: '31/01/2026', currency: 'AUD', symbol: '$' },
};

const FORMATS = {
  excel: {
    label: 'Excel', file: '.xlsx workbook',
    why: 'Dates come through as real Excel dates and amounts as numbers, so SUM, filters and pivot tables work straight away. A second sheet shows the balance check.',
    steps: ['Download your statement PDF from online banking.', 'Drop it in the converter above.', 'Check the green "Balanced" banner, fix any highlighted rows, then click Download Excel.'],
    columns: ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
  },
  csv: {
    label: 'CSV', file: '.csv file',
    why: 'A clean CSV with one row per transaction, separate money-in and money-out columns and the running balance, ready for any spreadsheet or accounting tool.',
    steps: ['Download your statement PDF from online banking.', 'Drop it in the converter above.', 'Review any highlighted rows, then click CSV.'],
    columns: ['Date', 'Description', 'Debit', 'Credit', 'Amount', 'Balance'],
  },
  quickbooks: {
    label: 'QuickBooks', file: 'QuickBooks-ready CSV',
    why: 'QuickBooks Online accepts a three-column bank file: Date, Description, Amount. The converter writes exactly that, with spending as negative amounts, so the upload maps without edits.',
    steps: ['Convert the statement above and click QuickBooks CSV.', 'In QuickBooks Online, go to Banking, then Upload transactions (under the Link account menu).', 'Choose the file, pick the bank account, map Date, Description and Amount, and confirm.'],
    columns: ['Date', 'Description', 'Amount'],
  },
  xero: {
    label: 'Xero', file: 'Xero-ready CSV',
    why: 'Xero imports statement lines from CSV or OFX. The converter fills the Date, Amount, Payee and Description columns Xero expects, in your region\'s date format.',
    steps: ['Convert the statement above and click Xero CSV (or OFX).', 'In Xero, open the bank account and choose Import a statement.', 'Upload the file, check the preview and import.'],
    columns: ['*Date', '*Amount', 'Payee', 'Description'],
  },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page({ path, title, description, h1, lead, content = '', tool = true, dateOrder = '', format = '', bank = '', jsonld = null, scripts }) {
  const depth = path.split('/').filter(Boolean).length;
  const root = depth ? '../'.repeat(depth) : './';
  const fill = (tpl, map) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in map ? map[k] : ''));
  const toolMarkup = tool
    ? fill(toolHtml, { root, dateOrder, format }).replace('id="tool"', `id="tool" data-bank="${esc(bank)}"`)
    : '';
  const html = fill(shell, {
    title: esc(title), description: esc(description), canonical: site.domain + '/' + path,
    h1: esc(h1), lead: esc(lead), brand: esc(site.brand), root, content,
    tool: toolMarkup,
    scripts: scripts ?? (tool ? `<script type="module" src="${root}app.js"></script>` : ''),
    jsonld: jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : '',
  });
  const dir = join(DIST, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  pages.push(path);
}

const pages = [];
const fmtLabel = (id) => formatById[id].label;
// filled in below; used by targetLinks()
let TARGET_LIST = [];
function targetLinks(root, except = '') {
  return `<ul class="links">${TARGET_LIST.filter((t) => t.slug !== except).map((t) =>
    `<li><a href="${root}convert/pdf-bank-statement-to-${t.slug}/">${esc(t.name)}</a></li>`).join('')}</ul>`;
}

function faq(items) {
  return {
    html: `<h2>Questions</h2>${items.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}`,
    jsonld: {
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: items.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    },
  };
}

function sampleTable(fmt, country) {
  const c = COUNTRY[country];
  const d = (day) => (c.dateOrder === 'DMY' ? `${day}/01/2026` : `01/${day}/2026`);
  const rows = [
    { date: d('05'), desc: 'CARD PURCHASE OFFICE SUPPLIES', amt: -48.2, bal: 2391.8 },
    { date: d('06'), desc: 'CLIENT PAYMENT INV 1043', amt: 1250, bal: 3641.8 },
    { date: d('09'), desc: 'MONTHLY ACCOUNT FEE', amt: -12, bal: 3629.8 },
  ];
  const n = (v) => v.toFixed(2);
  const cell = (col, r) => ({
    Date: r.date, '*Date': r.date, Description: r.desc, Payee: r.desc,
    Debit: r.amt < 0 ? n(-r.amt) : '', Credit: r.amt > 0 ? n(r.amt) : '',
    Amount: n(r.amt), '*Amount': n(r.amt), Balance: n(r.bal),
  })[col];
  const f = FORMATS[fmt];
  return `<div class="table-wrap"><table><thead><tr>${f.columns.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${f.columns.map((col) => `<td${/Amount|Debit|Credit|Balance/.test(col) ? ' class="num"' : ''}>${esc(cell(col, r))}</td>`).join('')}</tr>`).join('')
  }</tbody></table></div><p class="hint">Example rows (made up) showing the ${esc(f.file)} layout.</p>`;
}

const howItWorks = `<h2 id="how">How it works</h2><ol class="steps">
<li><strong>Drop the PDF.</strong> It is read inside your browser, so the statement never leaves your computer.</li>
<li><strong>We check every cent.</strong> Opening balance plus every transaction must equal the closing balance. Rows that don't add up are highlighted for you.</li>
<li><strong>Download for your software.</strong> Excel, CSV, QuickBooks, Xero or OFX, with dates and signs already right.</li></ol>`;

const pricing = `<h2 id="pricing">Pricing</h2><div class="plans">
<div class="plan featured"><h3>Beta</h3><div class="price">Free</div><p>Every feature, while we're in beta. Tell us what to improve on the <a href="feedback/">feedback page</a>.</p></div>
<div class="plan"><h3>Pro</h3><div class="price">$19<small>/mo</small></div><p>Coming soon: email import, batch conversion, saved bank fixes.</p></div>
<div class="plan"><h3>Firm</h3><div class="price">$99<small>/mo</small></div><p>Coming soon: client upload links, team seats, priority bank support.</p></div></div>`;

function bankLinks(root) {
  return `<ul class="links">${banks.map((b) => `<li><a href="${root}banks/${b.slug}/">${esc(b.name)}</a></li>`).join('')}</ul>`;
}

const TARGETS = [
  { slug: 'quickbooks-online', name: 'QuickBooks Online', formats: ['quickbooks', 'qbo'], steps: ['Convert the statement and download QuickBooks Online (CSV).', 'In QuickBooks Online, go to Banking, then Upload transactions under the Link account menu.', 'Choose the file and the bank account, map Date, Description and Amount, then confirm.'] },
  { slug: 'quickbooks-desktop', name: 'QuickBooks Desktop', formats: ['qbo', 'quickbooks'], steps: ['Convert the statement and download QuickBooks Desktop (.qbo).', 'In QuickBooks Desktop, choose File, Utilities, Import, Web Connect Files.', 'Pick the .qbo file and link it to the right bank account.'] },
  { slug: 'xero', name: 'Xero', formats: ['xero', 'ofx'], steps: ['Convert the statement and download Xero (CSV) or OFX.', 'In Xero, open the bank account and choose Import a statement.', 'Upload the file, check the preview and import.'] },
  { slug: 'sage', name: 'Sage', formats: ['sage', 'ofx'], steps: ['Convert the statement and download Sage (CSV) or OFX.', 'In Sage Accounting, open the bank account and choose Import statement.', 'Upload the file and match the Date, Reference, Description and Amount columns.'] },
  { slug: 'freshbooks', name: 'FreshBooks', formats: ['freshbooks'], steps: ['Convert the statement and download FreshBooks (CSV).', 'In FreshBooks, open Accounting, Bank Connections and choose to upload a statement.', 'Upload the CSV and confirm the column mapping.'] },
  { slug: 'wave', name: 'Wave', formats: ['wave'], steps: ['Convert the statement and download Wave (CSV).', 'In Wave, open Transactions, then More, then Upload a bank statement.', 'Pick the CSV and the payment account, then map the columns.'] },
  { slug: 'zoho-books', name: 'Zoho Books', formats: ['zoho', 'ofx', 'qif'], steps: ['Convert the statement and download Zoho Books (CSV), OFX or QIF.', 'In Zoho Books, open Banking, select the account and choose Import Statement.', 'Upload the file and map Date, Withdrawals and Deposits.'] },
  { slug: 'myob', name: 'MYOB', formats: ['qif', 'ofx'], steps: ['Convert the statement and download QIF or OFX.', 'In MYOB, open Banking and choose to import a bank statement file.', 'Select the file and match the transactions.'] },
  { slug: 'quicken', name: 'Quicken', formats: ['qfx', 'qif'], steps: ['Convert the statement and download Quicken (.qfx).', 'In Quicken, choose File, File Import, Web Connect (.QFX) File.', 'Pick the file and link it to the right account.'] },
  { slug: 'ynab', name: 'YNAB', formats: ['ynab'], steps: ['Convert the statement and download YNAB (CSV).', 'In YNAB, open the account and choose File Import.', 'Pick the CSV and review the imported transactions.'] },
  { slug: 'tally', name: 'Tally', formats: ['tally', 'xlsx'], steps: ['Convert the statement and download Tally (XML). It creates Payment and Receipt vouchers against a ledger called "Bank Account", with "Suspense A/c" as the other side.', 'In Tally, make sure both ledgers exist (rename them in the file if yours differ).', 'Use Import Data, Vouchers and pick the XML file, then move entries from Suspense to the right ledgers.'] },
  { slug: 'gnucash', name: 'GnuCash', formats: ['qif', 'ofx'], steps: ['Convert the statement and download QIF or OFX.', 'In GnuCash, choose File, Import, then QIF or OFX/QFX.', 'Pick the file and match it to the account.'] },
  { slug: 'moneydance', name: 'Moneydance', formats: ['ofx', 'qif'], steps: ['Convert the statement and download OFX or QIF.', 'In Moneydance, choose File, Import.', 'Pick the file and the account.'] },
  { slug: 'odoo', name: 'Odoo', formats: ['camt053', 'ofx', 'csv'], steps: ['Convert the statement and download CAMT.053, OFX or CSV.', 'In Odoo Accounting, open the bank journal and choose Import.', 'Upload the file and check the statement lines.'] },
  { slug: 'sap', name: 'SAP', formats: ['mt940', 'camt053'], steps: ['Convert the statement and download MT940 or CAMT.053.', 'Load it through your electronic bank statement import (for example FF_5 in SAP ECC, or Manage Bank Statements in S/4HANA).', 'Post and reconcile as usual.'] },
  { slug: 'google-sheets', name: 'Google Sheets', formats: ['csv', 'xlsx'], steps: ['Convert the statement and download CSV.', 'In Google Sheets, choose File, Import, Upload.', 'Pick the CSV and choose to create a new sheet.'] },
  { slug: 'excel', name: 'Excel', formats: ['xlsx', 'csv'], steps: ['Convert the statement and download Excel (.xlsx).', 'Open it: dates are real Excel dates and amounts are numbers.', 'The Summary sheet shows the balance check.'] },
  { slug: 'csv', name: 'CSV', formats: ['csv'], steps: ['Convert the statement and download CSV.', 'Open it in any spreadsheet or accounting tool.', 'Columns: Date, Description, Debit, Credit, Amount, Balance.'] },
  { slug: 'ofx', name: 'OFX', formats: ['ofx'], steps: ['Convert the statement and download OFX.', 'Import it into Xero, Sage, Zoho Books, MYOB, GnuCash, Moneydance or most other accounting apps.', 'Match the transactions as usual.'] },
  { slug: 'qbo', name: 'QBO (Web Connect)', formats: ['qbo'], steps: ['Convert the statement and download QuickBooks Desktop (.qbo).', 'In QuickBooks, choose File, Utilities, Import, Web Connect Files.', 'Link it to the right bank account.'] },
  { slug: 'qfx', name: 'QFX', formats: ['qfx'], steps: ['Convert the statement and download Quicken (.qfx).', 'In Quicken, choose File, File Import, Web Connect (.QFX) File.', 'Link it to the right account.'] },
  { slug: 'qif', name: 'QIF', formats: ['qif'], steps: ['Convert the statement and download QIF.', 'Import it into Quicken, MYOB, GnuCash, Moneydance or Zoho Books.', 'Match the transactions as usual.'] },
  { slug: 'mt940', name: 'MT940', formats: ['mt940'], steps: ['Convert the statement and download MT940.', 'Import it into an ERP that reads SWIFT statements (SAP, Exact, Odoo, Microsoft Dynamics and others).', 'Post and reconcile as usual.'] },
  { slug: 'camt-053', name: 'CAMT.053', formats: ['camt053'], steps: ['Convert the statement and download CAMT.053 (XML).', 'Import it into any ERP that reads ISO 20022 statements.', 'Post and reconcile as usual.'] },
  { slug: 'json', name: 'JSON', formats: ['json'], steps: ['Convert the statement and download JSON.', 'Each transaction has date, description, amount, balance and check flags.', 'Feed it into your own scripts or tools.'] },
];
TARGET_LIST = TARGETS;

// ---------- build ----------

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(join(ROOT, 'src/core'), join(DIST, 'core'), { recursive: true });
for (const f of ['app.js', 'feedback.js', 'feedback-page.js', 'styles.css']) cpSync(join(ROOT, 'src/app', f), join(DIST, f));
mkdirSync(join(DIST, 'vendor'), { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  cpSync(join(ROOT, 'node_modules/pdfjs-dist/build', f), join(DIST, 'vendor', f));
}

// Home
{
  const q = faq([
    ['Is my bank statement uploaded anywhere?', 'No. The PDF is read and converted by your own browser. Nothing from the statement is sent to our servers.'],
    ['How do I know the conversion is right?', 'Every conversion is balance-checked: the opening balance plus all transactions must equal the closing balance printed on the statement. If it does not, the rows that break the running balance are highlighted.'],
    ['Which banks work?', 'Any bank that issues text-based PDF statements. Scanned or photographed statements need OCR, which is coming soon.'],
    ['Can I import the result into QuickBooks or Xero?', 'Yes. Use the QuickBooks CSV or Xero CSV buttons, or OFX for other accounting software.'],
  ]);
  page({
    path: '', title: `Bank statement converter: PDF to Excel, QuickBooks, Xero | ${site.brand}`,
    description: 'Convert PDF bank statements to Excel, CSV, QuickBooks or Xero in seconds. Balance-checked to the cent and converted in your browser, so statements stay private.',
    h1: 'Convert bank statement PDFs to Excel, QuickBooks and Xero',
    lead: 'Balance-checked to the cent, and converted on your own device. Built for bookkeepers.',
    content: howItWorks + `<h2>Works with your software</h2><p>Excel, QuickBooks, Xero, Sage, FreshBooks, Wave, Zoho Books, MYOB, Quicken, YNAB, Tally, GnuCash, Odoo, SAP and more, in 17 file formats.</p>` + targetLinks('./') + pricing + `<h2>Banks</h2>` + bankLinks('./') + q.html,
    jsonld: q.jsonld,
  });
}

// Bank index
page({
  path: 'banks/', title: `Supported banks | ${site.brand}`, tool: false,
  description: 'Convert statements from these banks, and any other bank that issues text-based PDF statements.',
  h1: 'Convert statements from any bank',
  lead: 'These pages have bank-specific tips. The converter works with any bank that issues text-based PDF statements.',
  content: bankLinks('../') + `<p>Bank missing? <a href="../feedback/">Tell us which one</a> and we'll add it.</p>`,
});

// Bank hubs and bank x format pages
for (const b of banks) {
  const c = COUNTRY[b.country];
  const formatLinks = (root) => `<ul class="links">${Object.entries(FORMATS).map(([k, f]) =>
    `<li><a href="${root}convert/${b.slug}-statement-to-${k}/">${esc(b.name)} statement to ${f.label}</a></li>`).join('')}</ul>`;
  const others = banks.filter((o) => o.country === b.country && o.slug !== b.slug).slice(0, 6);

  page({
    path: `banks/${b.slug}/`, title: `Convert ${b.name} bank statements to Excel, QuickBooks, Xero | ${site.brand}`,
    description: `Turn ${b.name} PDF statements into Excel, CSV, QuickBooks or Xero files, balance-checked and converted privately in your browser.`,
    h1: `Convert ${b.name} bank statements`,
    lead: `Drop a ${b.name} PDF statement to get every transaction as Excel, CSV, QuickBooks or Xero, checked against the statement's balances.`,
    dateOrder: c.dateOrder, bank: b.slug,
    content: `<h2>Choose your format</h2>${formatLinks('../../')}${howItWorks}
<h2>About ${esc(b.name)} statements</h2><p>${esc(b.name)} is a ${c.label} bank, so statements use ${c.currency} amounts and dates written like ${c.dateExample}. The converter reads them that way by default, and you can switch the date order if a statement says otherwise.</p>
<p>Something not right with a ${esc(b.name)} statement? <a href="../../feedback/">Tell us</a>. Bank-specific fixes go out every week.</p>
<h2>Other ${c.label} banks</h2><ul class="links">${others.map((o) => `<li><a href="../${o.slug}/">${esc(o.name)}</a></li>`).join('')}</ul>`,
  });

  for (const [k, f] of Object.entries(FORMATS)) {
    const q = faq([
      [`How do I convert a ${b.name} statement to ${f.label}?`, f.steps.join(' ')],
      [`Is it safe to convert my ${b.name} statement here?`, 'Yes. The PDF is processed by your own browser and is never uploaded.'],
      [`What if the ${b.name} statement does not balance?`, 'The rows where the running balance breaks are highlighted. Click a description or amount to correct it and the balance check updates instantly.'],
    ]);
    page({
      path: `convert/${b.slug}-statement-to-${k}/`,
      title: `${b.name} statement to ${f.label} converter | ${site.brand}`,
      description: `Convert ${b.name} PDF bank statements to a ${f.file}. Balance-checked to the cent, private, and free during beta.`,
      h1: `${b.name} bank statement to ${f.label}`,
      lead: `Drop your ${b.name} PDF statement below to get a ${f.file}. Every row is checked against the statement's opening and closing balance.`,
      dateOrder: c.dateOrder, format: k, bank: b.slug,
      content: `<h2>Why this ${esc(f.file)} is ready to use</h2><p>${esc(f.why)}</p>${sampleTable(k, b.country)}
<h2>Steps</h2><ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
<h2>Other formats for ${esc(b.name)}</h2><ul class="links">${Object.entries(FORMATS).filter(([o]) => o !== k).map(([o, of]) =>
        `<li><a href="../${b.slug}-statement-to-${o}/">${esc(b.name)} to ${of.label}</a></li>`).join('')}<li><a href="../../banks/${b.slug}/">All ${esc(b.name)} options</a></li></ul>${q.html}`,
      jsonld: q.jsonld,
    });
  }
}


// Software and file-format pages: "PDF bank statement to <app or format>"

for (const tg of TARGETS) {
  const labels = tg.formats.map((id) => fmtLabel(id));
  const q = faq([
    [`How do I import a PDF bank statement into ${tg.name}?`, tg.steps.join(' ')],
    ['Which banks are supported?', 'Any bank that issues text-based PDF statements. Scanned statements need OCR, which is coming soon.'],
    ['Is my statement uploaded?', 'No. It is converted inside your browser and never leaves your device.'],
  ]);
  page({
    path: `convert/pdf-bank-statement-to-${tg.slug}/`,
    title: `PDF bank statement to ${tg.name} converter | ${site.brand}`,
    description: `Convert PDF bank statements to ${labels.join(' or ')} for ${tg.name}. Balance-checked to the cent and converted privately in your browser.`,
    h1: `Convert PDF bank statements to ${tg.name}`,
    lead: `Get a ${labels[0]} file you can import into ${tg.name}, with every row checked against the statement's balances.`,
    format: tg.formats[0],
    content: `<h2>Steps</h2><ol>${tg.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
<h2>Formats for ${esc(tg.name)}</h2><p>${labels.map(esc).join(', ')}. Every other format is in the "More formats" menu above.</p>
${howItWorks}
<h2>Other apps and formats</h2>${targetLinks('../../', tg.slug)}${q.html}`,
    jsonld: q.jsonld,
  });
}

// Feedback
page({
  path: 'feedback/', title: `Feedback | ${site.brand}`, tool: false,
  description: `Tell us what to improve in ${site.brand}.`,
  h1: 'What should we do better?',
  lead: 'Every message is read. The most requested fixes and features ship first, usually within a week.',
  content: `<form class="feedback-form" id="feedback">
<label>What is this about?
<select name="kind"><option value="idea">An idea or feature request</option><option value="bug">Something didn't convert right</option><option value="bank_request">Add or improve a bank</option><option value="praise">Something you like</option><option value="other">Other</option></select></label>
<fieldset class="rating" style="border:0;padding:0"><legend>How useful is ${esc(site.brand)} so far? (optional)</legend>
${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="rating" value="${n}"><span>${n}</span></label>`).join('')}</fieldset>
<label>Your feedback (please don't paste account numbers or statement text)<textarea name="message" required maxlength="5000"></textarea></label>
<label>Email, only if you'd like a reply<input type="email" name="email" autocomplete="email"></label>
<input type="text" name="website" tabindex="-1" autocomplete="off" hidden>
<div><button class="primary">Send feedback</button></div></form>
<p id="thanks" hidden>Thank you! We've got it.</p>`,
  scripts: '<script type="module" src="../feedback-page.js"></script>',
});

// Privacy
page({
  path: 'privacy/', title: `Privacy | ${site.brand}`, tool: false,
  description: `How ${site.brand} handles your data.`,
  h1: 'Privacy',
  lead: 'Short version: your bank statements never leave your device.',
  content: `<p>Statements are opened and converted by JavaScript running in your browser. Their contents are not sent to us or anyone else.</p>
<p>If you send feedback we store what you type, the page you sent it from, an optional email address, and simple counts about the conversion (for example "42 transactions, balanced"). We never store statement contents. We keep a salted hash of your IP address only to stop spam.</p>
<p>Questions or deletion requests: use the <a href="../feedback/">feedback page</a> and include your email.</p>`,
});

// Sitemap + robots
const urls = pages.filter((p) => !p.startsWith('feedback') && !p.startsWith('privacy'));
writeFileSync(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((p) => `  <url><loc>${site.domain}/${p}</loc></url>`).join('\n')}
</urlset>
`);
writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${site.domain}/sitemap.xml\n`);
writeFileSync(join(DIST, '_headers'), `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Content-Security-Policy: default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'\n`);

console.log(`Built ${pages.length} pages into dist/`);
