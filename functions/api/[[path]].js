/** Fallback for unknown API routes. */
import { json } from '../../src/server/http.js';

export function onRequest() {
  return json({ error: 'المسار المطلوب غير موجود.' }, { status: 404 });
}
