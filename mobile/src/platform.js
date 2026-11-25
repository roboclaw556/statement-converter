// Thin wrappers over the native plugins, with browser fallbacks so the same
// code runs in a desktop browser (used by the tests) and in the iOS/Android app.
// No bundler: plugins are reached through the bridge Capacitor injects.

const C = globalThis.Capacitor;
export const isNative = !!C?.isNativePlatform?.();
export const platform = isNative ? C.getPlatform() : 'web'; // 'ios' | 'android' | 'web'

const cache = {};
function plugin(name) {
  if (!isNative) return null;
  if (!(name in cache)) cache[name] = C.isPluginAvailable(name) ? C.registerPlugin(name) : null;
  return cache[name];
}
export const has = (name) => !!plugin(name);
export const native = plugin;

// ---------- bytes <-> base64 ----------

export function toBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
export function fromBase64(b64) {
  const s = atob(b64.replace(/^data:[^,]*,/, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const toBytes = (content) => (typeof content === 'string' ? new TextEncoder().encode(content) : content);

// ---------- key/value storage ----------

export const store = {
  async get(key, fallback = null) {
    try {
      const P = plugin('Preferences');
      const raw = P ? (await P.get({ key })).value : localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  async set(key, value) {
    const raw = JSON.stringify(value);
    try {
      const P = plugin('Preferences');
      if (P) await P.set({ key, value: raw }); else localStorage.setItem(key, raw);
    } catch { /* storage full or blocked: the app still works without it */ }
  },
  async remove(key) {
    try {
      const P = plugin('Preferences');
      if (P) await P.remove({ key }); else localStorage.removeItem(key);
    } catch { /* ignore */ }
  },
};

// ---------- saving / sharing an export ----------

/** Writes the file to the cache and opens the share sheet. Browser: downloads it. */
export async function shareFile(content, filename, mime) {
  const bytes = toBytes(content);
  const FS = plugin('Filesystem');
  const Share = plugin('Share');
  if (FS && Share) {
    const safe = filename.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
    const { uri } = await FS.writeFile({ path: `exports/${safe}`, data: toBase64(bytes), directory: 'CACHE', recursive: true });
    try {
      await Share.share({ title: safe, files: [uri], dialogTitle: 'Export statement' });
    } catch (e) {
      if (!/cancel/i.test(String(e?.message || e))) throw e; // closing the sheet is not an error
      return 'cancelled';
    }
    return 'shared';
  }
  const blob = new Blob([bytes], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return 'downloaded';
}

// ---------- reading files the OS hands us ----------

/** Reads a file:// or content:// URL (from "Open in", the share sheet or a scanner). */
export async function readUrl(url) {
  const FS = plugin('Filesystem');
  if (!FS) {
    const res = await fetch(url);
    return new Uint8Array(await res.arrayBuffer());
  }
  const { data } = await FS.readFile({ path: url });
  return typeof data === 'string' ? fromBase64(data) : new Uint8Array(await data.arrayBuffer());
}

export function nameFromUrl(url, fallback = 'Statement.pdf') {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    if (/\.(pdf|jpe?g|png|heic|webp)$/i.test(last)) return last;
  } catch { /* not a URL */ }
  return fallback;
}

const looksLikeFile = (url) => /^(file|content):/i.test(url || '');

/**
 * Calls handler({ url, name }) for files opened with the app: at launch and
 * while running. iOS: "Open in" / share sheet (document types in Info.plist).
 * Android: VIEW and SEND intents (MainActivity turns SEND into VIEW).
 */
export async function onIncomingFile(handler) {
  const App = plugin('App');
  if (!App) return;
  App.addListener('appUrlOpen', ({ url }) => { if (looksLikeFile(url)) handler({ url, name: nameFromUrl(url) }); });
  try {
    const launch = await App.getLaunchUrl();
    if (launch?.url && looksLikeFile(launch.url)) handler({ url: launch.url, name: nameFromUrl(launch.url) });
  } catch { /* no launch URL */ }
}

// ---------- camera / document scanner ----------

/**
 * Scans paper pages. Returns an array of image Blobs in page order, or [] if cancelled.
 * Android: Google's ML Kit document scanner (edge detection, crop, multi-page).
 * iOS: VisionKit's document camera (DocScanner plugin in the app target).
 * Fallback: one photo per call from the camera plugin, or null when no camera
 * is available so the caller can fall back to a file input with capture.
 */
export async function scanPages() {
  const ML = plugin('DocumentScanner');
  if (ML && platform === 'android') {
    try {
      const avail = await ML.isGoogleDocumentScannerModuleAvailable();
      if (!avail.available) await ML.installGoogleDocumentScannerModule();
      const res = await ML.scanDocument({ galleryImportAllowed: true, pageLimit: 20, resultFormats: 'JPEG', scannerMode: 'FULL' });
      return Promise.all((res.scannedImages || []).map(async (u) => new Blob([await readUrl(u)], { type: 'image/jpeg' })));
    } catch (e) {
      if (/cancel/i.test(String(e?.message || e))) return [];
      console.warn('ML Kit scanner failed, using camera', e);
    }
  }
  const VK = plugin('DocScanner');
  if (VK && platform === 'ios') {
    try {
      const res = await VK.scan();
      return Promise.all((res.images || []).map(async (p) => new Blob([await readUrl(p)], { type: 'image/jpeg' })));
    } catch (e) {
      if (/cancel/i.test(String(e?.message || e))) return [];
      console.warn('VisionKit scanner failed, using camera', e);
    }
  }
  const Cam = plugin('Camera');
  if (Cam) {
    try {
      const photo = await Cam.getPhoto({ source: 'CAMERA', resultType: 'base64', quality: 90, correctOrientation: true, width: 3000 });
      return [new Blob([fromBase64(photo.base64String)], { type: `image/${photo.format || 'jpeg'}` })];
    } catch (e) {
      if (/cancel/i.test(String(e?.message || e))) return [];
      throw e;
    }
  }
  return null;
}

export async function setStatusBar(dark) {
  const SB = plugin('StatusBar');
  if (!SB) return;
  try { await SB.setStyle({ style: dark ? 'DARK' : 'LIGHT' }); } catch { /* not supported */ }
}

export async function hideSplash() {
  const S = plugin('SplashScreen');
  if (S) try { await S.hide(); } catch { /* ignore */ }
}
