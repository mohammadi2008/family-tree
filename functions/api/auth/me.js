/** GET /api/auth/me — tells the client whether the current visitor is the admin. */
import { json } from '../../../src/server/http.js';
import { isAdmin } from '../../../src/server/auth.js';

export async function onRequestGet(context) {
  return json({ isAdmin: await isAdmin(context) });
}
