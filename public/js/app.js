/**
 * app.js — application entry point / orchestrator.
 * Wires data loading, rendering, gestures, panels, admin actions and preferences.
 */
import { api, ApiError } from './api.js';
import { h, button, toast, openModal, confirmDialog, formError } from './ui.js';
import { icon, hydrateIcons } from './icons.js';
import { avatar } from './avatar.js';
import { loadPrefs, savePrefs, applyTheme, THEMES } from './prefs.js';
import { buildGraph, computeLayout, hitTest, partnersOf, parentsOf, descendantsOf, childrenOf, G } from './layout.js';
import { drawScene, readThemeColors, PhotoCache } from './renderer.js';
import { Viewport } from './viewport.js';
import { Minimap } from './minimap.js';
import { renderDetails } from './details.js';
import { openPersonForm, openAddChild, openAddSpouse, openAddParent, openMarriageForm, buildDivorceSection } from './forms.js';
import { openPdfDialog } from './pdf.js';
import { openLogin, openChangePassword, openSiteSettings, exportBackup, restoreBackup } from './admin.js';
import { setupSearch } from './search.js';
import { fullName, shortName, marriageDateOf } from './text.js';

const WHATSAPP_TEXT = 'السلام عليكم، أتواصل معكم بخصوص موقع شجرة العائلة.';
const BLINK_MS = 4500;

const $ = (id) => document.getElementById(id);
const state = {
  data: null, graph: null, layout: null,
  isAdmin: false, siteTitle: 'شجرة العائلة',
  selectedKey: null, selectedPid: null, blink: null,
  prefs: loadPrefs(), collapsed: new Set(), colors: null,
  panel: null, // 'details' | 'actions' | null
};
state.collapsed = new Set(state.prefs.collapsed);

let canvas, ctx, viewport, photos, minimap, search;
let raf = 0;
let loadSequence = 0;

/* ================================================================== */
/* Rendering loop                                                      */
/* ================================================================== */
function schedule() { if (!raf) raf = requestAnimationFrame(frame); }

function frame(now) {
  raf = 0;
  const pr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = canvas.clientWidth, hgt = canvas.clientHeight;
  if (canvas.width !== Math.round(w * pr) || canvas.height !== Math.round(hgt * pr)) {
    canvas.width = Math.round(w * pr);
    canvas.height = Math.round(hgt * pr);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.blink && now > state.blink.until) state.blink = null;
  if (state.layout && state.layout.nodes.length) {
    drawScene(ctx, {
      layout: state.layout, scale: viewport.scale, tx: viewport.tx, ty: viewport.ty,
      width: w, height: hgt, pr, colors: state.colors, photos,
      selectedKey: state.selectedKey, blink: state.blink, time: now,
    });
    minimap.draw();
  }
  if (state.blink) schedule();
}

