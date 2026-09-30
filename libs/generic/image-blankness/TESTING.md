# Testing — @papercusp/image-blankness

`npm test` (vitest) from this directory, or via the repo's affected-test walker.

Every fixture is built by the encoder in `src/testing.ts` and is a real PNG a viewer
could open — nothing binary is committed.

## Covered (`src/index.test.ts`)

- **Flat fill** → `blank`, one distinct colour, zero detail.
- **Smooth gradient** → `blank`. The case a distinct-colour or file-size test misses, and
  the one actually observed in the wild (a 91KB, 1280x800 dark gradient).
- **Rendered UI frame** → `has-content`.
- **Content in a narrow band** → `has-content`, and asserted to be a frame whose
  whole-frame average falls *below* the floor while its peak row is 40% edges. This is
  the regression guard on the per-row metric: a global average would reject a real
  capture here.
- **Fully transparent RGBA** → `blank` (composited over black), even with non-uniform
  RGB underneath.
- **Greyscale and palette** captures decode and judge.
- **Up scanline filter** reverses to the same statistics as an unfiltered encode.
- **Decoder round-trip** — pixel values survive encode → decode exactly.

## Abstaining rather than guessing

The direction of failure is the safety argument, so it has its own block: empty bytes, a
non-image, a JPEG header, a truncated PNG and an interlaced PNG must all report
`undecodable`; a sub-`minJudgeableArea` crop must report `inconclusive`. **None may ever
report `blank`** — the only action a caller takes on that verdict is a rejection.

## Calibration

The default `minPeakRowDetail` is not a guess: it was set by running the detector over
400 real captures on the dev box, checking the boundary cases by eye, and placing the
floor an order of magnitude clear of both populations (true failures score exactly
0.00000; the sparsest real capture scored 0.00938). Re-run that scan before changing it —
a unit test cannot tell you the threshold is well-placed, only that it is stable.

## Consumers

The completion-integrity gate that uses this is tested separately, in
`packages/operator-core`: `completion-audit.test.ts`
(`verifyLiveDroveUiArtifacts` — blank/missing/0-byte rejections and every fail-open
path) and `agent-tools/work_items/complete.test.ts` (the same rejections at the
`work_items:complete` boundary). Both build their fixtures from
`@papercusp/image-blankness/testing`.
