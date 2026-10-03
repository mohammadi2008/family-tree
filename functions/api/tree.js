/**
 * GET /api/tree — public. Returns all persons (without photo bytes) and marriages.
 * Phone numbers are only included for the admin (privacy).
 * Uses an ETag based on the data version so repeat visits are cheap.
 */
import { json } from '../../src/server/http.js';
import { getDb, PERSON_COLUMNS, MARRIAGE_COLUMNS } from '../../src/server/db.js';
import { isAdmin } from '../../src/server/auth.js';

export async function onRequestGet(context) {
  const db = getDb(context.env);
  const admin = await isAdmin(context);
  // Data and the revision/settings that describe it share one D1 snapshot.
  const [p, m, t] = await db.batch([
    db.prepare(`SELECT ${PERSON_COLUMNS.join(', ')} FROM persons ORDER BY id`),
    db.prepare(`SELECT ${MARRIAGE_COLUMNS.join(', ')} FROM marriages ORDER BY id`),
    db.prepare("SELECT key,value FROM settings WHERE key IN ('site_title','whatsapp_number','data_version')"),
  ]);
  const config = Object.fromEntries(t.results.map(r => [r.key,r.value]));
  const version = config.data_version || '0';
  const etag = `W/"v${version}-${admin ? 'a' : 'p'}"`;
  const cacheHeaders = { ETag: etag, 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

  if (context.request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }

  const persons = admin ? p.results : p.results.map((r) => ({ ...r, phone: '' }));
  // Notes are private to the admin, just like phone numbers.
  if (!admin) for (const p of persons) p.notes = '';
  return json({
    version: Number(version),
    isAdmin: admin,
    siteTitle: config.site_title || 'شجرة العائلة',
    whatsappNumber: config.whatsapp_number || '',
    persons,
    marriages: m.results,
  }, { headers: cacheHeaders });
}
