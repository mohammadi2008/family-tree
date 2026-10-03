import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as restore } from '../functions/api/admin/import.js';
import { onRequestPut as updatePerson } from '../functions/api/persons/[id].js';
import { onRequestGet as tree } from '../functions/api/tree.js';
import { onRequestGet as photo } from '../functions/api/photo/[id].js';
import { onRequestGet as exportData } from '../functions/api/admin/export.js';
import { sqlite,context,sample } from './helpers.mjs';
import { idempotentCreate } from '../src/server/idempotency.js';
import { onRequest as middleware } from '../functions/api/_middleware.js';
import { onRequestPost as createPerson } from '../functions/api/persons/index.js';
import { onRequestDelete as deletePerson } from '../functions/api/persons/[id].js';
import { onRequestPut as saveSettings } from '../functions/api/admin/settings.js';

const call=async(db,body)=> (await restore(context(db,body))).json();
const version=async db=>(await db.prepare("SELECT value FROM settings WHERE key='data_version'").first()).value;
const names=async db=>(await db.prepare('SELECT id,first_name FROM persons ORDER BY id').all()).results;
async function upload(db,backup=sample) {
  const {token}=await call(db,{phase:'begin',siteTitle:backup.siteTitle,personsCount:backup.persons.length,marriagesCount:backup.marriages.length,photosCount:(backup.photos || []).length});
  await call(db,{phase:'persons',token,rows:backup.persons});
  await call(db,{phase:'marriages',token,rows:backup.marriages});
  if (backup.photos?.length) await call(db,{phase:'photos',token,rows:backup.photos});
  return token;
}

