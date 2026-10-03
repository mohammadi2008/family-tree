/**
 * http.js — tiny HTTP helpers shared by all Pages Functions.
 */

/** Error carrying an HTTP status and a user-facing Arabic message. */
export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}

/** JSON response (never cached unless caller overrides headers). */
export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json; charset=utf-8');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status: init.status || 200, headers });
}

/** Convert any thrown value into a safe JSON error response. */
export function errorResponse(err) {
  if (err instanceof HttpError) {
    const headers = {};
    if (err.status === 429 && err.extra && err.extra.retryAfter) headers['Retry-After'] = String(err.extra.retryAfter);
    return json({ error: err.message }, { status: err.status, headers });
  }
  // Never leak internals to the client; log for `wrangler pages deployment tail`.
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  return json({ error: 'حدث خطأ غير متوقع في الخادم. حاول مرة أخرى.' }, { status: 500 });
}

/** Read and parse a JSON body with a hard size limit (bytes). */
export async function readJson(request, maxBytes = 1_000_000) {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.toLowerCase().includes('application/json')) throw new HttpError(415, 'نوع المحتوى غير مدعوم.');
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw new HttpError(413, 'حجم البيانات المرسلة كبير جدًا.');
  const reader = request.body?.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', size = 0;
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new HttpError(413, 'حجم البيانات المرسلة كبير جدًا.');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'صيغة البيانات غير صالحة.');
    } finally { reader.releaseLock(); }
  }
  let value;
  try { value = JSON.parse(text); } catch { throw new HttpError(400, 'صيغة البيانات غير صالحة.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'صيغة البيانات غير صالحة.');
  return value;
}

/** Parse a positive integer id or throw 400. */
export function parseId(value, label = 'المعرّف') {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new HttpError(400, `${label} غير صالح.`);
  return n;
}
