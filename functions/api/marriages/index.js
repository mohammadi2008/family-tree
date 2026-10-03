/** POST /api/marriages { aId, bId, marriage } — admin only. Links two EXISTING persons (e.g. cousins). */
import { json, readJson, parseId } from '../../../src/server/http.js';
import { getDb, loadLiteGraph, assertCanMarry, bumpVersionStmt } from '../../../src/server/db.js';
import { requireAdmin } from '../../../src/server/auth.js';
import { validateMarriage, assertMarriageAfterBirth } from '../../../src/server/validate.js';
import { loadBirths } from '../../../src/server/relations.js';

export async function onRequestPost(context) {
  await requireAdmin(context);
  const db = getDb(context.env);
  const body = await readJson(context.request, 8192);
  const aId = parseId(body.aId), bId = parseId(body.bId);
  const lite = await loadLiteGraph(db);
  const { husband, wife } = assertCanMarry(lite, aId, bId);
  const m = validateMarriage(body.marriage);
  const births = await loadBirths(db, [aId, bId]);
  assertMarriageAfterBirth(m, births.get(aId), births.get(bId));
  const res = await db.batch([
    db.prepare(`INSERT INTO marriages (husband_id, wife_id, marriage_date, marriage_prec, marriage_cal, status, sort_order)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
      .bind(husband.id, wife.id, m.marriage_date, m.marriage_prec, m.marriage_cal, m.status, m.sort_order),
    bumpVersionStmt(db),
  ]);
  return json({ ok: true, id: res[0].meta.last_row_id }, { status: 201 });
}
