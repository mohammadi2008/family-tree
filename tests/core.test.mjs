import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText } from '../src/server/validate.js';
import { readJson } from '../src/server/http.js';
import { readCookie,signSession,verifySession,hashPassword,verifyPassword } from '../src/server/auth.js';
import { makeRecord,normalizeRecord,recordRange,g2d,d2g,j2d,d2j } from '../public/js/calendar.js';
import { byteChunks,checkBackupStructure,jsonBytes } from '../public/js/backup.js';
import { cleanBackupRow,validateBackupGraph } from '../src/server/backup.js';
import { buildGraph,computeLayout } from '../public/js/layout.js';
import { buildPdf } from '../public/js/pdf.js';
import { sample } from './helpers.mjs';
import { createHash } from 'node:crypto';

test('sanitizer preserves hyphens, removes NUL/bidi controls, preserves notes newlines',()=>{
  assert.equal(cleanText('Ali-Reza\0\u202e','first_name'),'Ali-Reza');
  assert.equal(cleanText('a\tb\nc','notes',{multiline:true}),'a\tb\nc');
});
test('request limit counts UTF-8 bytes without trusting Content-Length',async()=>{
  const req=new Request('https://test.example',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'ش'.repeat(70)})});
  await assert.rejects(readJson(req,100),e=>e.status===413);
});
test('request reader accepts chunks split inside UTF-8 characters',async()=>{
  const bytes=new TextEncoder().encode('{"text":"سلام"}');
  const stream=new ReadableStream({start(c){for(const b of bytes)c.enqueue(new Uint8Array([b]));c.close();}});
  const req=new Request('https://test.example',{method:'POST',duplex:'half',headers:{'Content-Type':'application/json'},body:stream});
  assert.deepEqual(await readJson(req,100),{text:'سلام'});
});
test('malformed cookie is treated as anonymous rather than throwing',()=>{
  assert.equal(readCookie(new Request('https://test.example',{headers:{Cookie:'ft_session=%XX'}}),'ft_session'),null);
});
test('session verification and password hash round-trip',async()=>{
  const secret='x'.repeat(40);
  const token=await signSession({sub:'admin',pv:'1',exp:Math.floor(Date.now()/1000)+30},secret);
  assert.equal((await verifySession(token,secret)).pv,'1');
  assert.equal(await verifySession(token+'x',secret),null);
  const hash=await hashPassword('test-password',{PBKDF2_ITERATIONS:10000});
  assert.equal(await verifyPassword('test-password',hash),true);
  assert.equal(await verifyPassword('wrong',hash),false);
});
test('Gregorian and Jalali leap days and round trips',()=>{
  assert.throws(()=>makeRecord('g',2023,2,29));
  assert.doesNotThrow(()=>makeRecord('g',2024,2,29));
  for(let y=1200;y<=1450;y++) for(const m of [1,6,7,12]) {
    const j=j2d(y,m,1); assert.deepEqual(d2j(j),{y,m,d:1});
  }
  assert.deepEqual(d2g(g2d(2024,3,20)),{y:2024,m:3,d:20});
  const rec=makeRecord('j',1403,0,0);
  assert.deepEqual(normalizeRecord(rec),rec);
  assert.equal(recordRange(rec)[1]-recordRange(rec)[0]+1,366);
});
test('photo and Arabic batches stay below exact UTF-8 byte budget',()=>{
  const rows=Array.from({length:30},(_,i)=>({person_id:i+1,data:'x'.repeat(136536),label:'ش'.repeat(20)}));
  const batches=[...byteChunks(rows)];
  assert.ok(batches.length>1);
  assert.equal(batches.flat().length,rows.length);
  assert.ok(batches.every(b=>jsonBytes(b)<=1400000));
});
test('backup structure rejects duplicates and unsupported formats',()=>{
  checkBackupStructure(sample);
  assert.throws(()=>checkBackupStructure({...sample,persons:[sample.persons[0],sample.persons[0]]}));
  assert.throws(()=>checkBackupStructure({...sample,format:999}));
});
test('sample backup semantics and visibility pass',()=>{
  const persons=sample.persons.map(r=>cleanBackupRow('persons',r,999));
  const marriages=sample.marriages.map(r=>cleanBackupRow('marriages',r,999));
  validateBackupGraph(persons,marriages);
  const layout=computeLayout(buildGraph(persons,marriages));
  assert.equal(new Set(layout.nodes.map(n=>n.pid)).size,persons.length);
});
test('layout handles a 6000-generation chain without recursive stack overflow',()=>{
  const persons=Array.from({length:6000},(_,i)=>({id:i+1,first_name:'P',gender:'m',father_id:i || null,mother_id:null}));
  const graph=buildGraph(persons,[]);
  const expanded=computeLayout(graph);
  assert.equal(expanded.nodes.length,6000);
  assert.equal(expanded.nodes.at(-1).y,5999*214);
  const collapsed=computeLayout(graph,{collapsed:new Set([1])});
  assert.equal(collapsed.nodes.length,1);
  assert.equal(collapsed.toggles[0].count,5999);
});
test('sample geometry matches four snapshots (full-tree ones updated: husbands with their own branch are no longer repeated in the wife family)',()=>{
  const hashes=[
    'a32fb95a31a1482c53da8f769b1748ad79b5252d66468c668fa220e1f3e25838',
    '548eef562e60229e52f527ea544fc74eb9cc3435dc474c2c1be4a5a8cc90306d',
    'c1df1b09aca802c39f01ae6e67131eb76d16774889e8908ef9dd3fae6a30dad5',
    '3ad8b5da8d43b46dc7077d75b03ff1b300e43186fa70f1e94b6556a51cfb7158',
  ];
  const scenarios=[{},{collapsed:new Set([1])},{rootId:3},{rootId:2}];
  for(let i=0;i<scenarios.length;i++) {
    const l=computeLayout(buildGraph(sample.persons,sample.marriages),scenarios[i]);
    const shape={
      nodes:l.nodes.map(n=>[n.key,n.x,n.y]).sort((a,b)=>a[0].localeCompare(b[0])),
      edges:l.edges.map(e=>JSON.stringify([e.style,e.pts])).sort(),bounds:l.bounds,
      toggles:l.toggles.map(t=>[t.pid,t.x,t.y,t.count,t.collapsed]).sort((a,b)=>a[0]-b[0]),
    };
    assert.equal(createHash('sha256').update(JSON.stringify(shape)).digest('hex'),hashes[i]);
  }
});
test('backup validation rejects cycles, missing parents and impossible marriages',()=>{
  const p=(id,gender,extra={})=>({id,first_name:`P${id}`,gender,father_id:null,mother_id:null,...extra});
  assert.throws(()=>validateBackupGraph([p(1,'m',{father_id:2}),p(2,'m',{father_id:1})],[]));
  assert.throws(()=>validateBackupGraph([p(1,'m',{father_id:99})],[]));
  assert.throws(()=>validateBackupGraph([p(1,'m'),p(2,'f',{father_id:1})],[{husband_id:1,wife_id:2}]));
  assert.throws(()=>validateBackupGraph([p(1,'m',{birth_date:'2000-01-01',birth_prec:'d',birth_cal:'g'}),p(2,'f')],
    [{husband_id:1,wife_id:2,marriage_date:'1990-01-01',marriage_prec:'d',marriage_cal:'g'}]));
});
test('PDF writer creates structurally indexed PDF without browser rendering',async()=>{
  const blob=buildPdf({widthPt:600,heightPt:800,title:'اختبار',strips:[{w:1,h:1,yPt:0,hPt:800,data:new Uint8Array([255,216,255,217])}]});
  const text=new TextDecoder().decode(await blob.arrayBuffer());
  assert.ok(text.startsWith('%PDF-1.4'));
  const start=Number(/startxref\n(\d+)/.exec(text)[1]);
  const bytes=new Uint8Array(await blob.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(start,start+4)),'xref');
});
