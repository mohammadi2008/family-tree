/**
 * ui.js — DOM helpers, toasts and accessible modals.
 * SECURITY: user-provided text is ALWAYS inserted with textContent (never innerHTML).
 */
import { icon } from './icons.js';

/**
 * Hyperscript helper: h('button', { class: 'x', on: { click } , attrs: {...} }, 'text', childNode)
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'attrs') for (const [a, av] of Object.entries(v)) { if (av != null && av !== false) el.setAttribute(a, av === true ? '' : String(av)); }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Button with optional icon. */
export function button(label, { iconName, kind = 'ghost', onClick, type = 'button', attrs = {}, cls = '' } = {}) {
  const b = h('button', { class: `btn btn-${kind} ${cls}`.trim(), type, attrs, on: onClick ? { click: onClick } : {} });
  if (iconName) b.append(icon(iconName));
  if (label) b.append(h('span', { text: label }));
  return b;
}

/* ---------------- toasts ---------------- */
export function toast(message, kind = 'info', ms = 3600) {
  const root = document.getElementById('toast-root');
  const t = h('div', { class: `toast toast-${kind} glass`, attrs: { role: kind === 'error' ? 'alert' : 'status' } },
    icon(kind === 'error' ? 'info' : kind === 'success' ? 'check' : 'info'), h('span', { text: message }));
  root.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  const remove = () => { t.classList.remove('show'); setTimeout(() => t.remove(), 350); };
  const timer = setTimeout(remove, ms);
  t.addEventListener('click', () => { clearTimeout(timer); remove(); });
}

/* ---------------- modals ---------------- */
let modalDepth = 0;

/**
 * Opens a modal dialog.
 * @returns {{ el, body, footer, close, setBusy }}
 */
export function openModal({ title, body, actions = [], size = 'md', onClose, dismissible = true, cls = '' }) {
  const root = document.getElementById('modal-root');
  const previouslyFocused = document.activeElement;
  modalDepth += 1;
  const titleId = `modal-title-${Date.now()}-${modalDepth}`;
  const footer = h('div', { class: 'modal-footer' });
  const bodyEl = h('div', { class: 'modal-body' }, body);
  const closeBtn = h('button', { class: 'icon-btn modal-close', type: 'button', attrs: { 'aria-label': 'إغلاق' } }, icon('close'));
  const dialog = h('div', { class: `modal modal-${size} glass ${cls}`, attrs: { role: 'dialog', tabindex: '-1', 'aria-modal': 'true', 'aria-labelledby': titleId } },
    h('div', { class: 'modal-header' }, h('h2', { id: titleId, text: title }), dismissible ? closeBtn : null),
    bodyEl, footer);
  const wrap = h('div', { class: 'modal-wrap' }, h('div', { class: 'modal-scrim' }), dialog);
  wrap.style.zIndex = String(1000 + modalDepth * 10);
  root.append(wrap);
  document.body.classList.add('modal-open');

  let closed = false;
  let busy = false;
  const disabledBeforeBusy = new Map();
  const close = (result) => {
    if (closed) return;
    closed = true;
    modalDepth -= 1;
    wrap.classList.remove('show');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => wrap.remove(), 220);
    if (!modalDepth) document.body.classList.remove('modal-open');
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus({ preventScroll: true });
    if (onClose) onClose(result);
  };
  const onKey = (e) => {
    if (wrap !== root.lastElementChild) return;
    if (e.key === 'Escape' && dismissible) { e.stopPropagation(); if (!busy) close(); }
    if (e.key === 'Tab') {
      const f = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) { e.preventDefault(); dialog.focus({ preventScroll: true }); return; }
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  if (dismissible) {
    closeBtn.addEventListener('click', () => { if (!busy) close(); });
    wrap.firstChild.addEventListener('click', () => { if (!busy) close(); });
  }
  for (const a of actions) {
    const b = button(a.label, { kind: a.kind || 'ghost', iconName: a.icon, type: a.submit ? 'submit' : 'button' });
    b.addEventListener('click', () => { if (!busy) a.onClick && a.onClick({ close, button: b }); });
    footer.append(b);
  }
  if (!actions.length) footer.remove();
  requestAnimationFrame(() => {
    wrap.classList.add('show');
    const first = dialog.querySelector('[autofocus], input:not([type=hidden]):not([type=file]), select, textarea, .btn-primary');
    (first || (dismissible ? closeBtn : dialog)).focus({ preventScroll: true });
  });
  const setBusy = (busy, label) => {
    setBusyState(busy);
    if (label !== undefined) {
      const p = footer.querySelector('.btn-primary span, .btn-danger span');
      if (p) p.textContent = label;
    }
  };
  const setBusyState = (value) => {
    busy = !!value;
    dialog.classList.toggle('busy', busy);
    dialog.querySelectorAll('button, input, select, textarea').forEach((el) => {
      if (busy) {
        if (!disabledBeforeBusy.has(el)) disabledBeforeBusy.set(el, el.disabled);
        el.disabled = true;
      } else if (disabledBeforeBusy.has(el)) {
        el.disabled = disabledBeforeBusy.get(el);
      }
    });
    if (!busy) disabledBeforeBusy.clear();
  };
  dialog.addEventListener('submit', (e) => {
    if (busy) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  return { el: dialog, body: bodyEl, footer, close, setBusy, get busy() { return busy; } };
}

/** Promise-based confirmation dialog. */
export function confirmDialog({ title, message, confirmLabel = 'تأكيد', danger = false, extra }) {
  return new Promise((resolve) => {
    let result = false;
    openModal({
      title,
      size: 'sm',
      body: h('div', {}, h('p', { class: 'confirm-text', text: message }), extra || null),
      actions: [
        { label: 'إلغاء', kind: 'ghost', onClick: ({ close }) => close() },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: ({ close }) => { result = true; close(); } },
      ],
      onClose: () => resolve(result),
    });
  });
}

/** Shows an inline error box inside a form. */
export function formError(container, message) {
  let box = container.querySelector('.form-error');
  if (!message) { if (box) box.remove(); return; }
  if (!box) { box = h('div', { class: 'form-error', attrs: { role: 'alert' } }); container.prepend(box); }
  box.textContent = message;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Debounce helper. */
export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Triggers a file download for a Blob (works on mobile Safari/Chrome). */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, attrs: { download: filename, rel: 'noopener' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
