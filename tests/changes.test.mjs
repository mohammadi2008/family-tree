import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom,Element } from './dom-shim.mjs';
import { renderDetails } from '../public/js/details.js';
import { buildDivorceSection } from '../public/js/forms.js';
import { buildGraph,computeLayout,BRANCH_COLORS } from '../public/js/layout.js';
import { sqlite } from './helpers.mjs';

const P=(id,first,gender,extra={})=>({id,first_name:first,father_name:'',family_name:'',gender,...extra});
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/js/app.js',import.meta.url),'utf8');

test('lifespan label follows gender',()=>{
  installDom();
  const prefs={displayCal:'g',digits:'latin'};
  for(const [g,label] of [['m','عاش'],['f','عاشت']]) {
    const person=P(1,'X',g,{birth_date:'1900-01-01',birth_prec:'d',birth_cal:'g',is_deceased:1,death_date:'1970-01-01',death_prec:'d',death_cal:'g'});
    const panel=new Element('section');
    renderDetails(panel,person,{graph:buildGraph([person],[]),prefs,isAdmin:false});
    const labels=[];const walk=e=>{if(e.tagName==='DT')labels.push(e.textContent);(e.children||[]).forEach(walk);};walk(panel);
    assert.ok(labels.includes(label),`${g}: ${labels}`);
    if(g==='f')assert.ok(!labels.includes('عاش'));
  }
});

test('divorce section lists the wife marriages and reports only changes',()=>{
  installDom();
  const persons=[P(1,'H1','m'),P(2,'H2','m'),P(3,'W','f')];
  const marriages=[{id:1,husband_id:1,wife_id:3,status:'married'},{id:2,husband_id:2,wife_id:3,status:'divorced'}];
  const graph=buildGraph(persons,marriages);
  assert.equal(buildDivorceSection({person:persons[0],graph}),null);
  const s=buildDivorceSection({person:persons[2],graph});
  assert.deepEqual(s.read(),[]);
  const inputs=[];const walk=e=>{if(e.tagName==='INPUT')inputs.push(e);(e.children||[]).forEach(walk);};walk(s.el);
  assert.equal(inputs.length,2);
  inputs[0].checked=true;
  assert.deepEqual(s.read().map(x=>[x.marriage.id,x.status]),[[1,'divorced']]);
});

test('wives get distinct stable colours, used for their own children only',()=>{
  const persons=[P(1,'H','m'),P(2,'W1','f'),P(3,'W2','f'),P(4,'C1','m',{father_id:1,mother_id:2}),P(5,'C2','f',{father_id:1,mother_id:3}),P(6,'G','m',{father_id:4,mother_id:null})];
  const marriages=[{id:1,husband_id:1,wife_id:2,sort_order:0},{id:2,husband_id:1,wife_id:3,sort_order:1}];
  const run=()=>computeLayout(buildGraph(persons,marriages));
  const L=run();
  const colors=L.edges.map(e=>e.color).filter(Boolean);
  assert.ok(colors.includes(BRANCH_COLORS[0])&&colors.includes(BRANCH_COLORS[1]));
  assert.deepEqual(run().edges.map(e=>e.color),L.edges.map(e=>e.color)); // stable
  // Wife colours appear on both marriage lines and the branch to their children
  const w1_edges=L.edges.filter(e=>e.color===BRANCH_COLORS[0]);
  assert.ok(w1_edges.length>=2,'first wife: marriage line + branch to child');
  const w2_edges=L.edges.filter(e=>e.color===BRANCH_COLORS[1]);
  assert.ok(w2_edges.length>=2,'second wife: marriage line + branch to child');
  // Grandchild: no colour
  const g=L.byKey.get('b6');
  const edgeToG=L.edges.find(e=>e.pts.some(pt=>Math.abs(pt[0]-g.x)<5)&&e.pts.some(pt=>pt[1]>300));
  assert.ok(edgeToG&&!edgeToG.color,'grandchild edge loses the colour');
  // single-wife man: no colour overrides
  const L2=computeLayout(buildGraph(persons.slice(0,2).concat([P(4,'C','m',{father_id:1,mother_id:2})]),[marriages[0]]));
  assert.ok(L2.edges.every(e=>!e.color));
});


