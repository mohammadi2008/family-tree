import { readFileSync } from 'node:fs';
const config=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8');
const id=/^\s*database_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
if(!id || id==='00000000-0000-0000-0000-000000000000' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) {
  console.error('Set the real Cloudflare D1 database_id in wrangler.toml before deploying. Apply all migrations (0001, 0002 and 0003).');
  process.exit(1);
}
console.log('D1 database_id is set. Confirm migrations and secrets in Cloudflare before deploying.');
