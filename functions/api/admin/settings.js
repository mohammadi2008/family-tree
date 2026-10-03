/** PUT /api/admin/settings { siteTitle } — admin only. */
import { HttpError, json, readJson } from '../../../src/server/http.js';
import { getDb, setSettingStmt, bumpVersionStmt } from '../../../src/server/db.js';
import { requireAdmin } from '../../../src/server/auth.js';

export async function onRequestPut(context) {
  await requireAdmin(context);
  const db = getDb(context.env);
  const body = await readJson(context.request, 4096);
  const title = typeof body.siteTitle === 'string' ? body.siteTitle.replace(/\s+/g, ' ').trim() : '';
  if (!title) throw new HttpError(400, 'عنوان الموقع مطلوب.');
  if (title.length > 80) throw new HttpError(400, 'عنوان الموقع طويل جدًا.');
  const whatsapp = typeof body.whatsappNumber === 'string' ? body.whatsappNumber.trim() : '';
  if (whatsapp && !/^[1-9]\d{6,14}$/.test(whatsapp)) throw new HttpError(400,'رقم واتساب غير صالح. استخدم رمز البلد دون +.');
  await db.batch([setSettingStmt(db, 'site_title', title),setSettingStmt(db,'whatsapp_number',whatsapp),bumpVersionStmt(db)]);
  return json({ok:true,siteTitle:title,whatsappNumber:whatsapp});
}
