// Small HTTP helpers shared by every route.

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const fail = (status, code, message, extra) => { throw new HttpError(status, code, message, extra); };

export async function readJson(req, maxBytes = 64 * 1024) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > maxBytes) fail(413, 'too_large', 'Request body too large');
  const text = await req.text();
  if (text.length > maxBytes) fail(413, 'too_large', 'Request body too large');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, 'bad_json', 'Expected a JSON object');
    return v;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    fail(400, 'bad_json', 'Invalid JSON');
  }
}

/** Reads a PDF from a raw body (application/pdf) or a multipart "file" field. */
export async function readPdf(req, maxBytes) {
  const type = req.headers.get('content-type') || '';
  const len = Number(req.headers.get('content-length') || 0);
  if (len > maxBytes) fail(413, 'too_large', `PDF must be under ${Math.round(maxBytes / 1048576)} MB`);
  let bytes, filename = 'statement.pdf';
  if (type.startsWith('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') fail(400, 'no_file', 'Send the PDF in a "file" field');
    filename = file.name || filename;
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    bytes = new Uint8Array(await req.arrayBuffer());
    filename = req.headers.get('x-filename') || filename;
  }
  if (bytes.length > maxBytes) fail(413, 'too_large', `PDF must be under ${Math.round(maxBytes / 1048576)} MB`);
  if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') fail(415, 'not_pdf', 'That file is not a PDF');
  return { bytes, filename: filename.replace(/[^\w.\- ]+/g, '_').slice(0, 120) };
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, maxAgeSeconds) {
  return `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export const clearCookie = () => 'sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,}$/.test(s);

export const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
