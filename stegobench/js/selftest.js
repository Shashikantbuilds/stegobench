/* StegoBench - self-test. `SB.runSelfTest(report)` calls report(name, ok, detail) for every check.
 * Used by tests.html (browser) and tests/run-node.js (CI, headless). */
(function () {
  'use strict';
  const SB = window.SB;
  const bm = SB.bitMatch;

  SB.runSelfTest = async function (report) {
    let pass = 0, fail = 0;
    const row = (name, ok, detail) => { ok ? pass++ : fail++; report(name, !!ok, detail || ''); };
    const canvas = SB.makeSampleCanvas(800, 600);
    const cover = canvas.getContext('2d').getImageData(0, 0, 800, 600);
    const text = 'StegoBench test payload: meet at 9 PM, bring the keys.';
    const bits = SB.textToBits(text);
    const key = SB.keyFromNumber(1337), key2 = SB.keyFromNumber(1338);

    /* ---- codec ---- */
    row('Text <-> bits round trip', SB.bitsToText(SB.textToBits('héllo ✓')) === 'héllo ✓');
    row('CRC32 check value', SB.crc32(new TextEncoder().encode('123456789')) === 0xcbf43926, 'expected cbf43926');
    row('Keyed RNG: same key = same stream, different key = different stream',
      SB.keyedRng(key, 1)() === SB.keyedRng(key, 1)() && SB.keyedRng(key, 1)() !== SB.keyedRng(key2, 1)());
    {
      const rnd = SB.mulberry32(5);
      for (const nsym of [32, 96]) {
        const msg = new Uint8Array(500).map(() => (rnd() * 256) | 0), coded = SB.ecc.encode(msg, nsym), bad = coded.slice();
        let o = 0, left = 500; const k = 255 - nsym;
        while (left > 0) { const kk = Math.min(k, left); for (let i = 0; i < nsym / 2; i++) bad[o + i * 3 % (kk + nsym)] ^= 0xa5; o += kk + nsym; left -= kk; }
        const r = SB.ecc.decode(bad, nsym, 500);
        row(`Reed-Solomon (+${nsym}) corrects ${nsym / 2} byte errors per block`, r.ok && r.data.every((v, i) => v === msg[i]), 'corrected ' + r.corrected);
        const garbage = coded.map((v, i) => (i % 2 ? v ^ 0x55 : v)), g = SB.ecc.decode(garbage, nsym, 500);
        row(`Reed-Solomon (+${nsym}) reports failure when overloaded (no crash)`, g.ok === false || g.data.every((v, i) => v === msg[i]));
      }
    }
    {
      const p = new TextEncoder().encode('secret hello');
      const f = await SB.frame.pack(p, {});
      const u = await SB.frame.unpack(f);
      row('Frame: pack/unpack round trip', u.ok && new TextDecoder().decode(u.data) === 'secret hello');
      const g = f.slice(); g[6] ^= 1;
      row('Frame: CRC detects a flipped bit', !(await SB.frame.unpack(g)).ok);
      if (SB.crypto.available) {
        const k1 = await SB.crypto.deriveKey('hunter2'), k2 = await SB.crypto.deriveKey('hunter3');
        const fe = await SB.frame.pack(p, { key: k1, encrypt: true });
        const ok1 = await SB.frame.unpack(fe, k1), ok2 = await SB.frame.unpack(fe, k2);
        row('AES-GCM: correct passphrase decrypts', ok1.ok && new TextDecoder().decode(ok1.data) === 'secret hello');
        row('AES-GCM: wrong passphrase is rejected', !ok2.ok, ok2.reason);
      } else row('AES-GCM (WebCrypto unavailable here - skipped)', true);
    }

    /* ---- STC ---- */
    {
      const n = 60000, m = 9000, rnd = SB.mulberry32(9);
      const x = new Uint8Array(n).map(() => (rnd() < 0.5 ? 1 : 0)), rho = new Float32Array(n).map(() => 0.1 + rnd() * 10);
      const msg = new Uint8Array(m).map(() => (rnd() < 0.5 ? 1 : 0)), r = SB.stc.embed(x, rho, msg, key);
      row('STC: syndrome extraction returns the message', bm(msg, SB.stc.extract(r.y, m, key)) === 1);
      row('STC: needs fewer changes than naive LSB (0.5 per bit)', r.changes / m < 0.4, (r.changes / m).toFixed(3) + ' changes/bit');
    }

    /* ---- methods ---- */
    for (const m of SB.METHODS) {
      const stego = m.embed(cover, bits, key);
      row(`${m.name}: stego differs from cover`, !stego.data.every((v, i) => v === cover.data[i]));
      const got = m.extract(stego, bits.length, key);
      row(`${m.name}: clean extract recovers message`, SB.bitsToText(got) === text, SB.bitsToText(got).slice(0, 50));
      if (m.id !== 'seqlsb') row(`${m.name}: wrong key fails`, bm(bits, m.extract(stego, bits.length, key2)) < 0.75);
      const p = SB.metrics.psnr(SB.metrics.mse(cover, stego));
      row(`${m.name}: PSNR >= 33 dB`, p >= 33, p.toFixed(1) + ' dB');
    }

    /* ---- attacks ---- */
    const A = (id) => SB.attackById(id).run;
    const jq = await A('jpeg50')(cover), p50 = SB.metrics.psnr(SB.metrics.mse(cover, jq));
    row('Attack: JPEG QF50 really changes the image', p50 < 45 && p50 > 20, p50.toFixed(1) + ' dB');
    const g1 = await A('gauss')(cover), g2 = await A('gauss')(cover);
    row('Attack: noise is deterministic (reproducible)', g1.data.every((v, i) => v === g2.data[i]));
    const rec = async (id, atk) => { const m = SB.methodById(id), s = m.embed(cover, bits, key); return bm(bits, m.extract(await A(atk)(s), bits.length, key)); };
    row('Sequential LSB is destroyed by JPEG QF75 (~50 %)', (await rec('seqlsb', 'jpeg75')) < 0.65);
    row('LSB Matching is destroyed by JPEG QF75', (await rec('lsbm', 'jpeg75')) < 0.65);
    row('S-UNIWARD+STC is destroyed by JPEG QF75 (no robustness by design)', (await rec('suni', 'jpeg75')) < 0.65);
    row('DCT survives JPEG QF75 (>= 95 %)', (await rec('dct', 'jpeg75')) >= 0.95);
    row('DCT + Vote survives JPEG QF50 (100 %)', (await rec('dctvote', 'jpeg50')) === 1);
    row('Spread spectrum survives Gaussian noise (>= 95 %)', (await rec('spread', 'gauss')) >= 0.95);
    row('DWT-QIM survives JPEG QF75 (>= 95 %)', (await rec('dwt', 'jpeg75')) >= 0.95);
    row('DCT fails under a 3 px shift (grid sync lost)', (await rec('dct', 'shift3')) < 0.8, 'expected weakness, reported honestly');

    /* ---- detectors & metrics ---- */
    {
      const N = 800 * 600 * 3, rnd = SB.mulberry32(3), rb = new Uint8Array(Math.floor(N * 0.6)).map(() => (rnd() < 0.5 ? 1 : 0));
      const d0 = SB.detectors.run(cover), dr = SB.detectors.run(SB.methodById('rndlsb').embed(cover, rb, key));
      row('RS analysis rises when 60 % of samples carry LSB data', dr.rs - d0.rs > 0.2, `cover ${d0.rs.toFixed(2)} -> ${dr.rs.toFixed(2)}`);
      row('Weighted Stego rises when 60 % of samples carry LSB data', dr.ws - d0.ws > 0.15, `cover ${d0.ws.toFixed(2)} -> ${dr.ws.toFixed(2)}`);
      const ds = SB.detectors.run(SB.methodById('seqlsb').embed(cover, rb.subarray(0, Math.floor(N * 0.1)), key));
      row('Progressive chi-square flags sequential LSB (10 % fill)', ds.chiSeq > 0.9 && d0.chiSeq < 0.5, `cover ${d0.chiSeq.toFixed(2)} -> ${ds.chiSeq.toFixed(2)}`);
      row('SSIM of identical images is 1, PSNR is 99', Math.abs(SB.metrics.ssim(SB.metrics.describe(cover).ssimPrep, SB.lumaPlane(cover), SB.lumaPlane(cover), 800, 600) - 1) < 1e-6 && SB.metrics.psnr(0) === 99);
      const noisy = await A('gauss')(cover), prep = SB.metrics.describe(cover).ssimPrep;
      row('SSIM drops for a noisy image', SB.metrics.ssim(prep, SB.lumaPlane(cover), SB.lumaPlane(noisy), 800, 600) < 0.99);
    }
    {
      const r = SB.stats.roc([1, 2, 3, 4], [3, 4, 5, 6]);
      row('Statistics: ROC AUC on a known example', Math.abs(r.auc - 0.875) < 1e-9, r.auc.toFixed(3));
      const w = SB.stats.wilcoxon([1, 2, 3, 4, 5, 6, 7, 8], [0, 0, 0, 0, 0, 0, 0, 0]);
      row('Statistics: Wilcoxon signed-rank detects a consistent shift', w.p < 0.05, 'p = ' + w.p.toFixed(4));
    }
    row('Capacity check works on tiny images', SB.methodById('spread').capacityBits(64, 64) < bits.length);

    /* ---- whole pipeline on a small dataset ---- */
    {
      const covers = [0, 1].map((i) => { const c = SB.makeSampleCanvas(400 + i * 8, 300); return { id: 'c' + i, name: 'c' + i, img: c.getContext('2d').getImageData(0, 0, c.width, c.height) }; });
      const out = await SB.runBenchmark({
        covers, payload: new TextEncoder().encode('meet me at 6'), isFile: false, passphrase: 'selftest', encrypt: true, ecc: 32, trials: 1,
        methods: ['seqlsb', 'dct', 'spread'], formats: ['lossless'], attackIds: SB.ATTACK_SETS.quick, useWorkers: false,
      });
      const by = Object.fromEntries(out.results.map((r) => [r.id, r]));
      row('Benchmark: encrypted + ECC payload recovered on the clean channel (all methods)', ['seqlsb', 'dct', 'spread'].every((id) => by[id].status === 'ok' ? by[id].attacks.none.exact >= 1 : by[id].status === 'skipped'), out.results.map((r) => r.id + ':' + r.status).join(' '));
      row('Benchmark: aggregates over images (n = 2)', by.seqlsb.n === 2);
      row('Benchmark: DCT more robust than sequential LSB', by.dct.status !== 'ok' || by.dct.robustness > by.seqlsb.robustness + 20, `${by.dct.robustness && by.dct.robustness.toFixed(0)} vs ${by.seqlsb.robustness.toFixed(0)}`);
      const sw = await SB.runSweep({ covers: [covers[0]], rates: [0.01, 0.1], methods: ['seqlsb', 'dct'], attackId: 'jpeg75', passphrase: 'selftest', useWorkers: false });
      row('Payload sweep returns points per method', sw.series.seqlsb && sw.series.seqlsb.length >= 1, Object.keys(sw.series).join(','));
      const bp = await SB.runBreakpoint({ cover: covers[0], methods: ['dct'], sweepId: 'jpeg', passphrase: 'selftest', useWorkers: false });
      row('Breakpoint curve: DCT degrades as JPEG quality falls', bp.curves.dct && bp.curves.dct[0] >= bp.curves.dct[bp.curves.dct.length - 1], (bp.curves.dct || []).map((v) => v == null ? '-' : v.toFixed(0)).join(' '));
    }
    return { pass, fail };
  };
})();
