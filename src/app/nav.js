// Swaps "Sign in" for "Account" in the header when this browser is signed in. No network request.
import { looksSignedIn } from './api.js';
const a = document.getElementById('navAccount');
if (a && looksSignedIn()) a.textContent = 'Account', a.href = a.href.replace(/login\/$/, 'account/');
