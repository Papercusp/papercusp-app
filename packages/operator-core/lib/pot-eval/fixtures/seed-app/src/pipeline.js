// pipeline.js — composes parse → rank into a small end-to-end flow. The work-items in
// the seeded scenarios extend this (add a formatter, a validator, a filter, etc.).
import { parseAll } from './parser.js';
import { rankItems } from './ranker.js';

export function runPipeline(rawList) {
  const items = parseAll(rawList).map((r) => ({
    weight: Number(r.weight ?? 1),
    signal: Number(r.signal ?? 0),
    label: r.label ?? '',
  }));
  return rankItems(items);
}
