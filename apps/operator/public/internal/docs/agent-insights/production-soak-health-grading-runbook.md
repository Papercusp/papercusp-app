# production-soak-health — grading runbook
URL: /internal/docs/agent-insights/production-soak-health-grading-runbook

How to grade the production-soak-health auto-loop component rubric: per-criterion instruments, evidence queries, and the typed emission path.

`production-soak-health` (5 criteria, ratingScale `healthy / degraded / broken /
unknown`) is one of the 6 auto-loop component rubrics ratified under
`rubric-system-and-auto-loop-release-profile-2026-07-15` P-007, composed into the
`papercusp-autoloop-public-release-readiness` profile
(`apps/operator/lib/release/release-profile.ts`,
`AUTOLOOP_COMPONENT_RUBRIC_REFS`). It is the newest of the 6 — unlike
`kettle-supervision-health` / `mug-pot-coordination-health` / `autonomy-owner-controls`
/ `release-integrity-health` (which reuse instruments already documented in
[autoloop-release-readiness-grading-runbook](/internal/docs/agent-insights/autoloop-release-readiness-grading-runbook)),
this rubric measures a genuinely new characteristic — does a release stay healthy
*through* a soak window after deploy, not just at the health-check moment — and most
of its instruments do not exist yet (flagged as a completeness gap at proposal time,
WI-4960 checkpoint).

## The one main procedure

1. **Generation stamp first.** Same discipline as the sibling rubrics: record the
   generation you are grading BEFORE gathering evidence
   (`blender:success-metrics { watermarkRef: 'bg-host-restart' }` + `dev:pipeline_position`).
   Evidence gathered across a host-restart boundary is invalid — re-gather.
2. **Gather instrument snapshots per criterion** (see below — most are `unknown` by
   construction today; that is the honest, correct rating until the instrument
   exists, not a grading failure).
3. **Emit via the typed path** — never prose:
   `scorecards:evaluate { rubricRef: 'production-soak-health' }` → fill the returned
   skeleton → `scorecards:evaluate { rubricRef, ratings, instrumentSnapshots }`
   (validates + fingerprints) → `scorecards:emit` the canonical result.
4. **Rate honestly.** `unknown` beats invented — a criterion with no instrument yet
   is `unknown`, never guessed at `healthy`.

## Per-criterion instruments

### sustained-post-deploy-health · `soak-health-samples`

**No instrument exists yet.** Intent: sample `dev:service_health` (or the
equivalent live health probe) on a fixed cadence (e.g. every 15 min) for a fixed
window after each deploy (e.g. 2h), and require every sample in the window to be
healthy — a single health-check pass at deploy time is NOT sufficient evidence for
this criterion. Until a `soak-health-samples` table/routine exists, rate `unknown`
with the gap stated in evidence.

### incident-rate-trend · `incident-rate-trend`

**No instrument exists yet.** Intent: a rolling comparison of
`engineer_issues`/`improvements` bug-severity filings (or an equivalent incident
ledger) release-over-release — does the rate drift upward? Until wired, rate
`unknown`.

### canary-liveness-continuous · `mug-wake-trace`

Partially measurable TODAY by reusing an existing signal: `harness_shared.autoloop_state`
role `director`/`kettle`/`mug` rows already carry a `last_fired_at` watermark (the
same table `kettle-supervision-health`'s `kettle-wake-cadence` criterion reads —
see that runbook for the exact query). A live, cycling watermark on the current
generation is real (if partial) evidence of continuous liveness; it does not by
itself prove *release-scoped* canary behavior across a soak window, so treat a
"watermark is fresh" reading as supporting evidence toward `healthy`, not
sufficient on its own — state the gap in evidence rather than rounding up.

### real-usage-validates-release · (no instrument bound)

Deliberately `instrumentKey: none` — this criterion is meant to be graded from
judgment against real usage signals (feature-adoption telemetry, live traffic
through the changed surface), not a single mechanical query. Rate `unknown` when no
such signal was actually reviewed this pass; never default it to `healthy` for lack
of a contrary signal.

### soak-duration-sufficient · `soak-health-samples`

Shares its instrument with `sustained-post-deploy-health` — same "no instrument
yet" status. Intent: refuse to call a release "durable" before a real, elapsed soak
window (not merely "no complaints since deploy 10 minutes ago").

## Known standing reds — status as of 2026-07-17

* **sustained-post-deploy-health**, **incident-rate-trend**, **soak-duration-sufficient**:
  `unknown` by construction — the `soak-health-samples` / `incident-rate-trend`
  instruments do not exist yet. This is the rubric's honest starting state, not a
  regression; building these instruments is follow-up work (file as a `change` work
  item referencing this doc + WI-4960's checkpoint gap note if picking it up).
* **canary-liveness-continuous**: partially gradeable today via the shared kettle
  watermark query (see above) — first live dogfood grading landed 2026-07-17 (see
  `rubric-system-and-auto-loop-release-profile-2026-07-15` P-010 completion evidence,
  scorecard EI-13372 on the sibling `kettle-supervision-health` rubric, which shares
  the same underlying `autoloop_state` instrument).
* **real-usage-validates-release**: `unknown` — not yet graded against a real usage
  review.
