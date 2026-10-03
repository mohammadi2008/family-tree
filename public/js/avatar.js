/**
 * avatar.js — small DOM avatars (photo or gender-colored default icon).
 */
import { h } from './ui.js';

const PERSON_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="25" r="10" fill="#fff" fill-opacity=".94"/><ellipse cx="32" cy="58" rx="19" ry="16" fill="#fff" fill-opacity=".94"/></svg>';

export function photoUrl(p) {
  return p && p.has_photo ? `/api/photo/${p.id}?v=${p.photo_ver}&privacy=2` : null;
}

/** Circular avatar element. `override` can be a data URL preview. */
export function avatar(p, size = 40, override) {
  const el = h('span', { class: `avatar ${p && p.gender === 'f' ? 'female' : 'male'}` });
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  const src = override === '' ? null : override || photoUrl(p);
  if (src) {
    el.append(h('img', { src, alt: '', attrs: { loading: 'lazy', decoding: 'async' } }));
  } else {
    el.innerHTML = PERSON_SVG; // static markup only
  }
  return el;
}
