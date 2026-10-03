/**
 * ratelimit.js — fixed-window limiter stored in D1 (free, no extra services).
 * Used for login and password-change attempts.
 */
import { HttpError } from './http.js';

const WINDOW_SEC = 15 * 60;
const MAX_FAILURES = 5;

export function clientKey(request, prefix) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'local';
  return `${prefix}:${ip.split(',')[0].trim()}`.slice(0, 100);
}

/** Throws 429 when the key exceeded the allowed failures in the window. */
export async function assertNotLimited(db, key) {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare('DELETE FROM login_attempts WHERE window_start < ?1').bind(now - WINDOW_SEC).run();
  const row = await db.prepare('SELECT count, window_start FROM login_attempts WHERE ip = ?1').bind(key).first();
  if (row && row.count >= MAX_FAILURES) {
    const retryAfter = Math.max(1, row.window_start + WINDOW_SEC - now);
    throw new HttpError(429, `محاولات كثيرة غير ناجحة. حاول مجددًا بعد ${Math.ceil(retryAfter / 60)} دقيقة.`, { retryAfter });
  }
}

export async function recordFailure(db, key) {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    'INSERT INTO login_attempts (ip, count, window_start) VALUES (?1, 1, ?2) ' +
    'ON CONFLICT(ip) DO UPDATE SET count = count + 1'
  ).bind(key, now).run();
}

export async function clearFailures(db, key) {
  await db.prepare('DELETE FROM login_attempts WHERE ip = ?1').bind(key).run();
}
