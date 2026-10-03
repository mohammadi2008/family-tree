/**
 * admin.js — login, change password, site settings, backup & restore.
 */
import { h, openModal, formError, toast, confirmDialog, downloadBlob } from './ui.js';
import { api } from './api.js';
import { byteChunks, checkBackupStructure } from './backup.js';

function passwordField(label, autocomplete, id) {
  const input = h('input', { class: 'input', type: 'password', id, attrs: { autocomplete, maxlength: '128', dir: 'ltr', required: true } });
  const toggle = h('button', { type: 'button', class: 'pw-toggle', text: 'إظهار', attrs: { 'aria-label': 'إظهار كلمة المرور' } });
  toggle.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    toggle.textContent = input.type === 'password' ? 'إظهار' : 'إخفاء';
  });
  return { el: h('div', { class: 'field' }, h('label', { class: 'label', attrs: { for: id }, text: label }), h('div', { class: 'pw-wrap' }, input, toggle)), input };
}

export function openLogin(onSuccess) {
  const pw = passwordField('كلمة مرور المدير', 'current-password', 'login-pw');
  const form = h('form', { class: 'form', attrs: { novalidate: true } },
    h('p', { class: 'hint', text: 'تسجيل الدخول مخصص لمدير الموقع لإضافة الأشخاص وتعديلهم.' }), pw.el);
  const submit = async () => {
    if (!pw.input.value) { formError(form, 'أدخل كلمة المرور.'); return; }
    m.setBusy(true);
    try {
      await api.login(pw.input.value);
      m.close();
      toast('مرحبًا بك! تم تسجيل الدخول كمدير.', 'success');
      onSuccess();
    } catch (e) {
      m.setBusy(false);
      pw.input.select();
      formError(form, e.message);
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  const m = openModal({
    title: 'دخول المدير', size: 'sm', body: form,
    actions: [{ label: 'إلغاء', onClick: ({ close }) => close() }, { label: 'دخول', kind: 'primary', icon: 'login', onClick: submit }],
  });
}

export function openChangePassword() {
  const cur = passwordField('كلمة المرور الحالية', 'current-password', 'cpw-cur');
  const next = passwordField('كلمة المرور الجديدة (8 أحرف على الأقل)', 'new-password', 'cpw-new');
  const again = passwordField('تأكيد كلمة المرور الجديدة', 'new-password', 'cpw-again');
  const form = h('form', { class: 'form', attrs: { novalidate: true } }, cur.el, next.el, again.el,
    h('p', { class: 'hint', text: 'بعد التغيير سيتم تسجيل الخروج من جميع الأجهزة الأخرى.' }));
  const submit = async () => {
    if (next.input.value.length < 8) return formError(form, 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف.');
    if (next.input.value !== again.input.value) return formError(form, 'كلمتا المرور غير متطابقتين.');
    if (next.input.value === cur.input.value) return formError(form, 'اختر كلمة مرور مختلفة عن الحالية.');
    m.setBusy(true);
    try {
      await api.changePassword(cur.input.value, next.input.value);
      m.close();
      toast('تم تغيير كلمة المرور بنجاح.', 'success');
    } catch (e) { m.setBusy(false); formError(form, e.message); }
    return null;
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  const m = openModal({
    title: 'تغيير كلمة المرور', size: 'sm', body: form,
    actions: [{ label: 'إلغاء', onClick: ({ close }) => close() }, { label: 'حفظ', kind: 'primary', icon: 'key', onClick: submit }],
  });
}

export function openSiteSettings(currentTitle, currentWhatsapp, onSaved) {
  const input = h('input', { class: 'input', type: 'text', value: currentTitle, id: 'site-title-input', attrs: { maxlength: '80' } });
  const whatsapp = h('input',{class:'input',type:'tel',value:currentWhatsapp || '',id:'site-whatsapp-input',attrs:{dir:'ltr',maxlength:'15',placeholder:'989…'}});
  const form = h('form', { class: 'form', attrs: { novalidate: true } },
    h('div', { class: 'field' }, h('label', { class: 'label', attrs: { for: 'site-title-input' }, text: 'عنوان الموقع' }), input),
    h('div',{class:'field'},h('label',{class:'label',attrs:{for:'site-whatsapp-input'},text:'واتساب: رمز البلد والرقم دون + (اختياري)'}),whatsapp));
  const submit = async () => {
    m.setBusy(true);
    try { const r = await api.saveSettings(input.value,whatsapp.value); m.close(); toast('تم حفظ الإعدادات.', 'success'); onSaved(r); } catch (e) { m.setBusy(false); formError(form, e.message); }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  const m = openModal({ title: 'إعدادات الموقع', size: 'sm', body: form, actions: [{ label: 'إلغاء', onClick: ({ close }) => close() }, { label: 'حفظ', kind: 'primary', icon: 'check', onClick: submit }] });
}

/* ---------------- backup ---------------- */
export async function exportBackup() {
  const t = h('span', { text: 'جارٍ تجهيز النسخة الاحتياطية…' });
  const m = openModal({ title: 'نسخة احتياطية', size: 'sm', body: h('div', { class: 'progress-box' }, h('div', { class: 'spinner' }), t), dismissible: false });
  try {
    const data = await api.exportData();
    const { photoCount, ...head } = data;
    const json = JSON.stringify(head);
    const parts = [`${json.slice(0, -1)},"photos":[`];
    let after = 0, first = true, count = 0;
    for (;;) {
      if (!photoCount) break;
      const r = await api.exportPhotos(after,data.version);
      for (const p of r.photos) { parts.push((first ? '' : ',') + JSON.stringify(p)); first = false; count += 1; }
      t.textContent = `تنزيل الصور ${count} من ${photoCount}…`;
      if (!r.next) break;
      after = r.next;
    }
    parts.push(']}');
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob(parts, { type: 'application/json' }), `family-tree-backup-${stamp}.json`);
    toast(`تم تنزيل النسخة الاحتياطية (${data.persons.length} شخصًا، ${count} صورة).`, 'success', 5000);
  } catch (e) {
    toast(e.message || 'تعذّر إنشاء النسخة الاحتياطية.', 'error');
  } finally {
    m.close();
  }
}

/* ---------------- restore ---------------- */
export function restoreBackup(onDone) {
  const input = h('input', { type: 'file', attrs: { accept: 'application/json,.json' } });
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
      checkBackupStructure(data);
    } catch {
      toast('الملف غير صالح. اختر ملف نسخة احتياطية صادرًا من هذا الموقع.', 'error', 5000);
      return;
    }
    const photos = Array.isArray(data.photos) ? data.photos : [];
    const ok = await confirmDialog({
      title: 'استعادة نسخة احتياطية',
      message: `سيتم حذف جميع البيانات الحالية واستبدالها بمحتوى الملف: ${data.persons.length} شخصًا، ${data.marriages.length} زواجًا، ${photos.length} صورة. لا يمكن التراجع عن هذه العملية.`,
      confirmLabel: 'استبدال البيانات', danger: true,
    });
    if (!ok) return;
    const t = h('span', { text: 'جارٍ الاستعادة…' });
    const m = openModal({ title: 'استعادة نسخة احتياطية', size: 'sm', body: h('div', { class: 'progress-box' }, h('div', { class: 'spinner' }), t), dismissible: false });
    let token = null;
    try {
      const begin = await api.importPhase({phase:'begin',siteTitle:data.siteTitle,whatsappNumber:data.whatsappNumber,
        personsCount:data.persons.length,marriagesCount:data.marriages.length,photosCount:photos.length});
      token = begin.token;
      let done = 0;
      for (const rows of byteChunks(data.persons)) {
        await api.importPhase({phase:'persons',token,rows});
        done += rows.length;
        t.textContent = `استيراد الأشخاص ${done} من ${data.persons.length}…`;
      }
      for (const rows of byteChunks(data.marriages)) await api.importPhase({phase:'marriages',token,rows});
      let sent = 0;
      for (const rows of byteChunks(photos)) {
        await api.importPhase({phase:'photos',token,rows});
        sent += rows.length;
        t.textContent = `استيراد الصور ${sent} من ${photos.length}…`;
      }
      const r = await api.importPhase({phase:'finish',token});
      toast(`تمت الاستعادة بنجاح: ${r.persons} شخصًا و${r.marriages} زواجًا.`, 'success', 5000);
      onDone();
    } catch (e) {
      toast(`توقفت الاستعادة: ${e.message}. البيانات لا تُستبدل إلا عند اكتمال الحفظ؛ أعد تحميل الشجرة للتأكد ثم أعد المحاولة.`, 'error', 8000);
      onDone();
    } finally {
      m.close();
    }
  });
  input.click();
}
