/**
 * GET /api/photo/:id?v=N — public. Serves a person's photo from D1.
 * Responses are deliberately not cached; new URLs bypass historical edge keys.
 */
import { HttpError, parseId } from '../../../src/server/http.js';
import { getDb } from '../../../src/server/db.js';
import { b64ToBytes } from '../../../src/server/auth.js';

export async function onRequestGet(context) {
  const id = parseId(context.params.id);
  // Do not serve or populate old edge cache entries: photos are sensitive.
  const db = getDb(context.env);
  const row = await db.prepare('SELECT mime, data FROM photos WHERE person_id = ?1').bind(id).first();
  if (!row) throw new HttpError(404, 'لا توجد صورة.');
  const bytes = b64ToBytes(row.data);
  const response = new Response(bytes, {
    headers: {
      'Content-Type': row.mime === 'image/jpeg' ? 'image/jpeg' : 'image/webp',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
  return response;
}