test('begin, invalid upload and incomplete finish NEVER delete live data',async()=>{
  const db=sqlite();
  try {
    const before=await names(db), v=await version(db);
    const {token}=await call(db,{phase:'begin',personsCount:1,marriagesCount:0,photosCount:0});
    assert.deepEqual(await names(db),before);
    await assert.rejects(call(db,{phase:'persons',token,rows:[{id:1,gender:'m',first_name:''}]}),e=>e.status===400);
    await assert.rejects(call(db,{phase:'finish',token}),e=>e.status===400);
    assert.deepEqual(await names(db),before);
    assert.equal(await version(db),v);
    await call(db,{phase:'abort',token});
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM import_rows').first()).n,0);
  } finally {db.close();}
});
test('successful atomic restore, photo flags, new epoch, version, idempotent finish',async()=>{
  const db=sqlite();
  try {
    const fakeJpeg=Buffer.from([255,216,255,217]).toString('base64');
    const backup={...sample,photos:[{person_id:sample.persons[0].id,mime:'image/jpeg',data:fakeJpeg}]};
    const before=await version(db), token=await upload(db,backup);
    // Live data remains available until finish.
    assert.equal((await names(db)).length,20);
    const result=await call(db,{phase:'finish',token});
    assert.equal(result.persons,20);assert.equal(result.marriages,8);
    assert.equal(Number(await version(db)),Number(before)+1);
    const p=await db.prepare('SELECT has_photo,photo_ver FROM persons WHERE id=?1').bind(sample.persons[0].id).first();
    assert.equal(p.has_photo,1);assert.ok(p.photo_ver>1e12);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM import_rows').first()).n,0);
    await call(db,{phase:'finish',token});
    assert.equal(Number(await version(db)),Number(before)+1);
  } finally {db.close();}
});
test('concurrent live edit prevents stale restore from replacing current data',async()=>{
  const db=sqlite();
  try {
    const token=await upload(db);
    await db.batch([
      db.prepare("UPDATE persons SET first_name='Live edit' WHERE id=1"),
      db.prepare("UPDATE settings SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='data_version'"),
    ]);
    const before=await names(db);
    await assert.rejects(call(db,{phase:'finish',token}),e=>e.status===409);
    assert.deepEqual(await names(db),before);
    await assert.rejects(call(db,{phase:'persons',token,rows:[sample.persons[0]]}),e=>e.status===409);
  } finally {db.close();}
});
test('a mid-commit SQL failure rolls back deletions and preserves live data',async()=>{
  const db=sqlite();
  try {
    const token=await upload(db), before=await names(db),v=await version(db);
    db.exec("CREATE TRIGGER test_fail BEFORE INSERT ON persons BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
    await assert.rejects(call(db,{phase:'finish',token}),/injected failure/);
    assert.deepEqual(await names(db),before);assert.equal(await version(db),v);
    db.exec('DROP TRIGGER test_fail;');
    await call(db,{phase:'finish',token});
    assert.equal(Number(await version(db)),Number(v)+1);
  } finally {db.close();}
});
test('restored missing parent or impossible marriage rejects without destructive repair',async()=>{
  const db=sqlite();
  try {
    const backup={...sample,persons:sample.persons.map((p,i)=>i===0?{...p,father_id:999}:p)};
    const token=await upload(db,backup),before=await names(db);
    await assert.rejects(call(db,{phase:'finish',token}),e=>e.status===400);
    assert.deepEqual(await names(db),before);
  } finally {db.close();}
});
test('person birth edit cannot move birth after existing marriage',async()=>{
  const db=sqlite(false);
  try {
    db.exec("INSERT INTO persons(id,first_name,gender,birth_date,birth_prec,birth_cal) VALUES(1,'A','m','1970-01-01','d','g'),(2,'B','f','1970-01-01','d','g'); INSERT INTO marriages(husband_id,wife_id,marriage_date,marriage_prec,marriage_cal) VALUES(1,2,'1990-01-01','d','g');");
    await assert.rejects(updatePerson(context(db,{person:{first_name:'A',gender:'m',birth:{date:'2000-01-01',prec:'d',cal:'g'}}},{id:1,method:'PUT'})),e=>e.status===400);
    assert.equal((await db.prepare('SELECT birth_date FROM persons WHERE id=1').first()).birth_date,'1970-01-01');
  } finally {db.close();}
});
test('public tree excludes private notes/phone, admin tree includes them',async()=>{
  const db=sqlite();
  try {
    db.exec("UPDATE persons SET phone='+989123456789',notes='private' WHERE id=1;");
    const p=await (await tree(context(db,null,{method:'GET',admin:false}))).json();
    assert.equal(p.persons[0].notes,'');assert.equal(p.persons[0].phone,'');
    const a=await (await tree(context(db,null,{method:'GET'}))).json();
    assert.equal(a.persons[0].notes,'private');
  } finally {db.close();}
});
test('photos bypass legacy edge cache and use no-store',async()=>{
  const db=sqlite();
  try {
    db.exec("INSERT INTO photos(person_id,mime,data) VALUES(1,'image/jpeg','/9j/2Q==');");
    globalThis.caches={default:{match(){throw new Error('must not call cache');}}};
    const r=await photo(context(db,null,{method:'GET',id:1}));
    assert.ok(r.headers.get('Cache-Control').includes('no-store'));
    db.exec('DELETE FROM photos WHERE person_id=1;');
    await assert.rejects(photo(context(db,null,{method:'GET',id:1})),e=>e.status===404);
  } finally {delete globalThis.caches;db.close();}
});
test('photo export rejects a changed backup revision',async()=>{
  const db=sqlite();
  try {
    const head=await (await exportData(context(db,null,{method:'GET',path:'/api/admin/export?part=data'}))).json();
    db.exec("UPDATE settings SET value='999' WHERE key='data_version';");
    await assert.rejects(exportData(context(db,null,{method:'GET',path:`/api/admin/export?part=photos&version=${head.version}`})),e=>e.status===409);
  } finally {db.close();}
});
test('unauthorized restore never creates a staging session',async()=>{
  const db=sqlite();
  try {
    await assert.rejects(restore(context(db,{phase:'begin'},{admin:false})),e=>e.status===401);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM import_sessions').first()).n,0);
  } finally {db.close();}
});
test('create retry replays successful response without repeating handler',async()=>{
  const db=sqlite();
  try {
    let calls=0;
    const options={path:'/api/persons',headers:{'Idempotency-Key':'retry-key-12345678901234567890'}};
    const handler=async()=>{calls++;return new Response(JSON.stringify({ok:true,id:123}),{status:201});};
    const first=await idempotentCreate(context(db,{person:{first_name:'A'}},options),handler);
    const second=await idempotentCreate(context(db,{person:{first_name:'A'}},options),handler);
    assert.equal(first.status,201);assert.equal(second.status,201);
    assert.deepEqual(await second.json(),{ok:true,id:123});assert.equal(calls,1);
    await assert.rejects(idempotentCreate(context(db,{person:{first_name:'B'}},options),handler),e=>e.status===409);
  } finally {db.close();}
});
test('ambiguous failed create reservation prevents unsafe retry',async()=>{
  const db=sqlite();
  try {
    const options={path:'/api/persons',headers:{'Idempotency-Key':'pending-key-12345678901234567890'}};
    await assert.rejects(idempotentCreate(context(db,{},options),async()=>{throw new Error('lost result');}),/lost result/);
    await assert.rejects(idempotentCreate(context(db,{},options),async()=>new Response('{}')),e=>e.status===409);
  } finally {db.close();}
});
test('full create flow: replay, spouse with photo, child, parent, branch delete',async()=>{
  const db=sqlite(false);
  try {
    const opts={path:'/api/persons',headers:{'Idempotency-Key':'full-flow-root-123456789012345'}};
    const payload={person:{first_name:'Root',gender:'m'},link:{type:'root'}};
    const run=()=>{
      const c=context(db,payload,opts);c.next=()=>createPerson(c);
      return middleware(c);
    };
    const root=await (await run()).json();
    assert.equal(root.id,1);
    assert.equal((await (await run()).json()).id,1);
    assert.equal((await names(db)).length,1);
    const spouse=await (await createPerson(context(db,{
      person:{first_name:'Wife',gender:'f'},
      photo:'data:image/jpeg;base64,/9j/2Q==',
      link:{type:'spouse',personId:root.id},
    }))).json();
    const child=await (await createPerson(context(db,{
      person:{first_name:'Child',gender:'m'},link:{type:'child',parentId:root.id,otherParentId:spouse.id},
    }))).json();
    const dad=await (await createPerson(context(db,{
      person:{first_name:'Father',gender:'m'},link:{type:'parent',childId:root.id,marryOther:false},
    }))).json();
    assert.equal((await db.prepare('SELECT father_id FROM persons WHERE id=?1').bind(root.id).first()).father_id,dad.id);
    assert.equal((await db.prepare('SELECT father_id,mother_id FROM persons WHERE id=?1').bind(child.id).first()).mother_id,spouse.id);
    const c=context(db,null,{method:'DELETE',id:root.id,path:`/api/persons/${root.id}?mode=branch`});
    const deleted=await (await deletePerson(c)).json();
    assert.equal(deleted.deleted,3);
    assert.equal((await names(db)).length,1);
  } finally {db.close();}
});
test('middleware blocks cross-origin write and missing anti-CSRF header',async()=>{
  const db=sqlite(false);
  try {
    for(const headers of [{'Origin':'https://attacker.example'},{'X-Requested-With':'wrong'}]) {
      const c=context(db,{}, {headers});let ran=false;
      c.next=()=>{ran=true;return new Response('{}');};
      const res=await middleware(c);
      assert.equal(res.status,403);assert.equal(ran,false);
    }
  } finally {db.close();}
});
test('site settings save WhatsApp number, hide blank number and reject invalid input',async()=>{
  const db=sqlite(false);
  try {
    const saved=await (await saveSettings(context(db,{siteTitle:'Tree',whatsappNumber:'989123456789'},{method:'PUT'}))).json();
    assert.equal(saved.whatsappNumber,'989123456789');
    const p=await (await tree(context(db,null,{method:'GET',admin:false}))).json();
    assert.equal(p.whatsappNumber,'989123456789');
    await assert.rejects(saveSettings(context(db,{siteTitle:'Tree',whatsappNumber:'not-a-phone'},{method:'PUT'})),e=>e.status===400);
    await saveSettings(context(db,{siteTitle:'Tree',whatsappNumber:''},{method:'PUT'}));
    assert.equal((await db.prepare("SELECT value FROM settings WHERE key='whatsapp_number'").first()).value,'');
  } finally {db.close();}
});
