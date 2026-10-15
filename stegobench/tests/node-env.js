/* Headless environment for running StegoBench's browser code in Node (used by CI and `npm test`).
 * Uses @napi-rs/canvas for <canvas>, ImageData and JPEG/WebP encoding. */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const nc = require('@napi-rs/canvas');

function install() {
  const g = globalThis;
  g.window = g;
  g.ImageData = nc.ImageData;
  const mimeOf = (t) => (t === 'image/jpeg' ? 'image/jpeg' : t === 'image/webp' ? 'image/webp' : 'image/png');
  function patch(c) {
    c.toBlob = (cb, type, q) => {
      const t = mimeOf(type);
      const buf = t === 'image/png' ? c.toBuffer('image/png') : c.toBuffer(t, Math.round((q == null ? 0.92 : q) * 100));
      cb(new Blob([buf], { type: t }));
    };
    c.convertToBlob = undefined;   // napi's version ignores the type; force the toBlob path used by page canvases
    return c;
  }
  g.document = { createElement: (tag) => { if (tag !== 'canvas') throw new Error('shim: only canvas'); return patch(nc.createCanvas(300, 150)); } };
  g.createImageBitmap = async (blob) => nc.loadImage(Buffer.from(await blob.arrayBuffer()));
  g.Image = nc.Image;
}

/* load js/*.js (same order as index.html) into the global scope */
function loadSources(files) {
  const dir = path.join(__dirname, '..', 'js');
  for (const f of files) vm.runInThisContext(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f });
}

module.exports = { install, loadSources };
