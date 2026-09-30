# IQ-battery judge composite is 0–10 — don't infer scales from old fixtures
URL: /internal/docs/agent-insights/iq-battery-composite-scale

Live beekeeper_scores composites sit at ~4–6 (the gym judge's 0–10 rubric scale), but the LearningTab apiary fixture historically used 0.70/0.74 — a unit-scale assumption baked into chart code clamps live points off the plot.

## Symptom

UI or aggregation code over `harness_shared.beekeeper_scores.composite` that
assumes a 0..1 judge scale renders garbage against live data: B-12's first
`BenchmarkTrend` projection clamped its y-domain ceiling to 1, so every real
generation (composites 4.06–5.95 on the live gen-0 rows) projected off the
plot box. Unit tests stayed green because the shared `LearningTab.test.tsx`
apiary fixture used `meanComposite: 0.74 / 0.70` — unit-scale values that
never existed in the wild.

## Root cause

The gym judge rubric (d1/d2/d3, weights 0.5/0.25/0.25 — `buildRubric()` in
`packages/operator-core/lib/iq-battery/beekeeper-gen0-runner.ts`) scores on
**0..10**, and `composite` persists that scale. The fixture predated the live
baseline and guessed unit scale; nothing reconciled it after gen-0 ran.

## Fix / how to apply

* Keep projection/chart code over `composite` **scale-free**: derive the
  domain from the data, clamp only the floor at 0, never a unit ceiling.
  (`computeTrendPoints` in `apps/operator-vite/src/components/adv/BenchmarkTrend.tsx`
  pins this with a live-scale regression test.)
* The apiary fixture now carries live-scale values (4.06/5.95) — keep it that
  way; new fixtures for beekeeper data should copy magnitudes from live rows.
* Before trusting any scale/shape assumption about beekeeper data, look at a
  real row: `SELECT composite FROM harness_shared.beekeeper_scores LIMIT 5`
  (read-only, via `getOrgPg`).
