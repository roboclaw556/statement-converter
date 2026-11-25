// Every export format in one place, so the web app, the email worker and the
// SEO pages all offer the same list.
import * as x from './export.js';

const csv = 'text/csv';
/** ctx = { dateStyle: 'MDY'|'DMY', currency: 'USD' } */
export const FORMATS = [
  { id: 'xlsx', label: 'Excel (.xlsx)', ext: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', build: (r) => x.toXlsx(r) },
  { id: 'csv', label: 'CSV', ext: '.csv', mime: csv, build: (r) => x.toGenericCsv(r) },
  { id: 'quickbooks', label: 'QuickBooks Online (CSV)', ext: '-quickbooks.csv', mime: csv, build: (r, c) => x.toQuickBooksCsv(r, c.dateStyle) },
  { id: 'qbo', label: 'QuickBooks Desktop (.qbo)', ext: '.qbo', mime: 'application/vnd.intu.qbo', build: (r, c) => x.toWebConnect(r, { currency: c.currency }) },
  { id: 'xero', label: 'Xero (CSV)', ext: '-xero.csv', mime: csv, build: (r, c) => x.toXeroCsv(r, c.dateStyle) },
  { id: 'ofx', label: 'OFX', ext: '.ofx', mime: 'application/x-ofx', build: (r, c) => x.toOfx(r, { currency: c.currency }) },
  { id: 'qfx', label: 'Quicken (.qfx)', ext: '.qfx', mime: 'application/vnd.intu.qfx', build: (r, c) => x.toWebConnect(r, { currency: c.currency }) },
  { id: 'qif', label: 'QIF', ext: '.qif', mime: 'application/qif', build: (r, c) => x.toQif(r, c.dateStyle) },
  { id: 'sage', label: 'Sage (CSV)', ext: '-sage.csv', mime: csv, build: (r, c) => x.toSageCsv(r, c.dateStyle) },
  { id: 'freshbooks', label: 'FreshBooks (CSV)', ext: '-freshbooks.csv', mime: csv, build: (r, c) => x.toFreshBooksCsv(r, c.dateStyle) },
  { id: 'wave', label: 'Wave (CSV)', ext: '-wave.csv', mime: csv, build: (r, c) => x.toWaveCsv(r, c.dateStyle) },
  { id: 'zoho', label: 'Zoho Books (CSV)', ext: '-zoho.csv', mime: csv, build: (r, c) => x.toZohoCsv(r, c.dateStyle) },
  { id: 'ynab', label: 'YNAB (CSV)', ext: '-ynab.csv', mime: csv, build: (r, c) => x.toYnabCsv(r, c.dateStyle) },
  { id: 'tally', label: 'Tally (XML)', ext: '-tally.xml', mime: 'application/xml', build: (r) => x.toTallyXml(r) },
  { id: 'mt940', label: 'MT940', ext: '.sta', mime: 'text/plain', build: (r, c) => x.toMt940(r, { currency: c.currency }) },
  { id: 'camt053', label: 'CAMT.053 (XML)', ext: '-camt053.xml', mime: 'application/xml', build: (r, c) => x.toCamt053(r, { currency: c.currency }) },
  { id: 'json', label: 'JSON', ext: '.json', mime: 'application/json', build: (r) => x.toJson(r) },
];

export const formatById = Object.fromEntries(FORMATS.map((f) => [f.id, f]));
