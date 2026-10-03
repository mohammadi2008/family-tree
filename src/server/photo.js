/**
 * photo.js — validation of uploaded photos.
 * Photos arrive as data URLs already resized/compressed by the browser
 * (WebP, or JPEG on browsers that cannot encode WebP) and are stored as
 * base64 text in D1 (table `photos`).
 */
import { HttpError } from './http.js';
import { b64ToBytes } from './auth.js';

export const MAX_PHOTO_BYTES = 180 * 1024; // client targets ~100 KB

export function parsePhotoDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_PHOTO_BYTES * 1.4 + 100) {
    throw new HttpError(413, 'حجم الصورة كبير جدًا.');
  }
  const m = /^data:(image\/(?:webp|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) throw new HttpError(400, 'صيغة الصورة غير مدعومة (WebP أو JPEG فقط).');
  return validatePhoto(m[1], m[2]);
}

/** Validates base64 image data by size and magic bytes. */
export function validatePhoto(mime, b64) {
  let bytes;
  try { bytes = b64ToBytes(b64); } catch { throw new HttpError(400, 'بيانات الصورة تالفة.'); }
  if (bytes.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'حجم الصورة كبير جدًا.');
  const isWebp = bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((mime === 'image/webp' && !isWebp) || (mime === 'image/jpeg' && !isJpeg) || (!isWebp && !isJpeg)) {
    throw new HttpError(400, 'ملف الصورة غير صالح.');
  }
  return { mime, data: b64 };
}
