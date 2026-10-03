/**
 * validate.js — server-side validation & sanitization of all user input.
 * The client validates too, but the server is the source of truth.
 */
import { HttpError } from './http.js';
import { normalizeRecord, recordRange, todayJdn, toLatinDigits, DateError } from '../../public/js/calendar.js';

const LIMITS = {
  first_name: 60, father_name: 60, family_name: 60,
  birth_place: 100, occupation: 100, phone: 30, notes: 2000,
};

const FIELD_LABELS = {
  first_name: 'الاسم', father_name: 'اسم الأب', family_name: 'اسم العائلة',
  birth_place: 'مكان الميلاد', occupation: 'المهنة', phone: 'رقم الهاتف', notes: 'الملاحظات',
  birth: 'تاريخ الميلاد', death: 'تاريخ الوفاة', marriage: 'تاريخ الزواج',
};

// Control characters (except tab/newline) and bidi-override characters that can spoof text.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

export function cleanText(value, field, { required = false, multiline = false } = {}) {
  if (value == null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${FIELD_LABELS[field]}: قيمة غير صالحة.`);
  let v = value.normalize('NFC').replace(CONTROL_RE, '');
  v = multiline ? v.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : v.replace(/\s+/g, ' ').trim();
  if (required && !v) throw new HttpError(400, `${FIELD_LABELS[field]} مطلوب.`);
  if (v.length > LIMITS[field]) throw new HttpError(400, `${FIELD_LABELS[field]} طويل جدًا (الحد ${LIMITS[field]} حرفًا).`);
  return v;
}

const DATE_MESSAGES = {
  BAD_YEAR: 'السنة غير صالحة', BAD_MONTH: 'الشهر غير صالح', BAD_DAY: 'اليوم غير صالح لهذا الشهر',
  DAY_WITHOUT_MONTH: 'لا يمكن تحديد اليوم دون الشهر', BAD_CALENDAR: 'نوع التقويم غير صالح', BAD_DATE: 'التاريخ غير صالح',
};

export function cleanDate(value, field) {
  try {
    return normalizeRecord(value);
  } catch (e) {
    const msg = e instanceof DateError ? DATE_MESSAGES[e.code] || DATE_MESSAGES.BAD_DATE : DATE_MESSAGES.BAD_DATE;
    throw new HttpError(400, `${FIELD_LABELS[field]}: ${msg}.`);
  }
}

/** Validates the editable fields of a person. Returns DB-ready values. */
export function validatePerson(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'بيانات الشخص مفقودة.');
  const gender = input.gender;
  if (gender !== 'm' && gender !== 'f') throw new HttpError(400, 'الجنس مطلوب.');

  const birth = cleanDate(input.birth, 'birth');
  const isDeceased = input.is_deceased === true || input.is_deceased === 1;
  const death = isDeceased ? cleanDate(input.death, 'death') : null;
  const today = todayJdn() + 1; // +1 day tolerance for time zones

  if (birth && recordRange(birth)[0] > today) throw new HttpError(400, 'تاريخ الميلاد لا يمكن أن يكون في المستقبل.');
  if (death && recordRange(death)[0] > today) throw new HttpError(400, 'تاريخ الوفاة لا يمكن أن يكون في المستقبل.');
  if (birth && death && recordRange(death)[1] < recordRange(birth)[0]) {
    throw new HttpError(400, 'تاريخ الوفاة يجب أن يكون بعد تاريخ الميلاد.');
  }

  let phone = cleanText(toLatinDigits(input.phone), 'phone');
  if (phone && !/^\+?[0-9][0-9\s\-()]{2,28}$/.test(phone)) throw new HttpError(400, 'رقم الهاتف غير صالح.');

  return {
    first_name: cleanText(input.first_name, 'first_name', { required: true }),
    father_name: cleanText(input.father_name, 'father_name'),
    family_name: cleanText(input.family_name, 'family_name'),
    gender,
    birth_date: birth ? birth.date : null, birth_prec: birth ? birth.prec : null, birth_cal: birth ? birth.cal : null,
    is_deceased: isDeceased ? 1 : 0,
    death_date: death ? death.date : null, death_prec: death ? death.prec : null, death_cal: death ? death.cal : null,
    birth_place: cleanText(input.birth_place, 'birth_place'),
    occupation: cleanText(input.occupation, 'occupation'),
    phone,
    notes: cleanText(input.notes, 'notes', { multiline: true }),
  };
}

/** Validates marriage details (date + status). */
export function validateMarriage(input) {
  const m = input && typeof input === 'object' ? input : {};
  const date = cleanDate(m.date, 'marriage');
  if (date && recordRange(date)[0] > todayJdn() + 1) throw new HttpError(400, 'تاريخ الزواج لا يمكن أن يكون في المستقبل.');
  const status = m.status === 'divorced' ? 'divorced' : 'married';
  let sort = Number(m.sort_order ?? 0);
  if (!Number.isInteger(sort) || sort < 0 || sort > 99) sort = 0;
  return {
    marriage_date: date ? date.date : null, marriage_prec: date ? date.prec : null, marriage_cal: date ? date.cal : null,
    status, sort_order: sort,
  };
}

/** Reject a marriage outside the spouses' known lifespans. Partial dates may overlap. */
export function assertMarriageAfterBirth(marriage, ...persons) {
  if (!marriage.marriage_date) return;
  const m = recordRange({ date: marriage.marriage_date, prec: marriage.marriage_prec, cal: marriage.marriage_cal });
  for (const p of persons) {
    if (p && p.birth_date) {
      const b = recordRange({ date: p.birth_date, prec: p.birth_prec, cal: p.birth_cal });
      if (m[1] < b[0]) throw new HttpError(400, 'تاريخ الزواج يجب أن يكون بعد تاريخ ميلاد الزوجين.');
    }
    if (p && p.is_deceased && p.death_date) {
      const d = recordRange({ date: p.death_date, prec: p.death_prec, cal: p.death_cal });
      if (m[0] > d[1]) throw new HttpError(400, 'تاريخ الزواج لا يمكن أن يكون بعد وفاة أحد الزوجين.');
    }
  }
}
