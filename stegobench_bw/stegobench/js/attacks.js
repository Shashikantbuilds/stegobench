/* StegoBench - attack simulation engine. Runs on <canvas> (page) or OffscreenCanvas (worker).
 * Every attack is described by a small serialisable spec {id, kind, value}, so it can be sent to a worker. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;
  const SB = root.SB;

  class Unsupported extends Error {}
  SB.Unsupported = Unsupported;

  function toCanvas(img) {
    const c = SB.makeCanvas(img.width, img.height);
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }
  function fromCanvas(c) {
    return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  }
  async function encode(c, type, q) {
    return c.convertToBlob ? c.convertToBlob({ type, quality: q }) : new Promise((r) => c.toBlob(r, type, q));
  }
  async function decode(blob, w, h) {
    const bmp = await createImageBitmap(blob);
    const c = SB.makeCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    return ctx.getImageData(0, 0, w, h);
  }

  /* real browser JPEG / WebP encoder-decoder round trip */
  async function lossy(img, type, quality) {
    const blob = await encode(toCanvas(img), type, quality / 100);
    if (!blob || blob.type !== type) throw new Unsupported(type + ' encoding is not supported by this browser');
    return decode(blob, img.width, img.height);
  }
  const jpeg = (img, q) => lossy(img, 'image/jpeg', q);

  function scaleTo(img, w2, h2) {
    const c = SB.makeCanvas(w2, h2), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(toCanvas(img), 0, 0, w2, h2);
    return ctx.getImageData(0, 0, w2, h2);
  }
  function resize(img, scale) {
    const small = scaleTo(img, Math.max(8, Math.round(img.width * scale)), Math.max(8, Math.round(img.height * scale)));
    return scaleTo(small, img.width, img.height);
  }

  function gaussian(img, sigma) {
    const out = SB.cloneImage(img), d = out.data, r = SB.mulberry32(20261014);
    for (let i = 0; i < d.length; i += 4)
      for (let c = 0; c < 3; c++) {
        const u1 = Math.max(r(), 1e-12), u2 = r();
        d[i + c] = Math.round(d[i + c] + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
      }
    return out;
  }
  function saltPepper(img, p) {
    const out = SB.cloneImage(img), d = out.data, r = SB.mulberry32(20261014);
    for (let i = 0; i < d.length; i += 4)
      if (r() < p) { const v = r() < 0.5 ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v; }
    return out;
  }
  function crop(img, frac) {                       // border painted black, size kept
    const out = SB.cloneImage(img), d = out.data, w = img.width, h = img.height;
    const mx = Math.round(w * frac), my = Math.round(h * frac);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (x < mx || x >= w - mx || y < my || y >= h - my) { const p = (y * w + x) * 4; d[p] = d[p + 1] = d[p + 2] = 0; }
    return out;
  }
  function shift(img, k) {                         // translate by (k,k), edges replicated: breaks 8x8 / 2x2 grids
    if (!k) return img;
    const w = img.width, h = img.height, out = SB.cloneImage(img), s = img.data, d = out.data;
    for (let y = 0; y < h; y++) {
      const sy = Math.max(0, y - k);
      for (let x = 0; x < w; x++) {
        const sx = Math.max(0, x - k), p = (y * w + x) * 4, q = (sy * w + sx) * 4;
        d[p] = s[q]; d[p + 1] = s[q + 1]; d[p + 2] = s[q + 2];
      }
    }
    return out;
  }
  function rotate(img, deg) {                      // rotate about the centre, zoom 1.03 to hide the corners
    const w = img.width, h = img.height, src = toCanvas(img);
    const c = SB.makeCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.translate(w / 2, h / 2); ctx.rotate((deg * Math.PI) / 180); ctx.scale(1.03, 1.03);
    ctx.drawImage(src, -w / 2, -h / 2);
    return ctx.getImageData(0, 0, w, h);
  }
  function brightContrast(img, [contrast, brightness]) {
    const out = SB.cloneImage(img), d = out.data;
    for (let i = 0; i < d.length; i += 4)
      for (let c = 0; c < 3; c++) d[i + c] = (d[i + c] - 128) * contrast + 128 + brightness;
    return out;
  }
  function blur(img) {                             // 3x3 gaussian [1 2 1]/4 separable
    const w = img.width, h = img.height, s = img.data;
    const tmp = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1);
        for (let c = 0; c < 3; c++)
          tmp[(y * w + x) * 3 + c] = (s[(y * w + xl) * 4 + c] + 2 * s[(y * w + x) * 4 + c] + s[(y * w + xr) * 4 + c]) / 4;
      }
    const out = SB.cloneImage(img), d = out.data;
    for (let y = 0; y < h; y++) {
      const yu = Math.max(0, y - 1), yd = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++)
          d[(y * w + x) * 4 + c] = Math.round((tmp[(yu * w + x) * 3 + c] + 2 * tmp[(y * w + x) * 3 + c] + tmp[(yd * w + x) * 3 + c]) / 4);
    }
    return out;
  }
  function sharpen(img, amount) {
    const b = blur(img), out = SB.cloneImage(img), d = out.data, s = img.data, bb = b.data;
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = s[i + c] + amount * (s[i + c] - bb[i + c]);
    return out;
  }
  function median3(img) {
    const w = img.width, h = img.height, s = img.data, out = SB.cloneImage(img), d = out.data, v = new Array(9);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let k = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            for (let dx = -1; dx <= 1; dx++) v[k++] = s[(yy * w + Math.min(w - 1, Math.max(0, x + dx))) * 4 + c];
          }
          for (let i = 1; i < 9; i++) { const t = v[i]; let j = i - 1; while (j >= 0 && v[j] > t) { v[j + 1] = v[j]; j--; } v[j + 1] = t; }
          d[(y * w + x) * 4 + c] = v[4];
        }
    return out;
  }
  async function social(img, [scale, q]) {         // typical re-share: downscale, JPEG, upscale back
    const w = img.width, h = img.height;
    const small = scaleTo(img, Math.round(w * scale), Math.round(h * scale));
    return scaleTo(await jpeg(small, q), w, h);
  }

  const KINDS = {
    none: async (i) => i,
    jpeg: (i, v) => jpeg(i, v),
    webp: (i, v) => lossy(i, 'image/webp', v),
    dbljpeg: async (i, v) => jpeg(await jpeg(i, v[0]), v[1]),
    resize: async (i, v) => resize(i, v),
    gauss: async (i, v) => gaussian(i, v),
    sp: async (i, v) => saltPepper(i, v),
    crop: async (i, v) => crop(i, v),
    shift: async (i, v) => shift(i, v),
    rotate: async (i, v) => rotate(i, v),
    bc: async (i, v) => brightContrast(i, v),
    blur: async (i) => blur(i),
    sharpen: async (i, v) => sharpen(i, v),
    median: async (i) => median3(i),
    social: (i, v) => social(i, v),
  };
  SB.makeAttack = (kind, value) => (img) => KINDS[kind](img, value);
  SB.attackFromSpec = (s) => SB.makeAttack(s.kind, s.value);
  SB.attackFns = { jpeg, resize, gaussian, saltPepper, crop, shift, rotate, blur, median3, sharpen, scaleTo, toCanvas, fromCanvas };

  const A = (id, label, group, kind, value) => ({ id, label, group, kind, value, run: SB.makeAttack(kind, value) });
  SB.ATTACKS = [
    A('none', 'None (baseline)', 'baseline', 'none'),
    A('jpeg90', 'JPEG QF 90', 'jpeg', 'jpeg', 90),
    A('jpeg75', 'JPEG QF 75', 'jpeg', 'jpeg', 75),
    A('jpeg50', 'JPEG QF 50', 'jpeg', 'jpeg', 50),
    A('jpeg30', 'JPEG QF 30', 'jpeg', 'jpeg', 30),
    A('dbljpeg', 'Double JPEG (85 → 70)', 'jpeg', 'dbljpeg', [85, 70]),
    A('webp80', 'WebP quality 80', 'format', 'webp', 80),
    A('resize90', 'Resize 90%', 'resize', 'resize', 0.9),
    A('resize75', 'Resize 75%', 'resize', 'resize', 0.75),
    A('resize50', 'Resize 50%', 'resize', 'resize', 0.5),
    A('gauss', 'Gaussian noise (σ=5)', 'noise', 'gauss', 5),
    A('sp', 'Salt & pepper (1%)', 'noise', 'sp', 0.01),
    A('crop', 'Crop 10% border (black)', 'geometry', 'crop', 0.1),
    A('shift3', 'Shift by 3 px (grid sync)', 'geometry', 'shift', 3),
    A('rot1', 'Rotate 1° (+3% zoom)', 'geometry', 'rotate', 1),
    A('bc', 'Brightness +10 / contrast ×1.1', 'tone', 'bc', [1.1, 10]),
    A('blur', 'Blur (3×3 Gaussian)', 'filter', 'blur'),
    A('median', 'Median filter 3×3', 'filter', 'median'),
    A('sharpen', 'Sharpen (unsharp 0.8)', 'filter', 'sharpen', 0.8),
    A('convert', 'PNG→JPEG(85)→PNG', 'convert', 'jpeg', 85),
    A('social', 'Social-media style (80% + JPEG 72)', 'chain', 'social', [0.8, 72]),
  ];
  SB.attackById = (id) => SB.ATTACKS.find((a) => a.id === id);
  SB.attackSpec = (a) => ({ id: a.id, kind: a.kind, value: a.value, label: a.label, group: a.group });
  SB.ATTACK_SETS = {
    full: SB.ATTACKS.map((a) => a.id),
    quick: ['none', 'jpeg90', 'jpeg75', 'jpeg50', 'resize75', 'gauss', 'shift3', 'blur'],
  };
  SB.GROUP_LABEL = { jpeg: 'JPEG', format: 'Other formats', resize: 'Resize', noise: 'Noise', geometry: 'Geometry', tone: 'Tone', filter: 'Filters', convert: 'Conversion', chain: 'Re-share chain' };

  /* strength sweeps for the "breaking point" analysis */
  SB.SWEEPS = {
    jpeg: { label: 'JPEG quality factor', axis: 'JPEG QF (high → low = stronger)', values: [100, 95, 90, 80, 70, 60, 50, 40, 30, 20], reverse: true },
    gauss: { label: 'Gaussian noise σ', axis: 'Noise σ (gray levels)', values: [0, 1, 2, 3, 5, 8, 12, 20] },
    resize: { label: 'Down/up-scale factor', axis: 'Scale (1 → 0.3)', values: [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3], reverse: true },
    shift: { label: 'Pixel shift (grid sync)', axis: 'Shift (px)', values: [0, 1, 2, 3, 4, 5, 6, 7] },
  };
})();
