import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('contact links start hidden with no embedded personal number', () => {
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const links=[...html.matchAll(/<a\b[^>]*data-whatsapp[^>]*>/g)].map(m=>m[0]);
  assert.equal(links.length,1); // menu only; the home-page floating button was removed
  for(const link of links) {
    assert.match(link,/\bhidden\b/);
    assert.doesNotMatch(link,/\bhref=/);
  }
  assert.doesNotMatch(html,/989178733909/);
});
test('unversioned script and style assets revalidate after deployment', () => {
  const headers=readFileSync(new URL('../public/_headers',import.meta.url),'utf8');
  for(const folder of ['js','css'])assert.match(headers,new RegExp(`/${folder}/\\*\\s+Cache-Control: public, no-cache`));
});
