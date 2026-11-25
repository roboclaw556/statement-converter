// Pulls the last 7 days of feedback into feedback/weekly/<date>.md for the Friday review.
// Usage: SITE_URL=https://yoursite.com EXPORT_TOKEN=... node scripts/weekly-feedback.mjs [since]
import { mkdirSync, writeFileSync } from 'node:fs';

const site = process.env.SITE_URL;
const token = process.env.EXPORT_TOKEN;
if (!site || !token) { console.error('Set SITE_URL and EXPORT_TOKEN'); process.exit(1); }
const since = process.argv[2] || new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
const res = await fetch(`${site.replace(/\/$/, '')}/api/feedback?since=${since}&format=md`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!res.ok) { console.error('Export failed', res.status, await res.text()); process.exit(1); }
const md = await res.text();
mkdirSync('feedback/weekly', { recursive: true });
const file = `feedback/weekly/${new Date().toISOString().slice(0, 10)}.md`;
writeFileSync(file, md);
console.log('Wrote', file);
