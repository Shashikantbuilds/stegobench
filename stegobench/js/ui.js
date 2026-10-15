/* StegoBench - user interface wiring */
(function () {
  'use strict';
  const SB = window.SB;
  const $ = (id) => document.getElementById(id);
  const MAX_BYTES = 10 * 1024 * 1024, MAX_PAYLOAD = 64 * 1024, MAX_DATASET = 40;

  const ICON = {
    seqlsb: ['#i-cube', 'c-blue'], rndlsb: ['#i-cube', 'c-green'], lsbm: ['#i-cube', 'c-cyan'], suni: ['#i-eye', 'c-pink'],
    dct: ['#i-pulse', 'c-purple'], dctvote: ['#i-shield-check', 'c-teal'], spread: ['#i-signal', 'c-orange'], dwt: ['#i-layers', 'c-amber'],
  };
  const SHORT = { seqlsb: 'Seq LSB', rndlsb: 'Rnd LSB', lsbm: 'LSB±1', suni: 'S-UNIW', dct: 'DCT', dctvote: 'DCT+Vote', spread: 'Spread', dwt: 'DWT' };
  const PRESETS = {
    all: SB.METHODS.map((m) => m.id), spatial: ['seqlsb', 'rndlsb', 'lsbm'], stealth: ['lsbm', 'suni'], robust: ['dct', 'dctvote', 'spread', 'dwt'],
  };
  const DETECTOR_LABEL = { rs: 'RS analysis', ws: 'Weighted Stego', chiSeq: 'Progressive χ²' };

  const state = {
    mode: 'single', sources: [], covers: [], payloadTab: 'text', payloadFile: null,
    maxSide: 1024, useWorkers: true, running: false, last: null, goal: 'balanced', justDone: false,
    sweep: null, bp: null, extractedFile: null, inspect: null,
  };

  /* ------------------------------------------------------------ helpers */
  const selectedMethods = () => [...document.querySelectorAll('input[name=method]:checked')].map((i) => i.value);
  const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '–');
  const icon = (id) => `<svg><use href="${id}"/></svg>`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const eccLevel = () => +$('ecc').value;
  const trialsN = () => Math.max(1, Math.min(5, parseInt($('trials').value, 10) || 1));
  const formatsSel = () => { const v = $('carrier').value; return v === 'both' ? ['lossless', 'jpeg'] : [v]; };
  const encryptOn = () => $('encrypt').checked && SB.crypto.available;
  const pm = (r, f, d) => (r.n > 1 && r.std && Number.isFinite(r.std[f]) ? `<small class="sd">±${r.std[f].toFixed(d == null ? 1 : d)}</small>` : '');

  function showNotice(text, isErr) {
    const n = $('notice');
    if (!text) { n.classList.add('hidden'); return; }
    n.textContent = text; n.classList.toggle('err', !!isErr); n.classList.remove('hidden');
  }
  function setStatus(text, done) {
    $('statusLabel').textContent = text;
    $('statusOk').classList.toggle('hidden', !done);
    $('statusIc').classList.toggle('hidden', !!done);
  }
  function setProgress(p) { $('progressFill').style.width = p + '%'; $('progressTrack').setAttribute('aria-valuenow', Math.round(p)); }
  function download(name, blob) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const legendHTML = (items) => items.map((it) => `<span><i style="background:${it.color}"></i>${esc(it.name)}</span>`).join('');
  const goalW = () => SB.GOALS[state.goal].w;

  /* ----------------------------------------------------------- payload */
  function payloadBytes() {
    if (state.payloadTab === 'file') return state.payloadFile ? state.payloadFile.bytes : null;
    return new TextEncoder().encode($('message').value);
  }

  /* ----------------------------------------------------------- validation */
  function refresh() {
    $('msgCount').textContent = $('message').value.length + '/2000';
    const methods = selectedMethods(), pb = payloadBytes(), pass = $('pass').value;
    const n = state.covers.length;
    $('runBtn').disabled = !(n && methods.length && pb && pb.length && pass && !state.running);
    $('sweepRun').disabled = $('bpRun').disabled = !(n && methods.length && pass && !state.running);

    if (!state.running && !state.justDone) {
      if (!n) setStatus('Load an image to start');
      else if (!methods.length) setStatus('Select at least one method');
      else if (!pb || !pb.length) setStatus(state.payloadTab === 'file' ? 'Choose a payload file' : 'Enter a secret message');
      else if (!pass) setStatus('Enter a passphrase');
      else setStatus(`Ready – ${methods.length} method${methods.length > 1 ? 's' : ''}, ${n} image${n > 1 ? 's' : ''}`);
    }
    if (pb && pb.length) {
      const opts = { encrypt: encryptOn(), ecc: eccLevel() };
      const bits = SB.pipeline.bitLength(pb.length, opts);
      $('payloadInfo').textContent = `${pb.length} B payload → ${SB.frame.overhead(opts.encrypt)} B header/CRC${opts.encrypt ? '/AES-GCM' : ''}${opts.ecc ? ' + RS parity' : ''} → ${bits / 8} B (${bits} bits) hidden per image.`;
      if (n && methods.length && !state.running) {
        const small = state.covers.reduce((a, c) => (c.img.width * c.img.height < a.img.width * a.img.height ? c : a));
        const { width: w, height: h } = small.img;
        const too = methods.map(SB.methodById).filter((m) => m.capacityBits(w, h) < bits);
        if (too.length === methods.length) showNotice(`The payload is too large for every selected method on the smallest image (${w}×${h}). Shorten it, lower error correction, or use a larger image.`, true);
        else if (too.length) showNotice(`Not enough capacity on the smallest image for: ${too.map((m) => m.name).join(', ')} (they will be skipped there). Shorten the payload or lower error correction.`);
        else if (!state.scaledNote) showNotice('');
      }
    } else $('payloadInfo').textContent = '';
    const jobs = n * trialsN() * formatsSel().length * methods.length;
    $('jobHint').textContent = jobs ? `${jobs} job${jobs > 1 ? 's' : ''}${jobs > 150 ? ' – this can take a few minutes; Quick attack set or fewer images will be faster' : ''}` : '';
  }
  const touch = () => { state.justDone = false; refresh(); };

  /* ----------------------------------------------------------- image load */
  function scaleSource(s) {
    const k = Math.min(1, state.maxSide / Math.max(s.w, s.h));
    const c = document.createElement('canvas');
    c.width = Math.max(16, Math.round(s.w * k)); c.height = Math.max(16, Math.round(s.h * k));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(s.drawable, 0, 0, c.width, c.height);
    return { canvas: c, img: g.getImageData(0, 0, c.width, c.height), scaled: k < 1 };
  }
  function applyScale() {
    if (!state.sources.length) { state.covers = []; $('fileRow').classList.add('hidden'); touch(); return; }
    state.covers = state.sources.map((s, i) => {
      const r = scaleSource(s);
      return { id: 'img' + i, name: s.name, bytes: s.bytes, sha: s.sha, srcW: s.w, srcH: s.h, img: r.img, canvas: r.canvas, scaled: r.scaled };
    });
    const c0 = state.covers[0], t = $('fileThumb').getContext('2d'), tw = 56, th = 56;
    t.clearRect(0, 0, tw, th);
    const q = Math.max(tw / c0.canvas.width, th / c0.canvas.height);
    t.drawImage(c0.canvas, (tw - c0.canvas.width * q) / 2, (th - c0.canvas.height * q) / 2, c0.canvas.width * q, c0.canvas.height * q);
    const n = state.covers.length;
    $('fileName').textContent = n > 1 ? `${n} images` : c0.name;
    $('fileMeta').textContent = n > 1 ? `(first: ${c0.name}, ${c0.img.width}×${c0.img.height})` : `(${c0.bytes ? SB.fmtBytes(c0.bytes) + ', ' : ''}${c0.img.width}×${c0.img.height})`;
    $('fileRow').classList.remove('hidden');
    const anyScaled = state.covers.some((c) => c.scaled);
    state.scaledNote = anyScaled;
    showNotice(anyScaled ? `Large images were scaled to at most ${state.maxSide} px (change in Settings). Everything stays in your browser.` : '');
    touch();
  }
  function clearImages() {
    state.sources = []; state.covers = []; state.scaledNote = false;
    $('fileInput').value = ''; showNotice(''); applyScale();
  }
  async function readSource(file) {
    if (!/^image\/(png|jpeg|bmp|x-ms-bmp)$/.test(file.type) && !/\.(png|jpe?g|bmp)$/i.test(file.name)) throw new Error(`${file.name}: unsupported type (use PNG, JPG or BMP)`);
    if (file.size > MAX_BYTES) throw new Error(`${file.name}: larger than 10 MB`);
    const buf = await file.arrayBuffer();
    let drawable;
    try { drawable = await createImageBitmap(new Blob([buf], { type: file.type || 'image/png' })); }
    catch (e) { throw new Error(`${file.name}: could not be read as an image`); }
    return { drawable, w: drawable.width, h: drawable.height, name: file.name, bytes: file.size, sha: await SB.crypto.sha256Hex(new Uint8Array(buf)) };
  }
  async function loadFiles(list) {
    const files = [...list].filter(Boolean);
    if (!files.length) return;
    const use = state.mode === 'dataset' ? files.slice(0, MAX_DATASET) : files.slice(0, 1);
    const out = [], errs = [];
    for (const f of use) { try { out.push(await readSource(f)); } catch (e) { errs.push(e.message); } }
    if (!out.length) { showNotice(errs.join(' · ') || 'No readable images.', true); return; }
    state.sources = state.mode === 'dataset' ? state.sources.concat(out).slice(0, MAX_DATASET) : out;
    applyScale();
    if (errs.length) showNotice(`Skipped: ${errs.join(' · ')}`);
    else if (files.length > use.length) showNotice(`Only the first ${use.length} images were used.`);
  }
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('#modeSeg button').forEach((b) => { const on = b.dataset.mode === mode; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    const ds = mode === 'dataset';
    $('fileInput').multiple = ds;
    $('dropMain').textContent = ds ? 'Choose images' : 'Choose file';
    $('dropSub').textContent = ds ? `or drop up to ${MAX_DATASET} images here` : 'or drag and drop';
    $('sampleSetBtn').classList.toggle('hidden', !ds);
    $('sampleBtn').classList.toggle('hidden', ds);
    if (ds && state.maxSide > 512) { state.maxSide = 512; $('maxSide').value = '512'; if (state.sources.length) applyScale(); }
    if (!ds && state.sources.length > 1) { state.sources = state.sources.slice(0, 1); applyScale(); }
  }
  function setPayloadTab(tab) {
    state.payloadTab = tab;
    document.querySelectorAll('#payloadSeg button').forEach((b) => { const on = b.dataset.ptab === tab; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    $('textPane').classList.toggle('hidden', tab !== 'text'); $('filePane').classList.toggle('hidden', tab !== 'file');
    touch();
  }
  async function loadPayloadFile(f) {
    if (!f) { state.payloadFile = null; $('payloadFileInfo').textContent = 'Choose any file up to 64 KB.'; touch(); return; }
    if (f.size > MAX_PAYLOAD) { state.payloadFile = null; $('payloadFileInfo').textContent = `${f.name} is ${SB.fmtBytes(f.size)} – the limit is 64 KB.`; touch(); return; }
    state.payloadFile = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    $('payloadFileInfo').textContent = `${f.name} · ${SB.fmtBytes(f.size)}`;
    touch();
  }

  /* ----------------------------------------------------------------- run */
  async function run() {
    if (state.running) return;
    state.running = true; state.justDone = false;
    $('runBtn').disabled = true; showNotice(''); setProgress(0);
    const pb = payloadBytes();
    const cfg = {
      covers: state.covers.map((c) => ({ id: c.id, name: c.name, img: c.img })), payload: pb, isFile: state.payloadTab === 'file', passphrase: $('pass').value,
      encrypt: encryptOn(), ecc: eccLevel(), trials: trialsN(), methods: selectedMethods(), formats: formatsSel(),
      attackIds: SB.ATTACK_SETS[$('attackSet').value], useWorkers: state.useWorkers,
    };
    try {
      const out = await SB.runBenchmark(cfg, ({ done, total, label, eta }) => {
        setProgress(total ? (done / total) * 100 : 0);
        setStatus(`${label} (${done}/${total})${eta != null && done < total ? ` · ~${Math.max(1, Math.round(eta))} s left` : ''}`);
      });
      out.settings = { goal: state.goal, maxSide: state.maxSide, attackSet: $('attackSet').value, payloadType: cfg.isFile ? 'file' : 'text', methods: cfg.methods };
      out.coversInfo = state.covers.map((c) => ({ name: c.name, width: c.img.width, height: c.img.height, source_bytes: c.bytes, source_sha256: c.sha }));
      out.coverRef = state.covers[0].img;
      state.last = out; state.sweep = null; state.bp = null; setProgress(100);
      state.running = false; state.justDone = true;
      setStatus(`Done in ${out.seconds.toFixed(1)} s (${out.workers}). ${out.nImages} image${out.nImages > 1 ? 's' : ''} × ${out.trials} key${out.trials > 1 ? 's' : ''}.`, true);
      renderAll();
      $('leaderboard').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } catch (e) {
      console.error(e); state.running = false;
      showNotice('Benchmark failed: ' + (e && e.message ? e.message : e), true); setStatus('Failed');
    } finally { state.running = false; refresh(); }
  }

  /* --------------------------------------------------------- leaderboard */
  const best = (arr, f, dir) => arr.reduce((a, b) => ((dir || 1) * (f(b) - f(a)) > 0 ? b : a));
  const heat = (p) => `background:hsl(${Math.round(p * 1.3)} 65% var(--hl,90%));color:hsl(${Math.round(p * 1.3)} 60% var(--hd,24%))`;
  const okRows = () => state.last.results.filter((r) => r.status === 'ok');
  const label = (r, multi) => r.name + (multi ? ` · ${r.formatLabel}` : '');
  const rankedRows = () => { const ok = okRows(); ok.forEach((r) => { r.overall = SB.overall(r, state.goal); }); return [...ok].sort((a, b) => b.overall - a.overall); };

  function renderAll() {
    renderLeaderboard(); renderAttacks(); renderDetection(); renderRepro();
    $('sweepRun').disabled = $('bpRun').disabled = false;
  }

  function renderLeaderboard() {
    const run = state.last; if (!run) return;
    $('lbEmpty').classList.add('hidden'); $('lbBody').classList.remove('hidden');
    const G = SB.GOALS[state.goal], multi = run.formats.length > 1, ok = okRows();
    if (!ok.length) {
      $('tiles').innerHTML = ''; $('recs').innerHTML = '';
      $('lbTable').innerHTML = '<tbody><tr><td class="skip">No method could embed this payload: ' + esc(run.results.map((r) => r.name + ' – ' + r.reason).join('; ')) + '</td></tr></tbody>';
      $('attackCard').classList.add('hidden'); $('paretoChart').classList.add('hidden'); return;
    }
    $('paretoChart').classList.remove('hidden');
    const ranked = rankedRows(), top = ranked[0], rob = best(ok, (r) => r.robustness);
    const stab = SB.rankStability(ranked, 600), par = SB.pareto(ranked);
    const nMethods = new Set(run.results.map((r) => r.id)).size;
    const minCap = Math.min(...ok.map((r) => r.capacityBits)), ratio = run.payloadBits / minCap;
    const nSamples = run.nImages * run.trials;
    $('tiles').innerHTML =
      `<div class="tilebox"><span class="ticon">${icon('#i-image')}</span><div><small>Methods tested</small><b>${nMethods}</b><span class="sub">${run.attacks.length - 1} attacks · ${nSamples} sample${nSamples > 1 ? 's' : ''} each</span><span class="chip g">${icon('#i-check')}Complete</span></div></div>` +
      `<div class="tilebox"><span class="ticon p">${icon('#i-box')}</span><div><small>Hidden per image</small><b>${run.codedBytes} B<em>${run.payloadBits} bits</em></b><span class="sub">payload ${run.payloadBytes} B${run.encrypt ? ' · encrypted' : ''}${run.ecc ? ' · RS ECC' : ''}</span><span class="chip p">${icon('#i-shield-check')}${ratio < 0.5 ? 'Good capacity' : ratio < 1 ? 'Near the limit' : 'Over capacity'}</span></div></div>` +
      `<div class="tilebox"><span class="ticon s">${icon('#i-star')}</span><div><small>Top ranked</small><b>${esc(label(top, multi))}</b><span class="sub">${f1(top.overall)}/100${top.n > 1 ? ` · #1 in ${Math.round(stab[0].pFirst * 100)}% of weightings` : ''}</span><span class="chip o">${icon('#i-crown')}${state.goal === 'balanced' ? 'Best overall' : 'Best for goal'}</span></div></div>` +
      `<div class="tilebox"><span class="ticon">${icon('#i-shield-check')}</span><div><small>Most robust</small><b>${esc(label(rob, multi))}</b><span class="sub">${f1(rob.robustness)}/100</span><span class="chip p">${icon('#i-shield-check')}Best robustness</span></div></div>`;

    const arrow = (a, l) => `${l} <span style="color:var(--blue)">${a}</span>`;
    let h = `<thead><tr><th>#</th><th>Method</th><th>Type</th><th>Capacity</th><th>${arrow('↑', 'Imperceptibility')}</th><th>${arrow('↑', 'Robustness')}</th><th>${arrow('↓', 'Detectability')}</th><th>${arrow('↑', 'Overall')}</th><th title="Share of 600 random weightings in which this method ranks first">#1 in</th></tr></thead><tbody>`;
    ranked.forEach((r, i) => {
      const [ic, cl] = ICON[r.id];
      h += `<tr class="${i === 0 ? 'first' : ''}" title="PSNR ${f1(r.psnr)} dB · SSIM ${r.ssim.toFixed(4)} · JPEG QF75 recovery ${f1(r.jpeg75)}% · risk ${r.riskLabel} · n = ${r.n}">` +
        `<td><span class="rk">${i === 0 ? icon('#i-crown') : i + 1}</span></td>` +
        `<td><span class="mname"><i class="${cl}">${icon(ic)}</i>${r.name}${multi ? `<span class="fmt">${r.formatLabel}</span>` : ''}${par[i] ? '<span class="par" title="Pareto-optimal: no other method is at least as good on all four scores">Pareto</span>' : ''}</span></td>` +
        `<td>${r.domain}</td><td>${SB.fmtBytes(r.capacityBytes)}</td>` +
        `<td>${f1(r.quality)}${pm(r, 'quality')}</td><td>${f1(r.robustness)}${pm(r, 'robustness')}</td><td>${f1(r.risk)}${pm(r, 'risk')}</td>` +
        `<td><span class="ovr">${f1(r.overall)}</span></td><td>${Math.round(stab[i].pFirst * 100)}%</td></tr>`;
    });
    run.results.filter((r) => r.status !== 'ok').forEach((r) => {
      const [ic, cl] = ICON[r.id];
      h += `<tr><td></td><td><span class="mname"><i class="${cl}">${icon(ic)}</i>${r.name}${multi ? `<span class="fmt">${r.formatLabel}</span>` : ''}</span></td><td>${r.domain}</td><td>${SB.fmtBytes(r.capacityBytes)}</td><td colspan="5" class="skip">Skipped – ${esc(r.reason)}</td></tr>`;
    });
    $('lbTable').innerHTML = h + '</tbody>';
    $('lbHint').textContent = `Goal: ${G.label} (robustness ${G.w[0] * 100}%, imperceptibility ${G.w[1] * 100}%, low detectability ${G.w[2] * 100}%, capacity ${G.w[3] * 100}%). Scores are 0–100; detectability is a risk score, lower is better. ${nSamples > 1 ? 'Values are means; ± is the standard deviation over image/key samples. ' : 'One sample only – use Dataset mode or several keys for error bars. '}Hover a row for PSNR and SSIM.`;

    /* trade-off chart */
    SB.charts.draw($('paretoChart'), 'scatter', {
      xlabel: 'Imperceptibility', ylabel: 'Robustness',
      points: ranked.map((r, i) => ({ x: r.quality, y: r.robustness, r: 6 + r.capScore / 12, color: SB.METHOD_COLOR[r.id], ring: par[i], label: label(r, multi), short: SHORT[r.id] + (multi ? (r.format === 'jpeg' ? ' (J)' : '') : '') })),
    });
    $('paretoLegend').innerHTML = legendHTML([...new Set(ranked.map((r) => r.id))].map((id) => ({ name: SB.methodById(id).name, color: SB.METHOD_COLOR[id] })));

    /* recommendations */
    const recs = [`<li><b>Top for “${G.label}”:</b> ${esc(label(top, multi))} (${f1(top.overall)}/100)</li>`];
    if (multi) run.formats.forEach((f) => {
      const sub = ok.filter((r) => r.format === f);
      if (sub.length) { const b = best(sub, (r) => r.overall); recs.push(`<li><b>Best for ${b.formatLabel} carrier:</b> ${b.name} (${f1(b.overall)}/100)</li>`); }
    });
    const rec = (r, id) => (r.attacks[id] && !r.attacks[id].unsupported ? r.attacks[id].recovery : -1);
    const j50 = best(ok, (r) => rec(r, 'jpeg50')), nz = best(ok, (r) => rec(r, 'gauss')), cap = best(ok, (r) => r.capacityBytes), lr = best(ok, (r) => r.risk, -1), q = best(ok, (r) => r.psnr);
    recs.push(`<li><b>Must survive JPEG QF 50:</b> ${esc(label(j50, multi))} (${rec(j50, 'jpeg50').toFixed(0)}% recovery)</li>`);
    recs.push(`<li><b>Noisy channel:</b> ${esc(label(nz, multi))} (${rec(nz, 'gauss').toFixed(0)}% recovery at σ=5)</li>`);
    if (run.attacks.some((a) => a.id === 'social')) { const s = best(ok, (r) => rec(r, 'social')); recs.push(`<li><b>Social-media re-share:</b> ${esc(label(s, multi))} (${rec(s, 'social').toFixed(0)}% recovery)</li>`); }
    recs.push(`<li><b>Largest payload:</b> ${esc(label(cap, multi))} (up to ${SB.fmtBytes(cap.capacityBytes)})</li>`);
    recs.push(`<li><b>Least visible change:</b> ${esc(label(q, multi))} (PSNR ${f1(q.psnr)} dB)</li>`);
    recs.push(`<li><b>Lowest detection risk:</b> ${esc(label(lr, multi))} (risk ${f1(lr.risk)}/100)</li>`);
    const weak = ok.filter((r) => rec(r, 'jpeg75') >= 0 && rec(r, 'jpeg75') < 20);
    if (weak.length && weak.length < ok.length) recs.push(`<li><b>Lossless-only:</b> ${esc([...new Set(weak.map((r) => r.name))].join(', '))} do not survive JPEG – use only if the image is never re-compressed.</li>`);
    const geo = ok.filter((r) => r.groupRobustness && r.groupRobustness.geometry != null);
    if (geo.length && geo.every((r) => r.groupRobustness.geometry < 40)) recs.push('<li><b>Geometry warning:</b> shifting, rotating or cropping defeated every method here (block and pixel positions are lost). None of these methods is geometry-robust.</li>');
    $('recs').innerHTML = recs.join('');
    renderStats(ranked);
  }

  function renderStats(ranked) {
    const run = state.last, nS = run.nImages * run.trials, w = goalW();
    let h = `<p class="hint">Sample size: ${run.nImages} image${run.nImages > 1 ? 's' : ''} × ${run.trials} key${run.trials > 1 ? 's' : ''} = ${nS} per method.</p>`;
    if (nS < 6) {
      $('statsBody').innerHTML = h + '<p>With fewer than 6 samples no significance test is meaningful. Use <b>Dataset</b> mode (many images) or raise <b>Keys per image</b>, then run again.</p>';
      return;
    }
    const sc = (r) => r.samples.robustness.map((_, k) => w[0] * r.samples.robustness[k] + w[1] * r.samples.quality[k] + w[2] * r.samples.stealth[k] + w[3] * r.samples.capScore[k]);
    const rows = ranked.filter((r) => r.n >= 6 && r.sampleKeys).slice(0, 8), pairs = [];
    for (let i = 0; i < rows.length; i++)
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i], b = rows[j], sa = sc(a), sb = sc(b), idx = new Map(b.sampleKeys.map((k, n) => [k, n]));
        const x = [], y = [];
        a.sampleKeys.forEach((k, n) => { if (idx.has(k)) { x.push(sa[n]); y.push(sb[idx.get(k)]); } });
        pairs.push({ a, b, ...SB.stats.wilcoxon(x, y) });
      }
    pairs.sort((p, q) => (Number.isFinite(p.p) ? p.p : 2) - (Number.isFinite(q.p) ? q.p : 2));
    const m = pairs.length, multi = run.formats.length > 1;
    h += `<p>Paired Wilcoxon signed-rank tests on the overall score (goal: ${SB.GOALS[state.goal].label}) between the top ${rows.length} methods; the same image and key are compared with each other. “Significant” uses a Bonferroni correction for ${m} comparisons (α = ${(0.05 / m).toFixed(4)}).</p>`;
    h += '<div class="table-wrap"><table><thead><tr><th>Comparison</th><th>Median difference</th><th>p-value</th><th>Significant</th></tr></thead><tbody>';
    pairs.slice(0, 20).forEach((p) => {
      const sig = Number.isFinite(p.p) && p.p < 0.05 / m;
      h += `<tr><td>${esc(label(p.a, multi))} vs ${esc(label(p.b, multi))}</td><td>${p.medianDiff >= 0 ? '+' : ''}${p.medianDiff.toFixed(2)}</td><td>${Number.isFinite(p.p) ? p.p.toExponential(2) : 'n/a'}</td><td><span class="sig ${sig ? 'y' : 'n'}">${sig ? 'yes' : 'no'}</span></td></tr>`;
    });
    $('statsBody').innerHTML = h + '</tbody></table></div><p class="hint">A positive median difference means the first method scored higher. “No” means the data cannot separate the two methods.</p>';
  }

  /* ------------------------------------------------------------ attacks */
  function renderAttacks() {
    const run = state.last; if (!run) return;
    const ok = okRows(), multi = run.formats.length > 1;
    if (!ok.length) { $('attackCard').classList.add('hidden'); return; }
    $('attackCard').classList.remove('hidden');
    const cols = rankedRows();
    const head = '<thead><tr><th class="l">Attack</th>' + cols.map((r) => `<th>${r.name}${multi ? `<br><small>${r.formatLabel}</small>` : ''}</th>`).join('') + '</tr></thead><tbody>';
    let h = head;
    run.attacks.forEach((a) => {
      h += `<tr><td class="l">${a.label}</td>` + cols.map((r) => {
        const x = r.attacks[a.id];
        if (!x || x.unsupported) return '<td class="cell" title="Not supported by this browser">n/a</td>';
        const rawTip = `${(x.match * 100).toFixed(1)}% bit match after ECC, ${(x.raw * 100).toFixed(1)}% raw${x.eccFailed ? `, ECC failed in ${x.eccFailed} block(s)` : ''}`;
        return `<td class="cell" style="${heat(x.recovery)}" title="${rawTip}">${x.recovery.toFixed(0)}%${x.exact >= 1 ? ' ✓' : x.exact > 0 ? ` <small>${Math.round(x.exact * 100)}% exact</small>` : ''}${r.n > 1 ? `<small>±${x.std.toFixed(0)}</small>` : ''}</td>`;
      }).join('') + '</tr>';
    });
    $('attackTable').innerHTML = h + '</tbody>';
    const groups = [...new Set(run.attacks.filter((a) => a.group !== 'baseline').map((a) => a.group))];
    $('groupTable').innerHTML = head.replace('Attack', 'Attack family') + groups.map((g) => `<tr><td class="l">${SB.GROUP_LABEL[g] || g}</td>` + cols.map((r) => {
      const v = r.groupRobustness && r.groupRobustness[g];
      return v == null || !Number.isFinite(v) ? '<td class="cell">n/a</td>' : `<td class="cell" style="${heat(v)}">${v.toFixed(0)}%</td>`;
    }).join('') + '</tr>').join('') + '</tbody>';
    $('inspectSel').innerHTML = cols.filter((r) => r.stego).map((r) => `<option value="${r.key}">${r.name}${multi ? ' · ' + r.formatLabel : ''}</option>`).join('');
    drawInspect();
    $('exLen').value = run.frameBytes; $('exEcc').value = String(run.ecc); $('exPass').value = $('pass').value;
  }

  /* inspector with linked 5x lens */
  const ZR = 20;      // lens half-size in pixels (40x40 area)
  async function drawInspect() {
    const run = state.last; if (!run) return;
    const r = run.results.find((x) => x.key === $('inspectSel').value && x.status === 'ok'); if (!r || !r.stego) return;
    const cover = run.coverRef, st = r.stego, w = cover.width, h = cover.height;
    [['cvCover', cover], ['cvStego', st]].forEach(([id, img]) => { const c = $(id); c.width = w; c.height = h; c.getContext('2d').putImageData(img, 0, 0); });
    const gain = r.psnr > 60 ? 60 : r.psnr > 45 ? 20 : 8;
    $('diffGain').textContent = gain;
    const d = new ImageData(w, h);
    for (let i = 0; i < d.data.length; i += 4) {
      const v = SB.clamp8(128 + ((st.data[i] - cover.data[i]) + (st.data[i + 1] - cover.data[i + 1]) + (st.data[i + 2] - cover.data[i + 2])) / 3 * gain);
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255;
    }
    const dc = $('cvDiff'); dc.width = w; dc.height = h; dc.getContext('2d').putImageData(d, 0, 0);
    state.inspect = { w, h, x: w >> 1, y: h >> 1 };
    zoomAt(state.inspect.x, state.inspect.y);
    let text = '';
    if (r.recoveredFrame) {
      const u = await SB.frame.unpack(r.recoveredFrame, run.key0);
      text = u.ok && u.data ? (u.isFile ? `a ${u.data.length}-byte file` : `“${new TextDecoder().decode(u.data)}”`) : `could not be read (${u.reason || 'unknown'})`;
    }
    $('recoveredLine').textContent = `Payload recovered from the un-attacked stego image (first image, first key): ${text}  ·  PSNR ${f1(r.psnr)} dB · SSIM ${r.ssim.toFixed(4)} · histogram shift ${(r.histDiff * 100).toFixed(3)}%${r.format === 'jpeg' ? ' (compared with the cover saved as JPEG QF 90)' : ''}`;
  }
  function zoomAt(cx, cy) {
    const s = state.inspect; if (!s) return;
    cx = Math.max(ZR, Math.min(s.w - ZR, Math.round(cx))); cy = Math.max(ZR, Math.min(s.h - ZR, Math.round(cy)));
    s.x = cx; s.y = cy;
    [['cvCover', 'zmCover'], ['cvStego', 'zmStego'], ['cvDiff', 'zmDiff']].forEach(([a, b]) => {
      const z = $(b).getContext('2d'); z.imageSmoothingEnabled = false;
      z.drawImage($(a), cx - ZR, cy - ZR, ZR * 2, ZR * 2, 0, 0, 200, 200);
    });
  }
  function bindLens() {
    ['cvCover', 'cvStego', 'cvDiff'].forEach((id) => {
      const c = $(id);
      const at = (e) => { const r = c.getBoundingClientRect(); zoomAt(((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height); };
      c.addEventListener('pointermove', at); c.addEventListener('pointerdown', at);
      c.addEventListener('keydown', (e) => {
        const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (!k || !state.inspect) return; e.preventDefault();
        const st = e.shiftKey ? 8 : 1; zoomAt(state.inspect.x + k[0] * st, state.inspect.y + k[1] * st);
      });
    });
  }

  /* ----------------------------------------------------------- detection */
  function renderDetection() {
    const run = state.last; if (!run) return;
    const ok = rankedRows(), multi = run.formats.length > 1;
    $('detEmpty').classList.add('hidden'); $('detBody').classList.remove('hidden');
    if (!ok.length) { $('detBody').classList.add('hidden'); $('detEmpty').classList.remove('hidden'); return; }
    const nS = run.nImages * run.trials, hasRoc = ok.some((r) => r.detection);
    $('detNote').textContent = hasRoc
      ? `${nS} samples: ROC area (AUC) and the minimum average error P_E come from comparing the detector’s score on each cover and its stego version. AUC 0.50 = the detector guesses; 1.00 = it always tells them apart (an analyst who knows which direction means “stego” is assumed). Mean detector estimates are shown as stego − cover.`
      : `Only ${nS} sample${nS > 1 ? 's' : ''}: ROC curves need at least 12 (use Dataset mode). Shown below: the mean detector estimates, as stego − cover (RS and WS estimate the fraction of samples carrying LSB data; a value near 0 means “nothing seen”).`;
    let h = '<thead><tr><th>Method</th><th>RS Δ</th><th>Weighted Stego Δ</th><th>Progressive χ² Δ</th><th>Detection risk</th>' + (hasRoc ? '<th>Best detector</th><th>AUC</th><th>P_E</th>' : '') + '</tr></thead><tbody>';
    const series = [];
    ok.forEach((r) => {
      const [ic, cl] = ICON[r.id];
      h += `<tr><td><span class="mname"><i class="${cl}">${icon(ic)}</i>${r.name}${multi ? `<span class="fmt">${r.formatLabel}</span>` : ''}</span></td>`;
      ['rs', 'ws', 'chiSeq'].forEach((k) => { const v = r.detMeans ? r.detMeans[k] : NaN; h += `<td>${Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(3) : '–'}</td>`; });
      h += `<td>${f1(r.risk)} <small class="sd">${r.riskLabel}</small></td>`;
      if (hasRoc) {
        if (r.detection) {
          const d = r.detection;
          h += `<td>${DETECTOR_LABEL[d.best]}</td><td><b>${d.auc.toFixed(2)}</b></td><td>${(d.pe * 100).toFixed(1)}%</td>`;
          series.push({ name: label(r, multi) + ` (AUC ${d.auc.toFixed(2)})`, color: SB.METHOD_COLOR[r.id], dash: r.format === 'jpeg', points: d.byDetector[d.best].curve.map(([x, y]) => ({ x, y })) });
        } else h += '<td colspan="3">–</td>';
      }
      h += '</tr>';
    });
    $('detTable').innerHTML = h + '</tbody>';
    $('rocChart').classList.toggle('hidden', !series.length);
    if (series.length) {
      SB.charts.draw($('rocChart'), 'line', { series, xlabel: 'False-positive rate', ylabel: 'True-positive rate', xmin: 0, xmax: 1, ymin: 0, ymax: 1, diag: true, noMarkers: true, xfmt: (v) => v.toFixed(1), yfmt: (v) => v.toFixed(1) });
      $('rocLegend').innerHTML = legendHTML(series);
    } else $('rocLegend').innerHTML = '';
  }

  /* ---------------------------------------------------- reproducibility */
  function reproCard() {
    const run = state.last;
    return {
      tool: 'StegoBench', version: SB.VERSION, date: new Date().toISOString(), browser: navigator.userAgent, execution: run.workers, seconds: +run.seconds.toFixed(2),
      images: run.coversInfo, working_size_max_px: run.settings.maxSide,
      payload: { type: run.settings.payloadType, bytes: run.payloadBytes, frame_bytes: run.frameBytes, coded_bytes: run.codedBytes, encrypted: run.encrypt, ecc_parity_bytes_per_block: run.ecc },
      key_derivation: SB.crypto.available ? 'PBKDF2-SHA256, 150000 iterations; key #n = passphrase + "#n"' : 'weak fallback (WebCrypto unavailable)',
      keys_per_image: run.trials, formats: run.formats, methods: run.settings.methods, attack_set: run.settings.attackSet, attacks: run.attacks.map((a) => ({ id: a.id, kind: a.kind, value: a.value })),
      attack_noise_seed: 20261014, method_parameters: SB.params, detector_scale: SB.metrics.DET_SCALE, goal: SB.GOALS[state.goal].label,
      note: 'The passphrase is not stored. JPEG/WebP results depend on the browser encoder, so keep the browser string above when comparing runs.',
    };
  }
  function renderRepro() { $('reproBody').textContent = JSON.stringify(reproCard(), null, 2); }

  /* ------------------------------------------------------------ deep analysis */
  async function runSweep() {
    if (state.running) return; state.running = true; refresh();
    const methods = selectedMethods(), covers = state.covers.slice(0, 3);
    $('sweepStatus').textContent = 'Running…';
    try {
      const rates = [0.002, 0.004, 0.008, 0.016, 0.03, 0.06, 0.12, 0.25, 0.5, 1];
      const res = await SB.runSweep({ covers: covers.map((c) => ({ id: c.id, img: c.img })), rates, methods, attackId: $('sweepAttack').value, passphrase: $('pass').value, useWorkers: state.useWorkers },
        ({ done, total }) => { $('sweepStatus').textContent = `Running… ${done}/${total}`; });
      state.sweep = res;
      const ids = Object.keys(res.series);
      if (!ids.length) { $('sweepStatus').textContent = 'No method fits any of these payload sizes on this image.'; }
      else {
        $('sweepStatus').textContent = `Done – ${covers.length} image${covers.length > 1 ? 's' : ''}, attack: ${res.attack.label}.`;
        const mk = (f) => ids.map((id) => ({ name: SB.methodById(id).name, color: SB.METHOD_COLOR[id], points: res.series[id].map((p) => ({ x: p.bpp, y: p[f.y], e: f.e ? p[f.e] : 0 })) }));
        SB.charts.draw($('sweepChartA'), 'line', { series: mk({ y: 'atk', e: 'atkStd' }), xlog: true, xlabel: 'Payload (bits per pixel, log scale)', ylabel: 'Recovery after attack (%)', ymin: 0, ymax: 100, xfmt: (v) => +v.toPrecision(2) + '' });
        SB.charts.draw($('sweepChartB'), 'line', { series: mk({ y: 'psnr' }), xlog: true, xlabel: 'Payload (bits per pixel, log scale)', ylabel: 'PSNR (dB)', ymin: 20, ymax: 100, xfmt: (v) => +v.toPrecision(2) + '' });
        $('sweepLegend').innerHTML = legendHTML(mk({ y: 'atk' }));
      }
    } catch (e) { console.error(e); $('sweepStatus').textContent = 'Failed: ' + (e.message || e); }
    finally { state.running = false; refresh(); }
  }
  async function runBreakpoint() {
    if (state.running) return; state.running = true; refresh();
    const methods = selectedMethods(), sweepId = $('bpType').value;
    $('bpStatus').textContent = 'Running…';
    try {
      const res = await SB.runBreakpoint({ cover: { id: state.covers[0].id, img: state.covers[0].img }, methods, sweepId, passphrase: $('pass').value, ecc: eccLevel(), useWorkers: state.useWorkers },
        ({ done, total }) => { $('bpStatus').textContent = `Running… ${done}/${total}`; });
      state.bp = res;
      const ids = Object.keys(res.curves);
      if (!ids.length) { $('bpStatus').textContent = 'The test payload does not fit any selected method on this image.'; return; }
      $('bpStatus').textContent = `Done – ${eccLevel() ? 'with' : 'without'} error correction, first image.`;
      const series = ids.map((id) => ({ name: SB.methodById(id).name, color: SB.METHOD_COLOR[id], points: res.curves[id].map((v, i) => ({ x: i, y: v })) }));
      SB.charts.draw($('bpChart'), 'line', { series, xcats: res.sweep.values.map((v) => String(v)), xmin: 0, xmax: res.sweep.values.length - 1, xlabel: res.sweep.axis, ylabel: 'Recovery (%)', ymin: 0, ymax: 100 });
      $('bpLegend').innerHTML = legendHTML(series);
    } catch (e) { console.error(e); $('bpStatus').textContent = 'Failed: ' + (e.message || e); }
    finally { state.running = false; refresh(); }
  }

  /* ------------------------------------------------------------ downloads */
  const csvCell = (v) => { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const r2 = (v, d) => (Number.isFinite(v) ? +v.toFixed(d == null ? 2 : d) : '');
  function exportRows() {
    const run = state.last;
    return run.results.filter((r) => r.status === 'ok').map((r) => ({
      method: r.name, type: r.domain, format: r.formatLabel, samples: r.n, goal: SB.GOALS[state.goal].label, overall: r2(SB.overall(r, state.goal)),
      imperceptibility: r2(r.quality), imperceptibility_sd: r2(r.std.quality), robustness: r2(r.robustness), robustness_sd: r2(r.std.robustness),
      detectability_risk: r2(r.risk), stealth: r2(r.stealth), capacity_score: r2(r.capScore), capacity_bytes: r.capacityBytes, hidden_bytes_per_image: run.codedBytes,
      psnr_db: r2(r.psnr), ssim: r2(r.ssim, 5), mse: r2(r.mse, 4), hist_shift_pct: r2(r.histDiff * 100, 4),
      detector_best: r.detection ? DETECTOR_LABEL[r.detection.best] : '', detector_auc: r.detection ? r2(r.detection.auc, 3) : '', detector_pe: r.detection ? r2(r.detection.pe, 3) : '',
      ...Object.fromEntries(run.attacks.map((a) => ['recovery_' + a.id + '_pct', r.attacks[a.id] && !r.attacks[a.id].unsupported ? r2(r.attacks[a.id].recovery) : ''])),
    }));
  }

  /* ------------------------------------------------------------- extract */
  async function extractFromFile() {
    const f = $('exFile').files[0], out = $('exOut'), chips = $('exChips');
    chips.innerHTML = ''; $('exDownload').classList.add('hidden');
    if (!f) { out.textContent = 'Choose a stego image first.'; return; }
    const pass = $('exPass').value, len = Math.max(8, Math.min(70000, +$('exLen').value | 0)), nsym = +$('exEcc').value;
    if (!pass) { out.textContent = 'Enter the passphrase.'; return; }
    out.textContent = 'Working…';
    let img;
    try {
      const bmp = await createImageBitmap(f), c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0); img = g.getImageData(0, 0, c.width, c.height);
    } catch (e) { out.textContent = 'Could not read that image.'; return; }
    const m = SB.methodById($('exMethod').value), nbits = SB.ecc.codedLength(len, nsym) * 8;
    if (nbits > m.capacityBits(img.width, img.height)) { out.textContent = "Length exceeds this method's capacity for that image."; return; }
    const key = await SB.crypto.deriveKey(pass);
    const got = m.extract(img, nbits, key), dec = SB.pipeline.decodeBits(got, nsym, len), u = await SB.frame.unpack(dec.frame, key);
    const chip = (cls, txt) => `<span class="chip ${cls}">${txt}</span>`;
    chips.innerHTML = (nsym ? chip(dec.ecc.ok ? 'g' : 'r', dec.ecc.ok ? `ECC: ${dec.ecc.corrected} byte(s) corrected` : `ECC: ${dec.ecc.failed} block(s) unrecoverable`) : '') +
      chip(u.ok || u.encrypted ? 'g' : 'r', u.ok || u.encrypted ? 'Checksum OK' : 'Checksum failed') + (u.encrypted ? chip(u.ok ? 'g' : 'r', u.ok ? 'Decrypted' : 'Not decrypted') : '');
    if (!u.ok && !u.data) { out.textContent = u.reason || 'Nothing could be read.'; return; }
    if (!u.ok) { out.textContent = u.reason; return; }
    if (u.isFile) {
      state.extractedFile = u.data; out.textContent = `A file of ${u.data.length} bytes was recovered.`;
      $('exDownload').classList.remove('hidden');
    } else out.textContent = new TextDecoder().decode(u.data);
  }

  /* ----------------------------------------------------------- dropdowns */
  function dropdown(btnId, menuId) {
    const b = $(btnId), m = $(menuId);
    const close = () => { m.classList.add('hidden'); b.setAttribute('aria-expanded', 'false'); };
    b.addEventListener('click', (e) => { e.stopPropagation(); const open = m.classList.contains('hidden'); document.querySelectorAll('.menu').forEach((x) => x.classList.add('hidden')); if (open) { m.classList.remove('hidden'); b.setAttribute('aria-expanded', 'true'); } });
    m.addEventListener('click', close);
    document.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  /* --------------------------------------------------------------- theme */
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const light = t === 'light';
    $('themeLabel').textContent = light ? 'Light mode' : 'Dark mode';
    $('themeIcon').innerHTML = `<use href="#i-${light ? 'sun' : 'moon'}"/>`;
    SB.charts.redrawAll();
  }
  function initTheme() {
    let t = null; try { t = localStorage.getItem('stegobench-theme'); } catch (e) { /* storage blocked */ }
    if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(t);
    $('themeBtn').addEventListener('click', () => {
      const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('stegobench-theme', n); } catch (e) { /* ignore */ }
      applyTheme(n);
    });
  }

  /* --------------------------------------------------------------- wiring */
  function init() {
    $('verTxt').textContent = SB.VERSION;
    $('methodList').innerHTML = SB.METHODS.map((m) => {
      const [ic, cl] = ICON[m.id];
      return `<label class="mpill" title="${esc(m.info)}"><input type="checkbox" name="method" value="${m.id}" checked><span class="mic ${cl}">${icon(ic)}</span><span class="mtxt"><b>${m.name}</b><small>${m.domain}</small></span><span class="cbox">${icon('#i-check')}</span></label>`;
    }).join('');
    $('exMethod').innerHTML = SB.METHODS.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
    $('goal').innerHTML = Object.entries(SB.GOALS).map(([k, g]) => `<option value="${k}">${g.label}</option>`).join('');
    $('sweepAttack').innerHTML = SB.ATTACKS.filter((a) => a.id !== 'none').map((a) => `<option value="${a.id}"${a.id === 'jpeg75' ? ' selected' : ''}>${a.label}</option>`).join('');
    $('bpType').innerHTML = Object.entries(SB.SWEEPS).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join('');
    if (!window.SB_WORKER_SRC) { state.useWorkers = false; $('useWorkers').checked = false; $('useWorkers').disabled = true; }

    const dz = $('dropzone'), fi = $('fileInput');
    fi.addEventListener('change', () => { loadFiles(fi.files); fi.value = ''; });
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', (e) => loadFiles(e.dataTransfer.files));
    $('sampleBtn').addEventListener('click', () => { const c = SB.makeSampleCanvas(800, 600, 0); state.sources = [{ drawable: c, w: c.width, h: c.height, name: 'sample.png', bytes: 0, sha: 'generated:variant0' }]; applyScale(); });
    $('sampleSetBtn').addEventListener('click', () => {
      state.sources = Array.from({ length: 12 }, (_, i) => { const c = SB.makeSampleCanvas(512, 384, i); return { drawable: c, w: c.width, h: c.height, name: `sample-${i + 1}.png`, bytes: 0, sha: 'generated:variant' + i }; });
      applyScale();
    });
    $('clearFile').addEventListener('click', clearImages);
    document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    document.querySelectorAll('#payloadSeg button').forEach((b) => b.addEventListener('click', () => setPayloadTab(b.dataset.ptab)));
    $('payloadFile').addEventListener('change', () => loadPayloadFile($('payloadFile').files[0]));

    ['message', 'pass', 'carrier', 'ecc', 'trials', 'encrypt', 'attackSet'].forEach((id) => $(id).addEventListener('input', touch));
    document.querySelectorAll('input[name=method]').forEach((i) => i.addEventListener('change', touch));
    $('runBtn').addEventListener('click', run);
    $('sweepRun').addEventListener('click', runSweep);
    $('bpRun').addEventListener('click', runBreakpoint);

    dropdown('presetBtn', 'presetMenu'); dropdown('dlBtn', 'dlMenu');
    $('presetMenu').addEventListener('click', (e) => {
      const p = e.target.closest('[data-preset]'); if (!p) return;
      const set = PRESETS[p.dataset.preset];
      document.querySelectorAll('input[name=method]').forEach((i) => { i.checked = set.includes(i.value); });
      touch();
    });

    $('goal').addEventListener('change', () => { state.goal = $('goal').value; if (state.last) { renderLeaderboard(); renderAttacks(); renderDetection(); renderRepro(); } });
    $('inspectSel').addEventListener('change', drawInspect);
    bindLens();
    $('exBtn').addEventListener('click', extractFromFile);
    $('exDownload').addEventListener('click', () => { if (state.extractedFile) download('extracted.bin', new Blob([state.extractedFile])); });
    $('dlCsv').addEventListener('click', () => {
      if (!state.last) return; const rows = exportRows(); if (!rows.length) return; const cols = Object.keys(rows[0]);
      download('stegobench-results.csv', new Blob([[cols.join(',')].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))).join('\n')], { type: 'text/csv' }));
    });
    $('dlJson').addEventListener('click', () => {
      const run = state.last; if (!run) return;
      download('stegobench-results.json', new Blob([JSON.stringify({ reproducibility: reproCard(), results: exportRows(), sweep: state.sweep && { attack: state.sweep.attack.label, series: state.sweep.series }, breakpoints: state.bp && { sweep: state.bp.sweepId, values: state.bp.sweep.values, curves: state.bp.curves } }, null, 2)], { type: 'application/json' }));
    });
    $('dlPdf').addEventListener('click', () => { if (state.last) { document.querySelectorAll('details.more').forEach((d) => { d.open = true; }); SB.charts.redrawAll(); window.print(); } });
    $('dlStego').addEventListener('click', () => {
      const r = state.last && state.last.results.find((x) => x.key === $('inspectSel').value); if (!r) return;
      $('cvStego').toBlob((b) => download(`stego_${r.id}_${r.format}.png`, b), 'image/png');
    });

    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-selected', on); });
      ['sweep', 'break', 'detect'].forEach((k) => $('dp-' + k).classList.toggle('hidden', k !== b.dataset.dtab));
      SB.charts.redrawAll();
    }));

    const dlg = $('settings');
    $('openSettings').addEventListener('click', () => (dlg.showModal ? dlg.showModal() : dlg.setAttribute('open', '')));
    $('maxSide').addEventListener('change', () => { state.maxSide = +$('maxSide').value; if (state.sources.length) applyScale(); });
    $('useWorkers').addEventListener('change', () => { state.useWorkers = $('useWorkers').checked; });
    document.querySelectorAll('#nav a').forEach((a) => a.addEventListener('click', () => { document.querySelectorAll('#nav a').forEach((x) => x.classList.toggle('active', x === a)); }));
    if ('IntersectionObserver' in window) {
      const map = { home: 'home', step2: 'step2', leaderboard: 'leaderboard', deep: 'deep', extractCard: 'extractCard' };
      const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) document.querySelectorAll('#nav a').forEach((x) => x.classList.toggle('active', x.dataset.nav === map[e.target.id])); }), { rootMargin: '-30% 0px -60% 0px' });
      Object.keys(map).forEach((id) => { const el = $(id); if (el && id !== 'home') io.observe(el); });
    }
    initTheme();
    refresh();
  }
  document.addEventListener('DOMContentLoaded', init);
  SB.ui = { state, loadFiles, run };
})();
