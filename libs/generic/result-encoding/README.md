# @papercusp/result-encoding

Generic, domain-free token-efficient serialization for structured tool results.
Wraps [`@toon-format/toon`](https://toonformat.dev) and adds opt-in CSV/TSV/
markdown-table encoders plus a static schema→capability eligibility analyzer.
No host coupling — a tool framework supplies the schema and the negotiation;
this package knows nothing about MCP, HTTP, or Papercusp.

## Why

JSON's repeated keys/braces/quotes are pure structural overhead the model pays
for on every row of every list result. TOON renders uniform arrays as CSV-style
rows (≈ −40% tokens overall, −59% on flat data) while staying JSON-lossless.
This package is the encoder + the rules for *when each format is safe*.

## API

```ts
import {
  encode, decode, encodeAuto, encodeToonChecked, // encode.ts
  analyzeSchema, bestCompactFormat,               // eligibility.ts (P-002)
  parseFormatRequest, mimeForFormat,              // formats.ts
  type ResultFormat, type FormatRequest,
} from '@papercusp/result-encoding';
```

- **`encode(value, format)` / `decode(text, format)`** — render/parse a JSON
  value as `json | toon | csv | tsv | md`. TOON is lossless; CSV/TSV are lossy
  (string cells); `md` is display-only (no decode).
- **`encodeAuto(value)`** — the no-schema runtime default: arrays → TOON
  (verified lossless, else JSON fallback), single objects/scalars → JSON.
- **`encodeToonChecked(value)`** — encode to TOON and report whether it
  round-trips; the lossless guarantee is delivered here, not assumed from the
  dependency.
- **`analyzeSchema(jsonSchema)`** — static walk of a `data`-node JSON-Schema →
  `{ capabilities: Set<ResultFormat>, bestFormat }`. Flat scalar-object arrays
  unlock CSV; nested/heterogeneous arrays are TOON-only; non-arrays are JSON.
- **`parseFormatRequest(raw)`** — parse a `?format=` / `_meta.format` / `Accept`
  value (incl. MIME types + `compact`/`full`/`tabular` aliases) into a request.

## Contract

`decode(encode(v, 'toon'), 'toon')` deep-equals `v` for any JSON value, enforced
by fast-check round-trip property tests. CSV is opt-in-only and never
auto-selected. `json` is always available and is the lossless default for
nested / heterogeneous / single-object / round-trip-shaped payloads.

Plan: `token-efficient-tool-result-formats-2026-06-06`.
