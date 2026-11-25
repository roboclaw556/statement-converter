// Thin wrappers over the D1 binding so routes read cleanly.
export const one = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
export const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results || [];
export const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
export const isoIn = (seconds) => new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const period = (d = new Date()) => d.toISOString().slice(0, 7);

/** Counts events in a bucket over a window, and records one. Returns false when over the limit. */
export async function rateLimit(env, bucket, max, windowSeconds) {
  const since = isoIn(-windowSeconds);
  const row = await one(env, 'SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND created_at > ?', bucket, since);
  if (row && row.n >= max) return false;
  await run(env, 'INSERT INTO rate_events (bucket) VALUES (?)', bucket);
  return true;
}
