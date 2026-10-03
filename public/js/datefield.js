/**
 * datefield.js — date input supporting Jalali (Shamsi) and Gregorian calendars
 * and partial dates (year only / month + year).
 */
import { h } from './ui.js';
import {
  MONTHS, CAL_NAME, makeRecord, recordParts, isoToJdn, jdnToParts, toLatinDigits, DateError, formatRecord,
} from './calendar.js';

const MSG = {
  BAD_YEAR: 'السنة غير صالحة', BAD_MONTH: 'الشهر غير صالح', BAD_DAY: 'اليوم غير صالح لهذا الشهر',
  DAY_WITHOUT_MONTH: 'اختر الشهر عند تحديد اليوم', BAD_DATE: 'التاريخ غير صالح', NO_YEAR: 'أدخل السنة',
};

let uid = 0;

/**
 * @returns {{ el, getValue(): record|null, setValue(rec), setDisabled(bool), label }}
 * getValue throws Error with an Arabic message when invalid.
 */
export function createDateField({ label, value = null, cal = 'g', hint = 'يمكن ترك اليوم أو الشهر فارغًا إذا كان غير معروف.' }) {
  const id = `df${++uid}`;
  let current = value ? value.cal : cal;
  // Partial dates are intervals in their ORIGINAL calendar.
  let preservedPartial = value && value.prec !== 'd' ? { ...value } : null;

  const day = h('input', { class: 'input date-day', type: 'text', attrs: { inputmode: 'numeric', maxlength: '2', placeholder: 'اليوم', 'aria-label': `${label}: اليوم`, autocomplete: 'off' } });
  const month = h('select', { class: 'input date-month', attrs: { 'aria-label': `${label}: الشهر` } });
  const year = h('input', { class: 'input date-year', type: 'text', attrs: { inputmode: 'numeric', maxlength: '4', placeholder: 'السنة', 'aria-label': `${label}: السنة`, autocomplete: 'off' } });
  const preview = h('div', { class: 'date-preview', attrs: { 'aria-live': 'polite' } });

  const fillMonths = () => {
    const sel = month.value;
    month.textContent = '';
    month.append(h('option', { value: '', text: 'الشهر' }));
    MONTHS[current].forEach((name, i) => month.append(h('option', { value: String(i + 1), text: `${i + 1} - ${name}` })));
    month.value = sel;
  };

  const calBtns = {};
  const seg = h('div', { class: 'seg seg-sm', attrs: { role: 'radiogroup', 'aria-label': 'نوع التقويم' } });
  for (const c of ['j', 'g']) {
    const b = h('button', { type: 'button', class: 'seg-btn', text: CAL_NAME[c], attrs: { role: 'radio', 'aria-checked': String(c === current) } });
    b.addEventListener('click', () => switchCal(c));
    calBtns[c] = b;
    seg.append(b);
  }

  const setParts = (p) => {
    year.value = p.y ? String(p.y) : '';
    month.value = p.m ? String(p.m) : '';
    day.value = p.d ? String(p.d) : '';
  };

  const readRaw = () => ({
    y: toLatinDigits(year.value).trim(),
    m: month.value,
    d: toLatinDigits(day.value).trim(),
  });

  const getValue = () => {
    if (preservedPartial) return { ...preservedPartial };
    const { y, m, d } = readRaw();
    if (!y && !m && !d) return null;
    if (!y) throw new Error(`${label}: ${MSG.NO_YEAR}`);
    if (!/^\d{1,4}$/.test(y) || (d && !/^\d{1,2}$/.test(d))) throw new Error(`${label}: ${MSG.BAD_DATE}`);
    try {
      return makeRecord(current, Number(y), m ? Number(m) : 0, d ? Number(d) : 0);
    } catch (e) {
      throw new Error(`${label}: ${e instanceof DateError ? MSG[e.code] || MSG.BAD_DATE : MSG.BAD_DATE}`);
    }
  };

  const updatePreview = () => {
    let text = '';
    try {
      const rec = getValue();
      if (rec) {
        const other = current === 'g' ? 'j' : 'g';
        text = `يعادل: ${formatRecord(rec, other)}`;
      }
    } catch (e) { text = ''; }
    preview.textContent = text;
  };

  function switchCal(c) {
    if (c === current) return;
    let rec = null;
    try { rec = getValue(); } catch { rec = null; }
    if (rec && rec.prec !== 'd') {
      preservedPartial = { ...rec };
      preview.textContent = `التاريخ الجزئي محفوظ بتقويمه الأصلي: ${formatRecord(rec, rec.cal)}. يعادل: ${formatRecord(rec, c)}. لتغييره عدّل الحقول صراحة.`;
      return;
    }
    current = c;
    for (const k of Object.keys(calBtns)) calBtns[k].setAttribute('aria-checked', String(k === c));
    fillMonths();
    if (rec) {
      const p = jdnToParts(c, isoToJdn(rec.date));
      setParts({ y: p.y, m: rec.prec === 'y' ? 0 : p.m, d: rec.prec === 'd' ? p.d : 0 });
    }
    updatePreview();
  }

  const setValue = (rec) => {
    preservedPartial = rec && rec.prec !== 'd' ? { ...rec } : null;
    if (rec) {
      current = rec.cal;
      for (const k of Object.keys(calBtns)) calBtns[k].setAttribute('aria-checked', String(k === current));
      fillMonths();
      setParts(recordParts(rec));
    } else {
      fillMonths();
      setParts({ y: 0, m: 0, d: 0 });
    }
    updatePreview();
  };

  const edited = () => { preservedPartial = null; updatePreview(); };
  [day, month, year].forEach((i) => i.addEventListener('input', edited));
  [day, month, year].forEach((i) => i.addEventListener('change', edited));

  const el = h('div', { class: 'field date-field', attrs: { role: 'group', 'aria-labelledby': `${id}-l` } },
    h('div', { class: 'field-head' }, h('span', { class: 'label', id: `${id}-l`, text: label }), seg),
    h('div', { class: 'date-inputs' }, day, month, year),
    preview,
    hint ? h('small', { class: 'hint', text: hint }) : null);

  setValue(value);
  return {
    el, getValue, setValue, label,
    setDisabled(flag) { [day, month, year].forEach((i) => { i.disabled = flag; }); Object.values(calBtns).forEach((b) => { b.disabled = flag; }); },
  };
}
