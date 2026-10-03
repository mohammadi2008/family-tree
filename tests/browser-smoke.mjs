// Optional real-browser test. Run: node tests/browser-smoke.mjs
// Needs Python 3, Playwright and its Chromium browser installed.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { sqlite } from './helpers.mjs';
import { onRequest as middleware } from '../functions/api/_middleware.js';

const root = fileURLToPath(new URL('../public/',import.meta.url));
const db = sqlite();
db.exec("UPDATE persons SET phone='+989123456789',notes='RELEASE_PRIVATE_NOTE' WHERE id=1;");
const env = {DB:db,ADMIN_PASSWORD:'release-test-password',SESSION_SECRET:'s'.repeat(40)};
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css',
  '.woff':'font/woff','.svg':'image/svg+xml','.json':'application/json'};
let base;
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,base);
    if(url.pathname.startsWith('/api/')) {
      const chunks=[];for await (const chunk of req)chunks.push(chunk);
      const method=req.method;
      const c={env,data:{},params:{},request:new Request(url,{
        method,headers:req.headers,...(['GET','HEAD'].includes(method)?{}:{body:Buffer.concat(chunks)})
      })};
      let route=url.pathname.slice(5);
      if(/^persons\/\d+$/.test(route)){c.params.id=route.split('/')[1];route='persons/[id]';}
      if(/^marriages\/\d+$/.test(route)){c.params.id=route.split('/')[1];route='marriages/[id]';}
      if(/^photo\/\d+$/.test(route)){c.params.id=route.split('/')[1];route='photo/[id]';}
      if(['persons','marriages'].includes(route))route+='/index';
      c.next=async()=>{
        const handlers=await import(`../functions/api/${route}.js`);
        const name='onRequest'+method[0]+method.slice(1).toLowerCase();
        return handlers[name] ? handlers[name](c) : new Response('{}',{status:405});
      };
      const response=await middleware(c);
      res.writeHead(response.status,Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } else {
      const path=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
      if(!path.startsWith(root)){res.writeHead(403);res.end();return;}
      const headers={'Content-Type':mime[extname(path)]||'application/octet-stream'};
      if(extname(path)==='.html')headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
      res.writeHead(200,headers);res.end(await readFile(path));
    }
  } catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
base=`http://127.0.0.1:${server.address().port}`;
let browser;
const results=[];
try {
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  for(const size of [{width:1440,height:900},{width:390,height:844}]) {
    // Reset the demo fixture between the desktop and mobile flows.
    db.exec("UPDATE persons SET first_name='أحمد' WHERE id=1;");
    const c=await browser.newContext({viewport:size});
    const page=await c.newPage();
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.goto(base);
    await page.waitForFunction(()=>document.getElementById('people-count').textContent.includes('20'));
    assert.equal(await page.locator('#state-overlay').isVisible(),false);
    assert.ok(await page.evaluate(async()=>{await document.fonts.load('16px Cairo');return document.fonts.check('16px Cairo');}));
    // Search and keyboard navigation, including mobile search toggle.
    if(size.width<760)await page.locator('#btn-search').click();
    await page.locator('#search-input').fill('أحمد');
    await page.locator('#search-input').press('ArrowDown');
    assert.equal(await page.locator('#search-input').getAttribute('aria-activedescendant'),'sr-0');
    await page.locator('#search-input').press('Enter');
    await page.locator('#details').waitFor({state:'visible'});
    assert.ok(!(await page.locator('#details').innerText()).includes('RELEASE_PRIVATE_NOTE'));
    await page.locator('#btn-menu').click();
    await page.locator('#m-login').click();
    await page.locator('#login-pw').fill(env.ADMIN_PASSWORD);
    await page.locator('.modal-footer .btn-primary').click();
    await page.locator('#admin-badge').waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.body.classList.contains('modal-open'));
    // Actual authenticated edit with safe, test-only SQLite data.
    const tree=await page.evaluate(()=>fetch('/api/tree').then(r=>r.json()));
    assert.equal(tree.persons[0].notes,'RELEASE_PRIVATE_NOTE');
    const updated=await page.evaluate(async()=>{
      const r=await fetch('/api/persons/1',{method:'PUT',headers:{'Content-Type':'application/json','X-Requested-With':'FamilyTree'},body:JSON.stringify({
        person:{first_name:'Release Root',gender:'m',phone:'+989123456789',notes:'RELEASE_PRIVATE_NOTE'}
      })});
      return {status:r.status,data:await r.json()};
    });
    assert.equal(updated.status,200);
    await page.reload();
    await page.locator('#admin-badge').waitFor({state:'visible'});
    // A failed logout must not claim success.
    await page.route('**/api/auth/logout',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"logout failed"}'}));
    await page.locator('#btn-menu').click();await page.locator('#m-logout').click();
    await page.waitForFunction(()=>document.getElementById('toast-root').textContent.includes('logout failed'));
    assert.equal(await page.locator('#admin-badge').isVisible(),true);
    await page.unroute('**/api/auth/logout');
    // Logout with a failing public refresh still clears the local admin view.
    await page.route('**/api/tree',r=>r.abort());
    await page.locator('#btn-menu').click();await page.locator('#m-logout').click();
    await page.waitForFunction(()=>!document.body.classList.contains('is-admin'));
    await page.locator('#state-overlay.error').waitFor();
    assert.equal(await page.locator('#admin-badge').isVisible(),false);
    await page.unroute('**/api/tree');
    await page.locator('#state-overlay .btn-primary').click();
    await page.locator('#state-overlay').waitFor({state:'hidden'});
    if(size.width<760)await page.locator('#btn-search').click();
    await page.locator('#search-input').fill('Release Root');
    await page.locator('#search-input').press('Enter');
    await page.locator('#details').waitFor({state:'visible'});
    assert.ok(!(await page.locator('#details').innerText()).includes('RELEASE_PRIVATE_NOTE'));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    // Expected network errors above are not script failures.
    const unexpected=errors.filter(e=>!e.includes('Failed to load resource')&&!e.includes('net::ERR_FAILED'));
    assert.deepEqual(unexpected,[]);
    results.push({viewport:size,pass:true,consoleErrors:unexpected});
    await c.close();
  }
  console.log(JSON.stringify({browser:'Chromium',results},null,2));
} finally {
  await browser?.close();
  await new Promise(r=>server.close(r));
  db.close();
}
