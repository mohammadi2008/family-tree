import { HttpError, json, readJson } from './http.js';
import { getDb, getSetting } from './db.js';
import { requireAdmin, randomToken } from './auth.js';
import { MAX_IMPORT_BYTES, jsonBytes, cleanBackupRow, validateBackupGraph } from './backup.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const P_COLS = ['id','first_name','father_name','family_name','gender','birth_date','birth_prec','birth_cal',
  'is_deceased','death_date','death_prec','death_cal','birth_place','occupation','phone','notes',
  'father_id','mother_id','sort_order','photo_ver'];
const M_COLS = ['husband_id','wife_id','marriage_date','marriage_prec','marriage_cal','status','sort_order'];
const count = value => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) throw new HttpError(400,'عدد سجلات غير صالح.');
  return value;
};
const extract = cols => cols.map(c => `json_extract(data,'$.${c}')`).join(',');

export async function restore(context) {
  await requireAdmin(context);
  const db = getDb(context.env);
  const body = await readJson(context.request,MAX_IMPORT_BYTES+10_000);
  const now = Math.floor(Date.now()/1000);
  if (body.phase === 'begin') {
    const token = randomToken();
    const base = await getSetting(db,'data_version') || '0';
    const title = typeof body.siteTitle === 'string' ? body.siteTitle.trim().slice(0,80) : '';
    const whatsapp = typeof body.whatsappNumber === 'string' ? body.whatsappNumber : (await getSetting(db,'whatsapp_number') || '');
    if (whatsapp && !/^[1-9]\d{6,14}$/.test(whatsapp)) throw new HttpError(400,'رقم واتساب غير صالح.');
    const epoch = Date.now()*1000 + crypto.getRandomValues(new Uint16Array(1))[0]%1000;
    await db.batch([
      db.prepare('DELETE FROM import_rows WHERE token IN (SELECT token FROM import_sessions WHERE expires_at < ?1)').bind(now),
      db.prepare('DELETE FROM import_sessions WHERE expires_at < ?1').bind(now),
      db.prepare(`INSERT INTO import_sessions
        (token,base_version,site_title,whatsapp_number,persons_count,marriages_count,photos_count,photo_epoch,expires_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`)
        .bind(token,base,title || 'شجرة العائلة',whatsapp,count(body.personsCount),count(body.marriagesCount),count(body.photosCount),epoch,now+86400),
    ]);
    return json({ok:true,token,baseVersion:base});
  }
  const token = body.token;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,80}$/.test(token)) throw new HttpError(400,'معرّف استعادة غير صالح.');
  const session = await db.prepare('SELECT * FROM import_sessions WHERE token = ?1').bind(token).first();
  if (!session || session.expires_at < now) throw new HttpError(410,'انتهت عملية الاستعادة. البيانات الحالية لم تتغير.');
  if (body.phase === 'abort') {
    await db.batch([
      db.prepare('DELETE FROM import_rows WHERE token = ?1').bind(token),
      db.prepare('DELETE FROM import_sessions WHERE token = ?1').bind(token),
    ]);
    return json({ok:true});
  }
  if (session.state === 'done') {
    if (body.phase !== 'finish') throw new HttpError(409,'اكتملت الاستعادة.');
    return json({ok:true,persons:session.persons_count,marriages:session.marriages_count});
  }
  if (['persons','marriages','photos'].includes(body.phase)) {
    if (!Array.isArray(body.rows) || body.rows.length > 400 || jsonBytes(body.rows) > MAX_IMPORT_BYTES) throw new HttpError(413,'دفعة كبيرة جدًا.');
    const clean = body.rows.map(r => cleanBackupRow(body.phase,r,session.photo_epoch));
    const key = r => body.phase === 'persons' ? String(r.id) : body.phase === 'photos' ? String(r.person_id) : `${r.husband_id}:${r.wife_id}`;
    if (new Set(clean.map(key)).size !== clean.length) throw new HttpError(400,'سجلات مكررة في الدفعة.');
    if (jsonBytes(clean) > MAX_IMPORT_BYTES) throw new HttpError(413,'دفعة كبيرة جدًا.');
    const result = await db.prepare(`INSERT OR REPLACE INTO import_rows (token,kind,row_key,data)
      SELECT ?1,?2,
        CASE WHEN ?2 = 'persons' THEN CAST(json_extract(value,'$.id') AS TEXT)
             WHEN ?2 = 'photos' THEN CAST(json_extract(value,'$.person_id') AS TEXT)
             ELSE json_extract(value,'$.husband_id') || ':' || json_extract(value,'$.wife_id') END,value
      FROM json_each(?3)
      WHERE EXISTS (SELECT 1 FROM import_sessions WHERE token = ?1 AND state = 'ready')`)
      .bind(token,body.phase,JSON.stringify(clean)).run();
    if (clean.length && !result.meta.changes) throw new HttpError(409,'الاستعادة غير متاحة.');
    return json({ok:true,count:clean.length});
  }
  if (body.phase !== 'finish') throw new HttpError(400,'مرحلة استيراد غير معروفة.');
  // Freeze staging BEFORE reading/validating it. An overlapping upload must
  // not replace a validated row between validation and atomic commit.
  await db.prepare("UPDATE import_sessions SET state = 'validating' WHERE token = ?1 AND state = 'ready'").bind(token).run();
  const {results:staged} = await db.prepare("SELECT kind,data FROM import_rows WHERE token = ?1 AND kind != 'photos'").bind(token).all();
  const persons = staged.filter(r => r.kind === 'persons').map(r => JSON.parse(r.data));
  const marriages = staged.filter(r => r.kind === 'marriages').map(r => JSON.parse(r.data));
  const photos = await db.prepare("SELECT COUNT(*) AS n FROM import_rows WHERE token = ?1 AND kind = 'photos'").bind(token).first();
  if (persons.length !== session.persons_count || marriages.length !== session.marriages_count || photos.n !== session.photos_count) {
    throw new HttpError(400,'النسخة غير مكتملة. البيانات الحالية لم تتغير.');
  }
  validateBackupGraph(persons,marriages);
  const orphan = await db.prepare(`SELECT COUNT(*) AS n FROM import_rows AS photo WHERE token = ?1 AND kind = 'photos'
    AND NOT EXISTS (SELECT 1 FROM import_rows AS person WHERE person.token = photo.token AND person.kind = 'persons'
      AND person.row_key = photo.row_key)`).bind(token).first();
  if (orphan.n) throw new HttpError(400,'صورة مرتبطة بشخص غير موجود.');
  const guard = "EXISTS (SELECT 1 FROM import_sessions WHERE token = ?1 AND state = 'committing')";
  const rows = kind => `FROM import_rows WHERE token = ?1 AND kind = '${kind}' AND ${guard}`;
  const results = await db.batch([
    // Revision guard is in the SAME atomic transaction as replacement.
    db.prepare(`UPDATE import_sessions SET state = 'committing' WHERE token = ?1 AND state = 'validating'
      AND expires_at >= ?2 AND base_version = COALESCE((SELECT value FROM settings WHERE key='data_version'),'0')`).bind(token,now),
    db.prepare(`DELETE FROM marriages WHERE ${guard}`).bind(token),
    db.prepare(`DELETE FROM photos WHERE ${guard}`).bind(token),
    db.prepare(`DELETE FROM persons WHERE ${guard}`).bind(token),
    db.prepare(`INSERT INTO persons (${P_COLS.join(',')},has_photo,created_at,updated_at)
      SELECT ${extract(P_COLS)},0,COALESCE(json_extract(data,'$.created_at'),${NOW}),${NOW} ${rows('persons')}`).bind(token),
    db.prepare(`INSERT INTO marriages (${M_COLS.join(',')}) SELECT ${extract(M_COLS)} ${rows('marriages')}`).bind(token),
    db.prepare(`INSERT INTO photos (person_id,mime,data) SELECT ${extract(['person_id','mime','data'])} ${rows('photos')}`).bind(token),
    db.prepare(`UPDATE persons SET has_photo = 1 WHERE id IN (SELECT person_id FROM photos) AND ${guard}`).bind(token),
    db.prepare(`UPDATE settings SET value = (SELECT site_title FROM import_sessions WHERE token = ?1)
      WHERE key = 'site_title' AND ${guard}`).bind(token),
    db.prepare(`INSERT INTO settings (key,value)
      SELECT 'whatsapp_number',whatsapp_number FROM import_sessions WHERE token = ?1 AND state = 'committing'
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(token),
    db.prepare(`UPDATE settings SET value = CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='data_version' AND ${guard}`).bind(token),
    db.prepare(`DELETE FROM import_rows WHERE token = ?1 AND ${guard}`).bind(token),
    db.prepare("UPDATE import_sessions SET state = 'done' WHERE token = ?1 AND state = 'committing'").bind(token),
  ]);
  if (!results[0].meta.changes) {
    const latest = await db.prepare('SELECT state FROM import_sessions WHERE token = ?1').bind(token).first();
    if (latest?.state !== 'done') throw new HttpError(409,'تغيرت البيانات أثناء الاستعادة. أعد البدء؛ البيانات الحالية محفوظة.');
  }
  return json({ok:true,persons:session.persons_count,marriages:session.marriages_count,fixedCycles:0});
}
