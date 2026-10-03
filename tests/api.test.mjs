import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../public/js/api.js';

test('create retries retain their key after a malformed successful response', async () => {
  const original = globalThis.fetch;
  const keys = [];
  try {
    globalThis.fetch = async (_, opts) => {
      keys.push(opts.headers['Idempotency-Key']);
      return keys.length === 1
        ? new Response('{', {status:201,headers:{'Content-Type':'application/json'}})
        : new Response('{"ok":true,"id":1}',{status:201,headers:{'Content-Type':'application/json'}});
    };
    const payload = {person:{first_name:'retry-test',gender:'m'},link:{type:'root'}};
    await assert.rejects(api.createPerson(payload),e=>e instanceof ApiError && e.status===0);
    assert.equal((await api.createPerson(payload)).id,1);
    assert.equal(keys[0],keys[1]);
  } finally { globalThis.fetch=original; }
});
test('successful HTML, null and arrays do not masquerade as an API result', async () => {
  const original = globalThis.fetch;
  try {
    for (const [body,type] of [['<html>Gateway</html>','text/html'],['null','application/json'],['[]','application/json']]) {
      globalThis.fetch=async()=>new Response(body,{headers:{'Content-Type':type}});
      await assert.rejects(api.tree(),e=>e instanceof ApiError && e.status===0);
    }
  } finally { globalThis.fetch=original; }
});
