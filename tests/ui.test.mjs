import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom,Element } from './dom-shim.mjs';
import { createDateField } from '../public/js/datefield.js';
import { makeRecord } from '../public/js/calendar.js';
import { openModal } from '../public/js/ui.js';
import { renderDetails } from '../public/js/details.js';
import { buildGraph } from '../public/js/layout.js';

test('year-only and month-only dates remain identical after calendar button clicks',()=>{
  installDom();
  for(const rec of [makeRecord('j',1403,0,0),makeRecord('j',1403,7,0),makeRecord('g',2024,0,0)]) {
    const f=createDateField({label:'test',value:rec});
    for(const button of f.el.querySelectorAll('button'))button.click();
    assert.deepEqual(f.getValue(),rec);
  }
});
test('fully specified dates round-trip through both calendars',()=>{
  installDom();
  const rec=makeRecord('j',1403,1,1);
  const f=createDateField({label:'test',value:rec});
  f.el.querySelectorAll('button')[1].click();
  assert.deepEqual(f.getValue(),{...rec,cal:'g'});
  f.el.querySelectorAll('button')[0].click();
  assert.deepEqual(f.getValue(),rec);
});
test('explicit editing of a preserved partial date changes the date intentionally',()=>{
  installDom();
  const f=createDateField({label:'test',value:makeRecord('j',1403,0,0)});
  f.el.querySelector('.date-year').value='1402';
  f.el.querySelector('.date-year').dispatchEvent({type:'input'});
  assert.deepEqual(f.getValue(),makeRecord('j',1402,0,0));
});
test('modal busy state blocks duplicate submit, click and Escape; restores disabled states',()=>{
  const {doc,modalRoot}=installDom();
  const form=new Element('form'),input=new Element('input'),locked=new Element('input');
  locked.disabled=true;form.append(input,locked);
  let submits=0,actions=0;
  form.addEventListener('submit',()=>{submits++;});
  const m=openModal({title:'test',body:form,actions:[{label:'save',onClick:()=>actions++}]});
  m.setBusy(true);
  form.dispatchEvent({type:'submit'});
  m.footer.querySelector('button').dispatchEvent({type:'click'});
  doc.dispatchEvent({type:'keydown',key:'Escape'});
  assert.equal(submits,0);assert.equal(actions,0);
  assert.equal(input.disabled,true);assert.equal(m.busy,true);
  assert.ok(modalRoot.children.length);
  m.setBusy(false);
  assert.equal(input.disabled,false);assert.equal(locked.disabled,true);
  form.dispatchEvent({type:'submit'});assert.equal(submits,1);
  m.close();
});
test('public details never render notes even if stale data still contains them',()=>{
  installDom();
  const person={id:1,first_name:'P',gender:'m',phone:'+989123456789',notes:'SECRET_NOTE'};
  const panel=new Element('section');
  const ctx={graph:buildGraph([person],[]),prefs:{displayCal:'g',digits:'latin'},isAdmin:false};
  renderDetails(panel,person,ctx);
  assert.ok(!panel.textContent.includes('SECRET_NOTE'));
  assert.ok(!panel.textContent.includes('+989123456789'));
  renderDetails(panel,person,{...ctx,isAdmin:true});
  assert.ok(panel.textContent.includes('SECRET_NOTE'));
  assert.ok(panel.textContent.includes('+989123456789'));
});
test('a non-dismissible progress dialog has a focus target and traps Tab',()=>{
  const {doc}=installDom();
  const m=openModal({title:'progress',body:new Element('p'),dismissible:false});
  assert.equal(doc.activeElement,m.el);
  const event={type:'keydown',key:'Tab'};
  doc.dispatchEvent(event);
  assert.equal(event.defaultPrevented,true);
  m.close();
});
