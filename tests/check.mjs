import { readdirSync,readFileSync } from 'node:fs';
import { join,dirname,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=new URL('../',import.meta.url).pathname;
function* walk(dir) {
  for(const e of readdirSync(dir,{withFileTypes:true})) {
    if(['node_modules','.git','.wrangler'].includes(e.name))continue;
    const path=join(dir,e.name);
    if(e.isDirectory())yield* walk(path);else yield path;
  }
}
let count=0;
for(const path of walk(root)) {
  if(!/\.(?:js|mjs)$/.test(path))continue;
  const check=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});
  if(check.status!==0)throw new Error(check.stderr);
  const text=readFileSync(path,'utf8');
  for(const m of text.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
    if(!m[1].startsWith('.'))continue;
    readFileSync(resolve(dirname(path),m[1]));
  }
  count++;
}
console.log(`Syntax and relative imports passed: ${count} JavaScript files`);
