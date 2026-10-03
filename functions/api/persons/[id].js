/**
 * PUT    /api/persons/:id  { person, photo?, removePhoto? } — admin only
 * DELETE /api/persons/:id?mode=single|branch               — admin only
 *   single : delete only this person; children stay (their link to this parent is cleared)
 *   branch : delete this person + all descendants + in-law spouses left without any link
 */
import { HttpError, json, readJson, parseId } from '../../../src/server/http.js';
import { getDb, loadLiteGraph, requirePerson, bumpVersionStmt, descendantsOf } from '../../../src/server/db.js';
import { requireAdmin } from '../../../src/server/auth.js';
import { validatePerson, assertMarriageAfterBirth } from '../../../src/server/validate.js';
import { parsePhotoDataUrl } from '../../../src/server/photo.js';
import { assertParentOlder } from '../../../src/server/relations.js';

export async function onRequestPut(context) {
  await requireAdmin(context);
  const id = parseId(context.params.id);
  const db = getDb(context.env);
  const body = await readJson(context.request, 400_000);
  const v = validatePerson(body.person);
  const photo = body.photo ? parsePhotoDataUrl(body.photo) : null;

  const existing = await db.prepare('SELECT id, gender, father_id, mother_id FROM persons WHERE id = ?1').bind(id).first();
  if (!existing) throw new HttpError(404, 'الشخص غير موجود.');

  const { results: related } = await db.prepare(
    `SELECT id, first_name, birth_date, birth_prec, birth_cal, father_id, mother_id FROM persons
     WHERE id IN (?2, ?3) OR father_id = ?1 OR mother_id = ?1`
  ).bind(id, existing.father_id ?? -1, existing.mother_id ?? -1).all();
  const me = { first_name: v.first_name, birth_date: v.birth_date, birth_prec: v.birth_prec, birth_cal: v.birth_cal };
  const children = related.filter((r) => r.father_id === id || r.mother_id === id);
  for (const r of related) {
    if (r.id === existing.father_id || r.id === existing.mother_id) assertParentOlder(r, me);
  }
  for (const c of children) assertParentOlder(me, c);
  const { results: marriages } = await db.prepare(
    'SELECT marriage_date, marriage_prec, marriage_cal FROM marriages WHERE husband_id = ?1 OR wife_id = ?1'
  ).bind(id).all();
  for (const marriage of marriages) assertMarriageAfterBirth(marriage, v);

  if (v.gender !== existing.gender) {
    const m = await db.prepare('SELECT COUNT(*) AS n FROM marriages WHERE husband_id = ?1 OR wife_id = ?1').bind(id).first();
    if (children.length || (m && m.n)) throw new HttpError(409, 'لا يمكن تغيير الجنس لشخص لديه أبناء أو زيجات مسجلة.');
  }

  const stmts = [db.prepare(
    `UPDATE persons SET first_name = ?2, father_name = ?3, family_name = ?4, gender = ?5,
       birth_date = ?6, birth_prec = ?7, birth_cal = ?8, is_deceased = ?9,
       death_date = ?10, death_prec = ?11, death_cal = ?12,
       birth_place = ?13, occupation = ?14, phone = ?15, notes = ?16,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE id = ?1`
  ).bind(id, v.first_name, v.father_name, v.family_name, v.gender,
    v.birth_date, v.birth_prec, v.birth_cal, v.is_deceased, v.death_date, v.death_prec, v.death_cal,
    v.birth_place, v.occupation, v.phone, v.notes)];

  if (photo) {
    stmts.push(db.prepare(`INSERT OR REPLACE INTO photos (person_id, mime, data, updated_at) VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).bind(id, photo.mime, photo.data));
    stmts.push(db.prepare('UPDATE persons SET has_photo = 1, photo_ver = photo_ver + 1 WHERE id = ?1').bind(id));
  } else if (body.removePhoto === true) {
    stmts.push(db.prepare('DELETE FROM photos WHERE person_id = ?1').bind(id));
    stmts.push(db.prepare('UPDATE persons SET has_photo = 0, photo_ver = photo_ver + 1 WHERE id = ?1').bind(id));
  }
  stmts.push(bumpVersionStmt(db));
  await db.batch(stmts);
  return json({ ok: true, id });
}

export async function onRequestDelete(context) {
  await requireAdmin(context);
  const id = parseId(context.params.id);
  const db = getDb(context.env);
  const mode = new URL(context.request.url).searchParams.get('mode') || 'single';
  if (!['single', 'branch'].includes(mode)) throw new HttpError(400, 'نوع الحذف غير صالح.');
  const lite = await loadLiteGraph(db);
  requirePerson(lite, id);

  const del = new Set([id]);
  if (mode === 'branch') {
    for (const d of descendantsOf(lite, id)) del.add(d);
    // In-law spouses (no parents in the tree) whose every marriage and child is being deleted.
    for (const pid of [...del]) {
      for (const s of lite.spouses.get(pid) || []) {
        if (del.has(s)) continue;
        const sp = lite.persons.get(s);
        if (!sp || (sp.father_id != null && lite.persons.has(sp.father_id)) || (sp.mother_id != null && lite.persons.has(sp.mother_id))) continue;
        const allSpousesGone = [...(lite.spouses.get(s) || [])].every((x) => del.has(x));
        const allKidsGone = (lite.children.get(s) || []).every((x) => del.has(x));
        if (allSpousesGone && allKidsGone) del.add(s);
      }
    }
  }

  const ids = JSON.stringify([...del]);
  const IN = '(SELECT value FROM json_each(?1))';
  await db.batch([
    db.prepare(`DELETE FROM marriages WHERE husband_id IN ${IN} OR wife_id IN ${IN}`).bind(ids),
    db.prepare(`DELETE FROM photos WHERE person_id IN ${IN}`).bind(ids),
    db.prepare(`UPDATE persons SET father_id = NULL WHERE father_id IN ${IN}`).bind(ids),
    db.prepare(`UPDATE persons SET mother_id = NULL WHERE mother_id IN ${IN}`).bind(ids),
    db.prepare(`DELETE FROM persons WHERE id IN ${IN}`).bind(ids),
    bumpVersionStmt(db),
  ]);
  return json({ ok: true, deleted: del.size });
}
