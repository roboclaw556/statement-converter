// Runs inside the embedded converter: applies the firm's branding and reports height to the host page.
const key = new URLSearchParams(location.search).get('k') || '';
fetch(`/api/embed/${encodeURIComponent(key)}`).then((r) => (r.ok ? r.json() : null)).then((b) => {
  if (!b) { document.querySelector('#tool').innerHTML = '<p>This converter is not active.</p>'; return; }
  if (b.color) document.documentElement.style.setProperty('--accent', b.color);
  const bar = document.querySelector('#embedBrand');
  bar.textContent = b.brand ? `${b.brand} · bank statement converter` : '';
  if (b.logo) { const img = new Image(); img.src = b.logo; img.alt = ''; img.referrerPolicy = 'no-referrer'; bar.prepend(img); }
}).catch(() => {});
const report = () => parent.postMessage({ statementotterHeight: document.documentElement.scrollHeight }, '*');
new ResizeObserver(report).observe(document.body);
