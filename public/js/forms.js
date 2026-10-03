/**
 * forms.js — admin forms: person (create/edit), add child, add spouse
 * (new or existing person — e.g. a cousin), add parent, edit marriage.
 * Client-side validation mirrors the server rules for instant feedback.
 */
import { h, openModal, formError, button } from './ui.js';
import { icon } from './icons.js';
import { createDateField } from './datefield.js';
import { pickImageFile, cropImageFile } from './photo.js';
import { avatar } from './avatar.js';
import { recordRange, todayJdn, toLatinDigits } from './calendar.js';
import { fullName, birthOf, deathOf, normalizeArabic, marriageDateOf } from './text.js';
import { partnersOf, parentsOf } from './layout.js';

let fid = 0;

function textField(label, value, { required = false, max = 60, type = 'text', dir, multiline = false, placeholder = '', autocomplete = 'off' } = {}) {
  const id = `f${++fid}`;
  const input = multiline
    ? h('textarea', { class: 'input', id, attrs: { maxlength: String(max), rows: '3', placeholder } })
    : h('input', { class: 'input', id, type, attrs: { maxlength: String(max), placeholder, autocomplete, dir, required: required || null } });
  input.value = value || '';
  const el = h('div', { class: 'field' },
    h('label', { class: 'label', attrs: { for: id } }, label, required ? h('span', { class: 'req', text: ' *', attrs: { 'aria-hidden': 'true' } }) : null),
    input);
  return { el, input };
}

function segmented(label, options, value, { disabled = false } = {}) {
  let current = value;
  const btns = new Map();
  const listeners = [];
  const group = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': label } });
  for (const [val, text, cls] of options) {
    const b = h('button', { type: 'button', class: `seg-btn ${cls || ''}`, text, attrs: { role: 'radio', 'aria-checked': String(val === current) } });
    b.disabled = disabled;
    b.addEventListener('click', () => {
      current = val;
      for (const [k, x] of btns) x.setAttribute('aria-checked', String(k === val));
      listeners.forEach((fn) => fn(val));
    });
    btns.set(val, b);
    group.append(b);
  }
  const el = h('div', { class: 'field' }, h('span', { class: 'label', text: label }), group);
  return { el, get: () => current, onChange: (fn) => listeners.push(fn) };
}

function switchField(label, checked) {
  const id = `f${++fid}`;
  const input = h('input', { type: 'checkbox', id, class: 'switch-input' });
  input.checked = !!checked;
  const el = h('label', { class: 'switch', attrs: { for: id } }, input, h('span', { class: 'switch-track', attrs: { 'aria-hidden': 'true' } }), h('span', { text: label }));
  return { el, input };
}

const section = (title, ...children) => h('fieldset', { class: 'form-section' }, h('legend', { text: title }), ...children);

