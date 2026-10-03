import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
globalThis.crypto ||= webcrypto;

const bridge = new URL('./sqlite_bridge.py',import.meta.url);
export function sqlite(seed = true) {
  const dir=mkdtempSync(join(tmpdir(),'family-test-'));
  const path=join(dir,'db.sqlite');
  const rpc = payload => {
    const run=spawnSync(process.env.PYTHON || 'python3',[bridge.pathname],{
      input:JSON.stringify({path,...payload}),encoding:'utf8',maxBuffer:25_000_000,
    });
    if (run.error) throw run.error;
    if (!run.stdout.trim()) throw new Error(run.stderr || 'SQLite bridge failed; Python 3 is required.');
    const result=JSON.parse(run.stdout);
    if (result.error) throw new Error(result.error);
    return result.result;
  };
  class Statement {
    constructor(sql,values=[]) { this.sql=sql; this.values=values; }
    bind(...values) { return new Statement(this.sql,values); }
    async all() { return rpc({statements:[this]})[0]; }
    async first() { return (await this.all()).results[0] || null; }
    async run() { return this.all(); }
  }
  const db={
    prepare:sql => new Statement(sql),
    batch:async statements => rpc({statements}),
    exec:script => rpc({script}),
    close:() => rmSync(dir,{recursive:true,force:true}),
  };
  let script = readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8');
  script += readFileSync(new URL('../migrations/0002_safe_restore.sql',import.meta.url),'utf8');
  script += readFileSync(new URL('../migrations/0003_fix_spouse_parentage.sql',import.meta.url),'utf8');
  if (seed) script += readFileSync(new URL('../seed/sample-data.sql',import.meta.url),'utf8');
  db.exec(script);
  return db;
}
export function context(db,body,options={}) {
  return {
    env:{DB:db},data:{isAdmin:options.admin ?? true},params:{id:String(options.id || 1)},
    request:new Request(`https://test.example${options.path || '/api/admin/import'}`,{
      method:options.method || 'POST',
      headers:{'Content-Type':'application/json','X-Requested-With':'FamilyTree',...(options.headers || {})},
      ...((options.method === 'GET') ? {} : {body:JSON.stringify(body)}),
    }),
  };
}
export const sample = JSON.parse(readFileSync(new URL('../seed/sample-family.json',import.meta.url),'utf8'));
