/**
 * viewport.js — pan / zoom / pinch / tap handling for the tree canvas.
 * screen = world * scale + (tx, ty)   (CSS pixels)
 */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Viewport {
  constructor(el, { onChange, onTap }) {
    this.el = el;
    this.onChange = onChange;
    this.onTap = onTap;
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.minScale = 0.02; this.maxScale = 3;
    this.width = el.clientWidth || 1; this.height = el.clientHeight || 1;
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    this.pointers = new Map();
    this.anim = null;
    this.pinch = null;
    this.tap = null;
    this.velocity = { x: 0, y: 0, t: 0 };

    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    el.addEventListener('keydown', (e) => this.key(e));
    // iOS Safari: block native page pinch so our pinch works.
    ['gesturestart', 'gesturechange'].forEach((t) => el.addEventListener(t, (e) => e.preventDefault()));
    new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      // keep the visual center stable on resize/rotation
      const cx = (this.width / 2 - this.tx) / this.scale, cy = (this.height / 2 - this.ty) / this.scale;
      this.width = w; this.height = h;
      this.tx = w / 2 - cx * this.scale; this.ty = h / 2 - cy * this.scale;
      this.onChange('resize');
    }).observe(el);
  }

  local(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  toWorld(sx, sy) { return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale }; }
  toScreen(wx, wy) { return { x: wx * this.scale + this.tx, y: wy * this.scale + this.ty }; }

  /** Visible area (CSS px) excluding panels that cover the canvas. */
  visibleRect() {
    const i = this.insets;
    return { x: i.left, y: i.top, w: Math.max(80, this.width - i.left - i.right), h: Math.max(80, this.height - i.top - i.bottom) };
  }

  stop() { if (this.anim) { cancelAnimationFrame(this.anim.raf); this.anim = null; } }

  set(scale, tx, ty) {
    this.scale = clamp(scale, this.minScale, this.maxScale);
    this.tx = tx; this.ty = ty;
    this.onChange('view');
  }

  zoomAt(factor, sx, sy) {
    const ns = clamp(this.scale * factor, this.minScale, this.maxScale);
    const k = ns / this.scale;
    this.set(ns, sx - (sx - this.tx) * k, sy - (sy - this.ty) * k);
  }

  zoomBy(factor, animate = true) {
    const v = this.visibleRect();
    const sx = v.x + v.w / 2, sy = v.y + v.h / 2;
    if (!animate) return this.zoomAt(factor, sx, sy);
    const ns = clamp(this.scale * factor, this.minScale, this.maxScale);
    const w = this.toWorld(sx, sy);
    this.animateTo(ns, sx - w.x * ns, sy - w.y * ns, 260);
  }

  /** Smoothly center world point (wx, wy) in the visible area. */
  centerOn(wx, wy, scale = this.scale, duration = 650) {
    const v = this.visibleRect();
    const s = clamp(scale, this.minScale, this.maxScale);
    this.animateTo(s, v.x + v.w / 2 - wx * s, v.y + v.h / 2 - wy * s, duration);
  }

  /** Fit a world-space box into the visible area. */
  fit(b, { padding = 48, maxScale = 1.1, minScale = this.minScale, duration = 650 } = {}) {
    const v = this.visibleRect();
    const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
    const s = clamp(Math.min((v.w - padding * 2) / w, (v.h - padding * 2) / h), minScale, maxScale);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const tx = v.x + v.w / 2 - cx * s, ty = v.y + v.h / 2 - cy * s;
    if (duration) this.animateTo(s, tx, ty, duration); else this.set(s, tx, ty);
    return s;
  }

  /** Required scale to fit a box (without moving). */
  scaleToFit(b, padding = 48) {
    const v = this.visibleRect();
    return Math.min((v.w - padding * 2) / Math.max(1, b.maxX - b.minX), (v.h - padding * 2) / Math.max(1, b.maxY - b.minY));
  }

  animateTo(scale, tx, ty, duration = 600) {
    this.stop();
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) duration = 0;
    const from = { s: this.scale, tx: this.tx, ty: this.ty };
    if (!duration) return this.set(scale, tx, ty);
    // Interpolate in a way that keeps zooming natural (log scale).
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const k = ease(t);
      const s = Math.exp(Math.log(from.s) + (Math.log(scale) - Math.log(from.s)) * k);
      // keep the path of the screen center smooth
      const x = from.tx + (tx - from.tx) * k, y = from.ty + (ty - from.ty) * k;
      this.scale = s; this.tx = x; this.ty = y;
      this.onChange('anim');
      if (t < 1) this.anim.raf = requestAnimationFrame(step);
      else { this.anim = null; this.set(scale, tx, ty); }
    };
    this.anim = { raf: requestAnimationFrame(step) };
  }

  /* ---------------- input ---------------- */
  down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.el.setPointerCapture?.(e.pointerId);
    this.stop();
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.tap = { x: p.x, y: p.y, t: performance.now(), moved: false };
      this.velocity = { x: 0, y: 0, t: performance.now() };
      this.el.classList.add('grabbing');
    } else {
      this.tap = null;
      this.startPinch();
    }
  }

  startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const prev = this.pointers.get(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      if (this.tap && !this.tap.moved && Math.hypot(p.x - this.tap.x, p.y - this.tap.y) > 7) this.tap.moved = true;
      if (this.tap && !this.tap.moved) return;
      const dx = p.x - prev.x, dy = p.y - prev.y;
      const now = performance.now();
      const dt = Math.max(1, now - this.velocity.t);
      this.velocity = { x: 0.8 * (dx / dt) + 0.2 * this.velocity.x, y: 0.8 * (dy / dt) + 0.2 * this.velocity.y, t: now };
      this.set(this.scale, this.tx + dx, this.ty + dy);
    } else if (this.pointers.size >= 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const ns = clamp(this.scale * (d / this.pinch.d), this.minScale, this.maxScale);
      const k = ns / this.scale;
      const tx = mx - (this.pinch.mx - this.tx) * k;
      const ty = my - (this.pinch.my - this.ty) * k;
      this.pinch = { d, mx, my };
      this.set(ns, tx, ty);
    }
  }

  up(e, cancelled = false) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      this.el.classList.remove('grabbing');
      const tap = this.tap;
      this.tap = null;
      if (!cancelled && tap && !tap.moved && performance.now() - tap.t < 650) {
        this.onTap(p.x, p.y, e);
        return;
      }
      // inertia
      const v = this.velocity;
      if (!cancelled && performance.now() - v.t < 80 && Math.hypot(v.x, v.y) > 0.25) this.glide(v.x, v.y);
    } else if (this.pointers.size === 1) {
      this.pinch = null;
    } else {
      this.startPinch();
    }
  }

  glide(vx, vy) {
    this.stop();
    let last = performance.now();
    const step = (now) => {
      const dt = now - last; last = now;
      const decay = Math.pow(0.94, dt / 16);
      vx *= decay; vy *= decay;
      this.set(this.scale, this.tx + vx * dt, this.ty + vy * dt);
      if (Math.hypot(vx, vy) > 0.02) this.anim.raf = requestAnimationFrame(step); else this.anim = null;
    };
    this.anim = { raf: requestAnimationFrame(step) };
  }

  wheel(e) {
    e.preventDefault();
    this.stop();
    const p = this.local(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= this.height;
    if (e.ctrlKey || e.metaKey || Math.abs(dy) >= 40 || e.deltaX === 0) {
      // mouse wheel or trackpad pinch → zoom around cursor
      this.zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.0018)), p.x, p.y);
    } else {
      // two-finger trackpad scroll → pan
      this.set(this.scale, this.tx - e.deltaX, this.ty - dy);
    }
  }

  key(e) {
    const step = 80;
    switch (e.key) {
      case '+': case '=': this.zoomBy(1.25); break;
      case '-': case '_': this.zoomBy(0.8); break;
      case 'ArrowLeft': this.set(this.scale, this.tx + step, this.ty); break;
      case 'ArrowRight': this.set(this.scale, this.tx - step, this.ty); break;
      case 'ArrowUp': this.set(this.scale, this.tx, this.ty + step); break;
      case 'ArrowDown': this.set(this.scale, this.tx, this.ty - step); break;
      default: return;
    }
    e.preventDefault();
  }
}
