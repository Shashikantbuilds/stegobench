/* Live test on the landing page: uses the real StegoBench engine (js/methods.js, js/attacks.js). */
(function () {
  'use strict';
  var SB = window.SB, $ = function (id) { return document.getElementById(id); };
  if (!SB || !SB.methodById || !$('demoMethod')) return;
  var IDS = ['seqlsb', 'dct', 'dwt', 'lsbm', 'spread'], sel = $('demoMethod'), cover = null, busy = false, again = false;
  IDS.forEach(function (id) { var m = SB.methodById(id); if (m) { var o = document.createElement('option'); o.value = id; o.textContent = m.name; sel.appendChild(o); } });
  function draw(cv, img) { var s = SB.attackFns.toCanvas(img); cv.width = s.width; cv.height = s.height; cv.getContext('2d').drawImage(s, 0, 0); }
  function printable(bytes) { var o = ''; for (var i = 0; i < bytes.length; i++) { var c = bytes[i]; o += (c >= 32 && c < 127) ? String.fromCharCode(c) : '\u00b7'; } return o; }
  async function run() {
    if (busy) { again = true; return; } busy = true;
    var t = $('demoText'), s = $('demoStat'); t.className = 'skel-line'; t.textContent = ''; s.textContent = '';
    try {
      var msg = ($('demoMsg').value || 'meet me at 6').slice(0, 24), bytes = new TextEncoder().encode(msg), bits = SB.bytesToBits(bytes);
      var m = SB.methodById(sel.value), key = SB.keyFromNumber(20260), q = +$('demoQ').value;
      if (bits.length > m.capacityBits(cover.width, cover.height)) throw new Error('Message too long for this method');
      var stego = m.embed(cover, bits, key), att = q >= 100 ? stego : await SB.attackFns.jpeg(stego, q);
      draw($('demoStego'), att);
      var got = m.extract(att, bits.length, key), match = SB.bitMatch(bits, got), pct = Math.round(match * 100);
      t.className = pct === 100 ? 'good' : 'bad'; t.textContent = printable(SB.bitsToBytes(got).slice(0, bytes.length));
      s.textContent = pct === 100 ? 'All ' + bits.length + ' bits recovered.' : pct + '% of bits match (50% is pure chance). The message did not survive.';
    } catch (e) { t.className = ''; t.textContent = ''; s.textContent = String((e && e.message) || e); }
    busy = false; if (again) { again = false; run(); }
  }
  try {
    cover = SB.attackFns.fromCanvas(SB.makeSampleCanvas(320, 240, 0)); draw($('demoCover'), cover);
    $('demoQ').addEventListener('input', function () { $('demoQv').textContent = this.value; run(); });
    sel.addEventListener('change', run); $('demoMsg').addEventListener('input', run);
    $('demoQv').textContent = $('demoQ').value; setTimeout(run, 60);
  } catch (e) { $('demoStat').textContent = 'The live test could not start in this browser.'; }
})();