/* ------------------------------------------------------------------ */
/* Person fields                                                       */
/* ------------------------------------------------------------------ */
export function buildPersonFields({ person = null, defaults = {}, prefs, lockGender = false }) {
  const v = { ...defaults, ...(person || {}) };
  const first = textField('الاسم', v.first_name, { required: true });
  const father = textField('اسم الأب', v.father_name);
  const family = textField('اسم العائلة', v.family_name);
  const gender = segmented('الجنس', [['m', 'ذكر', 'male'], ['f', 'أنثى', 'female']], v.gender || 'm', { disabled: lockGender });
  const birth = createDateField({ label: 'تاريخ الميلاد', value: person ? birthOf(person) : null, cal: prefs.inputCal });
  const deceased = switchField('متوفى', !!v.is_deceased);
  const death = createDateField({ label: 'تاريخ الوفاة', value: person ? deathOf(person) : null, cal: prefs.inputCal, hint: 'اتركه فارغًا إذا كان غير معروف.' });
  const deathWrap = h('div', { class: 'collapsible' }, death.el);
  const place = textField('مكان الميلاد', v.birth_place, { max: 100 });
  const job = textField('المهنة', v.occupation, { max: 100 });
  const phone = textField('رقم الهاتف (اختياري)', v.phone, { max: 30, type: 'tel', dir: 'ltr', placeholder: '+98…', autocomplete: 'tel' });
  const notes = textField('ملاحظات خاصة (لا تظهر للزوار)', v.notes, { max: 2000, multiline: true });

  const syncDeath = () => { deathWrap.hidden = !deceased.input.checked; };
  deceased.input.addEventListener('change', syncDeath);
  syncDeath();

  /* photo */
  const photo = { dataUrl: null, remove: false };
  const preview = h('div', { class: 'photo-preview' });
  const renderPreview = () => {
    preview.textContent = '';
    const p = { ...(person || {}), gender: gender.get(), has_photo: person && person.has_photo && !photo.remove ? 1 : 0 };
    preview.append(avatar(p, 96, photo.dataUrl || (photo.remove ? '' : undefined)));
  };
  gender.onChange(renderPreview);
  const choose = async (camera) => {
    const file = await pickImageFile({ camera });
    const url = await cropImageFile(file);
    if (url) { photo.dataUrl = url; photo.remove = false; renderPreview(); removeBtn.hidden = false; }
  };
  const removeBtn = button('إزالة', { iconName: 'trash', kind: 'ghost', cls: 'btn-sm', onClick: () => { photo.dataUrl = null; photo.remove = true; renderPreview(); removeBtn.hidden = true; } });
  removeBtn.hidden = !(person && person.has_photo);
  renderPreview();
  const photoField = h('div', { class: 'photo-field' }, preview,
    h('div', { class: 'photo-actions' },
      button('من الجهاز', { iconName: 'image', kind: 'soft', cls: 'btn-sm', onClick: () => choose(false) }),
      button('الكاميرا', { iconName: 'camera', kind: 'soft', cls: 'btn-sm', onClick: () => choose(true) }),
      removeBtn,
      h('small', { class: 'hint', text: 'تُقص الصورة دائريًا وتُضغط تلقائيًا (WebP ≈ 100 كيلوبايت).' })));

  const el = h('div', { class: 'person-fields' },
    photoField,
    section('البيانات الأساسية', h('div', { class: 'grid-2' }, first.el, father.el), h('div', { class: 'grid-2' }, family.el, gender.el)),
    section('التواريخ', birth.el, deceased.el, deathWrap),
    section('معلومات إضافية', h('div', { class: 'grid-2' }, place.el, job.el), phone.el, notes.el));

  /** Validates and returns the payload, or throws Error(message). */
  const read = () => {
    const firstName = first.input.value.trim();
    if (!firstName) { first.input.focus(); throw new Error('الاسم مطلوب.'); }
    const b = birth.getValue();
    const isDead = deceased.input.checked;
    const d = isDead ? death.getValue() : null;
    const today = todayJdn();
    if (b && recordRange(b)[0] > today) throw new Error('تاريخ الميلاد لا يمكن أن يكون في المستقبل.');
    if (d && recordRange(d)[0] > today) throw new Error('تاريخ الوفاة لا يمكن أن يكون في المستقبل.');
    if (b && d && recordRange(d)[1] < recordRange(b)[0]) throw new Error('تاريخ الوفاة يجب أن يكون بعد تاريخ الميلاد.');
    const ph = toLatinDigits(phone.input.value).trim();
    if (ph && !/^\+?[0-9][0-9\s\-()]{2,28}$/.test(ph)) throw new Error('رقم الهاتف غير صالح.');
    return {
      person: {
        first_name: firstName,
        father_name: father.input.value.trim(),
        family_name: family.input.value.trim(),
        gender: gender.get(),
        birth: b,
        is_deceased: isDead,
        death: d,
        birth_place: place.input.value.trim(),
        occupation: job.input.value.trim(),
        phone: ph,
        notes: notes.input.value.trim(),
      },
      photo: photo.dataUrl,
      removePhoto: photo.remove && !photo.dataUrl,
    };
  };
  return { el, read, gender, fields: { first, father, family } };
}

/* ------------------------------------------------------------------ */
/* Marriage fields                                                     */
/* ------------------------------------------------------------------ */
export function buildMarriageFields({ marriage = null, prefs }) {
  const date = createDateField({ label: 'تاريخ الزواج', value: marriageDateOf(marriage), cal: prefs.inputCal, hint: 'اختياري.' });
  const status = segmented('حالة الزواج', [['married', 'قائم'], ['divorced', 'منفصلان (طلاق)']], (marriage && marriage.status) || 'married');
  const el = section('بيانات الزواج', date.el, status.el);
  const read = () => {
    const d = date.getValue();
    if (d && recordRange(d)[0] > todayJdn()) throw new Error('تاريخ الزواج لا يمكن أن يكون في المستقبل.');
    return { date: d, status: status.get() };
  };
  return { el, read };
}

