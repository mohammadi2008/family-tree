/**
 * Middleware for every /api/* request:
 *  - CSRF protection: state-changing requests must come from our own origin
 *    and carry the custom X-Requested-With header (cannot be sent cross-site
 *    without a CORS preflight, which we never allow).
 *  - Uniform JSON error handling.
 *  - Security headers on every API response.
 */
import { HttpError, errorResponse } from '../../src/server/http.js';
import { idempotentCreate } from '../../src/server/idempotency.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

function withSecurityHeaders(response) {
  const res = new Response(response.body, response);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'same-origin');
  res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (!res.headers.has('Content-Security-Policy')) {
    res.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
  return res;
}

export async function onRequest(context) {
  const { request } = context;
  try {
    if (!SAFE_METHODS.has(request.method)) {
      const url = new URL(request.url);
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) throw new HttpError(403, 'تم رفض الطلب لأسباب أمنية.');
      if (request.headers.get('X-Requested-With') !== 'FamilyTree') throw new HttpError(403, 'تم رفض الطلب لأسباب أمنية.');
      if (request.method === 'OPTIONS') throw new HttpError(405, 'طريقة غير مدعومة.');
    }
    context.data = context.data || {};
    const response = await idempotentCreate(context,()=>context.next());
    return withSecurityHeaders(response);
  } catch (err) {
    return withSecurityHeaders(errorResponse(err));
  }
}
