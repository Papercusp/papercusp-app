# Testing — @papercusp/result-encoding

Run: `npx vitest run` (from this directory) or via the repo's `npm run test:affected`.

## What's covered

- **`encode.test.ts`** — example-based encode/decode for every format: compact
  JSON, TOON (tabular + nested + empty array), CSV/TSV RFC 4180 quoting + ragged
  columns + lossy string round-trip, markdown-table escaping, and the
  `encodeAuto` runtime sniff (array→toon, object/scalar→json).
- **`encode.property.test.ts`** (fast-check) — the load-bearing invariants:
  - `encodeAuto` is **always lossless** over arbitrary JSON (the checked TOON
    encoder falls back to JSON on the rare pathological-key edge case rather
    than emit a corrupt compact payload).
  - `encodeToonChecked` only reports `lossless: true` when the round-trip holds.
  - CSV/TSV string-coerced round-trip under quoting (commas, quotes, CR/LF).
- **`eligibility.test.ts`** — the D-004 schema→capability table over real
  Zod→JSON-Schema projections (flat array → {json,toon,csv,tsv,md}; nested /
  heterogeneous / scalar arrays → {json,toon}; non-array / record / any →
  {json}); `bestCompactFormat` never auto-selects CSV.

## What's NOT covered here

- Wiring into the tool framework (format selection per call, envelope→`_meta`,
  the format marker) lives in `@papercusp/tooldef` (`serialize-result.ts`) and
  is tested there.
- TOON's own correctness is the upstream lib's concern; we only assert OUR
  lossless contract (verify-and-fall-back) holds regardless.

## After editing

`npx vitest run` here, plus `npm run test:affected` at the repo root (the
encoder is consumed by `@papercusp/tooldef`, so its suites run too).
