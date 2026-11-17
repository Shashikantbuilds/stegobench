/* StegoBench landing page: theme, mobile menu, active link, reveal on scroll, count-up. */
(function () {
  'use strict';
  var root = document.documentElement, $ = function (id) { return document.getElementById(id); };
  root.classList.add('js');
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* theme (shares the dashboard's saved choice) */
  function setTheme(t) {
    root.dataset.theme = t;
    var ic = $('themeIcon'); if (ic) ic.textContent = t === 'dark' ? 'Light' : 'Dark';
    var b = $('themeBtn'); if (b) b.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }
  var saved = null; try { saved = localStorage.getItem('stegobench-theme'); } catch (e) { /* storage blocked */ }
  setTheme(saved || 'light');
  if ($('themeBtn')) $('themeBtn').addEventListener('click', function () {
    var n = root.dataset.theme === 'dark' ? 'light' : 'dark'; setTheme(n);
    try { localStorage.setItem('stegobench-theme', n); } catch (e) { /* ignore */ }
  });

  /* mobile menu */
  var nav = $('siteNav'), mb = $('menuBtn');
  if (nav && mb) {
    mb.addEventListener('click', function () { var o = nav.classList.toggle('open'); mb.setAttribute('aria-expanded', String(o)); });
    nav.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a')) { nav.classList.remove('open'); mb.setAttribute('aria-expanded', 'false'); } });
  }

  if ($('year')) $('year').textContent = String(new Date().getFullYear());

  /* active link */
  var links = [].slice.call(document.querySelectorAll('a[data-sec]'));
  if ('IntersectionObserver' in window && links.length) {
    var so = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) links.forEach(function (a) { a.classList.toggle('active', a.dataset.sec === e.target.id); }); });
    }, { rootMargin: '-45% 0px -50% 0px' });
    links.forEach(function (a) { var s = document.getElementById(a.dataset.sec); if (s) so.observe(s); });
  }

  /* reveal (opacity only) */
  var rv = [].slice.call(document.querySelectorAll('.reveal'));
  if (calm || !('IntersectionObserver' in window)) rv.forEach(function (e) { e.classList.add('in'); });
  else {
    var ro = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); ro.unobserve(e.target); } }); }, { threshold: 0.12 });
    rv.forEach(function (e) { ro.observe(e); });
  }

  /* count-up on the four facts */
  if (!calm) document.querySelectorAll('.facts strong').forEach(function (el) {
    var n = el.firstChild, m = n && /^\d+/.exec(n.textContent); if (!m) return;
    var end = parseInt(m[0], 10), rest = n.textContent.slice(m[0].length), t0 = null; if (end < 1) return;
    function tick(t) { t0 = t0 || t; var p = Math.min(1, (t - t0) / 800); n.textContent = Math.round(end * (1 - Math.pow(1 - p, 3))) + rest; if (p < 1) requestAnimationFrame(tick); }
    n.textContent = '0' + rest; setTimeout(function () { requestAnimationFrame(tick); }, 300);
  });
})();