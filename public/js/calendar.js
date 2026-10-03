/**
 * calendar.js
 * ------------------------------------------------------------------
 * Shared calendar utilities used by BOTH the browser and the server
 * (Pages Functions import this file directly), so validation and
 * display always agree.
 *
 * A date is stored as a "date record":
 *   { date: 'YYYY-MM-DD', prec: 'y' | 'm' | 'd', cal: 'g' | 'j' }
 *   - date : ISO Gregorian date of the FIRST day of the known period
 *            (e.g. Jalali year 1403 only  ->  '2024-03-20').
 *   - prec : how much is known: year only, year+month, or full date.
 *   - cal  : the calendar the date was entered in (g = Gregorian,
 *            j = Jalali/Shamsi) so partial dates round-trip exactly.
 *
 * Jalali conversion uses the Borkowski algorithm (same as jalaali-js),
 * accurate for Jalali years 1..3177 including all leap years.
 */

/* ---------------- integer helpers ---------------- */
const div = (a, b) => ~~(a / b);
const mod = (a, b) => a - ~~(a / b) * b;
const pad = (n, w = 2) => String(n).padStart(w, '0');

/* ---------------- Julian Day Number <-> Gregorian ---------------- */
export function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

export function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { y: gy, m: gm, d: gd };
}

/* ---------------- Jalali core ---------------- */
const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210,
  1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

