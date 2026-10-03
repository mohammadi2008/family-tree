/**
 * text.js — name helpers and Arabic-aware search normalization.
 */
import { recordFromColumns, toLatinDigits } from './calendar.js';

/** Full name: first + father + family (e.g. "أحمد محمد الكعبي"). */
export function fullName(p) {
  if (!p) return '';
  return [p.first_name, p.father_name, p.family_name].map((s) => (s || '').trim()).filter(Boolean).join(' ');
}

/** Short name shown on tree nodes: first + family. */
export function shortName(p) {
  if (!p) return '';
  return [p.first_name, p.family_name].map((s) => (s || '').trim()).filter(Boolean).join(' ');
}

export const birthOf = (p) => recordFromColumns(p.birth_date, p.birth_prec, p.birth_cal);
export const deathOf = (p) => recordFromColumns(p.death_date, p.death_prec, p.death_cal);
export const marriageDateOf = (m) => (m ? recordFromColumns(m.marriage_date, m.marriage_prec, m.marriage_cal) : null);

/** Normalizes Arabic/Persian text for forgiving search (hamza forms, taa marbuta, diacritics…). */
export function normalizeArabic(s) {
  return toLatinDigits(String(s || ''))
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // tashkeel + tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ىی]/g, 'ي')
    .replace(/ئ/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ة/g, 'ه')
    .replace(/ک/g, 'ك')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export const genderLabel = (g) => (g === 'f' ? 'أنثى' : 'ذكر');
export const spouseWord = (g) => (g === 'f' ? 'زوجة' : 'زوج'); // word for a spouse OF that gender
