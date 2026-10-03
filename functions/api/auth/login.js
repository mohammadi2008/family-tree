/** POST /api/auth/login  { password } — rate limited (5 failures / 15 min / IP). */
import { HttpError, json, readJson } from '../../../src/server/http.js';
import { getDb, getSetting } from '../../../src/server/db.js';
import { checkAdminPassword, createSessionCookie } from '../../../src/server/auth.js';
import { assertNotLimited, clearFailures, clientKey, recordFailure } from '../../../src/server/ratelimit.js';

export async function onRequestPost(context) {
  const db = getDb(context.env);
  const key = clientKey(context.request, 'login');
  await assertNotLimited(db, key);
  const body = await readJson(context.request, 4096);
  // Bind the issued cookie to the password version being checked. A concurrent
  // password reset cannot upgrade a login with the old password to a new session.
  const pv = (await getSetting(db, 'password_ver')) || '0';
  const ok = await checkAdminPassword(context.env, db, body.password);
  if (!ok) {
    await recordFailure(db, key);
    throw new HttpError(401, 'كلمة المرور غير صحيحة.');
  }
  await clearFailures(db, key);
  return json({ ok: true, isAdmin: true }, { headers: { 'Set-Cookie': await createSessionCookie(context, pv) } });
}