/* ================================================================== */
/* Data                                                                */
/* ================================================================== */
function showOverlay(kind, opts = {}) {
  const o = $('state-overlay');
  o.textContent = '';
  o.hidden = !kind;
  o.className = `state-overlay ${kind || ''}`;
  if (!kind) return;
  if (kind === 'loading') {
    o.append(h('div', { class: 'crystal-loader', attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span')),
      h('p', { text: 'جارٍ تحميل شجرة العائلة…' }));
  } else if (kind === 'error') {
    o.append(h('div', { class: 'state-card glass' },
      h('div', { class: 'state-icon' }, icon('info')),
      h('h2', { text: 'تعذّر تحميل الشجرة' }),
      h('p', { text: opts.message || 'حدث خطأ غير متوقع.' }),
      button('إعادة المحاولة', { kind: 'primary', iconName: 'target', onClick: () => load(true) })));
  } else if (kind === 'empty') {
    o.append(h('div', { class: 'state-card glass' },
      h('div', { class: 'state-icon big' }, icon('tree')),
      h('h2', { text: 'الشجرة فارغة حاليًا' }),
      state.isAdmin
        ? h('p', { text: 'ابدأ بإضافة الشخص الأول (الجد الأكبر)، ثم أضف الأبناء والأزواج بالضغط على أي شخص في الشجرة.' })
        : h('p', { text: 'لم يُضِف مدير الموقع أي أفراد بعد. عُد لاحقًا أو تواصل مع المدير.' }),
      state.isAdmin
        ? button('إضافة الشخص الأول', { kind: 'primary', iconName: 'plus', onClick: addRoot })
        : button('دخول المدير', { kind: 'soft', iconName: 'login', onClick: () => openLogin(() => load()) })));
  }
}

async function load(first = false) {
  const sequence = ++loadSequence;
  if (first) showOverlay('loading');
  try {
    const tree = await api.tree();
    if (sequence !== loadSequence) return;
    if (state.isAdmin && !tree.isAdmin) clearSelection();
    state.data = tree;
    state.isAdmin = !!tree.isAdmin;
    state.siteTitle = tree.siteTitle || 'شجرة العائلة';
    rebuild();
    if (first || !state.didInitialView) initialView();
  } catch (e) {
    if (sequence !== loadSequence) return;
    showOverlay('error', { message: e.message });
  }
}

// Never leave private fields searchable/renderable after an auth transition,
// even when the following public refresh fails.
function clearAdminData() {
  ++loadSequence;
  state.isAdmin = false;
  clearSelection();
  if (state.data) {
    state.data = { ...state.data, isAdmin: false,
      persons: state.data.persons.map(p => ({ ...p, phone: '', notes: '' })) };
    rebuild();
  } else updateChrome();
}

function rebuild() {
  const { persons, marriages } = state.data;
  state.graph = buildGraph(persons, marriages);
  for (const id of [...state.collapsed]) if (!state.graph.byId.has(id)) state.collapsed.delete(id);
  state.layout = computeLayout(state.graph, { collapsed: state.collapsed });
  minimap.setLayout(state.layout, state.colors);
  // keep selection if still visible
  if (state.selectedKey && !state.layout.byKey.has(state.selectedKey)) {
    const alt = state.selectedPid != null && state.layout.appearances.get(state.selectedPid);
    state.selectedKey = alt ? alt[0].key : null;
    if (!alt) state.selectedPid = null;
  }
  if (state.selectedPid != null && !state.graph.byId.has(state.selectedPid)) closePanels();
  if (state.panel === 'details' && state.selectedPid != null) openDetails(state.graph.byId.get(state.selectedPid), false);
  updateChrome();
  showOverlay(persons.length ? null : 'empty');
  if (search) search.rebuildIndex();
  schedule();
}

function initialView() {
  const L = state.layout;
  if (!L || !L.nodes.length) return;
  state.didInitialView = true;
  updateInsets();
  const s = viewport.scaleToFit(L.bounds, 40);
  if (s >= 0.3) viewport.fit(L.bounds, { padding: 40, maxScale: 1, duration: 0 });
  else {
    // big tree: start at the top generation, readable zoom
    const root = L.nodes.reduce((a, n) => (n.y < a.y || (n.y === a.y && n.x > a.x) ? n : a), L.nodes[0]);
    const v = viewport.visibleRect();
    const sc = 0.75;
    viewport.set(sc, v.x + v.w / 2 - root.x * sc, v.y + 40 - (root.y - G.R - 20) * sc);
  }
}

/* ================================================================== */
/* Chrome (title, admin state, drawer)                                 */
/* ================================================================== */
function updateChrome() {
  $('site-title').textContent = state.siteTitle;
  const number = state.data?.whatsappNumber || '';
  document.querySelectorAll('[data-whatsapp]').forEach(a => {
    a.hidden = !number;
    if (number) a.href = `https://wa.me/${number}?text=${encodeURIComponent(WHATSAPP_TEXT)}`;
    else a.removeAttribute('href');
  });
  document.title = state.siteTitle;
  document.body.classList.toggle('is-admin', state.isAdmin);
  $('admin-badge').hidden = !state.isAdmin;
  document.querySelectorAll('[data-admin]').forEach((el) => { el.hidden = el.dataset.admin === 'in' ? !state.isAdmin : state.isAdmin; });
  const count = state.data ? state.data.persons.length : 0;
  $('m-add-root').hidden = count > 0;
  document.body.classList.toggle('is-empty', !count);
  // Each person record counts once, however many times (or marriages) it appears in the drawing.
  const males = count ? state.data.persons.filter((p) => p.gender === 'm').length : 0;
  const females = count ? state.data.persons.filter((p) => p.gender === 'f').length : 0;
  const fmt = (n) => n.toLocaleString(state.prefs.digits === 'ar' ? 'ar-EG' : 'en-US');
  $('people-count').textContent = count ? `${fmt(count)} فردًا · ${fmt(males)} ذكور · ${fmt(females)} إناث` : '';
}

function updateInsets() {
  const mobile = window.innerWidth < 760;
  const top = ($('topbar').getBoundingClientRect().bottom || 70) + 6;
  const ins = { top, right: 0, bottom: 0, left: 0 };
  const panel = $('details');
  const card = $('action-card');
  if (!panel.hidden) {
    if (mobile) ins.bottom = panel.getBoundingClientRect().height + 8;
    else ins.left = panel.getBoundingClientRect().right + 8;
  }
  if (!card.hidden) ins.bottom = Math.max(ins.bottom, window.innerHeight - card.getBoundingClientRect().top + 8);
  viewport.insets = ins;
}

/* ================================================================== */
/* Selection, blinking and focus                                       */
/* ================================================================== */
function clearSelection() {
  state.selectedKey = null;
  state.selectedPid = null;
  state.blink = null;
  closePanels();
  schedule();
}

function closePanels() {
  $('details').hidden = true;
  $('action-card').hidden = true;
  document.body.classList.remove('panel-open');
  state.panel = null;
}

function nodeBox(nodes, pad = G.SLOT) {
  return {
    minX: Math.min(...nodes.map((n) => n.x)) - pad, maxX: Math.max(...nodes.map((n) => n.x)) + pad,
    minY: Math.min(...nodes.map((n) => n.y)) - G.R - 40, maxY: Math.max(...nodes.map((n) => n.y)) + G.NAME_DY2 + 30,
  };
}

/** Selects an appearance; if the same person appears elsewhere, that appearance blinks and the view moves to it. */
function selectNode(node, { panel = true } = {}) {
  const person = state.graph.byId.get(node.pid);
  if (!person) return;
  state.selectedKey = node.key;
  state.selectedPid = node.pid;
  if (panel) { if (state.isAdmin) openActionCard(person, node); else openDetails(person); }
  const others = (state.layout.appearances.get(node.pid) || []).filter((n) => n.key !== node.key);
  if (others.length) {
    state.blink = { keys: new Set(others.map((n) => n.key)), from: node.key, until: performance.now() + BLINK_MS };
    updateInsets();
    const box = nodeBox([node, ...others]);
    if (viewport.scaleToFit(box, 50) >= 0.35) viewport.fit(box, { padding: 50, maxScale: Math.min(1, Math.max(viewport.scale, 0.55)), duration: 900 });
    else viewport.centerOn(others[0].x, others[0].y, Math.max(0.6, Math.min(viewport.scale, 1)), 900);
  } else {
    state.blink = null;
  }
  schedule();
}

/** Expands collapsed branches so that `pid` becomes visible. */
function ensureVisible(pid, depth = 0) {
  if (state.layout.appearances.has(pid) || depth > 4) return;
  let changed = false;
  const expandChain = (id) => {
    const seen = new Set();
    let cur = id;
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      const host = state.layout.hostOf(cur);
      if (host != null && state.collapsed.has(host)) { state.collapsed.delete(host); changed = true; }
      cur = host;
    }
  };
  expandChain(pid);
  for (const pt of partnersOf(state.graph, pid)) expandChain(pt.spouseId);
  if (changed) { persistCollapsed(); rebuild(); ensureVisible(pid, depth + 1); }
}

/** Moves the view to a person (search, links in details). */
function focusPerson(pid, { openPanel = true, partnerOf = null, select = false } = {}) {
  ensureVisible(pid);
  const apps = state.layout.appearances.get(pid);
  if (!apps || !apps.length) return;
  const node = (partnerOf != null && apps.find((n) => n.partnerOf === partnerOf)) || apps.find((n) => n.kind === 'blood') || apps[0];
  const person = state.graph.byId.get(pid);
  if (select) { selectNode(node); return; }
  state.selectedKey = node.key;
  state.selectedPid = pid;
  if (openPanel) { if (state.panel === 'actions' && state.isAdmin) openActionCard(person, node); else openDetails(person); }
  // Pulse the focused node; if the person appears elsewhere too, pulse those and draw the link.
  const others = apps.filter((n) => n.key !== node.key);
  state.blink = others.length
    ? { keys: new Set(others.map((n) => n.key)), from: node.key, until: performance.now() + BLINK_MS }
    : { keys: new Set([node.key]), from: null, until: performance.now() + 2600 };
  updateInsets();
  viewport.centerOn(node.x, node.y + 20, Math.max(0.8, Math.min(viewport.scale, 1.2)), 800);
  schedule();
}

function persistCollapsed() {
  state.prefs.collapsed = [...state.collapsed];
  savePrefs(state.prefs);
}

function toggleCollapse(pid) {
  const before = state.layout.byKey.get(`b${pid}`);
  const sb = before ? viewport.toScreen(before.x, before.y) : null;
  if (state.collapsed.has(pid)) state.collapsed.delete(pid); else state.collapsed.add(pid);
  persistCollapsed();
  rebuild();
  const after = state.layout.byKey.get(`b${pid}`);
  if (sb && after) {
    const sa = viewport.toScreen(after.x, after.y);
    viewport.set(viewport.scale, viewport.tx + (sb.x - sa.x), viewport.ty + (sb.y - sa.y));
  }
}

function onTap(sx, sy) {
  if (!state.layout) return;
  const w = viewport.toWorld(sx, sy);
  const hit = hitTest(state.layout, w.x, w.y, viewport.scale);
  if (!hit) { clearSelection(); return; }
  if (hit.type === 'toggle') { toggleCollapse(hit.toggle.pid); return; }
  selectNode(hit.node);
}

/* ================================================================== */
/* Panels                                                              */
/* ================================================================== */
function detailsCtx() {
  return {
    graph: state.graph, prefs: state.prefs, isAdmin: state.isAdmin,
    onFocus: (pid) => focusPerson(pid),
    onClose: () => { closePanels(); schedule(); },
    onEdit: editPerson, onDelete: deletePerson, onAddChild: addChild, onAddSpouse: addSpouse,
    onEditMarriage: editMarriage,
  };
}

function openDetails(person, animate = true) {
  if (!person) return;
  const panel = $('details');
  $('action-card').hidden = true;
  renderDetails(panel, person, detailsCtx());
  panel.hidden = false;
  if (animate) { panel.classList.remove('enter'); void panel.offsetWidth; panel.classList.add('enter'); }
  document.body.classList.add('panel-open');
  state.panel = 'details';
  updateInsets();
}

function openActionCard(person, node) {
  const card = $('action-card');
  $('details').hidden = true;
  document.body.classList.remove('panel-open');
  card.textContent = '';
  const { father, mother } = parentsOf(state.graph, person.id);
  const others = (state.layout.appearances.get(person.id) || []).length - 1;
  const close = h('button', { type: 'button', class: 'icon-btn', attrs: { 'aria-label': 'إغلاق' } }, icon('close'));
  close.addEventListener('click', clearSelection);
  const act = (label, ic, fn, cls = '') => {
    const b = h('button', { type: 'button', class: `action ${cls}` }, icon(ic), h('span', { text: label }));
    b.addEventListener('click', fn);
    return b;
  };
  const parentLabel = !father && !mother ? 'إضافة والد' : !father ? 'إضافة الأب' : 'إضافة الأم';
  card.append(
    h('div', { class: 'action-head' }, avatar(person, 46),
      h('div', { class: 'action-title' }, h('strong', { text: fullName(person) }),
        others > 0 ? h('small', { class: 'linked', text: 'يظهر أيضًا في موضع آخر من الشجرة (يومض الآن)' }) : h('small', { text: node.kind === 'spouse' ? `${person.gender === 'f' ? 'زوجة' : 'زوج'} ${shortName(state.graph.byId.get(node.partnerOf))}` : 'اختر إجراءً' })),
      close),
    h('div', { class: 'action-grid' },
      act('عرض التفاصيل', 'info', () => openDetails(person)),
      act('إضافة ابن/ابنة', 'child', () => addChild(person)),
      act(person.gender === 'm' ? 'إضافة زوجة' : 'إضافة زوج', 'heart', () => addSpouse(person)),
      !father || !mother ? act(parentLabel, 'up', () => addParent(person)) : null,
      act('تعديل', 'edit', () => editPerson(person)),
      act('حذف', 'trash', () => deletePerson(person), 'danger')));
  card.hidden = false;
  card.classList.remove('enter'); void card.offsetWidth; card.classList.add('enter');
  state.panel = 'actions';
  updateInsets();
}

/* ================================================================== */
/* Admin actions                                                       */
/* ================================================================== */
function handleAuthError(e) {
  if (e instanceof ApiError && e.status === 401) {
    clearAdminData();
  }
  throw e;
}

async function afterWrite(message, focusId, opts = {}) {
  toast(message, 'success');
  await load();
  if (focusId != null && state.graph.byId.has(focusId)) focusPerson(focusId, { ...opts, openPanel: true, select: !!opts.select });
}

function addRoot() {
  openPersonForm({
    title: 'إضافة الشخص الأول (الجذر)', submitLabel: 'إضافة', prefs: state.prefs, defaults: { gender: 'm' },
    onSubmit: async (p) => {
      const r = await api.createPerson({ person: p.person, photo: p.photo, link: { type: 'root' } }).catch(handleAuthError);
      state.didInitialView = false;
      await afterWrite('تمت إضافة الشخص الأول. اضغط عليه لإضافة الأبناء والأزواج.', r.id);
    },
  });
}

function addChild(parent) {
  openAddChild({
    parent, graph: state.graph, prefs: state.prefs,
    onAddSpouseFirst: () => addSpouse(parent),
    onSubmit: async (p) => {
      const r = await api.createPerson({ person: p.person, photo: p.photo, link: { type: 'child', parentId: parent.id, otherParentId: p.otherParentId } }).catch(handleAuthError);
      await afterWrite(`تمت إضافة «${p.person.first_name}».`, r.id);
    },
  });
}

function addSpouse(person) {
  openAddSpouse({
    person, graph: state.graph, prefs: state.prefs,
    onCreate: async (p, marriage) => {
      const r = await api.createPerson({ person: p.person, photo: p.photo, link: { type: 'spouse', personId: person.id, marriage } }).catch(handleAuthError);
      await afterWrite(`تمت إضافة «${p.person.first_name}».`, r.id, { partnerOf: person.id });
    },
    onLink: async (otherId, marriage) => {
      await api.createMarriage(person.id, otherId, marriage).catch(handleAuthError);
      await afterWrite('تم ربط الزوجين. الشخص نفسه يظهر الآن في موضعين ويومض عند اختياره.', otherId, { partnerOf: person.id, select: true });
    },
  });
}

function addParent(child) {
  openAddParent({
    child, graph: state.graph, prefs: state.prefs,
    onSubmit: async (p) => {
      const r = await api.createPerson({ person: p.person, photo: p.photo, link: { type: 'parent', childId: child.id, marryOther: p.marryOther } }).catch(handleAuthError);
      await afterWrite(`تمت إضافة «${p.person.first_name}».`, r.id);
    },
  });
}

function editPerson(person) {
  const locked = childrenOf(state.graph, person.id).length > 0 || partnersOf(state.graph, person.id).length > 0;
  const divorce = buildDivorceSection({ person, graph: state.graph });
  openPersonForm({
    title: `تعديل بيانات ${person.first_name}`, person, prefs: state.prefs, lockGender: locked,
    bottom: divorce ? divorce.el : null,
    beforeRead: () => ({ divorceChanges: divorce ? divorce.read() : [] }),
    onSubmit: async (p) => {
      await api.updatePerson(person.id, { person: p.person, photo: p.photo, removePhoto: p.removePhoto }).catch(handleAuthError);
      for (const { marriage, status } of p.divorceChanges || []) {
        await api.updateMarriage(marriage.id, { date: marriageDateOf(marriage), status, sort_order: marriage.sort_order }).catch(handleAuthError);
      }
      await afterWrite('تم حفظ التعديلات.', person.id);
    },
  });
}

function deletePerson(person) {
  const desc = descendantsOf(state.graph, person.id);
  const name = fullName(person);
  if (!desc.size) {
    confirmDialog({
      title: 'تأكيد الحذف',
      message: `هل تريد حذف «${name}»؟ سيتم حذف بياناته وصورته وروابط الزواج الخاصة به. لا يمكن التراجع.`,
      confirmLabel: 'حذف', danger: true,
    }).then(async (ok) => {
      if (!ok) return;
      try { await api.deletePerson(person.id, 'single'); clearSelection(); await afterWrite('تم الحذف.'); } catch (e) { toast(e.message, 'error'); }
    });
    return;
  }
  const radio = (value, label, checked) => {
    const input = h('input', { type: 'radio', name: 'delmode', value });
    input.checked = checked;
    return h('label', { class: 'radio' }, input, h('span', { text: label }));
  };
  const body = h('div', { class: 'form' },
    h('div', { class: 'warn' }, icon('info'), h('p', { text: `تنبيه: لدى «${name}» ${desc.size} من الذرية (أبناء وأحفاد).` })),
    h('div', { class: 'radio-group' },
      radio('single', 'حذف هذا الشخص فقط، مع إبقاء أبنائه في الشجرة (يُزال ارتباطهم به).', true),
      radio('branch', `حذف الفرع كاملًا: هذا الشخص وجميع ذريته (${desc.size}) وأزواجهم غير المرتبطين بغيرهم.`, false)));
  const m = openModal({
    title: 'حذف شخص لديه ذرية', size: 'md', body,
    actions: [
      { label: 'إلغاء', onClick: ({ close }) => close() },
      {
        label: 'حذف', kind: 'danger', icon: 'trash',
        onClick: async () => {
          const mode = body.querySelector('input[name=delmode]:checked').value;
          m.setBusy(true);
          try {
            const r = await api.deletePerson(person.id, mode);
            m.close();
            clearSelection();
            await afterWrite(`تم حذف ${r.deleted} ${r.deleted === 1 ? 'شخص' : 'أشخاص'}.`);
          } catch (e) { m.setBusy(false); formError(body, e.message); }
        },
      },
    ],
  });
}

function editMarriage(marriage) {
  const husband = state.graph.byId.get(marriage.husband_id), wife = state.graph.byId.get(marriage.wife_id);
  openMarriageForm({
    marriage, husband, wife, prefs: state.prefs,
    onSave: async (v) => { await api.updateMarriage(marriage.id, { ...v, sort_order: marriage.sort_order }).catch(handleAuthError); await afterWrite('تم حفظ بيانات الزواج.'); },
    onDelete: async () => {
      const ok = await confirmDialog({ title: 'فك الارتباط', message: `إزالة رابط الزواج بين «${fullName(husband)}» و«${fullName(wife)}»؟ يبقى الأبناء مرتبطين بوالديهم.`, confirmLabel: 'إزالة', danger: true });
      if (!ok) return false;
      await api.deleteMarriage(marriage.id).catch(handleAuthError);
      await afterWrite('تمت إزالة رابط الزواج.');
      return true;
    },
  });
}

/* ================================================================== */
/* Drawer / menu / preferences                                         */
/* ================================================================== */
function openDrawer(open) {
  const d = $('drawer');
  d.classList.toggle('open', open);
  d.setAttribute('aria-hidden', String(!open));
  d.inert = !open;
  $('drawer-scrim').hidden = !open;
  $('btn-menu').setAttribute('aria-expanded', String(open));
  if (open) d.querySelector('button')?.focus({ preventScroll: true });
}

function setupSegment(containerId, value, onPick) {
  const el = $(containerId);
  const sync = (v) => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === v)));
  sync(value);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    sync(b.dataset.value);
    onPick(b.dataset.value);
  });
}

