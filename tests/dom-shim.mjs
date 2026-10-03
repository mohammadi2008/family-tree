// Minimal event/element model for UNIT tests, not a browser or layout engine.
export class Element {
  constructor(tag='div') {
    this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;
    this.attributes={};this.listeners={};this.className='';this.style={};
    this.dataset={};this.value='';this.disabled=false;this.hidden=false;
    this.offsetParent={};this.id='';this._text='';
    this.classList={
      add:(...names)=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),...names])].join(' ');},
      remove:(...names)=>{this.className=this.className.split(' ').filter(n=>!names.includes(n)).join(' ');},
      toggle:(name,value)=>{const yes=value ?? !this.className.split(' ').includes(name);this.classList[yes?'add':'remove'](name);return yes;},
      contains:name=>this.className.split(' ').includes(name),
    };
  }
  set textContent(v) {this._text=String(v);this.children=[];}
  get textContent() {return this._text+this.children.map(c=>c.textContent).join('');}
  append(...items) {for(const item of items){this.children.push(item);item.parentNode=this;}}
  prepend(item) {this.children.unshift(item);item.parentNode=this;}
  setAttribute(k,v) {this.attributes[k]=String(v);if(k==='id')this.id=String(v);if(k==='value')this.value=String(v);}
  getAttribute(k) {return this.attributes[k] ?? null;}
  removeAttribute(k) {delete this.attributes[k];}
  get firstChild() {return this.children[0] || null;}
  get lastElementChild() {return this.children.at(-1) || null;}
  addEventListener(type,fn,opts=false) {(this.listeners[type] ||= []).push({fn,capture:opts===true || opts.capture===true});}
  removeEventListener(type,fn) {this.listeners[type]=(this.listeners[type] || []).filter(e=>e.fn!==fn);}
  dispatchEvent(event) {
    event.target=this;event.stopped=false;event.defaultPrevented=false;
    event.preventDefault=()=>{event.defaultPrevented=true;};
    event.stopImmediatePropagation=()=>{event.stopped=true;};
    event.stopPropagation=()=>{event.stopped=true;};
    const path=[];let node=this;
    while(node){path.push(node);node=node.parentNode;}
    for(const capture of [true,false]) {
      for(const el of (capture ? [...path].reverse() : path)) {
        for(const listener of el.listeners[event.type] || []) {
          if(listener.capture===capture)listener.fn(event);
          if(event.stopped)return !event.defaultPrevented;
        }
      }
    }
    return !event.defaultPrevented;
  }
  click() {if(!this.disabled)this.dispatchEvent({type:'click'});}
  focus() {globalThis.document.activeElement=this;}
  remove() {if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(c=>c!==this);}
  scrollIntoView() {}
  matches(selector) {
    selector=selector.trim();
    if(selector.startsWith('.'))return this.className.split(' ').includes(selector.slice(1));
    if(selector.startsWith('['))return false;
    const tag=/^[a-z]+/.exec(selector)?.[0];
    if(tag && this.tagName!==tag.toUpperCase())return false;
    if(selector.includes(':not([type=hidden])') && this.attributes.type==='hidden')return false;
    if(selector.includes(':not([type=file])') && this.attributes.type==='file')return false;
    return !!tag;
  }
  querySelectorAll(selector) {
    const found=[];const parts=selector.split(',');
    const visit=el=>{for(const child of el.children){if(parts.some(p=>child.matches(p)))found.push(child);visit(child);}};
    visit(this);return found;
  }
  querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
}
export function installDom() {
  const body=new Element('body'),modalRoot=new Element('div');
  modalRoot.id='modal-root';body.append(modalRoot);
  const doc=new Element('document');
  doc.body=body;doc.activeElement=body;
  doc.createElement=tag=>new Element(tag);
  doc.createTextNode=text=>{const e=new Element('#text');e.textContent=text;return e;};
  doc.getElementById=id=>id==='modal-root'?modalRoot:null;
  globalThis.Node=Element;globalThis.document=doc;
  globalThis.requestAnimationFrame=fn=>fn(0);
  return {body,modalRoot,doc};
}
