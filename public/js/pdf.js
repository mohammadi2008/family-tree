/**
 * pdf.js — dependency-free PDF export.
 *
 * The page is rendered with the SAME canvas renderer as the screen, at the chosen
 * DPI (300 by default), using the embedded Cairo web font, so Arabic shaping and
 * RTL are perfect and photos are included. It is rasterized in horizontal strips
 * (≤ 4 megapixels each) to stay within mobile canvas limits, and each strip is
 * embedded as a JPEG image in a hand-written PDF 1.4 file.
 */
import { h, openModal, toast, downloadBlob, formError } from './ui.js';
import { computeLayout } from './layout.js';
import { drawScene, printColors } from './renderer.js';
import { formatRecord, makeRecord, jdnToParts, todayJdn, digits } from './calendar.js';
import { fullName } from './text.js';

const PAPERS = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841] };
const MM = 72 / 25.4;
const MAX_STRIP_PIXELS = 4_000_000;

/* ---------------- tiny PDF writer ---------------- */
function utf16Hex(s) {
  let out = 'FEFF';
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${out}>`;
}

export function buildPdf({ widthPt, heightPt, strips, title }) {
  const enc = new TextEncoder();
  const parts = [];
  let offset = 0;
  const offsets = [];
  const push = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; parts.push(b); offset += b.length; };
  const f = (n) => (Math.round(n * 1000) / 1000).toString();

  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4 + binary marker
  const IMG0 = 6;
  const startObj = (n) => { offsets[n] = offset; push(`${n} 0 obj\n`); };

  startObj(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  startObj(2); push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  const xobjs = strips.map((_, i) => `/Im${i} ${IMG0 + i} 0 R`).join(' ');
  startObj(3);
  push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(widthPt)} ${f(heightPt)}] /Resources << /XObject << ${xobjs} >> >> /Contents 4 0 R >>\nendobj\n`);
  const content = strips.map((s, i) => `q ${f(widthPt)} 0 0 ${f(s.hPt)} 0 ${f(heightPt - s.yPt - s.hPt)} cm /Im${i} Do Q`).join('\n');
  const cBytes = enc.encode(content);
  startObj(4); push(`<< /Length ${cBytes.length} >>\nstream\n`); push(cBytes); push('\nendstream\nendobj\n');
  const now = new Date();
  const d = `D:${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}00Z`;
  startObj(5); push(`<< /Title ${utf16Hex(title)} /Producer (Family Tree) /CreationDate (${d}) >>\nendobj\n`);
  strips.forEach((s, i) => {
    startObj(IMG0 + i);
    push(`<< /Type /XObject /Subtype /Image /Width ${s.w} /Height ${s.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${s.data.length} >>\nstream\n`);
    push(s.data);
    push('\nendstream\nendobj\n');
  });
  const count = IMG0 + strips.length;
  const xref = offset;
  let x = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

/* ---------------- page rendering ---------------- */
function todayLabel(cal, dg) {
  const p = jdnToParts(cal, todayJdn());
  return formatRecord(makeRecord(cal, p.y, p.m, p.d), cal, dg);
}

/**
 * Renders the tree to a PDF Blob.
 * opts = { graph, collapsed, branchId, paper:[wmm,hmm], orientation:'auto'|'portrait'|'landscape',
 *          dpi, title, showDate, prefs, colors, photos, onProgress }
 */
