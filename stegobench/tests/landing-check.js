/* Checks the landing page: every local link, script, stylesheet and image exists; every #anchor has a target;
 * header is sticky; the dashboard link is present; developer names and photos are in the footer. */
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
let fails = 0;
const check = (n, ok, d) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  [' + d + ']' : ''}`); };
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8'), css = fs.readFileSync(path.join(root, 'css/landing.css'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"#:]+?)(?:#[^"]*)?"/g)].map((m) => m[1]).filter((r) => !/^https?:/.test(r));
const missing = [...new Set(refs)].filter((r) => !fs.existsSync(path.join(root, r)));
check('All local files referenced by index.html exist', missing.length === 0, missing.join(', ') || refs.length + ' refs');
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
check('Every #anchor has a target', anchors.every((a) => ids.has(a)), anchors.filter((a) => !ids.has(a)).join(', '));
check('Header is sticky and above content', /\.site-header\{position:sticky;top:0;z-index:100/.test(css));
check('Open Dashboard links go to dashboard.html', (html.match(/href="dashboard\.html"/g) || []).length >= 4);
check('Dashboard page exists and links back to the overview', fs.existsSync(path.join(root, 'dashboard.html')) && /href="index\.html"/.test(fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8')));
['Shashikant', 'Hussain Khan', 'Jatin Kumar'].forEach((n) => check('Footer lists ' + n, new RegExp('<b>' + n + '</b>').test(html)));
check('Three developer photos in the footer', (html.match(/assets\/team\/dev[123]\.jpg/g) || []).length === 3);
check('No duplicate ids', ids.size === [...html.matchAll(/id="([^"]+)"/g)].length);
check('Landing JS parses', (() => { try { new Function(fs.readFileSync(path.join(root, 'js/landing.js'), 'utf8')); return true; } catch (e) { return false; } })());

/* behaviour of js/landing.js in jsdom */
const { JSDOM } = require('jsdom');
const dom = new JSDOM(html, { url: 'file://' + root + '/index.html', runScripts: 'outside-only', pretendToBeVisual: true,
  beforeParse(w) { w.matchMedia = () => ({ matches: false, addEventListener() {} }); } });
dom.window.eval(fs.readFileSync(path.join(root, 'js/landing.js'), 'utf8'));
const w = dom.window, $ = (id) => w.document.getElementById(id), click = (e) => e.dispatchEvent(new w.Event('click', { bubbles: true }));
check('JS marks the page (.js) so reveal effects apply', w.document.documentElement.classList.contains('js'));
click($('menuBtn')); check('Menu button opens the mobile menu', $('siteNav').classList.contains('open') && $('menuBtn').getAttribute('aria-expanded') === 'true');
click(w.document.querySelector('#siteNav a[data-sec=how]')); check('Choosing a link closes the menu', !$('siteNav').classList.contains('open'));
const before = w.document.documentElement.dataset.theme; click($('themeBtn'));
check('Theme button toggles light/dark', w.document.documentElement.dataset.theme !== before, before + ' -> ' + w.document.documentElement.dataset.theme);
check('Footer year filled in', /^\d{4}$/.test($('year').textContent));
console.log(fails ? `\n${fails} FAILED` : '\nLANDING CHECKS PASSED');
process.exit(fails ? 1 : 0);
