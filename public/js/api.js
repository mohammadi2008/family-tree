/**
 * api.js — thin client for the Pages Functions API.
 * Every state-changing request carries the anti-CSRF header.
 */
const pendingCreates = new Map();
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function request(method, path, body) {
  const opts = {
    method,
    credentials: 'same-origin',
    cache: method === 'GET' ? 'no-cache' : 'no-store',
    headers: { Accept: 'application/json' },
  };
  if (method !== 'GET') opts.headers['X-Requested-With'] = 'FamilyTree';
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let keySlot = null;
  if (method === 'POST' && ['/persons','/marriages'].includes(path)) {
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${path}\n${opts.body}`));
    keySlot='family-tree-pending-'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    let key=pendingCreates.get(keySlot);
    try { key ||= sessionStorage.getItem(keySlot); } catch { /* restricted storage */ }
    key ||= crypto.randomUUID();
    pendingCreates.set(keySlot,key);
    try { sessionStorage.setItem(keySlot,key); } catch { /* map still protects retries */ }
    opts.headers['Idempotency-Key']=key;
  }
  let res, data = null;
  const controller = new AbortController();
  opts.signal = controller.signal;
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    res = await fetch(`/api${path}`, opts);
    if ((res.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) {
      try { data = await res.json(); } catch {
        if (res.ok) throw new ApiError(0, 'استجابة الخادم غير مكتملة. أعد تحميل الشجرة قبل إعادة المحاولة.');
      }
    }
    if (res.ok && (!data || typeof data !== 'object' || Array.isArray(data))) {
      throw new ApiError(0, 'استجابة الخادم غير صالحة. أعد تحميل الشجرة قبل إعادة المحاولة.');
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const message = controller.signal.aborted
      ? 'انتهت مهلة الاتصال. قد يكون الطلب قد حُفظ؛ أعد تحميل الشجرة قبل إعادة المحاولة.'
      : 'تعذّر الاتصال بالخادم. تحقق من اتصالك بالإنترنت ثم حاول مجددًا.';
    throw new ApiError(0, message);
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    if (keySlot && res.status < 500 && res.status !== 409) {
      pendingCreates.delete(keySlot);
      try { sessionStorage.removeItem(keySlot); } catch { /* restricted storage */ }
    }
    const fallback = res.status === 401 ? 'انتهت الجلسة. سجّل الدخول مجددًا.'
      : res.status >= 500 ? 'حدث خطأ في الخادم. حاول لاحقًا.' : 'تعذّر تنفيذ الطلب.';
    throw new ApiError(res.status, (data && data.error) || fallback);
  }
  if (keySlot) {
    pendingCreates.delete(keySlot);
    try { sessionStorage.removeItem(keySlot); } catch { /* restricted storage */ }
  }
  return data;
}

export const api = {
  tree: () => request('GET', '/tree'),
  me: () => request('GET', '/auth/me'),
  login: (password) => request('POST', '/auth/login', { password }),
  logout: () => request('POST', '/auth/logout', {}),
  changePassword: (current, next) => request('POST', '/auth/password', { current, next }),
  createPerson: (payload) => request('POST', '/persons', payload),
  updatePerson: (id, payload) => request('PUT', `/persons/${id}`, payload),
  deletePerson: (id, mode) => request('DELETE', `/persons/${id}?mode=${mode === 'branch' ? 'branch' : 'single'}`),
  createMarriage: (aId, bId, marriage) => request('POST', '/marriages', { aId, bId, marriage }),
  updateMarriage: (id, marriage) => request('PUT', `/marriages/${id}`, { marriage }),
  deleteMarriage: (id) => request('DELETE', `/marriages/${id}`),
  exportData: () => request('GET', '/admin/export?part=data'),
  exportPhotos: (after,version) => request('GET', `/admin/export?part=photos&after=${after || 0}&version=${encodeURIComponent(version)}`),
  importPhase: (body) => request('POST', '/admin/import', body),
  saveSettings: (siteTitle,whatsappNumber) => request('PUT', '/admin/settings', { siteTitle,whatsappNumber }),
};
