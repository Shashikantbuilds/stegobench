# StegoBench 2.0 – image steganography benchmark portal

Pure HTML + CSS + JavaScript. No server, no network, nothing is uploaded. Everything (embedding, attacks, detectors, statistics) runs in your browser tab.

## Run it
Unzip and open `index.html` (the overview / landing page). Its **Open Dashboard** buttons take you to `dashboard.html`, the actual tool (Chrome, Edge, Firefox or Safari). VS Code Live Server also works (port in `.vscode/settings.json`).

Optional, for development and CI: `npm install`, then `npm test` (67 headless checks), `npm run test:ui` (drives the real page in jsdom), `npm run validate` (reproducible results table below).

```
stegobench/
├── index.html            landing page (overview, how it works, attack steps, developers)
├── dashboard.html        the benchmark portal (opened from the landing page)
├── tests.html            in-browser self-test (67 checks)
├── build.js              builds js/worker-src.js (run `node build.js` after editing js/)
├── css/style.css         dashboard styles (light + dark, print)
├── css/landing.css       landing page styles
├── js/landing.js         landing page script (theme, menu, scroll effects)
├── js/utils.js           keyed 128-bit PRNG, bytes/bits, CRC32, 8x8 DCT, statistics (Wilcoxon, ROC, Pareto)
├── js/codec.js           payload codec: frame + CRC32, AES-256-GCM (PBKDF2), Reed-Solomon ECC
├── js/stc.js             S-UNIWARD costs + syndrome-trellis codes
├── js/methods.js         the 8 embedding methods
├── js/attacks.js         20 attacks + strength sweeps
├── js/detectors.js       RS analysis, Weighted Stego, progressive chi-square
├── js/metrics.js         PSNR, SSIM (11x11 Gaussian), histogram shift, detection risk
├── js/job.js             one benchmark job + aggregation + rank stability
├── js/benchmark.js       orchestration, worker pool, payload sweep, breakpoints
├── js/worker-src.js      generated Web Worker bundle (so it works from file://)
├── js/charts.js, sample.js, ui.js, selftest.js
├── tests/                node harness (run-node.js, ui-smoke.js, validation-run.js)
└── assets/               logo, favicon, team/ (developer photos)
```

## What is new in 2.0 (and why)
| Gap in 1.0 | Now |
|---|---|
| One image, one message, one key – no statistics | **Dataset mode** (up to 40 images) and **keys per image**; every score is a mean ± std; paired **Wilcoxon** tests with Bonferroni correction; “#1 in x % of weightings” rank stability |
| Payload size was not controlled | **Payload sweep**: raw channel recovery and PSNR vs bits per pixel (log axis) |
| Stealth score came from a weak chi-square | **RS analysis, Weighted Stego, progressive chi-square**; with ≥ 12 samples stealth comes from the measured **ROC / AUC / P_E** of the best detector |
| Only 5 methods | + **LSB Matching (±1)**, **DWT-QIM (Haar)**, **S-UNIWARD + STC** (content-adaptive) |
| Attacks too easy | + **shift 3 px**, **rotate 1°**, **median**, **sharpen**, **WebP**, **double JPEG**, **social-media chain**; **breaking-point curves** for JPEG, noise, scale and shift |
| No header / ECC | **Frame** (flags, length, CRC32) so a wrong key is *detected*; **Reed-Solomon** ECC applied to every method equally |
| 32-bit numeric key | **Passphrase → PBKDF2-SHA256 (150 000 rounds)** → 128-bit position seed + **AES-256-GCM** payload encryption; file payloads up to 64 KB |
| Weighted sum hid trade-offs | **Pareto-optimal** marker + trade-off map; goal presets kept |
| Main thread froze | **Web Workers** pool with automatic fallback; progress with ETA |
| UI | dark mode, keyboard-accessible controls, tooltips, linked 5× inspector lens, reproducibility card (browser, image SHA-256, settings), CSV / JSON / PDF export |
| No CI | `tests/` + GitHub Actions workflow |

## Use it
1. **Carrier & payload** – choose one image or switch to *Dataset* (or click *Generate 12 sample images*). Enter text or pick a file, a passphrase, the ECC level, carrier format and keys per image.
2. **Methods & run** – tick methods, choose the *Full* (20 attacks) or *Quick* attack set, press **Run benchmark**.
3. **Leaderboard** – ranked by your goal; open *Is the ranking reliable?* for significance tests and *How the scores are calculated* for formulas.
4. **Attack simulation** – heat-map per attack and per attack family, plus an inspector (cover / stego / amplified difference with a linked 5× lens; arrow keys move it).
5. **Deep analysis** – *Payload sweep*, *Breaking points*, *Detection* (ROC curves).
6. **Extract & verify** – load a downloaded stego PNG, pick method, passphrase, frame length and ECC. You get the text (or file) back plus ECC / checksum / decryption status. A wrong passphrase is rejected.

