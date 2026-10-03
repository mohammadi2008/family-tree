/**
 * POST /api/persons — admin only. Creates a person and links it:
 *   link.type = 'root'   : first person of an empty tree
 *   link.type = 'child'  : { parentId, otherParentId? }
 *   link.type = 'spouse' : { personId, marriage: { date, status } }
 *   link.type = 'parent' : { childId, marryOther?: boolean }
 * Everything runs in ONE D1 batch (atomic transaction).
 */
import { HttpError, json, readJson, parseId } from '../../../src/server/http.js';
import { getDb, loadLiteGraph, requirePerson, bumpVersionStmt } from '../../../src/server/db.js';
import { requireAdmin } from '../../../src/server/auth.js';
import { validatePerson, validateMarriage, assertMarriageAfterBirth } from '../../../src/server/validate.js';
import { parsePhotoDataUrl } from '../../../src/server/photo.js';
import { loadBirths, assertParentOlder } from '../../../src/server/relations.js';

const NEW_ID = 'last_insert_rowid()';

export async function onRequestPost(context) {
  await requireAdmin(context);
  const db = getDb(context.env);
  const body = await readJson(context.request, 400_000);
  const v = validatePerson(body.person);
  const photo = body.photo ? parsePhotoDataUrl(body.photo) : null;
  const link = body.link && typeof body.link === 'object' ? body.link : { type: 'root' };
  const lite = await loadLiteGraph(db);
  const newRow = { first_name: v.first_name, birth_date: v.birth_date, birth_prec: v.birth_prec, birth_cal: v.birth_cal };

  let fatherId = null, motherId = null;
  const tail = []; // statements that run after the INSERT (may reference last_insert_rowid())

  switch (link.type) {
    case 'root': {
      if (lite.persons.size > 0) throw new HttpError(409, 'الشجرة تحتوي على أشخاص بالفعل. أضف الأشخاص الجدد عبر أقاربهم.');
      break;
    }
    case 'child': {
      const parent = requirePerson(lite, parseId(link.parentId), 'الوالد');
      let other = null;
      if (link.otherParentId != null && link.otherParentId !== '') {
        other = requirePerson(lite, parseId(link.otherParentId), 'الوالد الآخر');
        if (other.gender === parent.gender) throw new HttpError(400, 'يجب أن يكون الوالدان من جنسين مختلفين.');
        const married = lite.spouses.get(parent.id)?.has(other.id);
        const coParents = [...lite.persons.values()].some((p) =>
          (p.father_id === parent.id && p.mother_id === other.id) || (p.mother_id === parent.id && p.father_id === other.id));
        if (!married && !coParents) throw new HttpError(400, 'الوالد الآخر يجب أن يكون زوجًا أو زوجة لهذا الشخص.');
      }
      fatherId = parent.gender === 'm' ? parent.id : other ? other.id : null;
      motherId = parent.gender === 'f' ? parent.id : other ? other.id : null;
      const births = await loadBirths(db, [fatherId, motherId]);
      for (const pid of [fatherId, motherId]) if (pid) assertParentOlder(births.get(pid), newRow);
      break;
    }
    case 'spouse': {
      const target = requirePerson(lite, parseId(link.personId));
      if (target.gender === v.gender) throw new HttpError(400, 'يجب أن يكون الزوجان من جنسين مختلفين.');
      const m = validateMarriage(link.marriage);
      const births = await loadBirths(db, [target.id]);
      assertMarriageAfterBirth(m, births.get(target.id), v);
      const husband = v.gender === 'm' ? NEW_ID : '?1';
      const wife = v.gender === 'f' ? NEW_ID : '?1';
      tail.push(db.prepare(
        `INSERT INTO marriages (husband_id, wife_id, marriage_date, marriage_prec, marriage_cal, status, sort_order)
         VALUES (${husband}, ${wife}, ?2, ?3, ?4, ?5, ?6)`
      ).bind(target.id, m.marriage_date, m.marriage_prec, m.marriage_cal, m.status, m.sort_order));
      break;
    }
    case 'parent': {
      const child = requirePerson(lite, parseId(link.childId), 'الابن/الابنة');
      const slot = v.gender === 'm' ? 'father_id' : 'mother_id';
      if (child[slot] != null && lite.persons.has(child[slot])) {
        throw new HttpError(409, v.gender === 'm' ? 'لهذا الشخص أب مسجل بالفعل.' : 'لهذا الشخص أم مسجلة بالفعل.');
      }
      const births = await loadBirths(db, [child.id]);
      assertParentOlder(newRow, births.get(child.id));
      tail.push(db.prepare(`UPDATE persons SET ${slot} = ${NEW_ID}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1`).bind(child.id));
      const otherId = v.gender === 'm' ? child.mother_id : child.father_id;
      if (otherId != null && lite.persons.has(otherId) && link.marryOther !== false) {
        const husband = v.gender === 'm' ? NEW_ID : '?1';
        const wife = v.gender === 'f' ? NEW_ID : '?1';
        tail.push(db.prepare(`INSERT OR IGNORE INTO marriages (husband_id, wife_id, status) VALUES (${husband}, ${wife}, 'married')`).bind(otherId));
      }
      break;
    }
    default:
      throw new HttpError(400, 'نوع الربط غير معروف.');
  }

  const insert = db.prepare(
    `INSERT INTO persons (first_name, father_name, family_name, gender,
       birth_date, birth_prec, birth_cal, is_deceased, death_date, death_prec, death_cal,
       birth_place, occupation, phone, notes, father_id, mother_id, has_photo, photo_ver)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`
  ).bind(v.first_name, v.father_name, v.family_name, v.gender,
    v.birth_date, v.birth_prec, v.birth_cal, v.is_deceased, v.death_date, v.death_prec, v.death_cal,
    v.birth_place, v.occupation, v.phone, v.notes, fatherId, motherId, photo ? 1 : 0, photo ? 1 : 0);

  const stmts = [insert];
  // photos.person_id is the rowid, so last_insert_rowid() stays equal to the new person id.
  if (photo) stmts.push(db.prepare(`INSERT OR REPLACE INTO photos (person_id, mime, data) VALUES (${NEW_ID}, ?1, ?2)`).bind(photo.mime, photo.data));
  stmts.push(...tail, bumpVersionStmt(db));

  const results = await db.batch(stmts);
  const id = results[0].meta.last_row_id;
  return json({ ok: true, id }, { status: 201 });
}
