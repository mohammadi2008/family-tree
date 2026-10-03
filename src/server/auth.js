/**
 * auth.js — admin authentication.
 *
 * - Password: bootstrap from the ADMIN_PASSWORD secret; after "change password"
 *   a PBKDF2-SHA256 hash (random salt) stored in D1 takes precedence.
 * - Session: HS256 JWT in an httpOnly, SameSite=Strict cookie.
 *   The token embeds the password version, so changing the password
 *   instantly invalidates all other sessions.
 */
import { HttpError } from './http.js';
import { getDb, getSetting } from './db.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
export const COOKIE_NAME = 'ft_session';
export const SESSION_TTL = 7 * 24 * 3600; // 7 days

/* ---------------- encoding ---------------- */
export function bytesToB64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64url = (bytes) => bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

export async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/* ---------------- password hashing ---------------- */
function iterationsFrom(env) {
  const n = Number(env && env.PBKDF2_ITERATIONS);
  // Cloudflare Workers caps PBKDF2 at 100,000 iterations.
  return Number.isInteger(n) && n >= 10000 && n <= 100000 ? n : 60000;
}

export async function hashPassword(password, env) {
  const iterations = iterationsFrom(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256));
  return `pbkdf2_sha256$${iterations}$${bytesToB64(salt)}$${bytesToB64(bits)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 100000 ||
      parts[2].length > 64 || parts[3].length > 64) return false;
  try {
    const salt = b64ToBytes(parts[2]);
    const expected = b64ToBytes(parts[3]);
    if (salt.length !== 16 || expected.length !== 32) return false;
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256));
    return timingSafeEqual(bits, expected);
  } catch { return false; }
}

/** Checks a candidate password against the stored hash or the env secret. */
export async function checkAdminPassword(env, db, password) {
  if (typeof password !== 'string' || !password || password.length > 256) return false;
  const stored = await getSetting(db, 'password_hash');
  if (stored) return verifyPassword(password, stored);
  if (!env.ADMIN_PASSWORD) {
    throw new HttpError(503, 'لم يتم ضبط كلمة مرور المدير بعد. أضف المتغير السري ADMIN_PASSWORD في إعدادات Cloudflare.');
  }
  return timingSafeEqual(await sha256(password), await sha256(String(env.ADMIN_PASSWORD)));
}

/* ---------------- session tokens ---------------- */
async function sessionSecret(env, db) {
  if (env.SESSION_SECRET && String(env.SESSION_SECRET).length >= 32) return String(env.SESSION_SECRET);
  // Fallback: auto-generated secret persisted in D1 (works without extra setup).
  let s = await getSetting(db, 'session_secret');
  if (!s) {
    await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('session_secret', ?1)").bind(randomToken(48)).run();
    s = await getSetting(db, 'session_secret');
  }
  return s;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(payload, secret) {
  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

export async function verifySession(token, secret) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  } catch { return null; }
  if (!ok) return null;
  try {
    const payload = JSON.parse(dec.decode(unb64url(parts[1])));
    if (!payload || payload.sub !== 'admin' || typeof payload.exp !== 'number') return null;
    if (!Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

/* ---------------- cookies ---------------- */
export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function cookieAttrs(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

export async function createSessionCookie(context, passwordVersion) {
  const db = getDb(context.env);
  const secret = await sessionSecret(context.env, db);
  const pv = passwordVersion ?? ((await getSetting(db, 'password_ver')) || '0');
  const now = Math.floor(Date.now() / 1000);
  const token = await signSession({ sub: 'admin', iat: now, exp: now + SESSION_TTL, pv }, secret);
  return `${COOKIE_NAME}=${token}; Max-Age=${SESSION_TTL}${cookieAttrs(context.request)}`;
}

export function clearSessionCookie(request) {
  return `${COOKIE_NAME}=; Max-Age=0${cookieAttrs(request)}`;
}

/* ---------------- authorization ---------------- */
export async function isAdmin(context) {
  if (context.data && typeof context.data.isAdmin === 'boolean') return context.data.isAdmin;
  let result = false;
  const token = readCookie(context.request, COOKIE_NAME);
  if (token) {
    const db = getDb(context.env);
    const payload = await verifySession(token, await sessionSecret(context.env, db));
    if (payload) {
      const pv = (await getSetting(db, 'password_ver')) || '0';
      result = String(payload.pv) === String(pv);
    }
  }
  if (context.data) context.data.isAdmin = result;
  return result;
}

/** Throws 401 unless the request carries a valid admin session. */
export async function requireAdmin(context) {
  if (!(await isAdmin(context))) throw new HttpError(401, 'يجب تسجيل الدخول كمدير لتنفيذ هذا الإجراء.');
}