/* ------------------------------------------------------------------ */
/* Divorce section (edit form of a married woman)                      */
/* ------------------------------------------------------------------ */
/**
 * One switch per marriage of the woman. The marriage row is shared by both
 * spouses, so saving it updates the husband's record as well. Nothing is
 * deleted and no parent-child link is touched.
 */
export function buildDivorceSection({ person, graph }) {
  if (!person || person.gender !== 'f') return null;
  const rows = partnersOf(graph, person.id)
    .filter((pt) => pt.marriage && graph.byId.get(pt.spouseId))
    .map((pt) => ({ marriage: pt.marriage, husband: graph.byId.get(pt.spouseId), sw: switchField(`منفصلان (طلاق) من ${fullName(graph.byId.get(pt.spouseId))}`, pt.marriage.status === 'divorced') }));
  if (!rows.length) return null;
  const el = section('الطلاق', ...rows.map((r) => r.sw.el),
    h('small', { class: 'hint', text: 'يُحفظ الطلاق في سجل الزواج لدى الزوجين معًا. لا يُحذف أي شخص، ويبقى الأبناء مرتبطين بوالديهم.' }));
  /** Only marriages whose status actually changed. */
  const read = () => rows
    .map((r) => ({ marriage: r.marriage, status: r.sw.input.checked ? 'divorced' : 'married' }))
    .filter((x) => x.status !== (x.marriage.status === 'divorced' ? 'divorced' : 'married'));
  return { el, read };
}

/* ------------------------------------------------------------------ */
/* Generic person dialog                                               */
/* ------------------------------------------------------------------ */
/**
 * onSubmit(payload) must return a Promise; errors are shown inline.
 */
