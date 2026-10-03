/**
 * prefs.js — visitor preferences persisted in localStorage.
 */
const KEY = 'family-tree-prefs-v1';

export const THEMES = [
  { id: 'crystal', name: 'كريستال فاتح', swatch: ['#eef2ff', '#a5b4fc', '#f0abfc'] },
  { id: 'midnight', name: 'منتصف الليل', swatch: ['#0b1026', '#4c5bd4', '#22d3ee'] },
  { id: 'emerald', name: 'زمرّد', swatch: ['#04241f', '#10b981', '#a7f3d0'] },
  { id: 'gold', name: 'ذهب ملكي', swatch: ['#1b1407', '#d4a017', '#fde68a'] },
  { id: 'ocean', name: 'أزرق المحيط', swatch: ['#e0f2fe', '#0284c7', '#5eead4'] },
  { id: 'rose', name: 'كوارتز وردي', swatch: ['#fff1f5', '#e11d74', '#c4b5fd'] },
];

const DEFAULTS = { theme: 'crystal', displayCal: 'g', inputCal: 'g', digits: 'latin', minimap: null, collapsed: [] };

export function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    const p = { ...DEFAULTS, ...raw };
    if (!THEMES.some((t) => t.id === p.theme)) p.theme = DEFAULTS.theme;
    if (!['g', 'j'].includes(p.displayCal)) p.displayCal = 'g';
    if (!['g', 'j'].includes(p.inputCal)) p.inputCal = p.displayCal;
    if (!['latin', 'ar'].includes(p.digits)) p.digits = 'latin';
    if (!Array.isArray(p.collapsed)) p.collapsed = [];
    return p;
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode: ignore */ }
}

export function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim() || '#eef2ff');
}
