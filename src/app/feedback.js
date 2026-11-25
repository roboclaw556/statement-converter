// Sends feedback to the site's own /api/feedback endpoint (Cloudflare Pages Function + D1).
// Never sends statement contents: only what the person typed and a few counts.
export async function sendFeedback(payload) {
  const res = await fetch(new URL('./api/feedback', import.meta.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, page: location.pathname }),
  });
  if (!res.ok) throw new Error('feedback failed: ' + res.status);
  return res.json();
}
