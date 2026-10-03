/**
 * minimap.js — overview of the whole tree with the current viewport rectangle.
 * Tap / drag on it to navigate.
 */
export class Minimap {
  constructor(canvas, viewport, onNavigate) {
    this.canvas = canvas;
    this.vp = viewport;
    this.onNavigate = onNavigate;
    this.layout = null;
    this.base = null;
    this.colors = null;
    let dragging = false;
    const go = (e) => {
      if (!this.layout || !this.map) return;
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left - this.map.ox) / this.map.s + this.layout.bounds.minX;
      const y = (e.clientY - r.top - this.map.oy) / this.map.s + this.layout.bounds.minY;
      this.onNavigate(x, y);
    };
    canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture?.(e.pointerId); go(e); e.preventDefault(); });
    canvas.addEventListener('pointermove', (e) => { if (dragging) go(e); });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('pointercancel', () => { dragging = false; });
  }

  setLayout(layout, colors) {
    this.layout = layout;
    this.colors = colors;
    this.base = null;
    this.draw();
  }

  prerender() {
    const c = this.canvas;
    const pr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h || !this.layout) return;
    c.width = Math.round(w * pr); c.height = Math.round(h * pr);
    const b = this.layout.bounds;
    const s = Math.min((w - 12) / (b.maxX - b.minX), (h - 12) / (b.maxY - b.minY));
    const ox = (w - (b.maxX - b.minX) * s) / 2, oy = (h - (b.maxY - b.minY) * s) / 2;
    this.map = { s, ox, oy, w, h, pr };
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.setTransform(pr, 0, 0, pr, 0, 0);
    ctx.strokeStyle = this.colors.line;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 0.7;
    const colors = this.layout.edgeColors || [...new Set(this.layout.edges.map((e) => e.color || null))];
    for (const col of colors) {
      ctx.strokeStyle = col || this.colors.line;
      ctx.beginPath();
      for (const e of this.layout.edges) {
        if ((e.color || null) !== col) continue;
        e.pts.forEach(([x, y], i) => {
          const X = ox + (x - b.minX) * s, Y = oy + (y - b.minY) * s;
          if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
        });
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const r = Math.max(1.3, Math.min(4, 34 * s));
    for (const n of this.layout.nodes) {
      const p = this.layout.graph.byId.get(n.pid);
      ctx.fillStyle = p && p.gender === 'f' ? this.colors.female2 : this.colors.male2;
      ctx.beginPath();
      ctx.arc(ox + (n.x - b.minX) * s, oy + (n.y - b.minY) * s, r, 0, Math.PI * 2);
      ctx.fill();
    }
    this.base = off;
  }

  draw() {
    if (!this.layout || this.canvas.offsetParent === null) return;
    if (!this.base || this.canvas.clientWidth !== this.map?.w || this.canvas.clientHeight !== this.map?.h) this.prerender();
    if (!this.base) return;
    const ctx = this.canvas.getContext('2d');
    const { s, ox, oy, pr } = this.map;
    const b = this.layout.bounds;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base, 0, 0);
    ctx.setTransform(pr, 0, 0, pr, 0, 0);
    const tl = this.vp.toWorld(0, 0), br = this.vp.toWorld(this.vp.width, this.vp.height);
    const x = ox + (tl.x - b.minX) * s, y = oy + (tl.y - b.minY) * s;
    const w = (br.x - tl.x) * s, h = (br.y - tl.y) * s;
    ctx.fillStyle = this.colors.viewport || 'rgba(99,102,241,.14)';
    ctx.strokeStyle = this.colors.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
  }
}
