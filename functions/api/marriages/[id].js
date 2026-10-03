/**
 * PUT    /api/marriages/:id { marriage } — edit date / status / order (admin)
 * DELETE /api/marriages/:id              — remove the marriage link (admin). Children keep both parents.
 */
import { HttpError, json, readJson, parseId } from '../../../src/server/http.js';
import { getDb, bumpVersionStmt } from '../../../src/server/db.js';
import { requireAdmin } from '../../../src/server/auth.js';
import { validateMarriage, assertMarriageAfterBirth } from '../../../src/server/validate.js';
import { loadBirths } from '../../../src/server/relations.js';

export async function onRequestPut(context) {
  await requireAdmin(context);
  const id = parseId(context.params.id);
  const db = getDb(context.env);
  const body = await readJson(context.request, 8192);
  const row = await db.prepare('SELECT id, husband_id, wife_id FROM marriages WHERE id = ?1').bind(id).first();
  if (!row) throw new HttpError(404, 'الزواج غير موجود.');
  const m = validateMarriage(body.marriage);
  const births = await loadBirths(db, [row.husband_id, row.wife_id]);
  assertMarriageAfterBirth(m, births.get(row.husband_id), births.get(row.wife_id));
  await db.batch([
    db.prepare('UPDATE marriages SET marriage_date = ?2, marriage_prec = ?3, marriage_cal = ?4, status = ?5, sort_order = ?6 WHERE id = ?1')
      .bind(id, m.marriage_date, m.marriage_prec, m.marriage_cal, m.status, m.sort_order),
    bumpVersionStmt(db),
  ]);
  return json({ ok: true });
}

export async function onRequestDelete(context) {
  await requireAdmin(context);
  const id = parseId(context.params.id);
  const db = getDb(context.env);
  const res = await db.batch([db.prepare('DELETE FROM marriages WHERE id = ?1').bind(id), bumpVersionStmt(db)]);
  if (!res[0].meta.changes) throw new HttpError(404, 'الزواج غير موجود.');
  return json({ ok: true });
}
