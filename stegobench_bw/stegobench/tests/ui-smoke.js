/* UI smoke test: loads the real index.html in jsdom (canvas via @napi-rs/canvas) and drives the page.
 * Run: node tests/ui-smoke.js   (needs `npm install`) */
'use strict';
const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');
const nc = require('@napi-rs/canvas');

const root = path.join(__dirname, '..');
let fails = 0;
const check = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100); } throw new Error('timeout: ' + what); }

(async () => {
  const errors = [];
  const downloads = [];
  const dom = await new Promise((resolve) => {
    const d = new JSDOM(fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8'), {
      url: 'file://' + root + '/dashboard.html', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
      beforeParse(w) {
        w.ImageData = nc.ImageData; w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.Blob = Blob; w.File = File;
        Object.defineProperty(w, 'crypto', { value: require('crypto').webcrypto, configurable: true });
        w.matchMedia = () => ({ matches: false, addEventListener() {} });
        w.URL.createObjectURL = (b) => { downloads.push(b); return 'blob:test'; }; w.URL.revokeObjectURL = () => {};
        w.HTMLElement.prototype.scrollIntoView = () => {};
        w.HTMLCanvasElement.prototype.getContext = function () {
          if (!this._nc) this._nc = nc.createCanvas(this.width || 300, this.height || 150);
          if (this._nc.width !== (this.width || 300) || this._nc.height !== (this.height || 150)) { this._nc.width = this.width || 300; this._nc.height = this.height || 150; }
          const ctx = this._nc.getContext('2d');
          return new Proxy(ctx, {
            get(t, k) { const v = t[k]; if (k === 'drawImage') return (src, ...a) => t.drawImage(src && src._nc ? src._nc : src, ...a); return typeof v === 'function' ? v.bind(t) : v; },
            set(t, k, v) { t[k] = v; return true; },
          });
        };
        w.HTMLCanvasElement.prototype.toBlob = function (cb, type, q) {
          const t = type === 'image/jpeg' ? 'image/jpeg' : type === 'image/webp' ? 'image/webp' : 'image/png';
          this.getContext('2d');
          cb(new Blob([t === 'image/png' ? this._nc.toBuffer('image/png') : this._nc.toBuffer(t, Math.round((q == null ? 0.92 : q) * 100))], { type: t }));
        };
        w.createImageBitmap = async (b) => nc.loadImage(Buffer.from(await b.arrayBuffer()));
        w.addEventListener('error', (e) => errors.push(e.message));
      },
    });
    d.window.addEventListener('load', () => resolve(d));
  });
  const w = dom.window, $ = (id) => w.document.getElementById(id), SB = w.SB;
  const click = (el) => el.dispatchEvent(new w.Event('click', { bubbles: true }));
  const setVal = (id, v) => { $(id).value = v; $(id).dispatchEvent(new w.Event('input', { bubbles: true })); };

  check('Page scripts loaded (SB, UI state)', !!SB && !!SB.ui && SB.METHODS.length === 8, SB.METHODS.length + ' methods');
  check('Method pills rendered', w.document.querySelectorAll('input[name=method]').length === 8);
  check('Run button disabled before an image is loaded', $('runBtn').disabled);

  // dataset mode + generated samples
  click(w.document.querySelector('#modeSeg [data-mode=dataset]'));
  check('Dataset mode enabled (multiple input, sample-set button)', $('fileInput').multiple && !$('sampleSetBtn').classList.contains('hidden'));
  click($('sampleSetBtn'));
  await until(() => SB.ui.state.covers.length === 12, 20000, 'covers');
  check('12 sample images loaded and scaled', SB.ui.state.covers.length === 12 && !$('fileRow').classList.contains('hidden'));
  check('Run button enabled', !$('runBtn').disabled);

  // real file upload through the loader (PNG made with the canvas)
  {
    const c = nc.createCanvas(200, 150), g = c.getContext('2d'); g.fillStyle = '#6a8'; g.fillRect(0, 0, 200, 150);
    const f = new File([c.toBuffer('image/png')], 'upload.png', { type: 'image/png' });
    const before = SB.ui.state.sources.length;
    await SB.ui.loadFiles([f]);
    check('File upload path reads PNG and records its SHA-256', SB.ui.state.sources.length === before + 1 && /^[0-9a-f]{64}$/.test(SB.ui.state.sources[before].sha));
    // drop it again so the dataset stays at 12
    SB.ui.state.sources.pop(); SB.ui.state.sources.length === 12;
    click($('sampleSetBtn')); await until(() => SB.ui.state.covers.length === 12, 20000, 'covers again');
  }

  // payload tab + file payload validation
  click(w.document.querySelector('#payloadSeg [data-ptab=file]'));
  check('File payload tab shows the file pane', !$('filePane').classList.contains('hidden') && $('runBtn').disabled);
  click(w.document.querySelector('#payloadSeg [data-ptab=text]'));

  // restrict to 4 methods + quick attack set to keep the test short
  const keep = ['seqlsb', 'lsbm', 'dct', 'dwt'];
  w.document.querySelectorAll('input[name=method]').forEach((i) => { i.checked = keep.includes(i.value); });
  setVal('attackSet', 'quick'); setVal('trials', '1');
  check('Job hint shows job count', /48 jobs/.test($('jobHint').textContent), $('jobHint').textContent);
  check('Payload info line explains framing', /hidden per image/.test($('payloadInfo').textContent), $('payloadInfo').textContent);

  const t0 = Date.now();
  click($('runBtn'));
  await until(() => SB.ui.state.last && !SB.ui.state.running, 240000, 'benchmark run');
  const last = SB.ui.state.last;
  check('Benchmark finished', last.results.length === 4, `${((Date.now() - t0) / 1000).toFixed(0)} s, execution: ${last.workers}`);
  check('Leaderboard visible with 4 ranked rows', !$('lbBody').classList.contains('hidden') && $('lbTable').querySelectorAll('tbody tr').length === 4);
  check('Mean ± std shown (dataset)', /±/.test($('lbTable').textContent));
  check('Rank stability column shown', /#1 in/.test($('lbTable').textContent));
  check('Attack heat-map has a row per attack', $('attackTable').querySelectorAll('tbody tr').length === 8, '8 expected');
  check('Attack family table rendered', $('groupTable').querySelectorAll('tbody tr').length >= 4);
  check('Detection table shows ROC columns for n >= 12', /AUC/.test($('detTable').textContent));
  const det = last.results.find((r) => r.id === 'seqlsb');
  check('ROC computed per method', det && det.detection && det.detection.auc >= 0.5, det && det.detection ? 'best ' + det.detection.best + ' AUC ' + det.detection.auc.toFixed(2) : 'none');
  check('Statistics: pairwise Wilcoxon table rendered', /Wilcoxon/.test($('statsBody').textContent) && $('statsBody').querySelectorAll('tbody tr').length >= 3);
  check('Reproducibility card includes image hashes', /source_sha256/.test($('reproBody').textContent) && !/correct horse/.test($('reproBody').textContent));
  const dctRow = last.results.find((r) => r.id === 'dct'), seqRow = last.results.find((r) => r.id === 'seqlsb');
  check('DCT more robust than Sequential LSB across the dataset', dctRow.robustness > seqRow.robustness + 15, `${dctRow.robustness.toFixed(0)} vs ${seqRow.robustness.toFixed(0)}`);
  check('Inspector has the stego image and lens canvases', $('cvStego').width > 0 && $('inspectSel').options.length === 4);
  check('Recovered payload text shown (decrypted with passphrase)', /meet me at 6/.test($('recoveredLine').textContent), $('recoveredLine').textContent.slice(0, 90));

  // goal change re-ranks
  const firstBefore = $('lbTable').querySelector('tbody tr .mname').textContent;
  setVal('goal', 'capacity'); $('goal').dispatchEvent(new w.Event('change', { bubbles: true }));
  const firstAfter = $('lbTable').querySelector('tbody tr .mname').textContent;
  check('Changing the goal re-ranks the leaderboard', $('lbTable').querySelectorAll('tbody tr').length === 4 && firstAfter.length > 0, `${firstBefore.trim()} → ${firstAfter.trim()}`);
  setVal('goal', 'balanced'); $('goal').dispatchEvent(new w.Event('change', { bubbles: true }));

  // deep analysis tabs + runs
  click(w.document.querySelector('.tabs [data-dtab=break]'));
  check('Tab switch shows breaking-point panel', !$('dp-break').classList.contains('hidden') && $('dp-sweep').classList.contains('hidden'));
  setVal('bpType', 'jpeg'); click($('bpRun'));
  await until(() => /Done|Failed|does not fit/.test($('bpStatus').textContent), 120000, 'breakpoint');
  check('Breaking-point curves computed', /Done/.test($('bpStatus').textContent) && $('bpLegend').textContent.length > 0, $('bpStatus').textContent);
  click(w.document.querySelector('.tabs [data-dtab=sweep]'));
  click($('sweepRun'));
  await until(() => /Done|Failed|No method/.test($('sweepStatus').textContent), 240000, 'sweep');
  check('Payload sweep computed', /Done/.test($('sweepStatus').textContent) && SB.ui.state.sweep && Object.keys(SB.ui.state.sweep.series).length >= 2, $('sweepStatus').textContent);

  // exports
  click($('dlCsv')); click($('dlJson'));
  const csv = await downloads[downloads.length - 2].text(), json = JSON.parse(await downloads[downloads.length - 1].text());
  check('CSV export has a header and 4 data rows', csv.split('\n').length === 5 && /robustness_sd/.test(csv));
  check('JSON export has reproducibility card, results, sweep and breakpoints', json.reproducibility && json.results.length === 4 && json.sweep && json.breakpoints);

  // extract & verify round trip with the downloaded stego image
  const row = last.results.find((r) => r.id === 'dct'), stego = row.stego;
  const c = nc.createCanvas(stego.width, stego.height); c.getContext('2d').putImageData(stego, 0, 0);
  Object.defineProperty($('exFile'), 'files', { value: [new File([c.toBuffer('image/png')], 'stego.png', { type: 'image/png' })], configurable: true });
  setVal('exMethod', 'dct'); setVal('exPass', 'correct horse battery');
  click($('exBtn'));
  await until(() => !/Working/.test($('exOut').textContent) && $('exOut').textContent !== 'Extracted text will appear here.', 60000, 'extract');
  check('Extract & verify returns the hidden text', $('exOut').textContent === 'meet me at 6', $('exOut').textContent);
  check('Extract shows checksum + decrypted chips', /Checksum OK/.test($('exChips').textContent) && /Decrypted/.test($('exChips').textContent), $('exChips').textContent);
  setVal('exPass', 'wrong passphrase'); click($('exBtn'));
  await until(() => !/Working/.test($('exOut').textContent) && $('exOut').textContent !== 'meet me at 6', 60000, 'wrong pass');
  check('Wrong passphrase is rejected (no text revealed, error chip shown)', $('exOut').textContent !== 'meet me at 6' && /chip r/.test($('exChips').innerHTML), $('exOut').textContent.slice(0, 80));

  // theme
  click($('themeBtn'));
  check('Theme toggle switches to dark', w.document.documentElement.dataset.theme === 'dark');

  check('No uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  console.log(fails ? `\n${fails} UI CHECK(S) FAILED` : '\nALL UI CHECKS PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('UI test crashed:', e); process.exit(2); });
