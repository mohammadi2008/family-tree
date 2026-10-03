/**
 * details.js — the person details panel (non-blocking glass sheet so the
 * tree, including the blinking appearance, stays visible behind it).
 */
import { h, button } from './ui.js';
import { icon } from './icons.js';
import { avatar } from './avatar.js';
import { formatRecord, lifeInfo, formatDuration, CAL_SUFFIX } from './calendar.js';
import { fullName, birthOf, deathOf, marriageDateOf, genderLabel } from './text.js';
import { parentsOf, partnersOf, childrenOf } from './layout.js';

function row(label, value, cls = '') {
  if (!value) return null;
  return h('div', { class: `info-row ${cls}` }, h('dt', { text: label }), h('dd', {}, value));
}

function chip(p, onFocus, sub) {
  const b = h('button', { type: 'button', class: 'person-chip', attrs: { title: 'عرض في الشجرة' } },
    avatar(p, 32),
    h('span', { class: 'chip-text' }, h('strong', { text: fullName(p) }), sub ? h('small', { text: sub }) : null));
  b.addEventListener('click', () => onFocus(p.id));
  return b;
}

/**
 * ctx = { graph, prefs, isAdmin, onFocus(pid), onClose(), onEdit(p), onDelete(p),
 *         onAddChild(p), onAddSpouse(p), onEditMarriage(marriage) }
 */
export function renderDetails(panel, person, ctx) {
  const { graph, prefs } = ctx;
  const cal = prefs.displayCal, dg = prefs.digits;
  const other = cal === 'g' ? 'j' : 'g';
  const birth = birthOf(person), death = deathOf(person);
  const life = lifeInfo(birth, death, !!person.is_deceased);

  const dateValue = (rec) => (rec ? h('span', { class: 'date-val' },
    h('span', { text: formatRecord(rec, cal, dg) }),
    h('small', { class: 'alt-date', text: formatRecord(rec, other, dg) })) : null);

  const { father, mother } = parentsOf(graph, person.id);
  const partners = partnersOf(graph, person.id);
  const kids = childrenOf(graph, person.id).map((id) => graph.byId.get(id)).filter(Boolean);

  panel.textContent = '';
  const close = h('button', { type: 'button', class: 'icon-btn details-close', attrs: { 'aria-label': 'إغلاق التفاصيل' } }, icon('close'));
  close.addEventListener('click', ctx.onClose);

  const header = h('div', { class: 'details-hero' },
    h('div', { class: 'details-photo' }, avatar(person, 112)),
    h('h2', { class: 'details-name', text: fullName(person) }),
    h('div', { class: 'chips' },
      h('span', { class: `tag ${person.gender === 'f' ? 'tag-female' : 'tag-male'}`, text: genderLabel(person.gender) }),
      person.is_deceased ? h('span', { class: 'tag tag-muted', text: person.gender === 'f' ? 'متوفاة' : 'متوفى' }) : null));

  let lifeRow = null;
  if (life) {
    lifeRow = life.kind === 'age'
      ? row('العمر', formatDuration(life, dg), 'highlight')
      : row(person.gender === 'f' ? 'عاشت' : 'عاش', formatDuration(life, dg), 'highlight');
  }

  const info = h('dl', { class: 'info' },
    row('تاريخ الميلاد', dateValue(birth) || h('span', { class: 'muted', text: 'غير معروف' })),
    person.is_deceased ? row('تاريخ الوفاة', dateValue(death) || h('span', { class: 'muted', text: 'غير معروف' })) : null,
    lifeRow,
    row('مكان الميلاد', person.birth_place),
    row('المهنة', person.occupation),
    ctx.isAdmin && person.phone ? row('الهاتف', h('a', { href: `tel:${person.phone.replace(/[^+0-9]/g, '')}`, text: person.phone, attrs: { dir: 'ltr' } })) : null);

  const notes = ctx.isAdmin && person.notes ? h('div', { class: 'notes' }, h('h3', { text: 'ملاحظات' }), h('p', { text: person.notes })) : null;

  const rel = h('div', { class: 'relations' });
  const group = (title, items) => {
    if (!items.length) return;
    rel.append(h('section', { class: 'rel-group' }, h('h3', { text: title }), h('div', { class: 'chip-list' }, ...items)));
  };
  group('الوالدان', [father, mother].filter(Boolean).map((p) => chip(p, ctx.onFocus, p.gender === 'm' ? 'الأب' : 'الأم')));
  const spouseTitle = person.gender === 'm' ? (partners.length > 1 ? 'الزوجات' : 'الزوجة') : (partners.length > 1 ? 'الأزواج' : 'الزوج');
  group(spouseTitle, partners.map((pt) => {
    const sp = graph.byId.get(pt.spouseId);
    const md = marriageDateOf(pt.marriage);
    const bits = [];
    if (md) bits.push(`تاريخ الزواج: ${formatRecord(md, cal, dg)}`);
    if (pt.marriage && pt.marriage.status === 'divorced') bits.push('منفصلان');
    if (sp.is_deceased) bits.push(sp.gender === 'f' ? 'متوفاة' : 'متوفى');
    const c = chip(sp, ctx.onFocus, bits.join(' · '));
    if (ctx.isAdmin && pt.marriage) {
      const edit = h('button', { type: 'button', class: 'icon-btn chip-edit', attrs: { 'aria-label': 'تعديل بيانات الزواج' } }, icon('edit'));
      edit.addEventListener('click', () => ctx.onEditMarriage(pt.marriage));
      return h('div', { class: 'chip-with-action' }, c, edit);
    }
    return c;
  }));
  group(`الأبناء (${kids.length.toLocaleString(dg === 'ar' ? 'ar-EG' : 'en-US')})`, kids.map((k) => chip(k, ctx.onFocus, k.gender === 'f' ? 'ابنة' : 'ابن')));
  if (!rel.childElementCount) rel.append(h('p', { class: 'muted', text: 'لا توجد صلات مسجلة.' }));

  const adminBar = ctx.isAdmin ? h('div', { class: 'details-actions' },
    button('تعديل', { iconName: 'edit', kind: 'soft', onClick: () => ctx.onEdit(person) }),
    button('ابن/ابنة', { iconName: 'child', kind: 'soft', onClick: () => ctx.onAddChild(person) }),
    button(person.gender === 'm' ? 'زوجة' : 'زوج', { iconName: 'heart', kind: 'soft', onClick: () => ctx.onAddSpouse(person) }),
    button('حذف', { iconName: 'trash', kind: 'danger-ghost', onClick: () => ctx.onDelete(person) })) : null;

  panel.append(h('div', { class: 'sheet-handle', attrs: { 'aria-hidden': 'true' } }), close,
    h('div', { class: 'details-scroll' }, header, info, notes, rel, adminBar,
      h('p', { class: 'cal-note', text: `التواريخ معروضة بالتقويم ${cal === 'j' ? 'الشمسي' : 'الميلادي'} (${CAL_SUFFIX[cal]})، وأسفلها ما يعادلها.` })));
}
