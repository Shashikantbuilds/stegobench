/* Reproducible validation run (headless): 12 generated covers, all 8 methods, all 20 attacks, lossless carrier.
 *   node tests/validation-run.js [payloadBytes=100]  ->  prints a markdown table (used in README) */
'use strict';
const env = require('./node-env'); env.install();
env.loadSources(['utils.js', 'codec.js', 'stc.js', 'methods.js', 'attacks.js', 'detectors.js', 'metrics.js', 'job.js', 'benchmark.js', 'sample.js']);
const SB = global.SB;
(async () => {
  const bytes = +process.argv[2] || 100;
  const covers = Array.from({ length: 12 }, (_, i) => { const c = SB.makeSampleCanvas(512, 384, i); return { id: 'c' + i, name: 'c' + i, img: c.getContext('2d').getImageData(0, 0, 512, 384) }; });
  const payload = new Uint8Array(bytes).map((_, i) => (i * 131 + 7) & 255);
  const t = Date.now();
  const out = await SB.runBenchmark({ covers, payload, isFile: true, passphrase: 'validation', encrypt: true, ecc: 0, trials: 1, methods: SB.METHODS.map((m) => m.id), formats: ['lossless'], attackIds: SB.ATTACK_SETS.full, useWorkers: false });
  console.log(`payload ${bytes} B -> ${out.codedBytes} B hidden, ${covers.length} images 512x384, ${((Date.now() - t) / 1000).toFixed(0)} s\n`);
  console.log('| Method | PSNR dB | SSIM | Robustness | JPEG75 | Gauss σ5 | Shift 3px | Best detector (AUC) |\n|---|---|---|---|---|---|---|---|');
  for (const r of out.results) {
    if (r.status !== 'ok') { console.log(`| ${r.name} | skipped (${r.reason}) |||||||`); continue; }
    const a = r.attacks, d = r.detection;
    console.log(`| ${r.name} | ${r.psnr.toFixed(1)} | ${r.ssim.toFixed(4)} | ${r.robustness.toFixed(0)} | ${a.jpeg75.recovery.toFixed(0)} | ${a.gauss.recovery.toFixed(0)} | ${a.shift3.recovery.toFixed(0)} | ${d ? d.best + ' (' + d.auc.toFixed(2) + ')' : '–'} |`);
  }
})();
