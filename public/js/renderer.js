/**
 * renderer.js — high-performance Canvas 2D drawing of the tree.
 * The same drawScene() is used for the screen and for the PDF export,
 * so what you see is exactly what you print.
 *
 * Performance: viewport culling + level-of-detail (dots when zoomed far out,
 * no text when names would be unreadable), cached name truncation, all lines
 * stroked in a single path per style.
 */
import { G } from './layout.js';

/* ---------------- theme colors (from CSS variables) ---------------- */
export function readThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, d) => (cs.getPropertyValue(n).trim() || d);
  return {
    line: v('--c-line', 'rgba(70,80,130,.55)'),
    text: v('--c-node-text', '#1c2340'),
    sub: v('--c-node-sub', '#4b5578'),
    pill: v('--c-name-pill', 'rgba(255,255,255,.6)'),
    halo: v('--c-halo', 'rgba(255,255,255,.7)'),
    glow: v('--c-glow', '#a855f7'),
    accent: v('--accent', '#4f46e5'),
    toggle: v('--c-toggle', 'rgba(255,255,255,.85)'),
    male1: v('--male-1', '#9cc8ff'),
    male2: v('--male-2', '#2563eb'),
    female1: v('--female-1', '#ffb3d9'),
    female2: v('--female-2', '#db2777'),
    font: v('--font-canvas', 'Cairo, Tajawal, sans-serif'),
  };
}

/** Print-friendly palette for PDF (white paper), keeping theme accents. */
export function printColors(base) {
  return { ...base, line: 'rgba(60,70,110,.7)', text: '#141a33', sub: '#4a5274', pill: 'rgba(255,255,255,0)', halo: 'rgba(120,130,190,.18)', toggle: '#fff' };
}

