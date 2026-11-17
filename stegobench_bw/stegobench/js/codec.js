/* StegoBench - payload codec: frame (length + CRC32), optional AES-GCM, Reed-Solomon ECC.
 *
 *   payload bytes -> [encrypt] -> frame -> [RS encode] -> bits -> embedding method
 *
 * frame = flags(1) | bodyLength(3, big endian) | body | CRC32(flags|length|body) (4)
 * flags: bit0 = body is AES-GCM encrypted (iv(12) | ciphertext | tag(16)), bit1 = body is a file
 */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;
  const SB = root.SB;

  /* ================================================== Reed-Solomon over GF(256) */
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (x, y) => (x && y ? EXP[LOG[x] + LOG[y]] : 0);
  const inv = (x) => EXP[255 - LOG[x]];
  const pw = (x, p) => EXP[(LOG[x] * p) % 255];

  function pScale(p, x) { return p.map((c) => mul(c, x)); }
  function pAdd(p, q) {
    const r = new Array(Math.max(p.length, q.length)).fill(0);
    for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
    for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
    return r;
  }
  function pMul(p, q) {
    const r = new Array(p.length + q.length - 1).fill(0);
    for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
    return r;
  }
  function pEval(p, x) { let y = p[0]; for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i]; return y; }

  const genCache = {};
  function generator(nsym) {
    if (genCache[nsym]) return genCache[nsym];
    let g = [1];
    for (let i = 0; i < nsym; i++) g = pMul(g, [1, EXP[i]]);
    return (genCache[nsym] = g);
  }
  function rsEncodeBlock(msg, nsym) {
    const gen = generator(nsym), out = new Uint8Array(msg.length + nsym);
    out.set(msg);
    for (let i = 0; i < msg.length; i++) {
      const coef = out[i];
      if (coef) for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
    }
    out.set(msg);                      // keep the message part, parity stays in the tail
    return out;
  }
  function syndromes(msg, nsym) {
    const s = [0];
    for (let i = 0; i < nsym; i++) s.push(pEval(msg, EXP[i]));
    return s;
  }
  function errorLocator(synd, nsym) {
    let errLoc = [1], oldLoc = [1];
    for (let i = 0; i < nsym; i++) {
      const K = i;
      let delta = synd[K + 1];
      for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], synd[K + 1 - j]);
      oldLoc.push(0);
      if (delta) {
        if (oldLoc.length > errLoc.length) {
          const nl = pScale(oldLoc, delta);
          oldLoc = pScale(errLoc, inv(delta));
          errLoc = nl;
        }
        errLoc = pAdd(errLoc, pScale(oldLoc, delta));
      }
    }
    while (errLoc.length && errLoc[0] === 0) errLoc.shift();
    if ((errLoc.length - 1) * 2 > nsym) return null;
    return errLoc;
  }
  function findErrors(errLoc, n) {
    const errs = errLoc.length - 1, pos = [];
    for (let i = 0; i < n; i++) if (pEval(errLoc, EXP[i % 255]) === 0) pos.push(n - 1 - i);
    return pos.length === errs ? pos : null;
  }
  function errataLocator(coefPos) {
    let loc = [1];
    for (const i of coefPos) loc = pMul(loc, pAdd([1], [EXP[i % 255], 0]));
    return loc;
  }
  function errorEvaluator(synd, errLoc, nsym) {
    const prod = pMul(synd, errLoc), keep = nsym + 1;
    const rem = prod.slice(Math.max(0, prod.length - keep));
    while (rem.length < keep) rem.unshift(0);
    return rem;
  }
  function correctErrata(msg, synd, errPos) {
    const coefPos = errPos.map((p) => msg.length - 1 - p);
    const errLoc = errataLocator(coefPos);
    const errEval = errorEvaluator([...synd].reverse(), errLoc, errLoc.length - 1).reverse();
    const X = coefPos.map((p) => EXP[p % 255]);
    const E = new Uint8Array(msg.length);
    for (let i = 0; i < X.length; i++) {
      const Xi_inv = inv(X[i]);
      let prime = 1;
      for (let j = 0; j < X.length; j++) if (j !== i) prime = mul(prime, 1 ^ mul(Xi_inv, X[j]));
      if (prime === 0) return null;
      let y = pEval([...errEval].reverse(), Xi_inv);
      y = mul(X[i], y);
      E[errPos[i]] = mul(y, inv(prime));
    }
    const out = new Uint8Array(msg.length);
    for (let i = 0; i < msg.length; i++) out[i] = msg[i] ^ E[i];
    return out;
  }
  /* returns { data: Uint8Array(message part), ok, corrected } */
  function rsDecodeBlock(block, nsym) {
    const k = block.length - nsym;
    let msg = Array.from(block);
    let synd = syndromes(msg, nsym);
    if (Math.max(...synd) === 0) return { data: block.slice(0, k), ok: true, corrected: 0 };
    const loc = errorLocator(synd, nsym);
    if (!loc) return { data: block.slice(0, k), ok: false, corrected: 0 };
    const pos = findErrors([...loc].reverse(), msg.length);
    if (!pos) return { data: block.slice(0, k), ok: false, corrected: 0 };
    const fixed = correctErrata(msg, synd, pos);
    if (!fixed) return { data: block.slice(0, k), ok: false, corrected: 0 };
    synd = syndromes(Array.from(fixed), nsym);
    if (Math.max(...synd) !== 0) return { data: block.slice(0, k), ok: false, corrected: 0 };
    return { data: fixed.slice(0, k), ok: true, corrected: pos.length };
  }

  /* message is split into blocks of k = 255 - nsym bytes (last block shortened) */
  SB.ecc = {
    levels: { 0: 'Off', 32: 'Light (RS +32 B / block)', 96: 'Strong (RS +96 B / block)' },
    codedLength(len, nsym) { if (!nsym) return len; const k = 255 - nsym; return len + Math.ceil(len / k) * nsym; },
    encode(bytes, nsym) {
      if (!nsym) return bytes;
      const k = 255 - nsym, parts = [];
      for (let o = 0; o < bytes.length; o += k) parts.push(rsEncodeBlock(bytes.subarray(o, Math.min(o + k, bytes.length)), nsym));
      return SB.concatBytes(...parts);
    },
    /* origLen = length of the uncoded message in bytes */
    decode(coded, nsym, origLen) {
      if (!nsym) return { data: coded.slice(0, origLen), ok: true, corrected: 0, failed: 0 };
      const k = 255 - nsym, parts = [];
      let o = 0, left = origLen, corrected = 0, failed = 0;
      while (left > 0) {
        const kk = Math.min(k, left), blk = coded.subarray(o, o + kk + nsym);
        if (blk.length < kk + nsym) { const pad = new Uint8Array(kk + nsym); pad.set(blk); parts.push(pad.slice(0, kk)); failed++; }
        else {
          const r = rsDecodeBlock(blk, nsym);
          parts.push(r.data); corrected += r.corrected; if (!r.ok) failed++;
        }
        o += kk + nsym; left -= kk;
      }
      return { data: SB.concatBytes(...parts), ok: failed === 0, corrected, failed };
    },
  };

  /* ================================================== crypto (WebCrypto) */
  const subtle = root.crypto && root.crypto.subtle;
  const KDF_ITER = 150000;
  SB.crypto = {
    available: !!subtle,
    /* passphrase -> key { w: 4 words for position/seed generators, aes: AES-256-GCM key } */
    async deriveKey(pass) {
      if (!subtle) return Object.assign(SB.keyFromNumber(SB.hash32(Array.from(new TextEncoder().encode(pass)).reduce((a, b) => (a * 31 + b) | 0, 7))), { label: 'weak-fallback' });
      const base = await subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
      const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITER, salt: new TextEncoder().encode('StegoBench/v2/key') }, base, 384));
      const dv = new DataView(bits.buffer);
      const w = [dv.getUint32(0), dv.getUint32(4), dv.getUint32(8), dv.getUint32(12)];
      const aes = await subtle.importKey('raw', bits.slice(16, 48), 'AES-GCM', false, ['encrypt', 'decrypt']);
      return { w, aes, label: 'passphrase' };
    },
    async encrypt(bytes, key) {
      if (!key.aes) throw new Error('This key has no AES material (use a passphrase)');
      const iv = root.crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key.aes, bytes));
      return SB.concatBytes(iv, ct);
    },
    async decrypt(bytes, key) {
      if (!key.aes || bytes.length < 28) return null;
      try { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key.aes, bytes.slice(12))); }
      catch (e) { return null; }
    },
    async sha256Hex(bytes) {
      if (!subtle) return 'n/a';
      const h = new Uint8Array(await subtle.digest('SHA-256', bytes));
      return Array.from(h).map((b) => b.toString(16).padStart(2, '0')).join('');
    },
  };

  /* ================================================== frame */
  const HDR = 4, CRC = 4;
  SB.frame = {
    overhead: (encrypted) => HDR + CRC + (encrypted ? 28 : 0),
    /* opts: { key, encrypt: bool, isFile: bool } */
    async pack(payload, opts) {
      opts = opts || {};
      let body = payload, flags = 0;
      if (opts.encrypt) { body = await SB.crypto.encrypt(payload, opts.key); flags |= 1; }
      if (opts.isFile) flags |= 2;
      if (body.length > 0xffffff) throw new Error('Payload too large');
      const head = new Uint8Array([flags, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]);
      const pre = SB.concatBytes(head, body), c = SB.crc32(pre);
      return SB.concatBytes(pre, new Uint8Array([(c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]));
    },
    /* -> { ok, reason, flags, encrypted, isFile, data (decrypted if key given), body } */
    async unpack(frame, key) {
      if (frame.length < HDR + CRC) return { ok: false, reason: 'Frame too short' };
      const flags = frame[0], len = (frame[1] << 16) | (frame[2] << 8) | frame[3];
      if (HDR + len + CRC > frame.length) return { ok: false, reason: 'Length field is inconsistent (wrong key, method or length?)' };
      const pre = frame.subarray(0, HDR + len), c = SB.crc32(pre);
      const got = ((frame[HDR + len] << 24) | (frame[HDR + len + 1] << 16) | (frame[HDR + len + 2] << 8) | frame[HDR + len + 3]) >>> 0;
      if (c !== got) return { ok: false, reason: 'Checksum mismatch (wrong key/method, or the image was altered)' };
      const body = frame.slice(HDR, HDR + len), res = { ok: true, flags, encrypted: !!(flags & 1), isFile: !!(flags & 2), body };
      if (res.encrypted) {
        if (!key || !key.aes) return Object.assign(res, { data: null, reason: 'Payload is encrypted – passphrase needed' });
        const pt = await SB.crypto.decrypt(body, key);
        if (!pt) return Object.assign(res, { ok: false, data: null, reason: 'Decryption failed (wrong passphrase)' });
        res.data = pt;
      } else res.data = body;
      return res;
    },
  };

  /* ================================================== whole pipeline */
  SB.pipeline = {
    /* payload bytes -> { frame, coded, bits, nsym } */
    async encode(payload, opts) {
      const frame = await SB.frame.pack(payload, opts);
      const nsym = (opts && opts.ecc) || 0;
      const coded = SB.ecc.encode(frame, nsym);
      return { frame, coded, bits: SB.bytesToBits(coded), nsym };
    },
    /* coded bit length for a given payload size */
    bitLength(payloadLen, opts) {
      const f = payloadLen + SB.frame.overhead(opts && opts.encrypt);
      return SB.ecc.codedLength(f, (opts && opts.ecc) || 0) * 8;
    },
    /* extract path: bits -> { frameBytes, ecc: {ok, corrected, failed} } */
    decodeBits(bits, nsym, frameLen) {
      const coded = SB.bitsToBytes(bits);
      const r = SB.ecc.decode(coded, nsym, frameLen);
      return { frame: r.data, ecc: r };
    },
  };
})();
