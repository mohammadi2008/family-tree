/** POST /api/auth/logout — clears the session cookie. */
import { json } from '../../../src/server/http.js';
import { clearSessionCookie } from '../../../src/server/auth.js';

export async function onRequestPost(context) {
  return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie(context.request) } });
}
