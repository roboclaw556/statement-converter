// Sends feedback to the site's /api/feedback (the same endpoint the web app uses),
// so app feedback lands in the Friday review. Never sends statement contents.
import { CONFIG } from './config.js';
import { platform } from './platform.js';

export async function sendFeedback(payload) {
  const context = { ...(payload.context || {}), source: 'app', platform, appVersion: CONFIG.version };
  const res = await fetch(CONFIG.apiBase + '/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, context, page: `app:${platform}` }),
  });
  if (!res.ok) throw new Error('feedback failed: ' + res.status);
  return res.json().catch(() => ({}));
}