## How scores work (all editable in `js/job.js`, `js/metrics.js`)
- **Recovery** – chance-adjusted bit recovery of the framed payload after the attack and ECC (50 % match = 0 %). **Robustness** = mean over all supported attacks.
- **Imperceptibility** = 70 % PSNR (30→60 dB) + 30 % SSIM (11×11 Gaussian window, luminance).
- **Stealth** = 100 − risk. *Under 12 samples*: risk = 30 % visible distortion + 50 % strongest of RS / WS / progressive χ² (measured against the cover) + 20 % high-frequency noise growth. *12 or more samples*: stealth = 100 × (1 − max(0, 2·AUC − 1)) for the best detector.
- **Capacity** = log-scaled maximum payload. **Overall** = weighted sum (goal presets).

## Validation
Run `npm run validate` to reproduce. 12 generated covers (512×384), 60-byte payload, AES-GCM, no ECC, lossless carrier, all 20 attacks:

| Method | PSNR dB | SSIM | Robustness | JPEG75 | Gauss σ5 | Shift 3px | Best detector (AUC) |
|---|---|---|---|---|---|---|---|
| Sequential LSB | 80.0 | 1.0000 | 8 | 3 | 0 | 2 | chiSeq (0.61) |
| Random LSB | 80.0 | 1.0000 | 11 | 3 | 0 | 1 | ws (0.53) |
| LSB Matching (±1) | 80.0 | 1.0000 | 11 | 2 | 4 | 1 | chiSeq (0.53) |
| S-UNIWARD + STC | 85.6 | 1.0000 | 1 | 1 | 0 | 3 | rs (0.51) |
| DCT (Koch-Zhao) | 45.9 | 0.9933 | 86 | 100 | 100 | 4 | rs (0.56) |
| DCT + Vote (ECC) | 41.2 | 0.9801 | 90 | 100 | 100 | 4 | ws (0.62) |
| Spread Spectrum | 38.6 | 0.9656 | 89 | 100 | 100 | 1 | ws (0.85) |
| DWT-QIM (Haar) | 40.1 | 0.9743 | 90 | 100 | 100 | 1 | rs (0.61) |

How to read it, and what it does not prove:
- The expected textbook behaviour appears: LSB-family methods carry the message perfectly but are destroyed by JPEG; DCT / DCT+Vote / Spread / DWT survive JPEG QF75 and noise; **every** method fails after a 3 px shift (block / pixel positions are lost).
- S-UNIWARD+STC and LSB Matching are the least detectable (AUC ≈ 0.5). **Spread Spectrum is the most detectable** (AUC 0.85 for Weighted Stego): robustness costs stealth.
- The covers are **procedurally generated** (grainy landscapes), not photographs. Detector baselines differ on real images (RS reads 0.3 on the grain, about 0 on many photos). Use *Dataset* mode with your own photos, or BOSSbase / ALASKA2, for publishable numbers.
- With a 60-byte payload in a 512×384 image the embedding rate is tiny. LSB-type methods are then essentially undetectable by RS / WS. Use the **payload sweep** to see detection grow with rate.

### Cross-checking with an independent tool
1. Run a *Dataset* benchmark, open **Inspect output**, download the stego PNG for a method (one image per download).
2. Run the same cover and stego through [Aletheia](https://github.com/daniellerch/aletheia) (open-source steganalysis toolbox with RS, WS, SPA and trained detectors) and compare its verdicts with the Detection tab. Agreement is external evidence; disagreement points to a flaw worth fixing.
3. For publishable steganalysis use rich-model features (SRM) with an ensemble classifier or a CNN (SRNet) on BOSSbase / ALASKA2 at fixed payloads such as 0.1–0.4 bpp.

## Honest limits
- RS, WS and chi-square are **classical** detectors for LSB replacement. They are not SRM / SRNet; “not detected” means “not caught by these tests”. SPA is not implemented.
- “JPEG carrier” means the stego image is re-encoded as JPEG QF 90. There is no JPEG-coefficient-domain embedding (nsF5 / J-UNIWARD).
- S-UNIWARD costs follow the paper; the STC uses a **key-derived random** submatrix (h = 7), not the optimised ones, so embedding efficiency is below the published optimum.
- JPEG / WebP attacks use the **browser's encoder**; numbers can differ slightly between browsers (the reproducibility card records the browser). WebP is skipped in browsers that cannot encode it.
- The key space is 128 bits for positions; the PRNG (sfc32) is not cryptographic. Encryption of the payload is AES-GCM, but a steganography tool should still be treated as research code.
- Large covers are scaled to the working size (Settings). Dataset mode keeps at most 40 images in memory.
- After editing anything in `js/`, run `node build.js` (or untick *Run in parallel Web Workers* in Settings).
- Not included: login, database, trained CNN detector, batch export of all stego images (single-image PNG download only).
