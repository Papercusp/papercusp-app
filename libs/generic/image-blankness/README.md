# @papercusp/image-blankness

Detects a **blank image capture** — a screenshot written successfully by a tool that
exited 0, of a window that never painted.

Zero runtime deps: a small PNG reader over `node:zlib`, then a statistical read of the
pixels. No native modules, no image library.

## Why

A screenshot tool cannot tell you whether the screenshot worked. `tauri-agent-tools
screenshot` writes a valid PNG, prints its path and exits 0 whether the window rendered
or not — on a GL-less display it captures nothing at all (see agent-e2e §15.4). The file
that results *looks* like proof: real bytes, real dimensions, produced by a real capture
command at a real path.

That makes it dangerous rather than merely useless, because any pipeline that treats "an
image exists" as evidence of "a UI was seen" will accept it. In this repo that pipeline
is the `work_items:complete` gate on `verifiedHow:'live-drove-ui'`
(EI-18797014705631713): an agent could run the capture, never open the file, cite the
path, and close the item having verified nothing — while leaving a paper trail that
reads as rigorous. This module is the cheap local test that closes it.

## Use

```ts
import { analyzeImageBlankness } from '@papercusp/image-blankness';

const report = analyzeImageBlankness(new Uint8Array(await readFile(path)));
if (report.verdict === 'blank') throw new Error(report.reason);
```

`verdict` is one of:

| verdict | meaning |
| --- | --- |
| `has-content` | Decoded, carries real rendered detail. |
| `blank` | Decoded, carries none — the window did not paint. |
| `undecodable` | Not a format the reader handles, or corrupt. **Never** treated as blank. |
| `inconclusive` | Decoded but too small to judge (below `minJudgeableArea`). |

From the shell, on any capture you are about to cite as evidence — exits 1 if any
argument is blank:

```sh
npm run check:screenshot -- /tmp/my-shot.png     # from the repo root
```

## How it judges

The metric is **adjacent-pixel detail measured per row**, and the frame is judged by its
densest row. Two decisions, both learned from real failures:

**Detail, not uniformity.** The observed failure was not a flat fill but a smooth dark
gradient — ~800 distinct colours, which sails past any distinct-colour or file-size
test (the real one was 91KB), yet no rendered content whatsoever. Real UI is full of
high-frequency detail: every glyph, border and icon edge is a large step between
neighbouring pixels. A gradient has none, anywhere.

**Per row, not per frame.** A whole-frame average asks the wrong question. Measured over
400 real captures from one workstation, the frames it ranks lowest are not failures at
all — a small terminal window on a black desktop, an app that painted only its menu bar.
Both composited correctly; their content is simply *local*. Asking "does ANY band of
this frame carry rendered content?" separated the two populations by ~40x where the
global average separated them by 2x.

It deliberately does **not** judge whether the app rendered what you wanted. A window
showing nothing but its own chrome is `has-content`, because the capture pipeline
demonstrably worked. What the app was showing is the DOM's question, not this module's.

## Calibration

Against those 400 captures: every genuinely dead one scores **exactly 0.00000** — a
gradient or flat fill has no sharp step by definition — and the sparsest frame that
really did composite (a boot screen: one logo, one progress bar, on black) scores
0.00938. The default floor of `0.001` sits an order of magnitude clear of both.

Read literally it says: across a 1280-wide frame, not one row anywhere contains even two
adjacent pixels with a visible step between them. Nothing was drawn.

## Direction of failure

Every uncertainty resolves **away** from `blank`, because the only action a caller takes
on that verdict is a rejection — and a wrong rejection blocks work that was genuinely
done. Unreadable, unsupported, interlaced, too small, or merely ambiguous all report as
something other than `blank`. The burden is on this module to be sure.

## Knobs (`BlanknessThresholds`)

- `minPeakRowDetail` — the floor described above.
- `detailLumaDelta` — luma step (0-255) counted as an edge; default 8.
- `minJudgeableArea` — below this pixel count, `inconclusive` rather than `blank`.

Override per call (`analyzeImageBlankness(bytes, { … })`) or process-wide via the host
seam `configureImageBlankness({ … })` / `resetImageBlanknessConfig()`.

## Formats

8- and 16-bit greyscale, RGB, greyscale+alpha and RGBA, plus 1/2/4/8-bit palette —
palette matters because an optimiser turns a blank grab into a tiny indexed PNG, and
refusing it would blind the detector to its own primary case. Alpha is composited over
black, so a fully transparent capture reads as blank. Interlaced (Adam7) files are
refused rather than half-decoded. Anything else reports `undecodable`.

## Test support

`@papercusp/image-blankness/testing` exports a minimal PNG encoder (`encodePng`,
`rgbSamples`) plus `blankPng()` / `contentPng()` fixtures, so a consumer can test its
own handling of both verdicts without committing binary files.