function refreshAfterPrefs() {
  savePrefs(state.prefs);
  if (state.panel === 'details' && state.selectedPid != null) openDetails(state.graph.byId.get(state.selectedPid), false);
  updateChrome();
  schedule();
}

function setupDrawer() {
  const grid = $('theme-grid');
  for (const t of THEMES) {
    const b = h('button', { type: 'button', class: 'theme-swatch', dataset: { theme: t.id }, attrs: { 'aria-pressed': String(t.id === state.prefs.theme), 'aria-label': `السمة: ${t.name}` } },
      h('span', { class: 'swatch-dots' }, ...t.swatch.map((c) => { const s = h('i'); s.style.background = c; return s; })),
      h('span', { text: t.name }));
    b.addEventListener('click', () => {
      state.prefs.theme = t.id;
      applyTheme(t.id);
      state.colors = readThemeColors();
      grid.querySelectorAll('.theme-swatch').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.theme === t.id)));
      if (state.layout) minimap.setLayout(state.layout, state.colors);
      savePrefs(state.prefs);
      schedule();
    });
    grid.append(b);
  }
  setupSegment('seg-cal', state.prefs.displayCal, (v) => { state.prefs.displayCal = v; state.prefs.inputCal = v; refreshAfterPrefs(); });
  setupSegment('seg-digits', state.prefs.digits, (v) => { state.prefs.digits = v; refreshAfterPrefs(); });

  const on = (id, fn) => $(id).addEventListener('click', () => { openDrawer(false); fn(); });
  on('m-pdf', () => state.graph && openPdfDialog({
    graph: state.graph, collapsed: state.collapsed,
    selected: state.selectedPid != null ? state.graph.byId.get(state.selectedPid) : null,
    siteTitle: state.siteTitle, prefs: state.prefs, colors: state.colors, photos,
  }));
  on('m-login', () => openLogin(() => load()));
  on('m-password', openChangePassword);
  on('m-settings', () => state.data && openSiteSettings(state.siteTitle,state.data.whatsappNumber, (r) => {
    state.siteTitle = r.siteTitle; state.data.whatsappNumber = r.whatsappNumber; updateChrome();
  }));
  on('m-export', exportBackup);
  on('m-import', () => restoreBackup(() => { state.didInitialView = false; clearSelection(); load(); }));
  on('m-add-root', addRoot);
  on('m-logout', async () => {
    try { await api.logout(); } catch (e) { toast(`تعذّر تسجيل الخروج: ${e.message}`, 'error'); return; }
    clearAdminData();
    toast('تم تسجيل الخروج.');
    load();
  });
}