test('marrying an existing woman never makes the husband a child of her parents',()=>{
  // cousins: U is W's father, F is H's father; H was wrongly given U as father
  const persons=[P(1,'Grand','m'),P(2,'U','m',{father_id:1}),P(3,'F','m',{father_id:1}),P(4,'W','f',{father_id:2}),P(5,'H','m',{father_id:2})];
  const marriages=[{id:1,husband_id:5,wife_id:4}];
  const g=buildGraph(persons,marriages);
  assert.equal(g.byId.get(5).father_id,null);           // wrong link ignored
  assert.equal(g.byId.get(4).father_id,2);              // her lineage preserved
  assert.equal(persons[4].father_id,2);                 // input data not mutated
  assert.ok(!g.kids.get(2).includes(5));
  // legitimate cousin marriage is untouched
  const ok=buildGraph([P(1,'G','m'),P(2,'U','m',{father_id:1}),P(3,'F','m',{father_id:1}),P(4,'W','f',{father_id:2}),P(5,'H','m',{father_id:3})],marriages);
  assert.equal(ok.byId.get(5).father_id,3);
  const L=computeLayout(ok);
  assert.equal(L.appearances.get(4).length,2);          // one record, two appearances
  // husband is drawn only in HIS branch, never as a spouse inside his wife's family
  assert.equal(L.appearances.get(5).length,1);
  assert.equal(L.appearances.get(5)[0].kind,'blood');
  assert.ok(L.byKey.get('s5_4')===undefined&&L.byKey.get('s4_5')===undefined?true:L.byKey.get('s5_4').kind==='spouse');
  assert.ok(!L.byKey.has('s4_5'));
  // outsider husband (no parents in the tree) is still shown next to his wife
  const out=computeLayout(buildGraph([P(1,'G','m'),P(2,'W','f',{father_id:1}),P(3,'Out','m')],[{id:1,husband_id:3,wife_id:2}]));
  assert.ok(out.byKey.has('s2_3')||out.byKey.has('b3'));
});

test('migration 0003 clears only the unambiguous wrong parent link',()=>{
  const db=sqlite(false);
  db.exec(`INSERT INTO persons(id,first_name,gender,father_id) VALUES(1,'G','m',NULL),(2,'U','m',1),(3,'F','m',1),(4,'W','f',2),(5,'Bad','m',2),(6,'Good','m',3);
    INSERT INTO marriages(husband_id,wife_id) VALUES(5,4),(6,4);`);
  db.exec(readFileSync(new URL('../migrations/0003_fix_spouse_parentage.sql',import.meta.url),'utf8'));
  return db.prepare('SELECT id,father_id FROM persons ORDER BY id').all().then(r=>{
    const m=Object.fromEntries(r.results.map(x=>[x.id,x.father_id]));
    assert.equal(m[5],null);assert.equal(m[6],3);assert.equal(m[4],2);assert.equal(m[2],1);
    db.close();
  });
});

test('home page has no floating contact button; menu keeps it; simplified controls',()=>{
  assert.ok(!html.includes('whatsapp-fab'));
  assert.ok(html.includes('class="menu-item whatsapp" data-whatsapp'));
  for(const id of ['z-in','z-out','z-reset','z-fit','m-expand','m-fit'])assert.ok(!html.includes(`id="${id}"`),id);
  assert.ok(html.includes('id="z-map"'));
  for(const id of ['m-expand','m-fit','z-in','z-out','z-reset','z-fit'])assert.ok(!app.includes(`'${id}'`),id);
  assert.ok(!html.includes('توسيع كل الفروع')&&!html.includes('عرض الشجرة كاملة'));
});
