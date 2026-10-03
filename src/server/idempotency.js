import { HttpError, json, readJson } from './http.js';
import { getDb } from './db.js';
import { requireAdmin } from './auth.js';

export async function idempotentCreate(context,next) {
  const path=new URL(context.request.url).pathname;
  const key=context.request.headers.get('Idempotency-Key');
  if (context.request.method !== 'POST' || !/^\/api\/(?:persons|marriages)\/?$/.test(path) || !key) return next();
  await requireAdmin(context);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(key)) throw new HttpError(400,'معرّف الطلب غير صالح.');
  const body=await readJson(context.request.clone(),path.includes('/persons') ? 400_000 : 8192);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${path}\n${JSON.stringify(body)}`));
  const fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const db=getDb(context.env);
  const claim=await db.prepare("INSERT OR IGNORE INTO write_requests(request_key,fingerprint,state,created_at) VALUES(?1,?2,'pending',?3)")
    .bind(key,fingerprint,Math.floor(Date.now()/1000)).run();
  if (!claim.meta.changes) {
    const previous=await db.prepare('SELECT fingerprint,state,response_status,response_body FROM write_requests WHERE request_key=?1').bind(key).first();
    if (!previous || previous.fingerprint !== fingerprint) throw new HttpError(409,'معرّف الطلب مستخدم لبيانات مختلفة.');
    if (previous.state !== 'done') throw new HttpError(409,'طلب سابق قيد التنفيذ أو نتيجته غير مؤكدة. أعد تحميل الشجرة قبل محاولة إنشاء سجل آخر.');
    return json(JSON.parse(previous.response_body),{status:previous.response_status});
  }
  try {
    const response=await next();
    if (response.ok) {
      const text=await response.clone().text();
      await db.prepare("UPDATE write_requests SET state='done',response_status=?2,response_body=?3 WHERE request_key=?1")
        .bind(key,response.status,text).run();
    } else if (response.status < 500) {
      await db.prepare('DELETE FROM write_requests WHERE request_key=?1').bind(key).run();
    }
    // For an ambiguous 5xx, keep the reservation rather than risk duplicates.
    return response;
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) await db.prepare('DELETE FROM write_requests WHERE request_key=?1').bind(key).run();
    throw e;
  }
}