/* ================================================================== */
/* Boot                                                                */
/* ================================================================== */
function init() {
  applyTheme(state.prefs.theme);
  hydrateIcons();
  state.colors = readThemeColors();
  canvas = $('tree');
  ctx = canvas.getContext('2d');
  photos = new PhotoCache(schedule);
  viewport = new Viewport(canvas, { onChange: schedule, onTap });
  minimap = new Minimap($('minimap'), viewport, (x, y) => viewport.centerOn(x, y, viewport.scale, 0));

  // WhatsApp contact
  document.querySelectorAll('[data-whatsapp]').forEach(a => { a.hidden = true; a.removeAttribute('href'); });

  // minimap toggle (the only visible view control)
  const mm = $('minimap-wrap');
  const mmDefault = state.prefs.minimap ?? window.innerWidth >= 760;
  mm.hidden = !mmDefault;
  $('z-map').setAttribute('aria-pressed', String(mmDefault));
  $('z-map').addEventListener('click', () => {
    mm.hidden = !mm.hidden;
    state.prefs.minimap = !mm.hidden;
    $('z-map').setAttribute('aria-pressed', String(!mm.hidden));
    savePrefs(state.prefs);
    minimap.base = null;
    schedule();
  });

  // drawer
  $('btn-menu').addEventListener('click', () => openDrawer(!$('drawer').classList.contains('open')));
  $('drawer-close').addEventListener('click', () => openDrawer(false));
  $('drawer-scrim').addEventListener('click', () => openDrawer(false));
  $('drawer').inert = true;
  setupDrawer();

  // search (+ compact mobile toggle)
  search = setupSearch({
    input: $('search-input'), list: $('search-results'),
    getGraph: () => state.graph, getPrefs: () => state.prefs,
    onPick: (pid) => { $('topbar').classList.remove('search-open'); focusPerson(pid); },
  });
  $('btn-search').addEventListener('click', () => {
    const tb = $('topbar');
    tb.classList.toggle('search-open');
    if (tb.classList.contains('search-open')) $('search-input').focus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.body.classList.contains('modal-open')) {
      if ($('drawer').classList.contains('open')) openDrawer(false);
      else if (state.panel) clearSelection();
    }
    if (e.key === '/' && document.activeElement === document.body) { e.preventDefault(); $('search-input').focus(); }
  });
  window.addEventListener('resize', () => { updateInsets(); schedule(); });
  document.fonts?.ready.then(() => { if (state.layout) for (const n of state.layout.nodes) n._label = false; schedule(); });

  load(true);
}

init();
