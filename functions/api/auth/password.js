/**
 * POST /api/auth/password  { current, next } — admin only.
 * Stores a PBKDF2 hash in D1 and bumps the password version, which
 * invalidates every other session. A fresh cookie is issued to the caller.
 */
import { HttpError, json, readJson } from '../../../src/server/http.js';
import { getDb, getSetting } from '../../../src/server/db.js';
import { checkAdminPassword, createSessionCookie, hashPassword, requireAdmin } from '../../../src/server/auth.js';
import { assertNotLimited, clearFailures, clientKey, recordFailure } from '../../../src/server/ratelimit.js';

export async function onRequestPost(context) {
  await requireAdmin(context);
  const db = getDb(context.env);
  const key = clientKey(context.request, 'pw');
  await assertNotLimited(db, key);
  const body = await readJson(context.request, 4096);
  const previousVersion = (await getSetting(db, 'password_ver')) || '0';
  const next = typeof body.next === 'string' ? body.next : '';
  if (next.length < 8) throw new HttpError(400, 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف.');
  if (next.length > 128) throw new HttpError(400, 'كلمة المرور الجديدة طويلة جدًا.');
  if (!(await checkAdminPassword(context.env, db, body.current))) {
    await recordFailure(db, key);
    throw new HttpError(401, 'كلمة المرور الحالية غير صحيحة.');
  }
  await clearFailures(db, key);
  const hash = await hashPassword(next, context.env);
  const pv = String(Number(previousVersion) + 1);
  // Compare-and-set in the same transaction as the hash update. If another
  // reset wins, neither the password nor the version may be overwritten.
  const results = await db.batch([
    db.prepare("INSERT INTO settings(key,value) SELECT 'password_hash',?1 " +
      "WHERE COALESCE((SELECT value FROM settings WHERE key='password_ver'),'0')=?2 " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(hash,previousVersion),
    db.prepare("INSERT INTO settings(key,value) SELECT 'password_ver',?1 " +
      "WHERE COALESCE((SELECT value FROM settings WHERE key='password_ver'),'0')=?2 " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(pv,previousVersion),
  ]);
  if (!results[0].meta.changes) throw new HttpError(409, 'تغيرت كلمة المرور أثناء الحفظ. سجّل الدخول مجددًا.');
  return json({ ok: true }, { headers: { 'Set-Cookie': await createSessionCookie(context, pv) } });
}
