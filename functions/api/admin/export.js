/**
 * GET /api/admin/export?part=data             — persons, marriages, settings (admin)
 * GET /api/admin/export?part=photos&after=ID  — photos page by page (keyset pagination)
 * The browser stitches the parts into one JSON backup file, so the Worker never
 * has to hold every photo in memory at once.
 */
import { HttpError, json, parseId } from '../../../src/server/http.js';
import { getDb, getSetting, PERSON_COLUMNS, MARRIAGE_COLUMNS } from '../../../src/server/db.js';
import { requireAdmin } from '../../../src/server/auth.js';

const PHOTO_PAGE = 40;

export async function onRequestGet(context) {
  await requireAdmin(context);
  const db = getDb(context.env);
  const url = new URL(context.request.url);
  const part = url.searchParams.get('part') || 'data';

  if (part === 'data') {
    const version = (await getSetting(db,'data_version')) || '0';
    const [p, m, c, settings] = await db.batch([
      db.prepare(`SELECT ${PERSON_COLUMNS.join(', ')} FROM persons ORDER BY id`),
      db.prepare(`SELECT ${MARRIAGE_COLUMNS.join(', ')} FROM marriages ORDER BY id`),
      db.prepare('SELECT COUNT(*) AS n FROM photos'),
      db.prepare("SELECT key,value FROM settings WHERE key IN ('site_title','whatsapp_number')"),
    ]);
    if (version !== (await getSetting(db,'data_version'))) throw new HttpError(409,'تغيرت البيانات أثناء التصدير. أعد المحاولة.');
    const config = Object.fromEntries(settings.results.map(r => [r.key,r.value]));
    return json({
      app: 'family-tree', format: 1,
      exportedAt: new Date().toISOString(),
      version,
      whatsappNumber: config.whatsapp_number || '',
      siteTitle: config.site_title || 'شجرة العائلة',
      persons: p.results, marriages: m.results, photoCount: c.results[0].n,
    });
  }

  if (part === 'photos') {
    const expected = url.searchParams.get('version');
    if (!expected || expected !== (await getSetting(db,'data_version'))) throw new HttpError(409,'تغيرت البيانات أثناء التصدير. أعد المحاولة.');
    const cursor = url.searchParams.get('after');
    const after = cursor == null || cursor === '0' ? 0 : parseId(cursor, 'مؤشر الصور');
    const { results } = await db.prepare(
      'SELECT person_id, mime, data FROM photos WHERE person_id > ?1 ORDER BY person_id LIMIT ?2'
    ).bind(after, PHOTO_PAGE).all();
    const next = results.length === PHOTO_PAGE ? results[results.length - 1].person_id : null;
    if (expected !== (await getSetting(db,'data_version'))) throw new HttpError(409,'تغيرت البيانات أثناء التصدير. أعد المحاولة.');
    return json({ photos: results, next });
  }

  throw new HttpError(400, 'جزء غير معروف.');
}
