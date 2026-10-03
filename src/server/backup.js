import { HttpError, parseId } from './http.js';
import { validatePerson, validateMarriage, assertMarriageAfterBirth } from './validate.js';
import { validatePhoto } from './photo.js';
import { recordFromColumns } from '../../public/js/calendar.js';
import { assertParentOlder } from './relations.js';
import { assertCanMarry } from './db.js';

export const MAX_IMPORT_BYTES = 1_500_000;
export const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function cleanBackupRow(kind, r, photoEpoch) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, 'سجل غير صالح.');
  if (kind === 'persons') {
    const id = parseId(r.id);
    const v = validatePerson({ ...r,
      birth: recordFromColumns(r.birth_date,r.birth_prec,r.birth_cal),
      death: recordFromColumns(r.death_date,r.death_prec,r.death_cal),
    });
    return { id,...v,
      father_id: r.father_id == null ? null : parseId(r.father_id),
      mother_id: r.mother_id == null ? null : parseId(r.mother_id),
      sort_order: Number.isInteger(r.sort_order) ? r.sort_order : 0,
      photo_ver: photoEpoch,
      created_at: typeof r.created_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(r.created_at) ? r.created_at : null,
    };
  }
  if (kind === 'marriages') return {
    husband_id:parseId(r.husband_id),wife_id:parseId(r.wife_id),
    ...validateMarriage({date:recordFromColumns(r.marriage_date,r.marriage_prec,r.marriage_cal),status:r.status,sort_order:r.sort_order}),
  };
  if (kind === 'photos') {
    if (!['image/webp','image/jpeg'].includes(r.mime) || typeof r.data !== 'string') throw new HttpError(400,'بيانات صورة غير صالحة.');
    return {person_id:parseId(r.person_id),...validatePhoto(r.mime,r.data)};
  }
  throw new HttpError(400,'مرحلة استيراد غير معروفة.');
}

export function validateBackupGraph(persons, marriages) {
  const byId = new Map(persons.map(p => [p.id,p]));
  if (byId.size !== persons.length) throw new HttpError(400,'معرّفات أشخاص مكررة.');
  const lite = {persons:byId,spouses:new Map()};
  for (const p of persons) for (const [slot,gender] of [['father_id','m'],['mother_id','f']]) {
    if (p[slot] == null) continue;
    const parent = byId.get(p[slot]);
    if (!parent || parent.gender !== gender || parent.id === p.id) throw new HttpError(400,'رابط والد غير صالح.');
    assertParentOlder(parent,p);
  }
  const state = new Map();
  for (const p of persons) {
    if (state.get(p.id) === 2) continue;
    const stack = [[p.id,false]];
    while (stack.length) {
      const [id,exit] = stack.pop();
      if (exit) { state.set(id,2); continue; }
      if (state.get(id) === 1) throw new HttpError(400,'دورة في روابط النسب.');
      if (state.get(id) === 2) continue;
      state.set(id,1); stack.push([id,true]);
      const row = byId.get(id);
      for (const parent of [row.father_id,row.mother_id]) if (parent != null) stack.push([parent,false]);
    }
  }
  for (const m of marriages) {
    const {husband,wife} = assertCanMarry(lite,m.husband_id,m.wife_id);
    if (husband.id !== m.husband_id || wife.id !== m.wife_id) throw new HttpError(400,'جنس الزوجين غير متوافق.');
    assertMarriageAfterBirth(m,husband,wife);
    for (const [a,b] of [[husband.id,wife.id],[wife.id,husband.id]]) {
      if (!lite.spouses.has(a)) lite.spouses.set(a,new Set());
      lite.spouses.get(a).add(b);
    }
  }
  return byId;
}

export function* byteChunks(rows,maxBytes = MAX_IMPORT_BYTES,maxRows = 400) {
  let batch = [], bytes = 2;
  for (const row of rows) {
    const size = jsonBytes(row);
    if (size+2 > maxBytes) throw new Error('سجل أكبر من الحد المسموح.');
    if (batch.length && (bytes+1+size > maxBytes || batch.length >= maxRows)) {
      yield batch; batch=[]; bytes=2;
    }
    bytes += size+(batch.length ? 1 : 0); batch.push(row);
  }
  if (batch.length) yield batch;
}
