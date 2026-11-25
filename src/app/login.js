// Sign in with an emailed link or 6-digit code. No passwords.
import { api, markSignedIn, escapeHtml } from './api.js';

const $ = (s) => document.querySelector(s);
const next = () => {
  const n = new URLSearchParams(location.search).get('next') || '';
  return /^\/[\w\-/]*$/.test(n) ? n : '../account/';
};
const done = () => { markSignedIn(true); location.replace(next()); };
const msg = (t, bad) => { $('#loginMsg').innerHTML = t; $('#loginMsg').className = bad ? 'error' : 'muted'; };

const link = new URLSearchParams(location.hash.slice(1)).get('t');
if (link) {
  history.replaceState(null, '', location.pathname + location.search); // keep the token out of history
  msg('Signing you in…');
  api.post('/api/auth/verify', { link }).then(done).catch((e) => msg(escapeHtml(e.message) + ' Ask for a new email below.', true));
}

let email = '';
$('#emailForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  email = $('#email').value.trim();
  const b = e.submitter; if (b) b.disabled = true;
  try {
    await api.post('/api/auth/start', { email });
    $('#emailForm').hidden = true;
    $('#codeForm').hidden = false;
    $('#sentTo').textContent = email;
    $('#code').focus();
    msg('Check your inbox. The email has a sign-in link and a 6-digit code.');
  } catch (err) { msg(escapeHtml(err.message), true); }
  finally { if (b) b.disabled = false; }
});

$('#codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api.post('/api/auth/verify', { email, code: $('#code').value.replace(/\D/g, '') }); done(); }
  catch (err) { msg(escapeHtml(err.message), true); }
});
$('#again').addEventListener('click', () => { $('#codeForm').hidden = true; $('#emailForm').hidden = false; msg(''); });