export async function renderTreePdf(opts) {
  const layout = computeLayout(opts.graph, { collapsed: opts.collapsed, rootId: opts.branchId });
  if (!layout.nodes.length) throw new Error('لا يوجد أشخاص لتصديرهم.');
  const progress = opts.onProgress || (() => {});
  progress('تجهيز الخطوط…');
  try { await document.fonts.load(`700 15px ${opts.colors.font}`); await document.fonts.ready; } catch { /* ignore */ }
  const persons = [...new Set(layout.nodes.map((n) => n.pid))].map((id) => opts.graph.byId.get(id));
  await opts.photos.ensure(persons, (d, n) => progress(`تحميل الصور ${d} من ${n}…`));

  const b = layout.bounds;
  const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  let [wmm, hmm] = opts.paper;
  const landscape = opts.orientation === 'landscape' || (opts.orientation === 'auto' && bw / bh > 1);
  if (landscape !== wmm > hmm) [wmm, hmm] = [hmm, wmm];
  const W = wmm * MM, H = hmm * MM;
  const margin = Math.max(18, Math.min(W, H) * 0.04);
  const headerH = opts.title || opts.showDate ? Math.max(48, Math.min(W, H) * 0.075) : 0;
  const footerH = 16;
  const area = { x: margin, y: margin + headerH, w: W - margin * 2, h: H - margin * 2 - headerH - footerH };
  const s = Math.min(area.w / bw, area.h / bh, 1.25);
  const tx = area.x + (area.w - bw * s) / 2 - b.minX * s;
  const ty = area.y + (area.h - bh * s) / 2 - b.minY * s;

  const k = opts.dpi / 72; // pixels per point
  const Wpx = Math.round(W * k), Hpx = Math.round(H * k);
  const stripRows = Math.max(64, Math.min(Hpx, Math.floor(MAX_STRIP_PIXELS / Wpx)));
  const colors = printColors(opts.colors);
  const font = opts.colors.font;
  const OVERLAP = 2;
  const strips = [];
  const canvas = document.createElement('canvas');

  for (let y0 = 0; y0 < Hpx; y0 += stripRows) {
    const rows = Math.min(stripRows, Hpx - y0);
    const extra = y0 + rows < Hpx ? OVERLAP : 0;
    canvas.width = Wpx;
    canvas.height = rows + extra;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // page decorations in point units
    ctx.setTransform(k, 0, 0, k, 0, -y0);
    if (headerH) {
      const grad = ctx.createLinearGradient(margin, 0, W - margin, 0);
      grad.addColorStop(0, opts.colors.accent);
      grad.addColorStop(1, opts.colors.glow);
      ctx.textAlign = 'center';
      ctx.direction = 'rtl';
      ctx.fillStyle = '#141a33';
      const titleSize = Math.min(28, headerH * 0.42);
      ctx.font = `800 ${titleSize}px ${font}`;
      if (opts.title) ctx.fillText(opts.title, W / 2, margin + titleSize);
      if (opts.showDate) {
        ctx.font = `500 ${titleSize * 0.45}px ${font}`;
        ctx.fillStyle = '#4a5274';
        ctx.fillText(`تاريخ التصدير: ${todayLabel(opts.prefs.displayCal, opts.prefs.digits)}`, W / 2, margin + titleSize * 1.75);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(margin, margin + headerH - 6, W - margin * 2, 2.2);
    }
    ctx.font = `500 8px ${font}`;
    ctx.fillStyle = '#6b7194';
    ctx.textAlign = 'center';
    ctx.fillText(`عدد الأفراد: ${digits(persons.length, opts.prefs.digits)}`, W / 2, H - margin / 2 - 2);

    drawScene(ctx, {
      layout, scale: s, tx, ty, width: W, height: H, pr: k, oy: -y0,
      colors, photos: opts.photos, selectedKey: null, blink: null, time: 0, forPrint: true,
    });
    progress(`رسم الصفحة ${Math.min(100, Math.round(((y0 + rows) / Hpx) * 100))}%…`);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
    if (!blob) throw new Error('تعذّر إنشاء الصورة. جرّب دقة أقل.');
    strips.push({ data: new Uint8Array(await blob.arrayBuffer()), w: Wpx, h: rows + extra, yPt: y0 / k, hPt: (rows + extra) / k });
    await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
  }
  canvas.width = canvas.height = 1; // free memory (iOS)
  return buildPdf({ widthPt: W, heightPt: H, strips, title: opts.title || 'شجرة العائلة' });
}

/* ---------------- dialog ---------------- */
export function openPdfDialog({ graph, collapsed, selected, siteTitle, prefs, colors, photos }) {
  const radio = (name, value, label, checked, disabled) => {
    const input = h('input', { type: 'radio', name, value });
    input.checked = checked; input.disabled = !!disabled;
    return h('label', { class: `radio ${disabled ? 'disabled' : ''}` }, input, h('span', { text: label }));
  };
  const scope = h('div', { class: 'radio-group' },
    radio('scope', 'all', 'الشجرة كاملة', true),
    radio('scope', 'branch', selected ? `فرع: ${fullName(selected)}` : 'فرع محدد (اختر شخصًا أولًا)', false, !selected));
  const paper = h('select', { class: 'input' },
    ...Object.keys(PAPERS).map((k) => h('option', { value: k, text: `${k} (${PAPERS[k][0]}×${PAPERS[k][1]} مم)` })),
    h('option', { value: 'custom', text: 'مقاس مخصص…' }));
  paper.value = 'A3';
  const cw = h('input', { class: 'input', type: 'number', value: '500', attrs: { min: '50', max: '2000', 'aria-label': 'العرض بالمليمتر' } });
  const ch = h('input', { class: 'input', type: 'number', value: '700', attrs: { min: '50', max: '2000', 'aria-label': 'الارتفاع بالمليمتر' } });
  const custom = h('div', { class: 'grid-2' }, h('label', { class: 'field' }, h('span', { class: 'label', text: 'العرض (مم)' }), cw), h('label', { class: 'field' }, h('span', { class: 'label', text: 'الارتفاع (مم)' }), ch));
  custom.hidden = true;
  paper.addEventListener('change', () => { custom.hidden = paper.value !== 'custom'; });
  const orient = h('div', { class: 'radio-group inline' },
    radio('orient', 'auto', 'تلقائي', true), radio('orient', 'portrait', 'عمودي', false), radio('orient', 'landscape', 'أفقي', false));
  const dpi = h('select', { class: 'input' },
    h('option', { value: '150', text: '150 DPI (سريع)' }), h('option', { value: '300', text: '300 DPI (جودة طباعة)' }), h('option', { value: '400', text: '400 DPI (فائقة)' }));
  dpi.value = '300';
  const title = h('input', { class: 'input', type: 'text', value: siteTitle, attrs: { maxlength: '80' } });
  const showDate = h('input', { type: 'checkbox' }); showDate.checked = true;
  const expandAll = h('input', { type: 'checkbox' }); expandAll.checked = true;
  const status = h('p', { class: 'progress-text', attrs: { 'aria-live': 'polite' } });

  const body = h('form', { class: 'form' },
    h('fieldset', { class: 'form-section' }, h('legend', { text: 'النطاق' }), scope),
    h('fieldset', { class: 'form-section' }, h('legend', { text: 'الورق' }),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'حجم الورق' }), paper), custom,
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'الاتجاه' }), orient),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'الدقة' }), dpi)),
    h('fieldset', { class: 'form-section' }, h('legend', { text: 'المحتوى' }),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'العنوان' }), title),
      h('label', { class: 'check' }, showDate, h('span', { text: 'إظهار تاريخ التصدير' })),
      h('label', { class: 'check' }, expandAll, h('span', { text: 'تضمين الفروع المطوية' }))),
    status);

  const m = openModal({
    title: 'تصدير PDF', size: 'md', body,
    actions: [
      { label: 'إلغاء', onClick: ({ close }) => close() },
      {
        label: 'تصدير', kind: 'primary', icon: 'download',
        onClick: async () => {
          const sc = body.querySelector('input[name=scope]:checked').value;
          const or = body.querySelector('input[name=orient]:checked').value;
          let size = PAPERS[paper.value];
          if (paper.value === 'custom') {
            const w = Number(cw.value), hh = Number(ch.value);
            if (!(w >= 50 && w <= 2000 && hh >= 50 && hh <= 2000)) { formError(body, 'المقاس المخصص يجب أن يكون بين 50 و2000 مم.'); return; }
            size = [w, hh];
          }
          formError(body, null);
          m.setBusy(true, 'جارٍ التصدير…');
          try {
            // Large custom posters: keep total pixels reasonable on phones.
            let d = Number(dpi.value);
            const px = (size[0] / 25.4) * d * (size[1] / 25.4) * d;
            if (px > 140e6) { d = Math.floor(Math.sqrt(140e6 / ((size[0] / 25.4) * (size[1] / 25.4)))); }
            const blob = await renderTreePdf({
              graph, collapsed: expandAll.checked ? new Set() : collapsed, branchId: sc === 'branch' && selected ? selected.id : null,
              paper: size, orientation: or, dpi: d, title: title.value.trim(), showDate: showDate.checked,
              prefs, colors, photos, onProgress: (t) => { status.textContent = t; },
            });
            const safe = (title.value.trim() || 'family-tree').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
            downloadBlob(blob, `${safe}.pdf`);
            toast(`تم إنشاء ملف PDF (${(blob.size / 1048576).toFixed(1)} ميغابايت).`, 'success');
            m.close();
          } catch (e) {
            m.setBusy(false, 'تصدير');
            status.textContent = '';
            formError(body, e.message || 'تعذّر التصدير.');
          }
        },
      },
    ],
  });
}
