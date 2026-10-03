/**
 * photo.js — choose a photo (gallery or camera), crop it to a circle
 * and compress it in the browser to WebP (~400px, ≤100 KB).
 * Falls back to JPEG on browsers that cannot encode WebP (older Safari).
 */
import { h, openModal, toast } from './ui.js';

const OUT = 400;
const TARGET_BYTES = 100 * 1024;

/** Opens the native picker; resolves a File or null. */
export function pickImageFile({ camera = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', attrs: { accept: 'image/*' } });
    if (camera) input.setAttribute('capture', 'environment');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    document.body.append(input);
    let done = false;
    const finish = (f) => { if (done) return; done = true; input.remove(); resolve(f); };
    input.addEventListener('change', () => finish(input.files && input.files[0] ? input.files[0] : null));
    input.addEventListener('cancel', () => finish(null));
    input.click();
  });
}

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

/** Compress a square canvas to WebP/JPEG under TARGET_BYTES. */
export async function compressCanvas(src) {
  let last = null;
  for (const size of [OUT, 360, 320, 280, 240]) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, size, size);
    for (const q of [0.86, 0.78, 0.7, 0.62, 0.54, 0.46]) {
      let blob = await toBlob(c, 'image/webp', q);
      if (!blob || blob.type !== 'image/webp') blob = await toBlob(c, 'image/jpeg', q);
      if (!blob) continue;
      last = blob;
      if (blob.size <= TARGET_BYTES) return blob;
    }
  }
  return last;
}

const blobToDataUrl = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

/** Crop UI. Resolves a data URL or null when cancelled. */
export async function cropImageFile(file) {
  if (!file) return null;
  if (file.size > 30 * 1024 * 1024) { toast('حجم الصورة كبير جدًا (الحد 30 ميغابايت).', 'error'); return null; }
  let bmp;
  try { bmp = await loadBitmap(file); } catch {
    toast('تعذّر قراءة الصورة. جرّب صورة بصيغة JPG أو PNG.', 'error');
    return null;
  }
  const iw = bmp.width, ih = bmp.height;
  const S = Math.min(320, window.innerWidth - 72);
  const pr = Math.min(2, window.devicePixelRatio || 1);
  const r = S / 2 - 14;
  const minS = (2 * r) / Math.min(iw, ih);
  let s = minS, ox = 0, oy = 0;

  const stage = h('canvas', { class: 'crop-stage', attrs: { 'aria-label': 'منطقة قص الصورة. اسحب لتحريكها وكبّر بالإصبعين أو بالمنزلق.' } });
  stage.width = S * pr; stage.height = S * pr;
  stage.style.width = `${S}px`; stage.style.height = `${S}px`;
  const ctx = stage.getContext('2d');
  const zoom = h('input', { type: 'range', class: 'range', attrs: { min: '1', max: '4', step: '0.01', value: '1', 'aria-label': 'تكبير' } });

  const clampOffsets = () => {
    const mx = Math.max(0, (iw * s) / 2 - r), my = Math.max(0, (ih * s) / 2 - r);
    ox = Math.min(mx, Math.max(-mx, ox));
    oy = Math.min(my, Math.max(-my, oy));
  };
  const draw = () => {
    clampOffsets();
    ctx.setTransform(pr, 0, 0, pr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(bmp, S / 2 + ox - (iw * s) / 2, S / 2 + oy - (ih * s) / 2, iw * s, ih * s);
    ctx.fillStyle = 'rgba(10,12,30,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, S, S);
    ctx.arc(S / 2, S / 2, r, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, r, 0, Math.PI * 2);
    ctx.stroke();
  };
  const setZoom = (mult, cx = S / 2, cy = S / 2) => {
    const ns = minS * Math.min(4, Math.max(1, mult));
    // keep the point under (cx, cy) fixed
    ox = cx - S / 2 - ((cx - S / 2 - ox) * ns) / s;
    oy = cy - S / 2 - ((cy - S / 2 - oy) * ns) / s;
    s = ns;
    zoom.value = String(s / minS);
    draw();
  };
  zoom.addEventListener('input', () => setZoom(Number(zoom.value)));

  const pts = new Map();
  let pinch = null;
  stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture?.(e.pointerId); pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY }); if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); } });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    const cur = { x: e.offsetX, y: e.offsetY };
    pts.set(e.pointerId, cur);
    if (pts.size === 1) { ox += cur.x - prev.x; oy += cur.y - prev.y; draw(); }
    else if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      setZoom((s / minS) * (d / pinch), (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = d;
    }
  });
  const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); setZoom((s / minS) * Math.exp(-e.deltaY * 0.0018), e.offsetX, e.offsetY); }, { passive: false });
  draw();

  return new Promise((resolve) => {
    let result = null;
    const m = openModal({
      title: 'قص الصورة',
      size: 'sm',
      cls: 'crop-modal',
      body: h('div', { class: 'crop-body' }, stage, h('label', { class: 'crop-zoom' }, h('span', { text: 'تكبير' }), zoom),
        h('small', { class: 'hint', text: 'اسحب الصورة لضبط الوجه داخل الدائرة.' })),
      actions: [
        { label: 'إلغاء', onClick: ({ close }) => close() },
        {
          label: 'اعتماد الصورة', kind: 'primary', icon: 'check',
          onClick: async ({ close }) => {
            m.setBusy(true, 'جارٍ الضغط…');
            try {
              const out = document.createElement('canvas');
              out.width = out.height = OUT;
              const octx = out.getContext('2d');
              octx.imageSmoothingQuality = 'high';
              const sx = ((iw * s) / 2 - r - ox) / s, sy = ((ih * s) / 2 - r - oy) / s, sw = (2 * r) / s;
              octx.fillStyle = '#fff';
              octx.fillRect(0, 0, OUT, OUT);
              octx.drawImage(bmp, sx, sy, sw, sw, 0, 0, OUT, OUT);
              const blob = await compressCanvas(out);
              if (!blob) throw new Error('encode');
              result = await blobToDataUrl(blob);
              close();
            } catch {
              m.setBusy(false, 'اعتماد الصورة');
              toast('تعذّر معالجة الصورة.', 'error');
            }
          },
        },
      ],
      onClose: () => { if (bmp.close) bmp.close(); resolve(result); },
    });
  });
}
