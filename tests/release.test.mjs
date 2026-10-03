import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlite, context } from './helpers.mjs';
import { assertParentOlder } from '../src/server/relations.js';
import { verifyPassword, verifySession, signSession } from '../src/server/auth.js';
import { onRequestPut as updatePerson, onRequestDelete as deletePerson } from '../functions/api/persons/[id].js';
import { onRequestPost as createMarriage } from '../functions/api/marriages/index.js';
import { onRequestGet as exportData } from '../functions/api/admin/export.js';
import { onRequestPost as changePassword } from '../functions/api/auth/password.js';
import { onRequestPost as login } from '../functions/api/auth/login.js';
import { isAdmin } from '../src/server/auth.js';

test('malformed stored password hashes fail closed without throwing', async () => {
  for (const hash of ['pbkdf2_sha256$0$@@$@@', 'pbkdf2_sha256$999999999$AAAA$AAAA',
    'pbkdf2_sha256$60000$AA==$AA==', 'pbkdf2_sha256$NaN$AA==$AA==']) {
    assert.equal(await verifyPassword('password', hash), false);
  }
});
test('a session expires at its exact expiry second', async () => {
  const secret = 's'.repeat(40);
  const token = await signSession({ sub: 'admin', exp: Math.floor(Date.now()/1000) }, secret);
  assert.equal(await verifySession(token, secret), null);
});
test('exact same-day parent and child births are rejected, overlapping partial dates allowed', () => {
  const birth = { first_name: 'P', birth_date: '2000-01-01', birth_prec: 'd', birth_cal: 'g' };
  assert.throws(() => assertParentOlder(birth, birth), e => e.status === 400);
  assert.doesNotThrow(() => assertParentOlder({...birth, birth_prec: 'y'}, {...birth, birth_date:'2000-07-01'}));
});
test('marriage cannot occur after the known death of either spouse', async () => {
  const db = sqlite(false);
  try {
    db.exec("INSERT INTO persons(id,first_name,gender,is_deceased,death_date,death_prec,death_cal) VALUES(1,'A','m',1,'2000-01-01','d','g'),(2,'B','f',0,NULL,NULL,NULL);");
    await assert.rejects(createMarriage(context(db, {aId:1,bId:2,marriage:{date:{date:'2001-01-01',prec:'d',cal:'g'}}})), e => e.status === 400);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM marriages').first()).n, 0);
  } finally { db.close(); }
});
test('editing a death date cannot invalidate an existing marriage', async () => {
  const db = sqlite(false);
  try {
    db.exec("INSERT INTO persons(id,first_name,gender) VALUES(1,'A','m'),(2,'B','f'); INSERT INTO marriages(husband_id,wife_id,marriage_date,marriage_prec,marriage_cal) VALUES(1,2,'2001-01-01','d','g');");
    await assert.rejects(updatePerson(context(db,{person:{first_name:'A',gender:'m',is_deceased:true,death:{date:'2000-01-01',prec:'d',cal:'g'}}},{method:'PUT',id:1})),e=>e.status===400);
    assert.equal((await db.prepare('SELECT is_deceased FROM persons WHERE id=1').first()).is_deceased,0);
  } finally { db.close(); }
});
test('an invalid deletion mode rejects without deleting or changing the version', async () => {
  const db = sqlite();
  try {
    await assert.rejects(deletePerson(context(db,null,{method:'DELETE',id:1,path:'/api/persons/1?mode=branxh'})),e=>e.status===400);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM persons').first()).n,20);
  } finally { db.close(); }
});
test('photo export rejects overflowing or malformed cursors instead of wrapping to zero', async () => {
  const db = sqlite();
  try {
    const head = await (await exportData(context(db,null,{method:'GET',path:'/api/admin/export?part=data'}))).json();
    for (const after of ['4294967296','1.5','bad','-1']) {
      await assert.rejects(exportData(context(db,null,{method:'GET',path:`/api/admin/export?part=photos&version=${head.version}&after=${after}`})),e=>e.status===400);
    }
  } finally { db.close(); }
});
test('password reset invalidates the previous cookie and issues a valid replacement', async () => {
  const db=sqlite(false);
  const env={DB:db,ADMIN_PASSWORD:'initial-password',SESSION_SECRET:'z'.repeat(40),PBKDF2_ITERATIONS:10000};
  try {
    const c=context(db,{password:'initial-password'},{path:'/api/auth/login',admin:false});c.env=env;
    const oldCookie=(await login(c)).headers.get('Set-Cookie').split(';')[0];
    const auth=cookie=>({env,data:{},request:new Request('https://test.example/api/auth/me',{headers:{Cookie:cookie}})});
    assert.equal(await isAdmin(auth(oldCookie)),true);
    const p=context(db,{current:'initial-password',next:'new-password'},{path:'/api/auth/password'});p.env=env;
    const newCookie=(await changePassword(p)).headers.get('Set-Cookie').split(';')[0];
    assert.equal(await isAdmin(auth(oldCookie)),false);
    assert.equal(await isAdmin(auth(newCookie)),true);
    assert.equal((await db.prepare("SELECT value FROM settings WHERE key='password_ver'").first()).value,'1');
  } finally {db.close();}
});
test('a concurrent reset cannot silently overwrite the winning password', async () => {
  const db=sqlite(false);
  const batch=db.batch;
  let injected=false;
  db.batch=async statements=>{
    if(!injected && statements.some(s=>s.sql.includes("'password_hash'"))) {
      injected=true;
      db.exec("INSERT INTO settings(key,value) VALUES('password_hash','winner') ON CONFLICT(key) DO UPDATE SET value='winner'; UPDATE settings SET value='1' WHERE key='password_ver';");
    }
    return batch(statements);
  };
  try {
    const c=context(db,{current:'initial-password',next:'new-password'});
    c.env={DB:db,ADMIN_PASSWORD:'initial-password',PBKDF2_ITERATIONS:10000};
    await assert.rejects(changePassword(c),e=>e.status===409);
    assert.equal((await db.prepare("SELECT value FROM settings WHERE key='password_hash'").first()).value,'winner');
    assert.equal((await db.prepare("SELECT value FROM settings WHERE key='password_ver'").first()).value,'1');
  } finally {db.close();}
});
test('a login checked during a password reset does not receive the new version', async () => {
  const db=sqlite(false),prepare=db.prepare;
  let checks=0;
  db.prepare=sql=>{
    const s=prepare(sql);
    const bind=s.bind;
    s.bind=function(...values){
      const bound=bind.apply(s,values);
      if(sql==='SELECT value FROM settings WHERE key = ?1' && values[0]==='password_hash') {
        const first=bound.first;
        bound.first=async()=>{
          const row=await first.call(bound);
          if(++checks===1)db.exec("UPDATE settings SET value='1' WHERE key='password_ver';");
          return row;
        };
      }
      return bound;
    };
    return s;
  };
  const env={DB:db,ADMIN_PASSWORD:'initial-password',SESSION_SECRET:'z'.repeat(40)};
  try {
    const c=context(db,{password:'initial-password'},{path:'/api/auth/login',admin:false});c.env=env;
    const cookie=(await login(c)).headers.get('Set-Cookie').split(';')[0];
    assert.equal(await isAdmin({env,data:{},request:new Request('https://test.example',{headers:{Cookie:cookie}})}),false);
  } finally {db.close();}
});
