/**
 * `tryParseJson` moved into the shared eval-battery engine (reconciliation D-001 —
 * one engine, the gym is the `HarnessSubject`). This thin re-export keeps the gym's
 * own modules + the (still-live) apiary importing `../gym/parse-json` working
 * byte-identically; the canonical home is `@papercusp/eval-battery`.
 */
export { tryParseJson } from '@papercusp/eval-battery';
