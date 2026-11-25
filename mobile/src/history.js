// Recently converted statements, kept on the device only (no PDFs, just the
// checked transactions), so a bookkeeper can export again without re-scanning.
import { store } from './platform.js';

const KEY = 'history.v1';
const MAX = 40;

export async function list() {
  const items = await store.get(KEY, []);
  return Array.isArray(items) ? items : [];
}

export async function save(entry) {
  if (!(await enabled())) return;
  const items = (await list()).filter((x) => x.id !== entry.id);
  items.unshift(entry);
  await store.set(KEY, items.slice(0, MAX));
}

export async function remove(id) {
  await store.set(KEY, (await list()).filter((x) => x.id !== id));
}

export async function clear() {
  await store.set(KEY, []);
}

export async function enabled() {
  return (await store.get('settings.keepHistory', true)) !== false;
}

export async function setEnabled(on) {
  await store.set('settings.keepHistory', !!on);
  if (!on) await clear();
}