export function openPersonForm({ title, submitLabel = 'حفظ', person, defaults, prefs, lockGender, top, bottom, onSubmit, beforeRead }) {
  const fields = buildPersonFields({ person, defaults, prefs, lockGender });
  const form = h('form', { class: 'form', attrs: { novalidate: true } }, top || null, fields.el, bottom || null);
  const m = openModal({
    title, size: 'lg', body: form,
    actions: [
      { label: 'إلغاء', onClick: ({ close }) => close() },
      { label: submitLabel, kind: 'primary', icon: 'check', onClick: () => submit() },
    ],
  });
  const submit = async () => {
    let payload;
    try {
      payload = fields.read();
      if (beforeRead) Object.assign(payload, beforeRead());
    } catch (e) { formError(form, e.message); return; }
    formError(form, null);
    m.setBusy(true);
    try {
      await onSubmit(payload);
      m.close(true);
    } catch (e) {
      m.setBusy(false);
      formError(form, e.message || 'تعذّر الحفظ.');
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  return { modal: m, fields };
}

/* ------------------------------------------------------------------ */
/* Add child                                                           */
/* ------------------------------------------------------------------ */
export function openAddChild({ parent, graph, prefs, onSubmit, onAddSpouseFirst }) {
  const partners = partnersOf(graph, parent.id).map((x) => graph.byId.get(x.spouseId)).filter(Boolean);
  const select = h('select', { class: 'input', id: `f${++fid}` });
  for (const s of partners) select.append(h('option', { value: String(s.id), text: fullName(s) }));
  select.append(h('option', { value: '', text: 'غير معروف / غير مسجّل' }));
  // prefer the current (non-divorced) spouse
  const current = partnersOf(graph, parent.id).find((x) => !x.marriage || x.marriage.status !== 'divorced');
  select.value = current ? String(current.spouseId) : partners[0] ? String(partners[0].id) : '';

  const otherLabel = parent.gender === 'm' ? 'الأم' : 'الأب';
  const top = h('div', { class: 'form-intro' },
    h('div', { class: 'field' }, h('label', { class: 'label', attrs: { for: select.id }, text: `${otherLabel} (الوالد الآخر)` }), select),
    !partners.length ? h('div', { class: 'note' },
      h('span', { text: `لا يوجد ${parent.gender === 'm' ? 'زوجة مسجلة' : 'زوج مسجل'} لهذا الشخص. ` }),
      button(parent.gender === 'm' ? 'إضافة زوجة أولًا' : 'إضافة زوج أولًا', { iconName: 'heart', kind: 'soft', cls: 'btn-sm', onClick: () => { ref.modal.close(); onAddSpouseFirst(); } })) : null);

  const defaultsFor = () => {
    const other = select.value ? graph.byId.get(Number(select.value)) : null;
    const father = parent.gender === 'm' ? parent : other;
    return { father_name: father ? father.first_name : '', family_name: father ? father.family_name : parent.family_name };
  };
  const ref = openPersonForm({
    title: `إضافة ابن/ابنة لـ ${parent.first_name}`,
    submitLabel: 'إضافة',
    defaults: { gender: 'm', ...defaultsFor() },
    prefs, top,
    beforeRead: () => ({ otherParentId: select.value ? Number(select.value) : null }),
    onSubmit,
  });
  // keep auto-filled names in sync with the chosen other parent (until edited by hand)
  const { father, family } = ref.fields.fields;
  let touched = false;
  [father.input, family.input].forEach((i) => i.addEventListener('input', () => { touched = true; }));
  select.addEventListener('change', () => {
    if (touched) return;
    const d = defaultsFor();
    father.input.value = d.father_name;
    family.input.value = d.family_name;
  });
  return ref;
}

/* ------------------------------------------------------------------ */
/* Add spouse (new person or existing person)                          */
/* ------------------------------------------------------------------ */
function ancestorsOf(graph, id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const { father, mother } = parentsOf(graph, stack.pop());
    for (const p of [father, mother]) if (p && !out.has(p.id)) { out.add(p.id); stack.push(p.id); }
  }
  return out;
}

export function spouseCandidates(graph, person) {
  const anc = ancestorsOf(graph, person.id);
  const partners = new Set(partnersOf(graph, person.id).map((x) => x.spouseId));
  const myParents = [person.father_id, person.mother_id].filter((x) => x != null && graph.byId.has(x));
  return graph.persons.filter((p) => {
    if (p.id === person.id || p.gender === person.gender || partners.has(p.id) || anc.has(p.id)) return false;
    if (ancestorsOf(graph, p.id).has(person.id)) return false;
    const pp = [p.father_id, p.mother_id].filter((x) => x != null);
    return !pp.some((x) => myParents.includes(x));
  });
}

export function openAddSpouse({ person, graph, prefs, onCreate, onLink }) {
  const spouseGender = person.gender === 'm' ? 'f' : 'm';
  const word = spouseGender === 'f' ? 'زوجة' : 'زوج';
  let mode = 'new';

  const marriage = buildMarriageFields({ prefs });
  const fields = buildPersonFields({ defaults: { gender: spouseGender }, prefs });

  /* existing-person picker */
  const candidates = spouseCandidates(graph, person);
  const query = h('input', { class: 'input', type: 'search', attrs: { placeholder: 'ابحث بالاسم…', 'aria-label': 'ابحث عن شخص موجود' } });
  const list = h('div', { class: 'pick-list', attrs: { role: 'listbox', 'aria-label': 'الأشخاص المتاحون' } });
  let picked = null;
  const describe = (p) => {
    const { father, mother } = parentsOf(graph, p.id);
    if (father) return `${p.gender === 'f' ? 'ابنة' : 'ابن'} ${fullName(father)}`;
    if (mother) return `${p.gender === 'f' ? 'ابنة' : 'ابن'} ${fullName(mother)}`;
    return '';
  };
  const renderList = () => {
    const q = normalizeArabic(query.value);
    list.textContent = '';
    const items = candidates.filter((p) => !q || normalizeArabic(fullName(p)).includes(q)).slice(0, 60);
    if (!items.length) list.append(h('div', { class: 'empty-mini', text: 'لا يوجد أشخاص مطابقون.' }));
    for (const p of items) {
      const row = h('button', { type: 'button', class: `pick-row ${picked === p.id ? 'active' : ''}`, attrs: { role: 'option', 'aria-selected': String(picked === p.id) } },
        avatar(p, 36), h('span', { class: 'pick-text' }, h('strong', { text: fullName(p) }), h('small', { text: describe(p) })),
        picked === p.id ? icon('check') : null);
      row.addEventListener('click', () => { picked = p.id; renderList(); });
      list.append(row);
    }
  };
  query.addEventListener('input', renderList);
  renderList();
  const existingPanel = h('div', { class: 'tab-panel' },
    h('p', { class: 'hint', text: `اختر شخصًا موجودًا في الشجرة (مثل ابن/ابنة العم). سيظهر في مكانه الأصلي وبجانب ${person.first_name}، وعند الضغط عليه يومض ظهوره الآخر.` }),
    query, list);
  existingPanel.hidden = true;
  const newPanel = h('div', { class: 'tab-panel' }, fields.el);

  const tabs = segmented('', [['new', `${word} جديد${spouseGender === 'f' ? 'ة' : ''}`], ['existing', 'شخص موجود في الشجرة']], 'new');
  tabs.el.classList.add('tabs-field');
  tabs.onChange((v) => { mode = v; newPanel.hidden = v !== 'new'; existingPanel.hidden = v !== 'existing'; if (v === 'existing') query.focus(); });

  const form = h('form', { class: 'form', attrs: { novalidate: true } }, tabs.el, newPanel, existingPanel, marriage.el);
  const m = openModal({
    title: `إضافة ${word} لـ ${person.first_name}`, size: 'lg', body: form,
    actions: [
      { label: 'إلغاء', onClick: ({ close }) => close() },
      { label: 'إضافة', kind: 'primary', icon: 'check', onClick: () => submit() },
    ],
  });
  const submit = async () => {
    let mar;
    try {
      mar = marriage.read();
      if (mode === 'new') {
        const payload = fields.read();
        if (payload.person.gender === person.gender) throw new Error('يجب أن يكون الزوجان من جنسين مختلفين.');
        formError(form, null);
        m.setBusy(true);
        await onCreate(payload, mar);
      } else {
        if (!picked) throw new Error('اختر شخصًا من القائمة.');
        formError(form, null);
        m.setBusy(true);
        await onLink(picked, mar);
      }
      m.close(true);
    } catch (e) {
      m.setBusy(false);
      formError(form, e.message || 'تعذّر الحفظ.');
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

/* ------------------------------------------------------------------ */
/* Add parent                                                          */
/* ------------------------------------------------------------------ */
export function openAddParent({ child, graph, prefs, onSubmit }) {
  const { father, mother } = parentsOf(graph, child.id);
  const gender = father ? 'f' : 'm';
  const other = father || mother;
  const marry = switchField(other ? `تسجيل زواج مع ${fullName(other)}` : '', true);
  const ref = openPersonForm({
    title: `إضافة ${gender === 'm' ? 'الأب' : 'الأم'} لـ ${child.first_name}`,
    submitLabel: 'إضافة',
    defaults: { gender, family_name: gender === 'm' ? child.family_name : '', first_name: gender === 'm' ? child.father_name : '' },
    lockGender: !!(father || mother),
    prefs,
    top: other ? h('div', { class: 'form-intro' }, marry.el) : null,
    beforeRead: () => ({ marryOther: other ? marry.input.checked : false }),
    onSubmit,
  });
  return ref;
}

/* ------------------------------------------------------------------ */
/* Edit marriage                                                       */
/* ------------------------------------------------------------------ */
export function openMarriageForm({ marriage, husband, wife, prefs, onSave, onDelete }) {
  const fields = buildMarriageFields({ marriage, prefs });
  const form = h('form', { class: 'form', attrs: { novalidate: true } },
    h('p', { class: 'form-intro strong', text: `${fullName(husband)} و ${fullName(wife)}` }), fields.el);
  const m = openModal({
    title: 'تعديل بيانات الزواج', size: 'md', body: form,
    actions: [
      { label: 'فك الارتباط', kind: 'danger-ghost', icon: 'trash', onClick: async () => { m.setBusy(true); try { if (await onDelete()) m.close(true); else m.setBusy(false); } catch (e) { m.setBusy(false); formError(form, e.message); } } },
      { label: 'إلغاء', onClick: ({ close }) => close() },
      { label: 'حفظ', kind: 'primary', icon: 'check', onClick: async () => { try { const v = fields.read(); m.setBusy(true); await onSave(v); m.close(true); } catch (e) { m.setBusy(false); formError(form, e.message); } } },
    ],
  });
}
