/**
 * search.js — instant name search with keyboard navigation.
 */
import { h } from './ui.js';
import { avatar } from './avatar.js';
import { fullName, normalizeArabic, birthOf } from './text.js';
import { recordYear, digits } from './calendar.js';

export function setupSearch({ input, list, getGraph, getPrefs, onPick }) {
  let items = [];
  let active = -1;
  let index = [];

  const rebuildIndex = () => {
    const g = getGraph();
    index = g ? g.persons.map((p) => ({ p, key: normalizeArabic(fullName(p)) })) : [];
  };

  const close = () => { list.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
  const pick = (p) => { close(); input.value = ''; input.blur(); onPick(p.id); };

  const render = () => {
    const q = normalizeArabic(input.value);
    list.textContent = '';
    if (!q) { close(); return; }
    const terms = q.split(' ').filter(Boolean);
    items = index.filter((e) => terms.every((t) => e.key.includes(t)))
      .sort((a, b) => (a.key.startsWith(terms[0]) ? 0 : 1) - (b.key.startsWith(terms[0]) ? 0 : 1) || a.key.length - b.key.length)
      .slice(0, 12).map((e) => e.p);
    const prefs = getPrefs();
    if (!items.length) {
      list.append(h('li', { class: 'search-empty', text: 'لا توجد نتائج مطابقة.' }));
    }
    items.forEach((p, i) => {
      const year = recordYear(birthOf(p), prefs.displayCal);
      const li = h('li', { class: `search-item ${i === active ? 'active' : ''}`, attrs: { role: 'option', id: `sr-${i}`, 'aria-selected': String(i === active) } },
        avatar(p, 34), h('span', { class: 'si-text' }, h('strong', { text: fullName(p) }), year ? h('small', { text: `مواليد ${digits(year, prefs.digits)}` }) : null));
      li.addEventListener('pointerdown', (e) => { e.preventDefault(); pick(p); });
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0 && items[active]) input.setAttribute('aria-activedescendant', `sr-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  input.addEventListener('focus', rebuildIndex);
  input.addEventListener('input', () => { active = -1; if (!index.length) rebuildIndex(); render(); });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { const p = items[active >= 0 ? active : 0]; if (p) pick(p); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  return { rebuildIndex };
}
