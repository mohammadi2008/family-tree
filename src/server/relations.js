/**
 * relations.js — chronology checks between relatives (parents born before children).
 */
import { HttpError } from './http.js';
import { recordRange } from '../../public/js/calendar.js';

const rangeOf = (row) => row && row.birth_date
  ? recordRange({ date: row.birth_date, prec: row.birth_prec || 'd', cal: row.birth_cal || 'g' })
  : null;

/** Loads birth columns for the given ids. */
export async function loadBirths(db, ids) {
  const list = [...new Set(ids.filter((x) => x != null))];
  if (!list.length) return new Map();
  const { results } = await db.prepare(
    'SELECT id, first_name, birth_date, birth_prec, birth_cal, is_deceased, death_date, death_prec, death_cal FROM persons WHERE id IN (SELECT value FROM json_each(?1))'
  ).bind(JSON.stringify(list)).all();
  return new Map(results.map((r) => [r.id, r]));
}

/** child must not be born before a parent was born. */
export function assertParentOlder(parentRow, childRow) {
  const p = rangeOf(parentRow), c = rangeOf(childRow);
  if (p && c && c[1] <= p[0]) {
    throw new HttpError(400, `تاريخ ميلاد الابن/الابنة يجب أن يكون بعد ميلاد الوالد (${parentRow.first_name}).`);
  }
}
