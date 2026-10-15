/* StegoBench landing page: theme, mobile menu, header shadow, active link, reveal on scroll */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  document.documentElement.classList.add('js');

  /* theme (shares the dashboard's saved choice) */
  const root = document.documentElement;
  function applyTheme(t) {
    root.dataset.theme = t;
    $('themeIcon').textContent = t === 'dark' ? '☀' : '☾';
    $('themeBtn').setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }
  let saved = null;
  try { saved = localStorage.getItem('stegobench-theme'); } catch (e) { /* storage blocked */ }
  applyTheme(saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $('themeBtn').addEventListener('click', () => {
    const n = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('stegobench-theme', n); } catch (e) { /* ignore */ }
    applyTheme(n);
  });

  /* mobile menu */
  const nav = $('siteNav'), btn = $('menuBtn');
  const setMenu = (open) => { nav.classList.toggle('open', open); btn.setAttribute('aria-expanded', open); btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); };
  btn.addEventListener('click', () => setMenu(!nav.classList.contains('open')));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

  /* header shadow once scrolled */
  const hdr = document.querySelector('.site-header');
  const onScroll = () => hdr.classList.toggle('scrolled', window.scrollY > 8);
  onScroll(); window.addEventListener('scroll', onScroll, { passive: true });

  /* active nav link */
  const links = [...nav.querySelectorAll('a[data-sec]')];
  if ('IntersectionObserver' in window) {
    const map = { overview: 'overview', about: 'overview', how: 'how', attacks: 'attacks', methods: 'methods', team: 'team' };
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) links.forEach((a) => a.classList.toggle('active', a.dataset.sec === map[e.target.id]));
    }), { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(map).forEach((id) => { const el = $(id); if (el) io.observe(el); });

    /* reveal on scroll (skipped for reduced motion) */
    const rv = [...document.querySelectorAll('.reveal')];
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) rv.forEach((el) => el.classList.add('in'));
    else {
      const ro = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); ro.unobserve(e.target); } }), { threshold: 0.12 });
      rv.forEach((el) => ro.observe(el));
    }
  } else document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));

  const y = $('year'); if (y) y.textContent = new Date().getFullYear();
})();