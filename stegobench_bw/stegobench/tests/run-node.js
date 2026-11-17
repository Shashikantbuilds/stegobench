/* Headless self-test:  npm test   (Node >= 18, uses @napi-rs/canvas) */
'use strict';
const env = require('./node-env');
env.install();
env.loadSources(['utils.js', 'codec.js', 'stc.js', 'methods.js', 'attacks.js', 'detectors.js', 'metrics.js', 'job.js', 'benchmark.js', 'sample.js', 'selftest.js']);
(async () => {
  const res = await global.SB.runSelfTest((name, ok, detail) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`));
  console.log(`\n${res.fail === 0 ? 'ALL ' + res.pass + ' TESTS PASSED' : res.fail + ' FAILED / ' + res.pass + ' passed'}`);
  process.exit(res.fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
