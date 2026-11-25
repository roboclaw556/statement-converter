// Tokens, hashes, signatures and encryption with Web Crypto (Workers and Node 20+).

const enc = new TextEncoder();

export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return b64url(b);
}

export function randomId(prefix = '') {
  return prefix + randomToken(12);
}

/** Uniform 6-digit code (rejection sampling avoids modulo bias). */
export function randomCode() {
  const max = 4294967296 - (4294967296 % 1000000);
  let n;
  do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= max);
  return String(n % 1000000).padStart(6, '0');
}

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function aesKey(keyB64) {
  if (!keyB64) throw new Error('ENC_KEY is not set');
  const raw = fromB64(keyB64);
  if (raw.length !== 32) throw new Error('ENC_KEY must be 32 bytes, base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** AES-256-GCM; output "v1.<iv>.<ciphertext>" in base64url. */
export async function encrypt(keyB64, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), enc.encode(plaintext));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function decrypt(keyB64, payload) {
  const [v, iv, ct] = String(payload).split('.');
  if (v !== 'v1') throw new Error('unknown ciphertext version');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await aesKey(keyB64), fromB64(ct));
  return new TextDecoder().decode(pt);
}

/** PKCE S256 challenge for OAuth. */
export async function pkceChallenge(verifier) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return b64url(new Uint8Array(d));
}
