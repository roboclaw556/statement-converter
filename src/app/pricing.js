// Pricing page: monthly/yearly toggle and Stripe Checkout.
import { api, getMe, escapeHtml } from './api.js';

const $ = (s) => document.querySelector(s);
let interval = 'month';
const me = await getMe();

for (const b of document.querySelectorAll('[data-interval]')) {
  b.addEventListener('click', () => {
    interval = b.dataset.interval;
    document.querySelectorAll('[data-interval]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    document.querySelectorAll('[data-price-month]').forEach((el) => {
      el.innerHTML = interval === 'year' ? `$${el.dataset.priceYear}<small>/yr</small>` : `$${el.dataset.priceMonth}<small>/mo</small>`;
    });
  });
}

if (me) {
  const cur = document.querySelector(`button[data-plan="${me.team.plan}"]`);
  if (cur) { cur.textContent = 'Your plan'; cur.disabled = true; }
}

if (new URLSearchParams(location.search).get('checkout') === 'canceled') $('#payMsg').textContent = 'Checkout was canceled. Nothing was charged.';

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-plan]');
  if (!b) return;
  if (b.dataset.plan === 'free') { location.href = me ? '../' : '../login/'; return; }
  if (!me) { location.href = `../login/?next=${encodeURIComponent('/pricing/')}`; return; }
  b.disabled = true;
  try {
    const { url } = await api.post('/api/billing/checkout', { plan: b.dataset.plan, interval });
    location.href = url;
  } catch (err) {
    $('#payMsg').innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
    b.disabled = false;
  }
});