function jalCal(jy, withoutLeap) {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14, jp = BREAKS[0], jm, jump = 0, n, i;
  if (jy < jp || jy >= BREAKS[bl - 1]) throw new Error('JALALI_RANGE');
  for (i = 1; i < bl; i += 1) {
    jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (withoutLeap) return { gy, march };
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

export function j2d(jy, jm, jd) {
  const r = jalCal(jy, true);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

export function d2j(jdn) {
  const gy = d2g(jdn).y;
  let jy = gy - 621;
  const r = jalCal(jy, false);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f, jm, jd;
  if (k >= 0) {
    if (k <= 185) {
      jm = 1 + div(k, 31);
      jd = mod(k, 31) + 1;
      return { y: jy, m: jm, d: jd };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  jm = 7 + div(k, 30);
  jd = mod(k, 30) + 1;
  return { y: jy, m: jm, d: jd };
}

/* ---------------- calendar facts ---------------- */
export const isLeapG = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const isLeapJ = (y) => jalCal(y, false).leap === 0;

export function monthLength(cal, y, m) {
  if (cal === 'j') {
    if (m <= 6) return 31;
    if (m <= 11) return 30;
    return isLeapJ(y) ? 30 : 29;
  }
  return [31, isLeapG(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** Allowed year ranges per calendar (keeps conversions meaningful). */
export const YEAR_RANGE = { g: [622, 2200], j: [1, 1579] };

/** Parts {y,m,d} in calendar `cal` -> JDN */
export function partsToJdn(cal, y, m, d) {
  return cal === 'j' ? j2d(y, m, d) : g2d(y, m, d);
}
/** JDN -> parts {y,m,d} in calendar `cal` */
export function jdnToParts(cal, jdn) {
  return cal === 'j' ? d2j(jdn) : d2g(jdn);
}

export function jdnToIso(jdn) {
  const g = d2g(jdn);
  return `${pad(g.y, 4)}-${pad(g.m)}-${pad(g.d)}`;
}

export function isoToJdn(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > monthLength('g', y, mo)) return null;
  return g2d(y, mo, d);
}

/** Today's JDN in the local time of the running environment. */
export function todayJdn(now = new Date()) {
  return g2d(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/* ---------------- date records ---------------- */
export class DateError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/**
 * Build a normalized date record from calendar parts.
 * m and d may be null/0 for partial dates (d requires m).
 */
export function makeRecord(cal, y, m, d) {
  if (cal !== 'g' && cal !== 'j') throw new DateError('BAD_CALENDAR');
  y = Number(y); m = m ? Number(m) : 0; d = d ? Number(d) : 0;
  const [minY, maxY] = YEAR_RANGE[cal];
  if (!Number.isInteger(y) || y < minY || y > maxY) throw new DateError('BAD_YEAR');
  if (!Number.isInteger(m) || m < 0 || m > 12) throw new DateError('BAD_MONTH');
  if (!Number.isInteger(d) || d < 0 || d > 31) throw new DateError('BAD_DAY');
  if (d && !m) throw new DateError('DAY_WITHOUT_MONTH');
  if (d && d > monthLength(cal, y, m)) throw new DateError('BAD_DAY');
  const prec = d ? 'd' : m ? 'm' : 'y';
  const jdn = partsToJdn(cal, y, m || 1, d || 1);
  return { date: jdnToIso(jdn), prec, cal };
}

/**
 * Validate + canonicalize an untrusted record (server side and import).
 * Returns null for empty input. Throws DateError when invalid.
 */
export function normalizeRecord(rec) {
  if (rec == null || rec === '') return null;
  if (typeof rec !== 'object') throw new DateError('BAD_DATE');
  const cal = rec.cal === 'j' ? 'j' : rec.cal === 'g' ? 'g' : null;
  const prec = ['y', 'm', 'd'].includes(rec.prec) ? rec.prec : null;
  if (!cal || !prec) throw new DateError('BAD_DATE');
  const jdn = isoToJdn(rec.date);
  if (jdn == null) throw new DateError('BAD_DATE');
  const p = jdnToParts(cal, jdn);
  return makeRecord(cal, p.y, prec === 'y' ? 0 : p.m, prec === 'd' ? p.d : 0);
}

/** Parts of a record in its OWN calendar (respecting precision). */
export function recordParts(rec) {
  const p = jdnToParts(rec.cal, isoToJdn(rec.date));
  return { y: p.y, m: rec.prec === 'y' ? 0 : p.m, d: rec.prec === 'd' ? p.d : 0 };
}

/** [startJdn, endJdn] covered by a (possibly partial) record. */
export function recordRange(rec) {
  const start = isoToJdn(rec.date);
  if (rec.prec === 'd') return [start, start];
  const p = jdnToParts(rec.cal, start);
  if (rec.prec === 'm') return [start, start + monthLength(rec.cal, p.y, p.m) - 1];
  const yearLen = rec.cal === 'j' ? (isLeapJ(p.y) ? 366 : 365) : (isLeapG(p.y) ? 366 : 365);
  return [start, start + yearLen - 1];
}

/** Record as {date,prec,cal} from DB columns (null when no date). */
export function recordFromColumns(date, prec, cal) {
  if (!date) return null;
  return { date, prec: prec || 'd', cal: cal || 'g' };
}

/* ---------------- durations (age / lifespan) ---------------- */
export function diffYearsMonths(startJdn, endJdn) {
  const a = d2g(startJdn), b = d2g(endJdn);
  let years = b.y - a.y;
  let months = b.m - a.m;
  if (b.d < a.d) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  return { years: Math.max(0, years), months: Math.max(0, months) };
}

/**
 * Age for living persons, lifespan for deceased ones.
 * Returns null if it cannot be computed.
 * { kind: 'age'|'lived', years, months, approx }
 */
export function lifeInfo(birth, death, isDeceased, today = todayJdn()) {
  if (!birth) return null;
  if (isDeceased && !death) return null;
  const [bs, be] = recordRange(birth);
  let es, ee;
  if (isDeceased) [es, ee] = recordRange(death); else es = ee = today;
  const approx = bs !== be || es !== ee;
  const from = approx ? Math.floor((bs + be) / 2) : bs;
  const to = approx ? Math.floor((es + ee) / 2) : es;
  if (to < from) return null;
  const r = diffYearsMonths(from, to);
  return { kind: isDeceased ? 'lived' : 'age', years: r.years, months: approx ? 0 : r.months, approx };
}

/* ---------------- Arabic formatting ---------------- */
export const MONTHS = {
  g: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
  j: ['فروردين', 'أرديبهشت', 'خرداد', 'تير', 'مرداد', 'شهريور', 'مهر', 'آبان', 'آذر', 'دي', 'بهمن', 'اسفند'],
};
export const CAL_SUFFIX = { g: 'م', j: 'هـ.ش' };
export const CAL_NAME = { g: 'ميلادي', j: 'شمسي' };

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
/** Convert western digits to Arabic-Indic when mode === 'ar'. */
export function digits(value, mode) {
  const s = String(value);
  return mode === 'ar' ? s.replace(/[0-9]/g, (c) => AR_DIGITS[+c]) : s;
}
/** Convert Arabic-Indic / Persian digits back to western digits. */
export function toLatinDigits(s) {
  return String(s ?? '').replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, (c) => c.charCodeAt(0) - 0x06f0);
}

/**
 * Human readable Arabic date in `displayCal`.
 * Partial dates shown in a different calendar become ranges ("2024 أو 2025").
 */
export function formatRecord(rec, displayCal = 'g', digitMode = 'latin') {
  if (!rec) return '';
  const cal = displayCal === 'j' ? 'j' : 'g';
  const suf = CAL_SUFFIX[cal];
  const D = (v) => digits(v, digitMode);
  const [s, e] = recordRange(rec);
  if (rec.prec === 'd') {
    const p = jdnToParts(cal, s);
    return `${D(p.d)} ${MONTHS[cal][p.m - 1]} ${D(p.y)} ${suf}`;
  }
  const a = jdnToParts(cal, s), b = jdnToParts(cal, e);
  if (rec.cal === cal) {
    return rec.prec === 'm' ? `${MONTHS[cal][a.m - 1]} ${D(a.y)} ${suf}` : `${D(a.y)} ${suf}`;
  }
  if (rec.prec === 'y') {
    return a.y === b.y ? `${D(a.y)} ${suf}` : `${D(a.y)} أو ${D(b.y)} ${suf}`;
  }
  if (a.y === b.y && a.m === b.m) return `${MONTHS[cal][a.m - 1]} ${D(a.y)} ${suf}`;
  if (a.y === b.y) return `${MONTHS[cal][a.m - 1]}/${MONTHS[cal][b.m - 1]} ${D(a.y)} ${suf}`;
  return `${MONTHS[cal][a.m - 1]} ${D(a.y)}/${MONTHS[cal][b.m - 1]} ${D(b.y)} ${suf}`;
}

/** Year of a record in display calendar (for compact lists). */
export function recordYear(rec, displayCal = 'g') {
  if (!rec) return null;
  const [s, e] = recordRange(rec);
  const a = jdnToParts(displayCal, s).y, b = jdnToParts(displayCal, e).y;
  return a === b ? `${a}` : `${a}/${b}`;
}

function arYears(n, D) {
  const r = n % 100;
  if (n === 1) return 'سنة واحدة';
  if (n === 2) return 'سنتان';
  if (r >= 3 && r <= 10) return `${D(n)} سنوات`;
  return `${D(n)} سنة`;
}
function arMonths(n, D) {
  if (n === 1) return 'شهر واحد';
  if (n === 2) return 'شهران';
  if (n >= 3 && n <= 10) return `${D(n)} أشهر`;
  return `${D(n)} شهرًا`;
}

/** "54 سنة و3 أشهر" style duration. */
export function formatDuration(info, digitMode = 'latin') {
  if (!info) return '';
  const D = (v) => digits(v, digitMode);
  const { years, months, approx } = info;
  let text;
  if (years === 0 && months === 0) text = approx ? 'أقل من سنة' : 'أقل من شهر';
  else if (years === 0) text = arMonths(months, D);
  else if (months === 0) text = arYears(years, D);
  else text = `${arYears(years, D)} و${arMonths(months, D)}`;
  return approx ? `حوالي ${text}` : text;
}
