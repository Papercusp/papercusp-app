# Ratified design evidence — operating the comparison contract
URL: /internal/docs/agent-insights/ratified-design-evidence-operations

How a ratified mockup becomes an enforceable implementation obligation: the lifecycle, the three verbs, how to read pass/fail/invalid, why enforcement is scoped to the machine the threshold was measured on, how to run and recalibrate the comparison, what a green does NOT establish, and the tested non-destructive disable path.

This is the operator manual for the ratified-design comparison contract. It is written so that someone who has never touched this subsystem can reproduce a comparison, read its verdict correctly, and turn the whole thing off without destroying anything.

> **Status today: ENFORCING, WITHIN A MEASURED SCOPE.** `papercusp-design-evidence-gate` is ON and measures every terminal completion; `papercusp-design-evidence-gate-enforcing` is now ON too. It does **not** follow that every failing reference is refused. The threshold was measured on ONE machine, so a refusal only happens for a reference ratified on that machine (D-023). Everything else is reported and never refused, and every non-enforcing outcome says so in words — see [Enforcement is scoped to the measured host](#enforcement-is-scoped-to-the-measured-host-d-023).

## The lifecycle

Four states, and only the third one constrains anybody.

1. **Exploration — unconstrained (D-001).** Images, Claude artifacts, sketches, competing directions. Mockups are proposals, not specifications. Nothing in this document applies. Do not point a comparison at an unratified mockup; there is nothing to compare against.
2. **Ratification — `design-phase.ratify_reference`.** A reviewer freezes one image as an immutable reference at one environment. This is the transition that creates an obligation, and it is deliberately explicit: nothing becomes binding by accident.
3. **Implementation — owes evidence.** Every required case on that reference needs CURRENT PASSING deterministic evidence before the work-item can complete. Produce it with `design-phase.compare_render`.
4. **Retraction — the legitimate exit.** If the design no longer applies, retract the reference. The surface becomes unconstrained again, recorded as a transition rather than a deletion. Retraction is a normal move, not an admission of failure — use it instead of forcing a comparison you know is meaningless.

### One reference = one image = one environment (D-019)

A required case is contracted at the reference's *own* viewport, theme, and state. `compare_render` refuses a cross-environment capture, because comparing a 1280x800 reference against a 390x844 render measures the viewport, not fidelity.

So: **cover a second breakpoint by ratifying a second reference, never by adding a case to the first.** A feature's obligation is composed across all of its references (`feature-gate.ts`), and that composition is storage-driven — the gate discovers which references exist rather than asking the caller, because a gate you can satisfy by naming no references is not a gate, it is a form to fill in.

## The three verbs

| verb                               | what it does                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design-phase.ratify_reference`    | Freezes an image as an immutable reference revision at a contracted environment. Takes the ratifying principal from the host, not the caller (D-018). |
| `design-phase.compare_render`      | Captures the implementation at the reference's environment, runs the deterministic engine, and persists a versioned verdict.                          |
| `design-phase.get_design_evidence` | Reads what a surface owes and what it has. The gate reads through this same verb, so what you see is exactly what the gate sees.                      |

That last point is a correctness property, not a convenience: staleness, schema-version mismatch and coverage are computed in one place. A gate that recomputed them from raw rows would be a second implementation free to drift — and drift toward "current" is the direction that passes work it should have stopped.

## Reading a verdict

A comparison returns **pass**, **fail**, or **invalid**. Evidence a surface *holds* fails in four distinct ways, each fixed differently:

| state       | meaning                                   | fix                                                      |
| ----------- | ----------------------------------------- | -------------------------------------------------------- |
| **missing** | never compared                            | run `compare_render`                                     |
| **stale**   | bound to a superseded reference revision  | re-run against the current revision                      |
| **invalid** | no meaningful verdict (see reasons below) | fix the precondition, then re-run                        |
| **failing** | diff exceeded policy                      | fix the implementation, or retract if the design changed |

**Stale is the one that gets misread.** A stale record still literally reads `verdict: 'pass'` — it passed, against an image that is no longer the reference. The verb is what knows it is stale; the stored row does not say so.

The refusal names every unmet case at once, deliberately: an agent told about one unmet reference fixes it, retries, and gets refused by the next.

### Why a case is unmet — the finer grain under those four states

The gate reports a `reason` beneath each state, because two cases in the same state can need opposite actions:

| reason                | state   | what to do                                                                                                                                                                          |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-evidence`         | missing | no comparison was ever run for this case — run `compare_render`                                                                                                                     |
| `wrong-surface`       | missing | a comparison WAS run at this environment, but it captured a different surface. Capture the surface the case names and re-run                                                        |
| `wrong-render-host`   | invalid | the evidence passed, but it was produced on a different machine than the reference was ratified on — or it does not record one. Re-capture on the ratifying host and re-run (D-023) |
| `superseded-revision` | stale   | measured against a reference revision that is no longer active — re-run against the current one                                                                                     |
| `unreadable-schema`   | invalid | the stored record was written under a compare-result schema this build cannot read, so it is not evidence                                                                           |
| `engine-invalid`      | invalid | the comparison returned `invalid` — resolve the precondition it names, then re-run                                                                                                  |
| `diff-exceeds-policy` | failing | fix the implementation, or ratify a new revision if the DESIGN changed                                                                                                              |
| `no-required-cases`   | invalid | the active revision declares no required cases, so there is nothing to verify — re-ratify it                                                                                        |

**`wrong-surface` is the one worth reading twice.** Reported as `no-evidence` it would send you to run the comparison you already ran — and under the indistinguishable-capture case above, that comparison may well have *passed* at diff ratio 0. You would read the same green a second time and conclude the gate was broken. The remedy is not "compare"; it is "compare the right thing".

**`wrong-render-host` is the other one.** It fires on evidence that *passed*, which makes it read like a bug the first time you see it. It is not: the implementation may be perfect and the engine may have behaved perfectly. What is wrong is the **measurement** — the threshold that judged it was never measured for that machine. The remedy is neither "compare" nor "fix the code"; it is "compare on the host this reference was ratified on".

### `invalid` reasons

`missing-reference` · `missing-capture` · `dimension-mismatch` · `environment-mismatch` · `target-mismatch` · `capture-failed` · `engine-error` · `engine-timeout` · `stale-evidence` · `unsupported-input` · `ungateable-reference-class`

`dimension-mismatch`, `environment-mismatch` and `target-mismatch` are the load-bearing ones, and all three are rejected **before** the engine is invoked.

Lost Pixel will happily *resize* unequal images before comparing them, so the adapter rejects a geometry mismatch up front (D-005) — it can never be normalised away into a plausible-looking pass.

`target-mismatch` guards the case no threshold can (D-020, D-022). A required case is contracted against a specific **surface**, and a capture of a different surface is refused rather than measured. This matters because captures of semantically different surfaces are sometimes *byte-identical* — when the content that distinguishes them arrives after the capture settles, the comparison returns a diff ratio of **0**. That is a perfect score for building the wrong thing, and there is nothing for a threshold to catch. The contract catches it instead.

### Verb refusals — no comparison was attempted

Separate vocabulary, separate meaning: these are conditions under which nothing was compared, so nothing can be described.

| code                   | what to do                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `engine-unavailable`   | No design-compare implementation is installed in this host (D-017). Not your code's fault; the host did not publish the verbs. |
| `unauthenticated`      | Caller carries no usable identity, so provenance could not be recorded.                                                        |
| `not-ratified`         | Reference never ratified, or has no active revision. Check you are pointing at the right reference id.                         |
| `revision-conflict`    | A concurrent writer took this revision. Re-read and retry — this one *is* worth retrying.                                      |
| `validation-failed`    | Malformed submission. Retrying unchanged is pointless; read `errors[]`, which lists every problem at once.                     |
| `reference-unreadable` | The reference image could not be decoded. Usually a JPEG (see below).                                                          |
| `storage-error`        | The store itself failed.                                                                                                       |

**JPEG references are refused at ratification (D-013)** — the mandated engine decodes PNG only. Reference *media* may be PNG or JPEG, but only PNG is comparable, so the refusal happens at the ratification boundary rather than surfacing much later as a confusing `reference-unreadable`.

## Enforcement is scoped to the measured host (D-023)

The enforcing flag being ON is only half of what decides a refusal. The other half is whether the threshold was ever measured for the machine involved — and it usually was not.

**Why.** The derived tolerance for `artifact-capture` is `0.000033816`, which is about **34 pixels of a 1280x800 render**. Every noise sample behind it was captured on one machine (D-021), so host-to-host variance — font rasterisation, GPU, driver — is entirely unmeasured and is plausibly far larger. Enforcing a same-host threshold across hosts fails correct work on the first runner whose fonts differ.

**The gap that made this urgent.** `CaptureEnvironment` has seven fields — viewport, deviceScaleFactor, browser, theme, fontSet, fixture, state — and none of them carries host identity. So two captures taken on machines with entirely different fonts satisfy `environmentsMatch`, and `describeEnvironment` renders them identically. A cross-host comparison was not merely unmeasured; it was *indistinguishable* from a same-host one at every precondition the gate checks. `fontSet: 'system'` is the mechanism: it is an honest declaration that a capture asserts **nothing** about fonts, which means the one field naming fonts is satisfied identically by two hosts whose fonts differ.

**What was added.** A render-host fingerprint, measured from the browser that produced the image:

* It reuses the D-016 metric instrument already in `capture-playwright.ts` — canvas `measureText` widths for `monospace`, `sans-serif` and `serif` — rather than `process.platform`. Two Linux x64 boxes with different font packages are exactly the case D-021 fears, and platform+arch would call them identical. The generics resolve to whatever the host actually has, so the widths move.
* Browser **major** version is included; the patch is not. Folding the full user-agent in would silently disable enforcement after a routine Chrome update — a gate that stops firing without anyone deciding it should.
* It is recorded on the reference at ratification (`provenance.capturedOnRenderHost`), on each comparison (`CompareResult.renderHost`), and on the calibration artifact (`measuredOnRenderHost`).

**The rule** (`enforceability.ts`), decided from facts a completing agent does not control:

| situation                                                                              | outcome                                                                                         |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| reference records no host (upload, Figma export, or ratified before the field existed) | **report-only** — `reference-host-unknown`                                                      |
| reference's host ≠ the calibration's host                                              | **report-only** — `uncalibrated-host`                                                           |
| calibration records no host at all                                                     | **report-only everywhere** — an artifact that cannot say where it was measured enforces nowhere |
| reference host = calibration host                                                      | **enforceable**                                                                                 |

This also gives "enforcement applies to newly ratified design work only" for free, from a measured property rather than a date comparison: references ratified before this landed carry no host and are never refused.

**Evidence cannot buy an exemption by staying silent.** For a reference that *does* record a host, evidence whose host is missing or different fails as `wrong-render-host` — it is insufficient evidence, not an exemption. If a missing host instead made the reference un-enforceable, omitting one field on a comparison would quietly downgrade every refusal to a notice.

**A non-enforcing outcome always says so in words.** "The gate could not enforce" must never render identically to "the gate passed" — a gate that quietly stops enforcing is the failure this whole mechanism exists to prevent, arriving by a different door.

## What actually gates today

Four reference classes exist: `artifact-capture`, `figma-export`, `raster-mockup`, and `derived-reference` (a gateable reference derived from an incommensurable one and approved, per D-007).

At policy `dcp-2026-08-25.1`, **only `artifact-capture` is gateable.**

| class               | eligibility                               | why                                   |
| ------------------- | ----------------------------------------- | ------------------------------------- |
| `artifact-capture`  | **gateable** — `maxDiffRatio` 0.000033816 | 12 real noise samples, measured max 0 |
| `figma-export`      | advisory-only                             | no real-surface cohort exists         |
| `raster-mockup`     | advisory-only                             | no real-surface cohort exists         |
| `derived-reference` | not in the calibration artifact           | `explainPolicy()` returns `undefined` |

This is a finding to state plainly, not an omission to apologise for: this repo can produce a real cohort of HTML renders and cannot produce one of Figma exports. A class with only synthetic corpus evidence has **no measured noise floor and does not borrow another class's** (D-021).

Class eligibility and host scope are **independent gates, and both must pass.** A gateable class on a reference ratified elsewhere is still report-only.

### Two traps when reading the policy

**1. `maxDiffRatio: 0` on an advisory-only class does NOT mean zero tolerance.** It means there is no usable threshold. Read `eligibility` first; the number is meaningless until it says `gateable`. Reading that `0` as a strict threshold inverts the meaning completely — it would say the most-uncertain classes are the most-strictly gated, when in fact they are not gated at all.

**2. `calibratedClasses()` is not "the gateable classes".** Despite the name, it returns every class present in the calibration artifact — all three, including the two advisory-only ones. The authoritative read is `explainPolicy(class).policy.eligibility`.

Read the live values rather than trusting the table above:

```ts
import { explainPolicy, CURRENT_POLICY_VERSION } from '@/lib/design-compare/policy';
explainPolicy('artifact-capture');
// { policy: { eligibility, maxDiffRatio, derivedFrom, policyVersion },
//   effectiveNoise, regressionFloor, separation, explainUngateable? }
```

`derivedFrom` is a sentence naming the exact samples the threshold came from. Quote it when a threshold is disputed; it is the audit trail.

## What a green does NOT establish

Read this section before you tell anyone the design is verified. A passing comparison says *the pixels match at the ratified environments*. It says nothing about the following, and three of these are live, measured gaps rather than theoretical caveats.

**Visual fidelity is not functional validation (D-004).** You still owe responsive, interaction, functional and accessibility validation. An LLM or a reviewer may explain likely causes — spacing, typography, colour drift — but that prose is advisory: **it cannot turn a deterministic failure into a pass**, and it cannot establish evidence on its own.

**Indistinguishable captures are a live bypass (D-020).** Six of this repo's own Storybook stories produce byte-identical captures across semantically different variants — `components-hostcheckbanner--{allowed-no-banner, already-acked, gated-shared}` share one sha256, and three `components-apikeystatus--*` variants share another. They differ only in a mocked fetch payload that has not resolved by the time the capture's settle contract is satisfied.

The consequence is not subtle: ratify a reference against surface A, implement surface B, and the comparison returns **pass at diff ratio 0**, with the engine behaving perfectly. No threshold tuning detects this, because there is nothing to threshold. The report surfaces such pairs loudly as `indistinguishablePairs`; **a non-empty list is a bypass, not a cohort defect to tidy away.** The calibration cohort therefore refuses to admit a zero-diff pair as a regression sample — a zero does not measure how small a real change can be, it measures that two captures are the same image, and admitting it would define the regression floor as 0.

**Cross-host variance is still unmeasured (D-021).** Nothing here measured it; D-023 only stops it being *enforced* across. A green says the pixels match on the machine that ratified the reference. The report-only CI run remains the instrument that would measure cross-host noise, and until it does, enforcement stays scoped to one host rather than widened on an assumption.

## Running a comparison yourself

```bash
npm run design:evidence-report      # measure + write design-evidence-report/report.json
npm run design:evidence-calibrate   # re-derive policy-calibration.json
```

Both wrap `packages/operator-core/lib/design-compare/report-cli.ts`:

| flag                  | default                          | notes                                                                                                                      |
| --------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--mode=`             | `report`                         | `report` or `calibrate`                                                                                                    |
| `--storybook-static=` | `apps/operator/storybook-static` | a missing `index.json` is reported, not fatal — the fixture-corpus leg still runs and the real-surface leg is simply empty |
| `--out=`              | `design-evidence-report`         | where `report.json` is written                                                                                             |
| `--work=`             | *(a temp dir)*                   | keeps captures and diff PNGs; the temp dir is deleted on exit, `--work` is not                                             |
| `--policy-version=`   | `dcp-unversioned`                | `calibrate` only                                                                                                           |
| `--artifact=`         | `policy-calibration.json`        | `calibrate` only                                                                                                           |

**Pass `--work=` when a result surprises you.** It is the only way to tell a real render from a blank page that reproduces perfectly — and given D-020, "reproduces perfectly" is exactly the result that most deserves a look. `npm run design:evidence-report` already passes `--work=design-evidence-report/captures`.

> ⚠ **`design-evidence-report/` is gitignored (`.gitignore:321`) and must stay that way.** The run writes megabytes of PNGs into the repo root. git-sync sweeps the whole tree on a short cadence — shorter than one build-and-test cycle — and `.gitignore` does not apply to files that are already tracked. If you add a tool that writes bulk output into the tree, ship its ignore entry in the *same* edit, before the first run.

## CI wiring

One step in `.github/workflows/test.yml`, deliberately placed **after** every `npm run lostpixel` step, with three properties that `ci-wiring.test.ts` pins:

* `if: always()` — it still runs when a Lost Pixel comparison has already failed the job. It does not rescue that failure; the job's conclusion remains the Lost Pixel step's.
* `continue-on-error: true` — a fault in this instrument can never turn a green build red. Report-only means report-only, including when the reporter itself breaks.
* The report's own exit code stays honest (non-zero on harness failure) and surfaces as a step annotation rather than being swallowed inside the script.

Existing build-to-build visual regression is untouched and still gates. That is the point of the placement.

CI is also, by construction, a **different rendering host** from the one that ratifies references locally, so a CI-produced comparison is report-only under D-023 even with the enforcing flag on. That is the intended shape: CI measures, the ratifying host enforces.

### Artifact retention

`design-evidence-report/` is uploaded as an artifact with **`retention-days: 14`**, stated explicitly rather than inherited — an unstated retention is the repo default silently applied, which is a policy nobody chose and nobody can see. 14 days outlasts a PR review cycle without accumulating captures indefinitely. `if-no-files-found: warn`, because an absent report is a condition worth seeing, not a build failure.

## Revising the policy

Thresholds are **derived from measurement, never hand-edited.**

1. Run `npm run design:evidence-calibrate -- --policy-version=dcp-<date>.<n>`.
2. Read the printed per-class summary: `noise n=… max=…`, `regression n=… min=…`, runtime percentiles, and any `⚠ INDISTINGUISHABLE pair(s)`.
3. Commit the regenerated `policy-calibration.json`. `CURRENT_POLICY_VERSION` follows the artifact.

The derivation refuses to produce a gateable threshold it cannot justify — that refusal is the feature. Three rules it enforces:

* **Noise comes only from the real-surface cohort.** The synthetic corpus measures a *fidelity* difference between a reference and an implementation. That is a different quantity that happens to share units, and pooling the two is not a rounding error: it once produced a floor roughly 2600x too high, exceeded the smallest real regression, and silently demoted the one genuinely gateable class to advisory-only — with every number well-formed and nothing failing loudly.
* **The one-pixel precision floor is scoped to the noise samples.** Taken from the cohort at large, a 320x240 corpus would set the precision floor for 1280x800 real captures, inflating it \~13x for a reason unconnected to the measurement it bounds.
* **The render host is recorded from the captures, not assumed.** `measureCalibration` stamps `measuredOnRenderHost` only when every capture in the noise leg agreed about which machine it ran on. Zero or several distinct hosts both mean the artifact cannot name the domain its numbers describe, and the absence is read as "enforce nowhere".

**Recalibrating on a new machine moves the enforcement scope with it.** The new artifact names that machine, so references ratified on the *old* one become report-only. That is correct — their threshold is gone — but it is a consequence worth knowing before you recalibrate somewhere unfamiliar.

Old policy versions stay readable: evidence records which version judged them, and a stale-policy record is surfaced rather than silently re-accepted (`UnknownPolicyVersionError`).

## Failure recovery

| symptom                                         | what it means                                                             | move                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gate says `unavailable`                         | The obligation could not be *established* — store or evidence read failed | Fix the infrastructure. Do **not** treat it as a pass; it is deliberately distinct from "unsatisfied" so an unavailable store can never become a silent pass. It fails open, so completion still proceeds — the report says it could not establish the obligation. |
| A case reports `wrong-render-host`              | The evidence passed, on a machine the threshold was never measured for    | Re-capture on the host the reference was ratified on. Do not "fix" the implementation; nothing said it was wrong.                                                                                                                                                  |
| The gate reports a failure but does not refuse  | The reference is outside the measured host scope (D-023)                  | Read the `NOT ENFORCED (...)` line, which names which of the three conditions failed. This is the designed outcome, not a malfunction.                                                                                                                             |
| `engine-unavailable`                            | Host published no verbs (D-017)                                           | Not a code fault in your feature. Check host install.                                                                                                                                                                                                              |
| CI step failed                                  | Harness failure, not a verdict                                            | `continue-on-error` means the build is unaffected. Read the annotation; the report distinguishes a harness failure from a comparison verdict.                                                                                                                      |
| Storybook index missing                         | Real-surface leg empty                                                    | Build Storybook first, or accept a corpus-only run — it is reported, not fatal.                                                                                                                                                                                    |
| A comparison passes but the UI is visibly wrong | Suspect D-020                                                             | Re-run with `--work=` and diff the captures by hand. Identical sha256 across different surfaces is the tell.                                                                                                                                                       |

## Reviewer responsibilities

* **Ratify deliberately.** Ratification creates a binding obligation on everyone implementing that surface. One image, one environment.
* **Ratify on the machine that will implement**, or expect report-only. The ratifying host is what the threshold is measured against (D-023).
* **Read `eligibility` before any threshold number.** See the two traps above.
* **Treat a non-empty `indistinguishablePairs` as a bypass**, and go look at the captures.
* **Never let advisory prose close a deterministic failure** (D-004). If the design changed, retract the reference — that is the sanctioned exit, and it is recorded.
* **Do not read a green as "the design is done."** It means the pixels match at the ratified environments, same-host, assuming the captures are distinguishable.

## The disable path

Turning the contract off is **one flag, non-destructive, and tested.**

| flag                                       | default | effect                                                                                                                                    |
| ------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `papercusp-design-evidence-gate`           | **ON**  | Measures and reports on terminal completion. Fail-open when reporting.                                                                    |
| `papercusp-design-evidence-gate-enforcing` | **ON**  | Turns the report into a refusal, for references within the measured host scope (D-023). Graduated from its `cutover` dark entry by P-011. |

Set `papercusp-design-evidence-gate` to OFF and **completion becomes byte-identical to today** — the gate is never consulted at all. Nothing is deleted: ratified references, evidence records and calibration artifacts all remain, and flipping the flag back on resumes reporting against the same data.

To stop refusals while keeping the measurement, turn OFF `papercusp-design-evidence-gate-enforcing` alone. Reporting continues unchanged, and no evidence is discarded.

This is pinned by a test that asserts inertness rather than merely asserting a return value — `design-evidence-gate.test.ts`, *"is inert when the gate flag is off"*, injects an evaluator that **throws if it is called at all**:

```ts
const outcome = await designEvidenceCompletionGate(['f'], {
  evaluate: async () => { throw new Error('the gate was consulted while disabled'); },
  isEnabled: off,
  isEnforcing: off,
});
expect(outcome.status).toBe('not-applicable');
```

A test that only checked the status would still pass if the gate ran the whole evaluation and discarded the answer. Throwing is what makes "never consulted" the thing actually under test.

Both flags fail **open**, by design: a flag-service blip must not block completions. Failing closed on the enforcing flag would be a far worse outcome than a missed report during an outage.

> Turning off the *reporting* flag also turns off the instrument that D-021 says must measure cross-host noise before enforcement can be widened beyond one host. Disabling is safe; just note that it pauses that evidence.

## Where the code lives

All under `packages/operator-core/lib/design-compare/`:

| file                                                             | role                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `contract.ts`                                                    | Versioned result shape, reference classes, invalid reasons             |
| `verbs.ts`                                                       | The three design-phase verbs and their refusal vocabulary              |
| `ratification.ts`, `reference-store.ts`, `reference-store-pg.ts` | Reference lifecycle and persistence                                    |
| `capture.ts`, `capture-playwright.ts`                            | Implementation capture at a contracted environment                     |
| `render-host.ts`                                                 | The rendering-host fingerprint — what makes "same machine" expressible |
| `enforceability.ts`                                              | Whether a verdict may refuse, as opposed to report (D-023)             |
| `provider.ts`                                                    | The engine seam — the only sanctioned path to an engine (D-012)        |
| `policy.ts`, `policy-shape.ts`, `policy-calibration.json`        | Threshold derivation and the calibration artifact                      |
| `gate.ts`, `feature-gate.ts`                                     | One reference; then composed across a feature                          |
| `report.ts`, `report-cli.ts`                                     | The report-only measurement and its CLI                                |

The completion integration is `packages/operator-core/lib/agent-tools/work_items/design-evidence-gate.ts`.

Papercusp owns reference resolution, capture orchestration, precondition validation, schema translation, persistence and gating. It does **not** implement pixel mathematics, computer vision, segmentation, clustering or semantic image diagnosis (D-002) — that is the engine's job, and keeping the line there is what makes the verdict auditable.