/* ---------------- photo cache ---------------- */
export class PhotoCache {
  constructor(onLoad) { this.map = new Map(); this.onLoad = onLoad; }
  key(p) { return `${p.id}:${p.photo_ver}`; }
  /** Returns a decoded image or null (starts loading on first request). */
  get(p) {
    if (!p || !p.has_photo) return null;
    const k = this.key(p);
    let e = this.map.get(k);
    if (!e) {
      const img = new Image();
      img.decoding = 'async';
      e = { img, ok: false, failed: false };
      img.onload = () => { e.ok = true; this.onLoad && this.onLoad(); };
      img.onerror = () => { e.failed = true; };
      img.src = `/api/photo/${p.id}?v=${p.photo_ver}&privacy=2`;
      this.map.set(k, e);
    }
    return e.ok ? e.img : null;
  }
  /** Loads every photo for the given persons (used before PDF export). */
  async ensure(persons, onProgress) {
    const list = persons.filter((p) => p.has_photo);
    let done = 0;
    const queue = list.slice();
    const worker = async () => {
      while (queue.length) {
        const p = queue.shift();
        this.get(p);
        const e = this.map.get(this.key(p));
        if (!e.ok && !e.failed) {
          await new Promise((res) => {
            const t = setTimeout(res, 15000);
            e.img.addEventListener('load', () => { clearTimeout(t); res(); }, { once: true });
            e.img.addEventListener('error', () => { clearTimeout(t); res(); }, { once: true });
          });
        }
        done += 1;
        if (onProgress) onProgress(done, list.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
  }
}

/* ---------------- primitives ---------------- */
const TAU = Math.PI * 2;

function roundedPolyline(ctx, pts, r) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const d1 = Math.hypot(x1 - x0, y1 - y0), d2 = Math.hypot(x2 - x1, y2 - y1);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    if (rr < 0.5) ctx.lineTo(x1, y1); else ctx.arcTo(x1, y1, x2, y2, rr);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

export function drawDefaultIcon(ctx, x, y, R, male, c) {
  const g = ctx.createLinearGradient(x, y - R, x, y + R);
  g.addColorStop(0, male ? c.male1 : c.female1);
  g.addColorStop(1, male ? c.male2 : c.female2);
  ctx.fillStyle = g;
  ctx.fillRect(x - R, y - R, R * 2, R * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.beginPath();
  ctx.arc(x, y - R * 0.2, R * 0.3, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x, y + R * 0.74, R * 0.6, R * 0.5, 0, 0, TAU);
  ctx.fill();
}

function truncate(ctx, text, max) {
  if (!text) return '';
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s.trim()}…`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---------------- scene ---------------- */
/**
 * Draws the tree.
 * o = { layout, scale, tx, ty, width, height, pr, colors, photos, selectedKey,
 *       blink: { keys:Set, from:key } | null, time, forPrint }
 */
export function drawScene(ctx, o) {
  const { layout, scale, colors: c } = o;
  const R = G.R;
  const g = layout.graph;
  const margin = G.SLOT;
  const wx0 = -o.tx / scale - margin, wy0 = -o.ty / scale - margin;
  const wx1 = (o.width - o.tx) / scale + margin, wy1 = (o.height - o.ty) / scale + margin;
  const inView = (x0, y0, x1, y1) => x1 >= wx0 && x0 <= wx1 && y1 >= wy0 && y0 <= wy1;
  const screenR = R * scale;
  const lod = o.forPrint ? 'full' : screenR < 6 ? 'dot' : screenR < 13 ? 'plain' : 'full';
  const showText = o.forPrint || 15 * scale >= 6.5;

  ctx.save();
  ctx.setTransform(o.pr * scale, 0, 0, o.pr * scale, o.pr * o.tx + (o.ox || 0), o.pr * o.ty + (o.oy || 0));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  /* edges, one path per style */
  const lw = Math.max(2, 1 / scale);
  const edgeColors = layout.edgeColors || (layout.edgeColors = [...new Set(layout.edges.map((e) => e.color || null))]);
  for (const style of ['solid', 'divorced', 'implicit']) for (const edgeColor of edgeColors) {
    ctx.beginPath();
    let any = false;
    for (const e of layout.edges) {
      if (e.style !== style || (e.color || null) !== edgeColor) continue;
      const b = e.bbox;
      if (!inView(b[0], b[1], b[2], b[3])) continue;
      roundedPolyline(ctx, e.pts, 12);
      any = true;
    }
    if (!any) continue;
    ctx.strokeStyle = edgeColor || c.line;
    ctx.lineWidth = lw;
    ctx.setLineDash(style === 'divorced' ? [10, 8] : style === 'implicit' ? [2, 7] : []);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  /* "crystal thread" connecting the appearances of the same person while blinking */
  const blink = o.blink;
  const pulse = blink ? 0.5 + 0.5 * Math.sin((o.time / 1000) * TAU * 1.3) : 0;
  if (blink && blink.from) {
    const from = layout.byKey.get(blink.from);
    if (from) {
      ctx.save();
      ctx.strokeStyle = c.glow;
      ctx.globalAlpha = 0.45 + 0.35 * pulse;
      ctx.lineWidth = Math.max(3, 2 / scale);
      ctx.setLineDash([3, 10]);
      ctx.lineDashOffset = -(o.time / 30) % 13;
      for (const k of blink.keys) {
        const to = layout.byKey.get(k);
        if (!to) continue;
        const mx = (from.x + to.x) / 2;
        const lift = Math.min(260, Math.abs(from.x - to.x) * 0.25 + Math.abs(from.y - to.y) * 0.3 + 60);
        const my = Math.min(from.y, to.y) - lift;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y - R - 6);
        ctx.quadraticCurveTo(mx, my, to.x, to.y - R - 6);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /* nodes */
  const baseFont = c.font;
  for (const n of layout.nodes) {
    if (!inView(n.x - G.SLOT / 2, n.y - R - 30, n.x + G.SLOT / 2, n.y + G.NAME_DY2 + 12)) continue;
    const p = g.byId.get(n.pid);
    if (!p) continue;
    const male = p.gender !== 'f';
    const selected = o.selectedKey === n.key;
    const blinking = blink && blink.keys.has(n.key);

    if (lod === 'dot') {
      ctx.beginPath();
      ctx.arc(n.x, n.y, R, 0, TAU);
      ctx.fillStyle = male ? c.male2 : c.female2;
      ctx.fill();
      if (selected || blinking) {
        ctx.lineWidth = 3 / scale;
        ctx.strokeStyle = blinking ? c.glow : c.accent;
        ctx.globalAlpha = blinking ? 0.5 + 0.5 * pulse : 1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, R + 6 / scale + (blinking ? pulse * 18 : 0), 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      continue;
    }

    // soft glass halo
    const halo = ctx.createRadialGradient(n.x, n.y, R * 0.7, n.x, n.y, R + 16);
    halo.addColorStop(0, c.halo);
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(n.x, n.y, R + 16, 0, TAU);
    ctx.fill();

    // blinking glow (other appearance of a selected person)
    if (blinking) {
      ctx.save();
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = (16 + 26 * pulse) * scale * o.pr;
      ctx.strokeStyle = c.glow;
      ctx.globalAlpha = 0.55 + 0.45 * pulse;
      ctx.lineWidth = 4 + 5 * pulse;
      ctx.beginPath();
      ctx.arc(n.x, n.y, R + 9 + 9 * pulse, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // photo or default icon, clipped to a circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(n.x, n.y, R, 0, TAU);
    ctx.clip();
    const img = lod === 'full' ? o.photos.get(p) : null;
    if (img) ctx.drawImage(img, n.x - R, n.y - R, R * 2, R * 2);
    else drawDefaultIcon(ctx, n.x, n.y, R, male, c);
    ctx.restore();

    // crystal ring + specular highlight
    const ring = ctx.createLinearGradient(n.x - R, n.y - R, n.x + R, n.y + R);
    ring.addColorStop(0, 'rgba(255,255,255,0.95)');
    ring.addColorStop(0.45, male ? c.male1 : c.female1);
    ring.addColorStop(1, male ? c.male2 : c.female2);
    ctx.strokeStyle = ring;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(n.x, n.y, R + 1.5, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(n.x, n.y, R - 5, Math.PI * 1.08, Math.PI * 1.42);
    ctx.stroke();

    if (selected) {
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(n.x, n.y, R + 7, 0, TAU);
      ctx.stroke();
    }

    // name (first name + family name)
    if (showText) {
      if (!n._label || n._labelFont !== baseFont) {
        ctx.font = `700 15px ${baseFont}`;
        n._l1 = truncate(ctx, p.first_name || '', G.SLOT - 12);
        ctx.font = `500 13px ${baseFont}`;
        n._l2 = truncate(ctx, p.family_name || '', G.SLOT - 12);
        ctx.font = `700 15px ${baseFont}`;
        const w1 = ctx.measureText(n._l1).width;
        ctx.font = `500 13px ${baseFont}`;
        const w2 = ctx.measureText(n._l2).width;
        n._labelW = Math.max(w1, w2);
        n._label = true;
        n._labelFont = baseFont;
      }
      if (c.pill && !c.pill.endsWith(',0)')) {
        ctx.fillStyle = c.pill;
        ctx.beginPath();
        const w = n._labelW + 16, top = n.y + R + 6, hgt = n._l2 ? 46 : 26;
        roundRect(ctx, n.x - w / 2, top, w, hgt, 10);
        ctx.fill();
      }
      ctx.textAlign = 'center';
      ctx.direction = 'rtl';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = c.text;
      ctx.font = `700 15px ${baseFont}`;
      ctx.fillText(n._l1, n.x, n.y + G.NAME_DY1 - 3);
      if (n._l2) {
        ctx.fillStyle = c.sub;
        ctx.font = `500 13px ${baseFont}`;
        ctx.fillText(n._l2, n.x, n.y + G.NAME_DY2 - 4);
      }
    }
  }

  /* collapse / expand toggles */
  if (lod !== 'dot' && !o.forPrint) {
    for (const t of layout.toggles) {
      if (!inView(t.x - 40, t.y - 14, t.x + 40, t.y + 14)) continue;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 11, 0, TAU);
      ctx.fillStyle = c.toggle;
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = c.line;
      ctx.stroke();
      ctx.strokeStyle = c.text;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(t.x - 5, t.y); ctx.lineTo(t.x + 5, t.y);
      if (t.collapsed) { ctx.moveTo(t.x, t.y - 5); ctx.lineTo(t.x, t.y + 5); }
      ctx.stroke();
      if (t.collapsed && t.count && showText) {
        const label = `+${t.count}`;
        ctx.font = `700 12px ${baseFont}`;
        const w = ctx.measureText(label).width + 14;
        ctx.fillStyle = c.accent;
        ctx.beginPath();
        roundRect(ctx, t.x - w / 2, t.y + 15, w, 20, 10);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.direction = 'ltr';
        ctx.fillText(label, t.x, t.y + 29);
      }
    }
  }
  ctx.restore();
}
