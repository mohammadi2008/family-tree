/**
 * db.js — D1 data-access helpers.
 * All SQL uses bound parameters (never string concatenation of user input).
 */
import { HttpError } from './http.js';

/** Columns returned to the client for each person (photo data excluded). */
export const PERSON_COLUMNS = [
  'id', 'first_name', 'father_name', 'family_name', 'gender',
  'birth_date', 'birth_prec', 'birth_cal',
  'is_deceased', 'death_date', 'death_prec', 'death_cal',
  'birth_place', 'occupation', 'phone', 'notes',
  'father_id', 'mother_id', 'sort_order', 'has_photo', 'photo_ver',
  'created_at', 'updated_at',
];
export const MARRIAGE_COLUMNS = [
  'id', 'husband_id', 'wife_id', 'marriage_date', 'marriage_prec', 'marriage_cal',
  'status', 'sort_order',
];

export function getDb(env) {
  if (!env || !env.DB) throw new HttpError(500, 'قاعدة البيانات غير مربوطة. راجع إعداد الربط DB في Cloudflare.');
  return env.DB;
}

export async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?1').bind(key).first();
  return row ? row.value : null;
}

export function setSettingStmt(db, key, value) {
  return db.prepare(
    'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, String(value));
}

/** Statement that increments the data version (used for ETag caching). Must be LAST in a batch. */
export function bumpVersionStmt(db) {
  return db.prepare(
    "INSERT INTO settings (key, value) VALUES ('data_version', '1') " +
    'ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)'
  );
}

/**
 * Lightweight graph of the whole family (ids, genders, parents, marriages).
 * Used for relationship validation; cheap even for thousands of rows.
 */
export async function loadLiteGraph(db) {
  const [p, m] = await db.batch([
    db.prepare('SELECT id, gender, father_id, mother_id, first_name FROM persons'),
    db.prepare('SELECT id, husband_id, wife_id FROM marriages'),
  ]);
  const persons = new Map();
  for (const r of p.results) persons.set(r.id, r);
  const children = new Map();
  for (const r of p.results) {
    for (const pid of [r.father_id, r.mother_id]) {
      if (pid == null) continue;
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid).push(r.id);
    }
  }
  const marriages = m.results;
  const spouses = new Map();
  for (const r of marriages) {
    if (!spouses.has(r.husband_id)) spouses.set(r.husband_id, new Set());
    if (!spouses.has(r.wife_id)) spouses.set(r.wife_id, new Set());
    spouses.get(r.husband_id).add(r.wife_id);
    spouses.get(r.wife_id).add(r.husband_id);
  }
  return { persons, children, marriages, spouses };
}

/** All descendants of `id` (not including id). */
export function descendantsOf(lite, id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of lite.children.get(cur) || []) {
      if (!out.has(c) && c !== id) { out.add(c); stack.push(c); }
    }
  }
  return out;
}

/** All ancestors of `id`. */
export function ancestorsOf(lite, id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const p = lite.persons.get(stack.pop());
    if (!p) continue;
    for (const pid of [p.father_id, p.mother_id]) {
      if (pid != null && !out.has(pid)) { out.add(pid); stack.push(pid); }
    }
  }
  return out;
}

export function requirePerson(lite, id, label = 'الشخص') {
  const p = lite.persons.get(id);
  if (!p) throw new HttpError(404, `${label} غير موجود.`);
  return p;
}

/**
 * Validates that two persons may be married to each other.
 * Cousin marriages are allowed; direct-line and sibling marriages are not.
 */
export function assertCanMarry(lite, aId, bId) {
  const a = requirePerson(lite, aId), b = requirePerson(lite, bId);
  if (aId === bId) throw new HttpError(400, 'لا يمكن ربط الشخص بنفسه.');
  if (a.gender === b.gender) throw new HttpError(400, 'يجب أن يكون الزوجان من جنسين مختلفين.');
  if (lite.spouses.get(aId)?.has(bId)) throw new HttpError(409, 'هذان الشخصان مرتبطان بالفعل.');
  if (ancestorsOf(lite, aId).has(bId) || ancestorsOf(lite, bId).has(aId)) {
    throw new HttpError(400, 'لا يمكن الزواج بين الأصول والفروع.');
  }
  const ap = [a.father_id, a.mother_id].filter((x) => x != null);
  const bp = [b.father_id, b.mother_id].filter((x) => x != null);
  if (ap.some((x) => bp.includes(x))) throw new HttpError(400, 'لا يمكن الزواج بين الإخوة.');
  return { husband: a.gender === 'm' ? a : b, wife: a.gender === 'm' ? b : a };
}
