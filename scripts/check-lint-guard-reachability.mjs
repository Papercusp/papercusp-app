#!/usr/bin/env node
/**
 * check-lint-guard-reachability.mjs — the META-guard: fails when a declared `lint:*`
 * script is reachable from NO blocking path (EI-19452618085391226).
 *
 * WHY THIS EXISTS. WI-6683 ruled that "a guard on no blocking path is not a guard."
 * The stronger, measured form of that rule is what makes this a gate rather than a
 * tidiness note:
 *
 *   An unwired guard does not merely fail to catch things. It ROTS — silently
 *   accruing false positives and baseline drift — so it fails CLOSED on innocent
 *   files the moment someone finally wires it up.
 *
 * Two instances were measured on 2026-08-03, both silently red, neither noticed:
 *   • `lint:no-sql-comment-backtick` — 7 hits, 7 FALSE POSITIVES, 0 true positives.
 *     Wiring it unchanged would have quarantined a file containing no SQL at all.
 *   • `lint:mock-cast-escape` — a RATCHET that had drifted +45 over its baseline,
 *     i.e. 45 new type-escapes landed past a guard built specifically to ratchet
 *     them down, in ~27h. Nobody saw it because nothing ran it.
 *
 * The natural remediation for an unwired guard ("just wire it up") is therefore the
 * dangerous one: it lands a RED gate on the whole fleet, caused by defects that
 * accrued invisibly while it ran nowhere. This check makes the rot detectable at the
 * moment a guard becomes unreachable, instead of at the moment someone needs it.
 *
 * ── WHAT COUNTS AS REACHABLE ─────────────────────────────────────────────────
 * Every root set below is DERIVED BY SCANNING, never hand-listed, so a guard that is
 * added, renamed, or dropped from a runner re-classifies itself with no edit here.
 * That is the same anti-drift property `enforcement-tier-census.ts` relies on: the
 * population comes from the scan, so nothing vanishes by being forgotten.
 *
 *   gate      — run by the green-checkpoint release gate  → BLOCKING
 *   ci        — run by a .github/workflows/* job          → BLOCKING
 *   test      — EXECUTED over the real tree by a *.test.ts (which the gate's own
 *               affected-suite leg runs)                  → BLOCKING
 *   chained   — run via `npm run <it>` by another script that is itself reachable
 *                                                         → inherits that tier
 *   hook      — invoked only from a Claude PreToolUse/PostToolUse hook → ADVISORY.
 *               Deliberately NOT blocking: a hook nudges the one agent who tripped
 *               it and blocks nothing, so a hook-only guard still rots.
 *   logic-test— a *.test.ts imports its PURE HELPERS and feeds them fixtures, but
 *               never runs the guard over the tree → ADVISORY, see below.
 *   (none)    — UNREACHABLE. The defect this script exists to catch.
 *
 * ── WHY `logic-test` IS NOT ENFORCEMENT (the subtle case, measured) ───────────
 * A unit test of a guard's helpers proves the DETECTOR works. It does not run the
 * detector over anything, so it catches no violation and blocks no commit — while
 * making the guard look thoroughly covered, which is worse than no test at all.
 *
 * `lint:mock-cast-escape` is the proof: `check-mock-cast-escape.test.ts` imports
 * `decide` / `findMockCastEscapesInText` (and, until the 2026-08-10 AST rewrite,
 * `maskStringsAndComments`) and asserts against string literals. Every one of those
 * tests passed, continuously, across the entire window in which the guard's real-tree
 * count drifted +45 past its baseline — and across a later window in which the
 * detector was silently blind to 13 real escapes (EI-20059456952698638).
 * A green logic test and a rotting guard are perfectly compatible states.
 *
 * The discriminator is therefore whether the test EXECUTES the guard against real
 * repository files (`ENFORCING_TEST_RE`) — spawning it, or driving its scan over a
 * repo-root path — not merely whether a test mentions it.
 *
 * ── KNOWN LIMITATION: the `ci` tier is credited GENEROUSLY ───────────────────
 * `ci` counts as blocking here, and on this box that is arguably too kind.
 * `green-checkpoint.ts`'s own `lint:no-control-bytes` comment records the precedent:
 * that guard "was already wired into .github/workflows/test.yml, but that workflow
 * does not gate this box's main-advance, and it had been failing for other reasons,
 * so the guard's own three-day red went unread" — i.e. a CI-tier guard rotted exactly
 * like an unwired one, and the fix was to gate it in green-checkpoint instead.
 *
 * It is left as blocking DELIBERATELY, not by oversight. Demoting it would move ~38
 * guards into the unenforced set in one step, and an allowlist that large is the
 * parking lot this script exists to prevent — the same shape as raising a watermark
 * to absorb debt rather than paying it. Tightening it is real work with a real
 * measurement behind it (does THIS box's main-advance consult CI?), so it is tracked
 * separately rather than smuggled in here. Read a `ci` classification as "a red would
 * be visible somewhere", not as "a red stops the release."
 *
 * ── KNOWN LIMITATION: this census models ENFORCEMENT EXISTENCE, never TIMING ──
 * `classifyGuard` asks only WHICH CORPUS mentions a guard, and returns the strongest
 * tier in BLOCKING_TIERS. That answers "would a red ever be SEEN?" It does NOT answer
 * "would the red arrive before the damage?" — the census has no notion of when a guard
 * fires, and none of who CONSUMES the artifact it guards. Those are different questions,
 * and a guard can score `gate` here while being structurally incapable of protecting a
 * given consumer.
 *
 * The case that proves it (raised by su-b9269, 2026-08-03, and demonstrated the same day):
 * `apps/operator/bin/bundle-host.sh` esbuild-bundles operator-core as `ExecStartPre` for
 * `papercup-staging-api` / `papercup-bg-host` — i.e. those consumers read the WORKING
 * TREE, before any commit exists. So every commit-time-or-later guard is unreachable for
 * them BY CONSTRUCTION, however well wired. On 2026-08-03 a saved-but-uncommitted backtick
 * inside a `sql` template literal (watchdog.ts:1836) crash-looped :3170 fleet-wide for 17
 * minutes while every relevant guard was, by this script's measure, fully enforced.
 *
 * So: "enforced" is NOT "prevents". Read a BLOCKING classification as "a red would stop
 * something downstream", never as "this artifact's consumers are protected."
 *
 * Deliberately NOT modelled rather than modelled badly: doing it properly needs a map from
 * each guarded artifact to its consumers and the stage at which each reads it (working tree
 * / commit / candidate / release). A hand-maintained `timing:` label per guard would rot
 * exactly the way this script's derive-from-the-runners design exists to prevent. Tracked
 * separately — see EI-19457231269012320 (edit-time parse check, the only tier that can
 * protect a working-tree consumer) and EI-19457273276133433.
 *
 * ── THE UNDER-CLAIM THIS AVOIDS ──────────────────────────────────────────────
 * The filing that prompted this deliberately under-claimed its own headline number:
 * "not referenced by npm-script NAME" is NOT the same as "runs nowhere", because
 * several guards are invoked by direct script PATH rather than by npm name (e.g.
 * `check-migration-fixture-drift.mjs` runs from a PostToolUse hook). So this script
 * resolves each guard to its IMPLEMENTATION FILE and searches for that path too —
 * never for the npm name alone. Erring toward "reachable" is deliberate: a false
 * UNREACHABLE would send someone to wire a guard that is already enforced, which is
 * exactly the wasteful direction.
 *
 * Usage:
 *   node scripts/check-lint-guard-reachability.mjs            # gate
 *   node scripts/check-lint-guard-reachability.mjs --json     # machine-readable census
 *   node scripts/check-lint-guard-reachability.mjs --census   # human table, always exit 0
 *
 * Exit codes:
 *   0 — every declared guard is reachable, or allow-listed with a reason
 *   1 — an unreachable guard is not allow-listed, or an allowlist entry is STALE
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listTrackedFiles } from './lib/tracked-files.mjs';
import {
  assessGraphHealth,
  buildImportGraph,
  buildShipmentDispositionInventory,
  findUnreachableModules,
  findUnclassifiedShipmentModules,
  NEW_MODULE_GRACE_DAYS,
  partitionByGracePeriod,
  GRACE_CLOCK_WINDOW,
  resolveGraceClock,
  detectEntrypointMarkers,
  findInaccurateAcknowledgements,
  selectDetectorModules,
  selfExclusionPaths,
} from './lib/module-reachability.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Guards whose unreachability is ACKNOWLEDGED, each with the decision that makes it
 * acceptable for now. This is an allowlist of *pending decisions*, not a parking lot:
 * every entry states what has to happen and which work-item owns it.
 *
 * ⚠ SHRINK-ONLY. `UNREACHABLE_HIGH_WATERMARK` below fails the build if this set grows.
 * The correct way to add a guard is to WIRE it (or retire it), not to append here —
 * the same rule `KNOWN_DARK_FLAGS` carries, for the same reason: an allowlist that
 * grows freely reproduces exactly the invisible rot this script exists to detect.
 */
export const ACKNOWLEDGED_UNREACHABLE = new Map([
  // ── Seeded 2026-08-03 from the first census run (EI-19452618085391226). ──────
  // Every entry below was ALREADY unenforced before this check existed. The seed
  // pins the debt at its MEASURED size so it can only shrink, and blesses none of
  // it: the point of seeding rather than failing outright is that wiring 13 rotted
  // guards at once is precisely the fleet-reddening move this script warns against.
  // What the check buys immediately is the ratchet — a NEW unenforced guard fails
  // the build on the commit that orphans it.

  // `lint:mock-cast-escape` USED TO SIT HERE and is now GONE from this set — burned down
  // 1121 → 1061 (under its 1076 baseline) and wired as a green-checkpoint leg on 2026-08-03.
  // Left as a comment rather than silently deleted because it is this set's first GRADUATION,
  // and the graduation is the point: entries here are debts to pay, not a parking lot.
  // The watermark dropped 15 → 14 with it, which is the only direction it may ever move.

  // MEASURED GREEN 2026-08-03, but enforced by nothing. Each needs a deliberate
  // wire-or-retire call (EI-19452618085391226 correct-state #2). Listed individually
  // rather than as a pattern so that retiring one is a visible one-line deletion.
  ['lint:constant-conditional', 'green (9342 files parsed); pending wire-or-retire decision'],
  ['lint:no-workspace-default', 'green; pending wire-or-retire decision'],
  ['lint:scope-defaults', 'advisory by design, but its :strict sibling exits 1; pending decision'],
  ['lint:knip', 'unused-export sweep; run by nothing — pending wire-or-retire decision'],
  // `lint:no-retired` USED TO SIT HERE — "DOC-ASSERTED but unenforced". It is now
  // WIRED (REPO_WIDE_INVARIANT_GUARDS in scripts/affected-tests.mjs, appliesTo the
  // TS/JS family it scans), so CLAUDE.md's long-standing claim that it guards
  // retired-surface re-imports is finally TRUE rather than aspirational.
  // EI-19971915610840229. Shrink-only ✓ — an entry left, none arrived.

  // Coverage is a UNIT TEST of the detector's helpers only — the guard itself runs
  // over nothing. Remedy is to deepen the existing test into a real-tree assertion,
  // which is cheaper than wiring a gate leg; that is why these are grouped apart.
  ['lint:as-committed', 'logic-test only; deepen to a real-tree assertion'],
  // `lint:explicit-presence` USED TO SIT HERE and is now GONE from this set — the FOURTH
  // graduation, and the first from the "logic-test only" group. It was NOT fixed the way this
  // row prescribed: deepening its test into a real-tree assertion would have made the guard
  // *reachable* while still leaving it advisory, and its own item (WI-5977) is precisely about
  // conventions that decay into advice. So it was WIRED instead — REPO_WIDE_INVARIANT_GUARDS in
  // scripts/affected-tests.mjs, keyed on the analyzer's own SCAN_ROOTS — gating on a count
  // ratchet (.explicit-presence-baseline.json, 55 at wiring time) rather than on `--strict`,
  // which cannot be green today. Left as a comment rather than silently deleted, like the three
  // graduations above: entries here are debts to pay, not a parking lot. Measured after the
  // wiring: the acknowledged set went 11 → 10 and the gate stayed exit 0 (102/112 enforced),
  // so the watermark drops 14 → 13 with it — the only direction it may ever move.
  ['lint:generic-independence', 'logic-test only; deepen to a real-tree assertion'],
  ['lint:no-raw-spawn', 'logic-test only; deepen to a real-tree assertion'],
  ['lint:no-retired-style', 'logic-test only; deepen to a real-tree assertion'],
  // `lint:no-unenrolled-mjs-imports` USED TO SIT HERE and is now GONE from this set — WI-7025
  // graduated it by registering the existing real-tree ratchet in affected-tests.mjs, so a
  // TS importer outside operator-core gets a local blocking signal instead of waiting for the
  // later fleet typecheck.
  ['lint:optional-seam-strands', 'logic-test only; deepen to a real-tree assertion'],
  ['lint:typeless-reexport', 'logic-test only; deepen to a real-tree assertion'],
  ['lint:vitest-mock-paths', 'logic-test only; deepen to a real-tree assertion'],

  // ── Seeded 2026-08-12 when the census was WIDENED to the `gen:*:check` family. ──
  // These 8 are not new debt. They are debt that was always there and structurally
  // invisible, because `selectGuardScripts` scanned `lint:*` only (see GEN_CHECK_RE).
  // Seeded at their MEASURED size for exactly the reason the 2026-08-03 block above
  // was: wiring 8 rotted guards in one commit is the fleet-reddening move this
  // script's own header warns against. The ratchet is what this buys immediately —
  // a NEWLY orphaned gen:*:check now fails the build on the commit that orphans it.
  // `gen:authored-docs:check` USED TO SIT HERE and is now GONE from this set — the SECOND
  // graduation, and the first from the gen:* family this census only started seeing hours
  // earlier. It is now REGISTERED in REPO_WIDE_INVARIANT_GUARDS (scripts/affected-tests.mjs),
  // keyed on apps/operator-docs/src/content/docs/** + the projector, so a hand-edit to a
  // projected doc attaches it to that very change. Two enabling fixes made registration honest
  // rather than theatre: project-authored-docs.ts now SKIPS cleanly with no DB (so it does not
  // fail every CI run), and operator-core declares the script the registration names.
  // Left as a comment rather than silently deleted, exactly like the graduation above: entries
  // here are debts to pay, not a parking lot. Watermark 22 → 21 with it — the only direction
  // it may move once a population widening has been paid for.
  // `gen:claude-md-manifest:check` USED TO SIT HERE and is now RETIRED — the THIRD graduation,
  // and the first by RETIREMENT rather than wiring. Measured before deciding, which is the whole
  // point of the wire-or-retire discipline: run against the real tree it exits 1, and it always
  // will. Its default source is the repo-root CLAUDE.md, which THIS plan
  // (claude-md-projection-from-pg-2026-08-10) turned into projector output, and a peer then
  // DELIBERATELY taught the generator to refuse a generated source (EI-20202197798077317) so it
  // could not silently emit a 130-part manifest with every corpus-only prose part dropped. That
  // refusal is correct and permanent, so wiring this onto a blocking path would red-pin the fleet
  // on a peer's intended behaviour — exactly the failure this script's header warns about when
  // an unwired guard is ported unchanged. Its job was also FINISHED: it is the P-014 bootstrap
  // that fed the one-time P-003 load into harness_shared.harness_doc_parts, and that load has run.
  // Retired = its npm declaration is gone (package.json), so it leaves the census population.
  // The MODULE stays and is load-bearing — `extractParts` / `projectionSourceProblem` are imported
  // by load-claude-md-doc-parts.mjs, split-claude-md-rule-evidence.mjs and three suites; only the
  // `:check` CLI alias retires. Watermark 21 → 20 with it.
  // WIRED 2026-08-12 (WI-38239), watermark 20 → 18: gen:compaction:check and
  // gen:knowledge-packs:check are both registered in REPO_WIDE_INVARIANT_GUARDS
  // (scripts/affected-tests.mjs) with narrow appliesTo sets and NO hostSuiteRatchet —
  // see the rationale on each entry. Paying this set down means REGISTERING a guard,
  // never re-parking it here.
  // RETIRED 2026-08-12 (WI-38239), watermark 18 → 17: `gen:doc-projections:check` was a pure
  // CONVENIENCE UMBRELLA over five per-page projectors, and every one of those five is already
  // DECLARED and ENFORCED individually, at exactly the tier the umbrella claims for it
  // (.github/workflows/test.yml:194-211 — blueprint-catalog + role-registry gating, and
  // insights-index + tool-catalog + plans-index under `continue-on-error: true`). So it added
  // zero coverage, while wiring it would have run all five on every matching change, including
  // the heavy full-registry tool-catalog import that is CI-informational precisely because it is
  // fleet-fragile (it once hung the umbrella outright — see the agent-tools-registry-import-
  // never-exits insight, which is why the umbrella grew its per-child SIGKILL timeout).
  // ⚠ It was NOT retired for being toothless — a note from an earlier wake of mine claimed it
  // "exits 0 while printing drift", and that is only true of the ADVISORY three. A gating child
  // that drifts DOES set `gatingFailure` and exit 1 (gen-doc-projections.ts:53-62). Registering
  // it would have been redundant, not theatre; the honest reason to retire is duplication + cost.
  // Retired = the npm declaration is gone (package.json), so it leaves the census population.
  // The SCRIPT stays: `gen:doc-projections` (the writer) is the local one-shot regenerate, and
  // its `--check` code path is still reachable as `npx tsx scripts/gen-doc-projections.ts --check`
  // for a local pre-push sweep — it is simply no longer a DECLARED guard nothing runs.
  // RETIRED 2026-08-12 (WI-38239), watermark 17 → 16: `gen:openapi:check` asserted a drift
  // invariant over an artifact that IS NOT IN THE REPO. `.papercusp/openapi.json` is GITIGNORED
  // (.gitignore:101) and untracked, and the generator's own header states the stance deliberately
  // ("ON-DEMAND, NOT committed or CI-gated"). Its --check treats a MISSING file as stale and exits
  // 1 (gen-openapi-spec.ts:129-139), so putting it on any blocking path would red-pin every fresh
  // checkout — the artifact does not exist there until someone runs the writer. That is not
  // enforcement debt a successor can pay down; there is no repo-level invariant to guard.
  // Nothing is lost: the generator's OWN documented check form is `npm run gen:openapi -- --check`,
  // which appends the flag to the surviving writer alias and never used this one.
  //
  // ⚠ `gen:tool-catalog:check` LOOKED like the same case and WAS THE MIRROR IMAGE — it is now
  // WIRED (REPO_WIDE_INVARIANT_GUARDS in affected-tests.mjs), not acknowledged. The SAME one
  // probe decided both, in opposite directions: openapi's artifact is gitignored (no repo-level
  // invariant exists, so retire), tool-catalog's is TRACKED (a real invariant exists, so wire).
  // Note gen-openapi-spec.ts's header justified its stance as "same stance + reasons as
  // gen-tool-catalog.ts", whose header in turn claimed its artifact was "NOT committed" — false
  // against the tree. Two headers agreeing is not corroboration when one cites the other; both
  // are corrected in place. The cost objection that held tool-catalog back also did not survive
  // measurement: ~10s, DB-less, idempotent.
]);

/**
 * Ceiling on the acknowledged set. SHRINK-ONLY: wire or retire a guard instead of
 * appending. Raising it needs owner sign-off and a stated reason, exactly like
 * `DARK_FLAGS_HIGH_WATERMARK` — and for the same reason, since an allowlist that
 * grows freely reproduces the invisible rot this script exists to detect.
 *
 * ── 14 → 22 on 2026-08-12. STATED REASON: the POPULATION grew, not the debt. ──
 * [owner 2026-08-12] directed an audit of plan claude-md-projection-from-pg-2026-08-10
 * ("compare every plan item to the code... fix any gaps"), which found that this census
 * scanned `lint:*` only and had never seen the `gen:*:check` family at all. Widening it
 * (GEN_CHECK_RE) made 8 already-orphaned guards VISIBLE in one step; not one of them was
 * orphaned by this commit, and the `lint:*` portion of the set is UNCHANGED at 14.
 *
 * This is the one move that legitimately raises a shrink-only ceiling: measuring more of
 * the world. It is NOT a licence to append — every rule above still holds, the set is
 * still shrink-only from this new baseline, and a guard orphaned from here on fails the
 * build rather than landing here. Raising it again to park a newly-rotted guard would be
 * precisely the abuse the sibling `KNOWN_DARK_FLAGS` rule exists to stop.
 *
 * ── 22 → 15, paid down one guard at a time on 2026-08-12/13, all under WI-38239. ──
 * Each step REGISTERED or RETIRED a guard and moved the ceiling DOWN with it; the set was
 * never appended to. 22→21 gen:authored-docs:check (wired), 21→20 gen:claude-md-manifest:check
 * (retired — CLAUDE.md is projector output and its generator deliberately refuses a generated
 * source), 20→18 gen:compaction:check + gen:knowledge-packs:check (wired), 18→16
 * gen:doc-projections:check + gen:openapi:check (retired — an umbrella whose five children are
 * each already CI-enforced, and a guard over a gitignored artifact), 16→15
 * gen:tool-catalog:check (wired), 15 → 14 gen:fleet-lessons:check (wired) — which CLOSES the
 * whole eight-guard cohort the widening exposed.
 *
 * The last one is the case worth remembering: it was not blocked by cost but by a DEFECT the
 * probe surfaced. Its remedy command would have stripped OKF v0.2 frontmatter from the committed
 * pack and turned `lint:okf-conformance` red — a red guard prescribing a fix that breaks a green
 * one. Wiring it required fixing the exporter first (gen-fleet-lessons.ts now applies the OKF
 * addition on export). So "wire or retire" has a THIRD outcome: REPAIR, then wire. A guard whose
 * prescribed remedy damages the tree must never be wired as-is — that arms a trap for whoever
 * hits the red and does what it says.
 *
 * ONE PROBE decided wire-vs-retire in every one of those cases and it is the first thing to
 * run on the next candidate: `git ls-files <artifact>` + `git check-ignore -v <artifact>`.
 * An IGNORED artifact has no repo-level invariant at all — `--check` treats a missing file as
 * stale, so wiring it red-pins every fresh checkout. A TRACKED artifact has a real invariant
 * however heavy its generator, and the only remaining objection is COST — which is measurable,
 * and is never by itself a reason to retire. Do not substitute a generator's header comment
 * for that probe: three of them were measured wrong here, mutually citing each other.
 */
export const UNREACHABLE_HIGH_WATERMARK = 12;

/**
 * Guards that CANNOT be gated, by design — a DIFFERENT population from the debt above,
 * governed differently (WI-39832).
 *
 * The set above is a parking lot with a shrink-only ceiling: every entry is a guard that
 * SHOULD be wired and is not yet. An entry here is the opposite — wiring it is the
 * MISTAKE, and the ceiling must never be spent on one. Rationing these against the debt
 * budget would mean a correctly-diagnosed permanent exclusion crowds out a real debt slot,
 * and the next agent "graduates" it by wiring it, which is exactly the damage the entry
 * exists to prevent. This mirrors how `KNOWN_DARK_FLAGS` splits by `DarkCase`: the
 * parking subset carries the watermark, owner-authority/cutover flags are governed only
 * by re-review.
 *
 * The bar for an entry is high — a guard is only ungateable if RUNNING it in the gate
 * environment is unsound, not merely slow or noisy. Cost is never a reason (see the
 * wire-or-retire probe above); "it fails in the checkpoint tree" is.
 */
export const ACKNOWLEDGED_UNGATEABLE = new Map([
  // Surfaced 2026-08-18 when the `test` tier stopped taking bare name mentions as
  // execution evidence (WI-39832). This guard was reported ENFORCED for ~2 weeks on the
  // strength of green-checkpoint.test.ts's `expect(scripts).not.toContain("lint:cell-matrix")`
  // — an assertion that exists precisely to keep it OUT of the gate. The census was
  // reading a padlock as a running engine.
  //
  // ⛔ DO NOT WIRE THIS. It drives reads against RUNNING operators on :3170 and :3070,
  // which the isolated checkpoint tree does not have; every read would fail and red-pin
  // `main` for the whole fleet. green-checkpoint.test.ts pins it shut on purpose, and
  // that test is the enforcement of this entry.
  ['lint:cell-matrix', 'needs live operators on :3170/:3070; green-checkpoint.test.ts pins it OUT of the gate by design'],

  // Surfaced 2026-09-05 as a gate red (WI-212675). The behavioural-strands detector is
  // an EDIT-TIME instrument by design: it AST-diffs the working tree against the
  // pre-edit commit to find a new call to an injected collaborator, and only the
  // PostToolUse hook that fires at the edit ever holds that diff. In the checkpoint tree
  // the candidate is a committed sha and `--base HEAD` is an EMPTY diff — measured in
  // gate mode 2026-09-05: exit 2 "NOT CHECKED", the script's own verdict that it saw
  // nothing, which is not a clean bill and must never be quoted as one. Wiring it would
  // add a leg that structurally cannot fire (or, with `--base <last-green main>`, one
  // that ranks the whole ~1,500-commit sweep). `:run` is the same script with `--run`.
  ['lint:behavioural-strands', 'edit-time diff instrument by design; in the checkpoint tree `--base HEAD` is an empty diff and it exits 2 NOT CHECKED — only the PostToolUse hook holds the pre-edit base'],
  ['lint:behavioural-strands:run', 'same script as lint:behavioural-strands with --run; edit-time by design, an empty diff in the checkpoint tree'],

  // Surfaced 2026-09-05 as a gate red (WI-212675). The base guard `lint:lockfile-census`
  // IS wired repo-wide (scripts/affected-tests.mjs); `:sbom` is its syft-emitting
  // sibling, which `emitSbom` makes REFUSE LOUDLY when the syft binary is absent —
  // deliberately, so a missing inventory can never read as a clean one. syft is a
  // dev-box tool, not a pipeline dependency, so in the checkpoint tree that refusal is
  // the guaranteed outcome: wiring it would red-pin every host without syft on the
  // absence of a tool, not on a defect. The census half it shares is already enforced.
  ['lint:lockfile-census:sbom', 'syft emission; refuses by design when the dev-box syft binary is absent, which the checkpoint tree guarantees — its census half (lint:lockfile-census) is wired'],
]);

/**
 * Guards that ARE enforced, but only over PART of what they scan (EI-19461064447747454).
 *
 * Seeded 2026-08-03 at its MEASURED size, for the same reason the unreachable set was:
 * both entries below were already partially covered before this axis existed, and the
 * remedy — registering a guard in `REPO_WIDE_INVARIANT_GUARDS` — makes it run on every
 * matching changed path, which is a real (if small) cost added to every affected-test
 * run. Failing outright on day one would red-pin the fleet on debt that accrued
 * invisibly, which is precisely the move this script's header warns against.
 *
 * ⚠ SHRINK-ONLY, like its sibling above. A NEW partially-covered guard fails the build
 * on the commit that creates it; paying one down means REGISTERING it, not appending here.
 */
export const ACKNOWLEDGED_PARTIAL_COVERAGE = new Map([
  [
    'lint:full-replacement-mocks',
    'scans every *.test.ts in the tree; enforced only when packages/operator-core is affected',
  ],
  [
    'lint:migration-fixture-drift',
    'scans every *.integration.test.ts in the tree; enforced only when apps/operator is affected',
  ],
]);

/** Ceiling on the partial-coverage set. SHRINK-ONLY — register a guard instead of appending. */
export const PARTIAL_COVERAGE_HIGH_WATERMARK = 2;

/**
 * Tiers that actually STOP a bad change. `hook` and `logic-test` are deliberately
 * excluded — see the header: both are real coverage of a kind, and neither blocks.
 *
 * `repo-wide` = registered in REPO_WIDE_INVARIANT_GUARDS (scripts/affected-tests.mjs) AND
 * declared by the workspace it names. That pair makes affected-tests.mjs push the guard as
 * a real task (`tasks.push({ ws, script: guard.script })`) whenever a changed path matches
 * its own `appliesTo` predicate — inside `test:affected`, which green-checkpoint runs as a
 * blocking leg. So it stops a bad change exactly like the other four.
 *
 * ⚠ WHY THIS TIER HAD TO EXIST (WI-37627, the ed2c4f36 gate red). `classifyGuard` read only
 * the gate/ci/test/hook/logic-test corpora, so a guard whose ONLY wiring was a registration
 * scored `tier: null` — reported verbatim as "nothing runs it at all" while it was in fact
 * running on every matching changed path. It went unnoticed because all 11 registered guards
 * that pre-dated it ALSO carried a corpus mention (a CI job, or a *.test.ts that names them),
 * so the blind spot needed a registration-ONLY guard to become visible;
 * `lint:no-ungated-mug-kettle` was the first, and it red-pinned `main` for the whole fleet.
 *
 * Note the script was already INTERNALLY INCONSISTENT about this: `computeCoverage` credits a
 * registered guard `verdict: 'full'` (line ~440), but that branch is unreachable for a
 * registration-only guard because the same function early-returns `not-enforced` whenever
 * `!row.blocking`. One axis called registration sufficient; the other had never heard of it.
 */
/* ── THE MODULE AXIS (WI-41775, plan decisions D-013 → D-014 → D-015) ────────
 *
 * Everything above this line polices DECLARED `lint:*` SCRIPTS. It is blind to a
 * detector that was never given an npm script — a module under `lib/release/` that
 * exports a detector, ships a passing unit test, is cited by a SHIPPED plan's
 * code-truth audit, and is called by nothing. `plans:audit` cannot catch it either:
 * a `code` citation verifies that code EXISTS at a path, never that anything CALLS it.
 *
 * knip cannot catch it either, and this is the part worth remembering. knip asks "is
 * this file imported by anything?" — and a module's OWN `*.test.ts` answers yes,
 * because test files are entry points. Measured 2026-08-26: with `lib/**` removed from
 * the operator entry glob, knip surfaced 31 unused files and NEITHER of the two known
 * dead gate detectors among them. The two tools answer different questions, and only
 * this one asks "does a production path CALL it?".
 *
 * The probe lives in ./lib/module-reachability.mjs — see its header for why it needs no
 * entry-root set (a fixpoint over the population instead) and how it fails open.
 */

/**
 * Detector modules whose unreachability is ACKNOWLEDGED. Seeded 2026-08-26 from the
 * first measuring run — 21 of 81 `lib/release/**` modules, pinned at their MEASURED
 * size so the set can only shrink. GRADUATIONS SINCE SEEDING (each dropped the
 * watermark by one, which is the only way it may move):
 *   · `_tmp-fire-git-sync.ts` — deleted 2026-08-26; a committed scratch file, 21 → 20.
 *   · 2026-08-27 (WI-71582), 20 → 11: nine entries were removed after the guard
 *     reported them "STALE acknowledged-unreachable — now wired or deleted". That
 *     verdict was later PARTLY FALSIFIED: passive JSON/YAML evidence manifests had
 *     been counted as execution. Four of the nine remained genuinely dead:
 *     prompt-divergence plus the external-prerequisite contract/runner/ports roots.
 *   · 2026-08-28, 11 → 10 in the actual set: retrofit-hive-to-gate was retired, but
 *     the watermark was not lowered, leaving one slot of accidental slack.
 *   · 2026-09-07 (WI-2145418), 10 → 8: the corrected graph drove the honest
 *     wire-or-retire decision. The tautological prompt-divergence CLI and the wholly
 *     unwired external-prerequisite subsystem were retired under
 *     green-main-fast D-052 and typed-external-prerequisite-attestations D-006.
 *     Removing the subsystem's two acknowledged adapter leaves plus restoring the
 *     missed retrofit ratchet lowers the watermark by three, 11 → 8.
 *
 * ⚠ SHRINK-ONLY, same doctrine as ACKNOWLEDGED_UNREACHABLE above and for the same
 * reason: the correct way to clear an entry is to WIRE the module or DELETE it, never
 * to append here. Wiring the whole set at once would land a wall of new gate legs on
 * the fleet — which is the precise move this file exists to warn against.
 *
 * ⚠ Every entry is a debt with an owner, not a blessing. `testedButUnwired` entries are
 * the dangerous ones: they LOOK covered (green unit test, plan-audited citation) while
 * enforcing nothing, so they read as diligence in a review.
 */
export const ACKNOWLEDGED_UNREACHABLE_MODULES = new Map([
  // ── The release-publication family: same transitive shape. The CLI root
  // (record-release-cli), release-completeness and changelog-generate have since
  // been wired and graduated out; these three are what is left of the family.
  [
    'apps/operator/lib/release/finalize-release-publication.ts',
    {
      kind: 'dead',
      action: 'wire-or-delete',
      reason: '1 test; reached only from dead publication siblings',
    },
  ],
  [
    'apps/operator/lib/release/patch-artifact-provenance.ts',
    {
      kind: 'dead',
      action: 'delete',
      reason: 'no test, no caller — strongest retire candidate in the family',
    },
  ],
  [
    'apps/operator/lib/release/preflight-build-set.ts',
    {
      kind: 'dead',
      action: 'wire-or-delete',
      reason: '1 test; reached only from dead publication siblings',
    },
  ],
  [
    'apps/operator/lib/release/gate-release-site.ts',
    {
      kind: 'dead',
      action: 'wire-or-delete',
      reason: '1 test, 0 callers — wire-or-retire',
    },
  ],
  [
    'apps/operator/lib/release/seed-release-routines.ts',
    {
      kind: 'dead',
      action: 'wire-or-delete',
      reason: '1 test, 0 callers — wire-or-retire',
    },
  ],
  [
    'apps/operator/lib/release/verify-seed-payload-cli.ts',
    {
      kind: 'dead',
      action: 'wire-or-delete',
      reason: '1 test, 0 callers — wire-or-retire',
    },
  ],
  [
    'apps/operator/lib/release/rollback.ts',
    {
      kind: 'dead',
      action: 'verify-then-delete',
      reason: '3 tests, 0 callers. ⚠ NAME IS LOAD-BEARING: verify the live rollback path before retiring',
    },
  ],
  [
    'apps/operator/lib/release/preview-data-plane.ts',
    {
      kind: 'dead',
      action: 'wire-or-delete',
      reason: 'no test, no caller — wire-or-retire',
    },
  ],
]);

/**
 * ⚠ SHRINK-ONLY. Pinned to the seeded population size so a NEWLY orphaned detector
 * module fails the build on the commit that orphans it, exactly as the script axis does.
 */
export const UNREACHABLE_MODULES_HIGH_WATERMARK = 8;

export const BLOCKING_TIERS = new Set(['gate', 'ci', 'test', 'chained', 'repo-wide']);

/**
 * A test EXECUTES a guard over the real tree (rather than unit-testing its helpers)
 * when it spawns the script or drives a scan rooted at the repository. Kept
 * deliberately generous: over-crediting a test yields a missed report, while
 * under-crediting sends someone to wire an already-enforced guard — and of those two
 * wrong answers, only the second wastes a fleet-wide gate run.
 *
 * `scanTree` was added 2026-08-04 (WI-10589) after the second wrong answer happened
 * exactly as this comment predicts. A guard test that imports the guard's OWN exported
 * tree-scanner and calls it with no arguments drives a scan rooted at the repository —
 * it just never shells out, so it matched none of the process-spawn markers and none of
 * the ROOT-name markers either. Measured on lint:no-hand-rolled-module-pin: its test
 * asserts scanTree().violations is empty REPO-WIDE, yet this regex scored the file 0 and
 * the leg reported the guard as running "over nothing", which would have red-pinned the
 * fleet minutes after an 8h26m gate freeze had just cleared.
 *
 * Note the direction of the bias this preserves: delegating the walk to the guard's own
 * export is the REUSE-THE-DETECTOR pattern this repo mandates everywhere (a re-derived
 * copy drifts), so the old regex penalised precisely the tests written correctly. Prefer
 * adding the scanner name a guard actually exports over inventing speculative ones.
 *
 * `runGuardScript` was added 2026-08-17 (EI-20692923474318761) for the same reason, one
 * layer up: it is this repo's helper for spawning a guard over the real tree (it wraps
 * spawnSync so a RED carries the guard's own report instead of "Command failed: <cmd>").
 * A test that adopts it is spawning the guard — the definition of the `test` tier — but
 * the raw `spawnSync` marker now lives in the helper rather than the test. The three
 * tests converted with it did still match, and the census did not move — but only
 * INCIDENTALLY, via the `REPO_ROOT` each passes as `cwd` (a comment mentioning the old
 * call would NOT have counted: this corpus is stripComments'd first). Hoisting that cwd
 * into a helper default is an ordinary tidy-up, and without this marker it would have
 * silently demoted three blocking guards to advisory with every test still green.
 */
export const ENFORCING_TEST_RE =
  /execFileSync|spawnSync|execSync|listTrackedFiles|REPO_ROOT|repoRoot|process\.cwd\(\)|scanTree|runGuardScript/;

/**
 * Companion INVOCATIONS of a guard rather than guards in their own right: a different
 * strictness or a write mode over the SAME implementation. Counting them separately
 * double-counts the debt — enforcement is a property of the implementation, not of how
 * many npm aliases point at it — so a base guard that IS wired makes its `:strict`
 * sibling enforced too, and a base guard that is not shows up once, not twice.
 */
// `list` joined 2026-09-05: `lint:foo:list` is the MEASURING form of `lint:foo` (the
// `--list` run the SHRINK-ONLY baselines are re-seeded from — never from a hand-run
// grep), the same relation `:report`/`:census` already express. Left out, the census
// counted `lint:test-timing-budgets:list` as a second unwired guard beside its base and
// asked for a wiring that would run the measurement twice.
const COMPANION_SUFFIX_RE = /:(fix|report|census|strict|all|fail|update|check|typecheck|list)$/;

/**
 * The OTHER guard family in this repo: `gen:<artifact>:check`, the drift check for a
 * GENERATED artifact. It asserts the committed file still matches what its generator
 * would produce — the same job a `lint:*` guard does, expressed in the generator's
 * namespace rather than the linter's.
 *
 * ── WHY THIS HAD TO BE ADDED (measured 2026-08-12, plan claude-md-projection-from-pg) ──
 * The census scanned `lint:*` ONLY, so this entire family was invisible to it — including
 * `gen:authored-docs:check`, the drift gate protecting the 873-doc PG-canonical corpus,
 * which `scripts/project-authored-docs.ts` calls "a GATE" in its own comments while
 * nothing invoked it. The consequence was exactly what this script's header predicts an
 * unwired guard produces: four projected docs were hand-edited and sat drifted for ~20h
 * with nothing reporting it, and the drift surfaced only because an agent ran the command
 * by hand. A meta-guard blind to half the guard namespace cannot detect that, and its
 * green gets quoted as evidence that every guard is wired.
 *
 * ⚠ COMPANION COLLAPSE MUST NOT APPLY HERE, and the reason is not cosmetic.
 * `COMPANION_SUFFIX_RE` includes `check`, so the ordinary rule would collapse
 * `gen:foo:check` onto `gen:foo` whenever the base is declared — which it always is.
 * But the two are NOT a guard and its variant: `gen:foo` WRITES the artifact (it is the
 * generator, and mutates the tree), while `gen:foo:check` is the only half that ASSERTS
 * anything. Collapsing would credit enforcement to a script that can never fail on drift
 * because its job is to overwrite it — silently emptying this family from the census
 * again, in the one direction the header calls the wasteful answer to get wrong. So the
 * `:check` variant is selected as a guard in its own right and its writer base is never
 * treated as covering it.
 */
const GEN_CHECK_RE = /^gen:.+:check$/;

/**
 * Is THIS guard registered in `REPO_WIDE_INVARIANT_GUARDS` — directly, or through one of
 * its companion aliases?
 *
 * ⚠ WHY THE ALIAS HOP IS REQUIRED, not a convenience (measured 2026-08-16, WI-39420).
 * A guard's blocking mode usually lives in a companion alias: `lint:x` prints findings and
 * exits 0, `lint:x:fail` exits 1. Registering the BASE is therefore the wrong half — it
 * would run the guard on every changed path it covers and never fail, i.e. buy full
 * coverage of a script that cannot red anything. So the correct registration names the
 * `:fail` alias — and an exact-Set lookup for the base guard then reported that correct
 * registration as NOT REGISTERED. `lint:di-seam-arity-strands` was wired properly and
 * still failed this check's coverage axis, which reads as "the wiring did not work" and
 * invites exactly the false-green re-registration described above.
 *
 * Enforcement is a property of the IMPLEMENTATION, not of how many npm aliases point at
 * it — the same premise `COMPANION_SUFFIX_RE` already encodes for the census.
 *
 * Two properties this must NOT break, both load-bearing:
 *  • NESTED NAMES. The match is exact-after-stripping, never a substring/prefix test, so
 *    `lint:no-retired-resurrection` still does not credit `lint:no-retired` (see the note
 *    on the exact-Set lookup in `classifyGuard`).
 *  • THE `gen:*:check` CARVE-OUT. There the `:check` half is a guard in its OWN right and
 *    its writer base must never inherit its coverage — collapsing them would credit a
 *    script whose job is to overwrite drift (see `GEN_CHECK_RE` above). Those registrations
 *    are skipped for the alias hop and only ever match exactly.
 */
export function hasRepoWideRegistration(repoWideRegistered, name) {
  if (repoWideRegistered.has(name)) return true;
  for (const registered of repoWideRegistered) {
    if (GEN_CHECK_RE.test(registered)) continue;
    if (registered !== name && registered.replace(COMPANION_SUFFIX_RE, '') === name) return true;
  }
  return false;
}

/**
 * Blank out COMMENTS before matching. A runner file that merely *discusses* a guard in
 * prose must not count as running it.
 *
 * This is not hypothetical tidiness — it fired on this very script. The
 * `green-checkpoint.ts` leg added for THIS check carries a comment naming
 * `lint:mock-cast-escape` as the motivating example; that one sentence reclassified the
 * rotting guard from `logic-test` to `gate`, i.e. the checker declared its own
 * motivating case fully enforced. It is also precisely the failure that produced
 * instance 1 in the filing, where a doc comment *about* a SQL bug pulled a file
 * containing no SQL into a SQL linter's scope: prose describing a rule reads exactly
 * like the rule being applied.
 *
 * String literals are deliberately KEPT — `exec('npm', ['run', 'lint:x'])` is a real
 * invocation living in a string, so masking those would blind the gate tier entirely.
 *
 * ⚠ LINE-BASED on purpose. The obvious implementation — `text.replace(/\/\*[\s\S]*?\*\//g)`
 * plus a `//` rule — is what this function had first, and it silently ate REAL CODE:
 * `lint:plane-adoption` is wired at green-checkpoint.ts:5094 as a plain array entry, and
 * that regex removed the line, reporting a properly-gated guard as unenforced. In a file
 * this size an unbalanced `/*` inside a string or regex literal lets a non-greedy block
 * match run for thousands of lines, so the damage is unbounded and invisible.
 *
 * Dropping only lines that are ENTIRELY comment cannot do that, and it still removes the
 * whole prose case, because narrative about a guard always lives in a comment block —
 * never trailing a line of code that invokes something else.
 */
export function stripComments(text, { yaml = false } = {}) {
  const commentLine = yaml ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/;
  return String(text)
    .split('\n')
    .map((line) => (commentLine.test(line) ? '' : line))
    .join('\n');
}

/**
 * `lint:foo` guards, minus the companion invocations described above.
 *
 * A suffix match alone is NOT sufficient to collapse a name: `lint:foo:strict` is a
 * companion of `lint:foo`, but a guard that merely ENDS in one of those words with no
 * base guard behind it is a guard in its own right, and dropping it would hide it from
 * the census entirely — the exact invisibility this script exists to detect. So the
 * base guard must actually exist for the collapse to apply. (Measured 2026-08-03: no
 * such orphan exists today, so this is a safety property, not a behaviour change.)
 */
export function selectGuardScripts(scripts) {
  const all = Object.keys(scripts);
  const lintNames = all.filter((name) => name.startsWith('lint:'));
  const declared = new Set(lintNames);
  const lintGuards = lintNames.filter((name) => {
    const m = name.match(COMPANION_SUFFIX_RE);
    return !m || !declared.has(name.slice(0, -m[0].length));
  });
  return [...lintGuards, ...all.filter((name) => GEN_CHECK_RE.test(name))].sort();
}

/**
 * The implementation file(s) a script command runs — `node scripts/x.mjs`,
 * `tsx scripts/x.mjs`, `npx tsx path/to/x.ts`, … Returns repo-relative paths.
 * TypeScript's module-suffixed forms (`.mts`/`.cts`) are included because generator
 * guards use them in the root package scripts.
 * A guard with no resolvable implementation (a bare `knip`, a shell pipeline) yields
 * an empty list and is then matched by npm NAME only.
 */
export function resolveImplementationPaths(command) {
  const out = new Set();
  for (const m of String(command).matchAll(/(?:^|\s)((?:scripts|apps|packages|libs)\/[\w./-]+\.(?:mjs|cjs|js|mts|cts|ts))/g)) {
    out.add(m[1]);
  }
  return [...out];
}

/** Every `npm run <name>` referenced by a command. */
export function referencedScripts(command) {
  return [...String(command).matchAll(/npm run ([\w:.-]+)/g)].map((m) => m[1]);
}

/** Escape a guard name for embedding in a RegExp. */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Impl paths claimed by MORE THAN ONE guard, and therefore NOT evidence about any one of
 * them (WI-39832). `lint:tool-prompts`, `lint:plane-guards` and `lint:design-primitives`
 * all run through `scripts/test-files.mjs`, so every test that names that shared runner —
 * the test-router and tmpdir-guard suites among them — credited all three.
 *
 * Companion invocations are collapsed by `selectGuardScripts` BEFORE this runs, so a
 * `:report`/`:update` sibling sharing its base guard's implementation is not counted here.
 */
export function sharedImplementationPaths(scripts, names = selectGuardScripts(scripts)) {
  const claims = new Map();
  for (const name of names) {
    for (const p of resolveImplementationPaths(scripts[name] ?? '')) {
      if (!claims.has(p)) claims.set(p, new Set());
      claims.get(p).add(name);
    }
  }
  return new Set([...claims].filter(([, owners]) => owners.size > 1).map(([p]) => p));
}

/**
 * Classify one guard against the pre-built runner corpora.
 * Returns the STRONGEST tier found, plus every tier for reporting.
 *
 * ⚠ THE `test` TIER TAKES EXECUTION EVIDENCE ONLY — a bare NAME mention does not count
 * (WI-39832). For `gate`/`ci`/`hook` a name mention IS the evidence: those corpora are
 * config that runs a guard BY npm name, so seeing `lint:x` in green-checkpoint.ts means
 * the gate runs it. A *.test.ts is different — it is prose-dense code that names guards
 * for every reason except running them, and the corpus is 424 such files concatenated.
 *
 * MEASURED, all three from the live tree on 2026-08-18:
 *   • `lint:cell-matrix` was reported ENFORCED / blocking on the strength of
 *     `expect(scripts).not.toContain("lint:cell-matrix")` — an assertion whose entire
 *     purpose is to pin the guard SHUT, read as proof that something runs it. The
 *     census inverted the meaning of its own evidence.
 *   • `lint:plane-adoption` was credited from a FIXTURE STRING inside this checker's
 *     OWN test (`const src = "{ script: 'lint:plane-adoption', … }"`).
 *   • four more (`lint:declared-consumed`, `lint:plane-producers`, `lint:plane-ratchet`,
 *     `lint:timer-classification`) from string literals in a gate-wiring list assertion.
 *
 * WHY THE OBVIOUS FIX IS A NO-OP — DO NOT RE-TRY IT. The natural reading is that the bug
 * is the CONCATENATION (per-file identity is lost, so file A's `spawnSync` can vouch for
 * file B's mention) and that the remedy is per-file attribution. Measured against the
 * real tree, per-file attribution revokes ZERO credits: for all 61 test-tier guards the
 * enforcing marker and the mention already co-occur in the SAME file. The defect is
 * evidence QUALITY, not attribution granularity.
 *
 * Execution evidence is therefore: a DISTINGUISHING implementation path (see
 * `sharedImplementationPaths`), or an `npm run <name>` invocation — tolerant of argv
 * spelling (`'npm', 'run', 'lint:x'`) and closed against name nesting, since
 * `lint:no-retired` is a prefix of `lint:no-retired-resurrection`.
 */
export function classifyGuard({
  name,
  command,
  corpora,
  repoWideRegistered = new Set(),
  sharedImpls = new Set(),
  trackedTestFiles = new Set(),
}) {
  const impls = resolveImplementationPaths(command);
  const tiers = [];
  const mentions = (text) => text.includes(name) || impls.some((p) => p && text.includes(p));
  // The separator bound spans the argv spelling `'npm', ['run', 'lint:x'` — five
  // non-word chars between tokens, not the one a shell string has.
  const npmRun = new RegExp(`npm\\W{1,8}run\\W{1,8}${escapeRe(name)}(?![\\w:.-])`);
  const runsGuard = (text) =>
    npmRun.test(text) || impls.some((p) => p && !sharedImpls.has(p) && text.includes(p));
  for (const [tier, text] of Object.entries(corpora)) {
    if (tier === 'test' ? runsGuard(text) : mentions(text)) tiers.push(tier);
  }
  // THE OTHER HALF OF THE SAME DEFECT (WI-39832). Three guards — `lint:tool-prompts`,
  // `lint:plane-guards`, `lint:design-primitives` — are IMPLEMENTED AS *.test.ts files
  // rather than as a checker script. vitest runs those files directly under
  // `test:affected`, so their enforcement is STRUCTURAL: it follows from the file
  // existing and being tracked, and no one has to mention it anywhere.
  //
  // Scoring them by mention got the right answer for the wrong reason — `lint:tool-prompts`
  // was credited only because seven unrelated suites happen to name
  // `tools-md-sync.test.ts`. Delete those incidental mentions and a genuinely-enforced
  // guard flips to "runs on NO blocking path", reddening the gate with a false finding
  // and sending someone to WIRE a guard that was already running. The failure direction
  // is the mirror of the one above and just as wrong.
  if (!tiers.includes('test') && impls.some((p) => trackedTestFiles.has(p))) tiers.push('test');
  // Appended AFTER the corpora so `blocking[0]` keeps reporting the more specific tier for a
  // guard that is both registered and named by a CI job / gate leg / enforcing test — all 11
  // registrations that pre-dated this tier are in that state, so their reported tier is
  // unchanged and only a registration-ONLY guard newly reads `repo-wide`.
  //
  // Membership is an exact Set lookup, deliberately NOT the substring `mentions()` used above:
  // guard names nest (`lint:no-retired` is a prefix of `lint:no-retired-resurrection`, and both
  // are registered), so a text-corpus spelling of this would credit the shorter name off the
  // longer one's registration. The caller passes the EFFECTIVE set — registrations whose named
  // workspace actually declares the script — so an INERT registration confers nothing here
  // either, and still falls through to be reported as the unwired guard it really is.
  if (hasRepoWideRegistration(repoWideRegistered, name)) tiers.push('repo-wide');
  const blocking = tiers.filter((t) => BLOCKING_TIERS.has(t));
  return {
    name,
    impls,
    tiers,
    tier: blocking[0] ?? tiers[0] ?? null,
    blocking: blocking.length > 0,
  };
}

/* ── COVERAGE: the THIRD axis (EI-19461064447747454) ─────────────────────────
 *
 * `classifyGuard` above answers "does a blocking path run this guard?" — a per-GUARD
 * boolean. It does NOT answer "would a violation ANYWHERE be seen?", and those come
 * apart for exactly one tier.
 *
 * `gate` and `ci` legs run UNCONDITIONALLY, so their scope is the whole tree. But the
 * `test` tier is enforced by a *.test.ts, and the gate runs tests via `test:affected`,
 * which selects suites BY WORKSPACE. So a `test`-tier guard runs only when its own
 * test file's workspace is independently affected — while the guard itself may scan
 * far wider. A violation introduced outside that workspace gets NO local signal and
 * first surfaces as a red FLEET gate hours later.
 *
 * MEASURED (WI-9434): `lint:partial-index-alignment` scans 4 roots but its ratchet is
 * a vitest file in `@papercusp/operator-core`, so `--changed-paths
 * apps/operator/lib/release/green-checkpoint.ts --print-affected` → `@papercusp/web`
 * only. 3 of its 4 scanned roots escaped. The census called it ENFORCED, truthfully,
 * and that read as "this guard is doing its job".
 *
 * The remedy already exists and is what makes this modellable rather than advisory:
 * `REPO_WIDE_INVARIANT_GUARDS` in `scripts/affected-tests.mjs` registers a guard to
 * run whenever any changed path matches its own predicate, independent of workspace
 * selection. A registered guard is therefore FULLY covered.
 *
 * ⚠ WHY MOST GUARDS REPORT `undetermined` RATHER THAN A NUMBER. Only two scan shapes
 * are comparable to workspace-scoped enforcement: a bounded root array, and a
 * repo-wide file enumeration. The others are not merely harder — a roots model is the
 * WRONG model for them, and forcing one would manufacture false precision:
 *   • `lint:cell-matrix` queries a LIVE DATABASE over a port; it has no file scope.
 *   • `lint:boundary-check` walks an import graph from an ENTRY POINT.
 * `undetermined` is a real answer here: it says the census has not measured coverage,
 * which is precisely the claim it was previously making silently and wrongly.
 *
 * ⚠ AND `undetermined` HAS AN EXIT — registration. `lint:required-field-strands` was this
 * list's third entry ("DIFF-driven (`--files=` / `--base`)") until WI-38401 registered it in
 * REPO_WIDE_INVARIANT_GUARDS. MEASURED via the differential this script's own
 * `LINT_GUARD_REACHABILITY_AFFECTED_TESTS` override makes possible (2026-08-13, HEAD registry
 * vs working registry): 8 guards `coverage NOT measured` → 7, the guard dropping out. So an
 * unmeasurable scan shape is a reason coverage cannot be COMPUTED, never a reason the guard
 * cannot be COVERED.
 *
 * ⚠ That same guard is why the enforcement axis must be read with its own caveat rather than
 * as a verdict: it was classified ENFORCED throughout, on a `test` tier — a vitest file that
 * exercises its FORMATTERS over fixtures and never diffs the real tree. It ran on no
 * automated path at all, and the class it detects froze `main` ~14h on 2026-08-12 with
 * `test:affected` green. ENFORCED means a blocking path runs SOMETHING that imports the
 * guard; it does not mean that path exercises the guard's actual subject.
 */

/** Workspace directory owning a repo-relative path (longest prefix wins), or null. */
export function workspaceOfPath(file, workspaceDirs) {
  let best = null;
  for (const dir of workspaceDirs) {
    if (file === dir || file.startsWith(`${dir}/`)) {
      if (!best || dir.length > best.length) best = dir;
    }
  }
  return best;
}

/** A test file, by the repo's own naming: `x.test.ts`, `x.test.tsx`, `x.integration.test.ts`. */
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/;

/**
 * Which of a guard's resolved impl paths actually define WHAT IT SCANS.
 *
 * `resolveImplementationPaths` matches every code path a command mentions, which for a
 * test-backed guard is the SUBJECT plus whatever RUNS it — e.g. `lint:tool-prompts` is
 * `… node scripts/test-files.mjs packages/operator-core/lib/__tests__/tools-md-sync.test.ts`,
 * yielding the shared runner AND the subject. Feeding both to `deriveScanScope` scans the
 * runner's source for scan-shape evidence, which is a category error: a runner EXECUTES a
 * guard, it is not part of what that guard covers.
 *
 * WHY THIS IS A CORRECTNESS BUG AND NOT A TIDINESS ONE (WI-38290, measured 2026-08-12): a
 * peer added a `git ls-files` call to `scripts/test-files.mjs` for unrelated provenance
 * reporting. `deriveScanScope` matches the argv literal `'ls-files'` anywhere in its input,
 * so THREE guards that merely share that runner instantly inherited scope `repo-wide`;
 * `lint:tool-prompts` scored `partial` off it and, the partial set being SHRINK-ONLY,
 * red-pinned the green-checkpoint gate. The guard itself had not changed at all.
 *
 * So: when a command names test subjects, THEY are the implementation for scope purposes
 * and every non-test entrypoint is a runner. With no test subject (`node scripts/check-x.mjs`)
 * the impl list is already the implementation and is returned unchanged.
 *
 * Deliberately NOT applied to the enforcement axis (`classifyGuard`'s `mentions`, and the
 * enforcing-test match): there, naming the runner path is how a guard is FOUND in a corpus,
 * and narrowing it would hide real wiring. This narrows only what gets read for scan SHAPE.
 */
export function scanScopeSources(impls) {
  const subjects = impls.filter((p) => TEST_FILE_RE.test(p));
  return subjects.length ? subjects : impls;
}

/**
 * What a guard's implementation ENUMERATES. Derived by scanning the implementation, never
 * hand-declared — the same anti-drift property the tier classification relies on.
 *
 * Order is significant: a guard that declares bounded roots AND calls `ls-files` uses the
 * roots to FILTER that enumeration, so `bounded` is the truthful answer, not `repo-wide`.
 */
export function deriveScanScope(source) {
  const text = String(source);
  const rootsMatch = text.match(/(?:export\s+)?const\s+\w*(?:SCAN|SOURCE)_ROOTS\s*=\s*\[([\s\S]*?)\]/);
  if (rootsMatch) {
    const roots = [...rootsMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
    if (roots.length) return { kind: 'bounded', roots };
  }
  // `listTrackedFiles(...)`, or a `git ls-files` spawn — the argv form means the literal
  // is `'ls-files'`, NOT the string `git ls-files`. Matching the latter is why an earlier
  // measurement pass reported two repo-wide guards as having no detectable scan at all.
  if (/listTrackedFiles\s*\(|['"]ls-files['"]/.test(text)) return { kind: 'repo-wide', roots: null };
  if (/--files=|--changed-paths|--base\b/.test(text)) return { kind: 'diff-driven', roots: null };
  return { kind: 'undetermined', roots: null };
}

/**
 * Coverage verdict for one classified row.
 *
 * Returns `{ verdict, reason, roots?, coveredRoots? }` where verdict is one of
 * `full` | `partial` | `undetermined` | `not-enforced`.
 */
export function computeCoverage({
  row,
  enforcingTestPaths = [],
  workspaceDirs = [],
  implSource = '',
  repoWideRegistered = new Set(),
}) {
  if (!row.blocking) return { verdict: 'not-enforced', reason: 'no blocking path runs it' };
  if (row.tier === 'gate' || row.tier === 'ci') {
    return { verdict: 'full', reason: `${row.tier} legs run unconditionally, not by affected-workspace selection` };
  }
  // `chained` inherits its runner's reachability, and that runner's own coverage is not
  // resolved here. Claiming `full` for it would re-create this very bug one hop down, so
  // it is reported as unmeasured rather than assumed good.
  if (row.tier === 'chained') {
    return { verdict: 'undetermined', reason: "inherits an unmeasured runner's coverage" };
  }
  if (hasRepoWideRegistration(repoWideRegistered, row.name)) {
    return { verdict: 'full', reason: 'registered in REPO_WIDE_INVARIANT_GUARDS — runs on its own predicate' };
  }

  const enforcementWorkspaces = [
    ...new Set(enforcingTestPaths.map((p) => workspaceOfPath(p, workspaceDirs)).filter(Boolean)),
  ];
  if (!enforcementWorkspaces.length) {
    return { verdict: 'undetermined', reason: 'could not resolve the workspace of its enforcing test' };
  }

  const scope = deriveScanScope(implSource);
  if (scope.kind === 'bounded') {
    const covered = scope.roots.filter((r) => {
      const ws = workspaceOfPath(r, workspaceDirs);
      return ws && enforcementWorkspaces.includes(ws);
    });
    if (covered.length === scope.roots.length) {
      return { verdict: 'full', reason: 'every scanned root lies inside its enforcing workspace', roots: scope.roots };
    }
    return {
      verdict: 'partial',
      reason: `scans ${scope.roots.length} roots; only ${covered.length} lie inside ${enforcementWorkspaces.join(', ')}`,
      roots: scope.roots,
      coveredRoots: covered,
    };
  }
  if (scope.kind === 'repo-wide') {
    return {
      verdict: 'partial',
      reason: `enumerates the WHOLE tree but only runs when ${enforcementWorkspaces.join(', ')} is affected`,
    };
  }
  return {
    verdict: 'undetermined',
    reason: `${scope.kind} scan is not comparable to workspace-scoped enforcement; coverage NOT measured`,
  };
}

/**
 * The whole census. `corpora` maps tier → concatenated source text of every runner in
 * that tier. Pure so it is unit-testable without a repo.
 *
 * `coverage` is OPTIONAL: omit it and no coverage is computed (rows simply carry no
 * `coverage` field). Supplying it adds the third axis described above.
 */
export function buildReachabilityCensus({
  scripts,
  corpora,
  acknowledged = new Map(),
  coverage = null,
  // Defaults to the coverage axis's own set so an existing caller that passes registrations
  // only under `coverage` keeps the same behaviour on BOTH axes. Accepted at the top level
  // too because enforcement is measurable without the coverage inputs, and conflating them
  // is what let the two axes disagree about registration in the first place (see BLOCKING_TIERS).
  repoWideRegistered = coverage?.repoWideRegistered ?? new Set(),
  // Tracked *.test.ts paths — a guard implemented AS one is run by vitest itself (WI-39832).
  trackedTestFiles = new Set(),
} = {}) {
  // Which impl paths are shared is a property of the whole guard SET, so it is computed
  // once here rather than per guard — a path is only non-distinguishing relative to its
  // rivals (WI-39832).
  const guardNames = selectGuardScripts(scripts);
  const sharedImpls = sharedImplementationPaths(scripts, guardNames);
  const rows = guardNames.map((name) =>
    classifyGuard({ name, command: scripts[name], corpora, repoWideRegistered, sharedImpls, trackedTestFiles }),
  );

  // A `chained` guard inherits reachability from whatever reachable script runs it.
  const blockingNames = new Set(rows.filter((r) => r.blocking).map((r) => r.name));
  for (const [scriptName, command] of Object.entries(scripts)) {
    if (!blockingNames.has(scriptName)) continue;
    for (const ref of referencedScripts(command)) {
      const row = rows.find((r) => r.name === ref);
      if (row && !row.blocking) {
        row.blocking = true;
        row.tier = 'chained';
        row.tiers = [...row.tiers, 'chained'];
      }
    }
  }

  // NOT ENFORCED = no blocking path runs it, whether that is because NOTHING runs it
  // (`tier: null`) or because its only coverage is advisory (`hook` / `logic-test`).
  //
  // ⚠ Both count. An earlier draft of this check failed only on `tier: null`, and that
  // draft would NOT have caught `lint:mock-cast-escape` — the very guard whose +45
  // baseline drift prompted this script — because it has a green logic test and so
  // looked covered. A check that misses its own motivating instance is not a check.
  // The `tier` is retained per row so the remedy is still distinguishable: deepen an
  // existing test vs. wire one from scratch.
  // Coverage is computed AFTER the chained-inheritance pass above, so every row's tier
  // is final. Rows carry no `coverage` field at all when the caller supplies no coverage
  // input — an absent field is honestly "not measured", never a silent `full`.
  if (coverage) {
    const {
      enforcingTests = [],
      workspaceDirs = [],
      implSources = new Map(),
      repoWideRegistered = new Set(),
    } = coverage;
    for (const row of rows) {
      const enforcingTestPaths = enforcingTests
        .filter((t) => t.text.includes(row.name) || row.impls.some((p) => p && t.text.includes(p)))
        .map((t) => t.path);
      row.coverage = computeCoverage({
        row,
        enforcingTestPaths,
        workspaceDirs,
        // SUBJECTS ONLY — a shared test runner's source is not evidence about what this
        // guard scans. See scanScopeSources (WI-38290).
        implSource: scanScopeSources(row.impls)
          .map((p) => implSources.get(p) ?? '')
          .join('\n'),
        repoWideRegistered,
      });
    }
  }

  const notEnforced = rows.filter((r) => !r.blocking);
  const unreachable = notEnforced.filter((r) => r.tier === null);
  const advisoryOnly = notEnforced.filter((r) => r.tier !== null);
  const unacknowledged = notEnforced.filter((r) => !acknowledged.has(r.name));
  // Enforced, but only over PART of what it scans — the defect this axis exists to name.
  const partiallyCovered = rows.filter((r) => r.coverage?.verdict === 'partial');
  const coverageUnmeasured = rows.filter((r) => r.coverage?.verdict === 'undetermined');
  // An allowlist entry for a guard that no longer exists keeps asserting a decision
  // about nothing — the same staleness `findStaleDeclarations` catches for tiers.
  const declaredNames = new Set(rows.map((r) => r.name));
  const staleAcknowledgements = [...acknowledged.keys()].filter((n) => !declaredNames.has(n));

  return {
    rows,
    notEnforced,
    unreachable,
    advisoryOnly,
    unacknowledged,
    staleAcknowledgements,
    partiallyCovered,
    coverageUnmeasured,
  };
}

/* ── repo I/O (impure; the logic above stays pure) ───────────────────────────── */

function readIfExists(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
  } catch {
    return '';
  }
}

function buildCorpora() {
  const { files } = listTrackedFiles(ROOT);

  const gate = stripComments(readIfExists(resolve(ROOT, 'apps/operator/lib/release/green-checkpoint.ts')));

  const wfDir = resolve(ROOT, '.github/workflows');
  const ci = existsSync(wfDir)
    ? readdirSync(wfDir)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map((f) => stripComments(readIfExists(resolve(wfDir, f)), { yaml: true }))
        .join('\n')
    : '';

  // Split the test corpus: only a test that RUNS the guard over real files enforces
  // anything. One that imports its pure helpers and asserts against fixtures goes to
  // the advisory `logic-test` pile — see the header for why that distinction is the
  // whole point of this check.
  //
  // Per-file identity is RETAINED for the enforcing pile (it used to be concatenated away).
  // Coverage needs to know WHICH test file enforces a guard, because that file's workspace
  // is exactly what `test:affected` selects on — see the COVERAGE section above.
  const testTexts = files
    .filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
    .map((f) => ({ path: f, text: stripComments(readIfExists(resolve(ROOT, f))) }));
  const enforcingTests = testTexts.filter((t) => ENFORCING_TEST_RE.test(t.text));
  const test = enforcingTests.map((t) => t.text).join('\n');
  const logicTest = testTexts.filter((t) => !ENFORCING_TEST_RE.test(t.text)).map((t) => t.text).join('\n');

  const hook = [
    ...files.filter((f) => f.includes('/hooks/') && !f.endsWith('.test.ts')),
    '.claude/settings.json',
  ]
    .map((f) => stripComments(stripComments(readIfExists(resolve(ROOT, f))), { yaml: true }))
    .join('\n');

  // Key order matters: `classifyGuard` reports the first matching tier for a guard
  // with no blocking tier, so the advisory tiers come last.
  // Tracked *.test.ts paths, for the guards whose IMPLEMENTATION is a test file — vitest
  // runs those by existence, so they need no mention anywhere (WI-39832).
  const trackedTestFiles = new Set(testTexts.map((t) => t.path));

  return { corpora: { gate, ci, test, hook, 'logic-test': logicTest }, enforcingTests, files, trackedTestFiles };
}

/**
 * Guards registered in `REPO_WIDE_INVARIANT_GUARDS` (scripts/affected-tests.mjs) — the
 * existing mechanism that runs a guard on its OWN predicate instead of by affected
 * workspace. Parsed rather than duplicated, so this cannot drift from the real list.
 *
 * The block is bounded to the array literal: `script:` also appears elsewhere in that
 * file, and reading the whole file would silently over-credit unrelated guards.
 */
export function parseRepoWideRegistrations(affectedTestsSource) {
  const text = String(affectedTestsSource);
  const start = text.indexOf('const REPO_WIDE_INVARIANT_GUARDS');
  if (start < 0) return new Set();
  const block = text.slice(start);
  const end = block.indexOf('\n];');
  return new Set(
    [...block.slice(0, end < 0 ? undefined : end).matchAll(/script:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
  );
}

/**
 * The same registrations as `parseRepoWideRegistrations`, but keeping the `workspace` each
 * one names instead of discarding it — which is what makes the INERT check below possible.
 *
 * Line comments are stripped first: the entries in that registry are heavily commented, and
 * a prose mention of a script name would otherwise be parsed as a registration.
 */
export function parseRepoWideRegistrationPairs(affectedTestsSource) {
  const text = String(affectedTestsSource);
  const start = text.indexOf('const REPO_WIDE_INVARIANT_GUARDS');
  if (start < 0) return [];
  const block = text.slice(start);
  const end = block.indexOf('\n];');
  const body = block.slice(0, end < 0 ? undefined : end).replace(/^\s*\/\/.*$/gm, '');
  const pairs = [];
  for (const chunk of body.split(/\n\s{2}\{/)) {
    const ws = /workspace:\s*['"]([^'"]+)['"]/.exec(chunk);
    const sc = /script:\s*['"]([^'"]+)['"]/.exec(chunk);
    if (ws && sc) pairs.push({ workspace: ws[1], script: sc[1] });
  }
  return pairs;
}

/**
 * Registrations that CANNOT run: the named workspace does not declare the named script.
 *
 * WHY THIS AXIS EXISTS (measured 2026-08-09, WI-37454). `affected-tests.mjs` skips a
 * registered guard whose owning workspace does not declare the script:
 *
 *     if (!ws?.scripts?.[guard.script]) continue;        // affected-tests.mjs:815
 *
 * — silently, by design, because that `continue` also absorbs a workspace that is simply
 * absent. Meanwhile `coverageOf` credited `verdict: 'full'` for anything merely PRESENT in
 * the registry. Those two facts compose into the exact rot this whole script exists to
 * catch, with the reporting surface pointing the wrong way: `lint:drop-database-force` was
 * registered (WI-4311, for the ~88-parked-backends bug) but never declared by
 * `@papercusp/operator-core`, so it ran NOWHERE while being scored fully enforced.
 *
 * A registration is a CLAIM about where a guard runs; declaring the script is what makes it
 * true. Crediting the claim without checking the fact is how a guard's own coverage report
 * becomes the thing that hides its absence.
 *
 * `scriptsByWorkspaceName` maps workspace package name → Set of declared script names. A
 * workspace MISSING from that map is treated as declared (fail OPEN, like the rest of this
 * file): an unreadable package.json must not red-pin the fleet gate on a file it could not
 * read, and this axis is only meaningful when the map was built successfully.
 */
export function findInertRepoWideRegistrations({ pairs = [], scriptsByWorkspaceName = new Map() } = {}) {
  const inert = [];
  for (const pair of pairs) {
    const declared = scriptsByWorkspaceName.get(pair.workspace);
    if (!declared) continue; // fail open — see docstring
    if (!declared.has(pair.script)) inert.push(pair);
  }
  return inert;
}

/** Workspace directories, expanded from package.json `workspaces` globs against the tree. */
function discoverWorkspaceDirs(pkg, files) {
  const dirs = new Set();
  for (const pattern of pkg.workspaces ?? []) {
    if (!pattern.endsWith('/*')) {
      dirs.add(pattern);
      continue;
    }
    const base = pattern.slice(0, -2);
    for (const f of files) {
      if (!f.startsWith(`${base}/`)) continue;
      const seg = f.slice(base.length + 1).split('/')[0];
      if (seg) dirs.add(`${base}/${seg}`);
    }
  }
  return [...dirs];
}

/**
 * The MODULE axis: which `lib/release/**` detector modules no production path calls.
 *
 * Reads every tracked source file once (~5s on this tree) and discards each body
 * immediately — the graph retains edges, never file contents.
 *
 * ⚠ FAILS OPEN, for the same reason the coverage axis does. `assessGraphHealth` is the
 * instrument's own positive control: a probe that classifies the ENTIRE population dead
 * has failed to see the tree, and reporting that as 81 violations would red-pin the
 * fleet gate on an instrument fault instead of a defect. When it says the axis is not
 * measurable, this returns an EMPTY finding set and says so out loud.
 */
function runModuleReachability({ files, workspaceDirByName }) {
  // `git ls-files` keeps an index-known deletion until the next commit. Read the
  // CURRENT tree here: otherwise the guard's own "DELETE it" remedy stays red after
  // the file is physically gone and cannot be verified until git-sync happens to run.
  const currentFiles = files.filter((f) => existsSync(resolve(ROOT, f)));
  const population = selectDetectorModules(currentFiles);
  // Returns RAW text: buildImportGraph applies the comment-strip itself, AFTER its
  // prefilter, so the expensive parse runs on the few hundred files that could possibly
  // reach a lib/release module rather than on all ~31k. Deliberately NOT memoized —
  // caching 31k file bodies costs hundreds of MB for a pass that never revisits a file.
  const readFile = (f) => readIfExists(resolve(ROOT, f));

  // ⚠ THE INSTRUMENT MUST NOT COUNT AS A CALLER. ACKNOWLEDGED_UNREACHABLE_MODULES above
  // is a list of `lib/release/**` paths, and the mention scan reads literal paths as
  // execution evidence — so without this exclusion THIS FILE resurrects every module it
  // tracks. Measured during bring-up: all 21 known-dead modules came back reachable with
  // one "production importer" each, this script. It failed GREEN, which is why it nearly
  // shipped. Same remedy as scripts/proc-guard.mjs excluding its own ancestor chain.
  // Both paths are derived from import.meta.url so a rename cannot re-open the hole.
  const excludeReachers = new Set([
    ...selfExclusionPaths(ROOT),
    relative(ROOT, fileURLToPath(import.meta.url)).split(sep).join('/'),
  ]);

  // Comment-stripped inside the graph, so a commented-out import cannot read as usage.
  // That direction matters: it is a false NEGATIVE — a dead module reported alive.
  const graph = buildImportGraph({
    files: currentFiles,
    readFile,
    stripComments,
    workspaceDirByName,
  });
  const result = findUnreachableModules({
    population,
    importers: graph.importers,
    pathMentions: graph.pathMentions,
    excludeReachers,
  });
  const health = assessGraphHealth({
    resolvedEdges: graph.resolvedEdges,
    population,
    dead: result.dead,
    unresolvedRelative: graph.unresolvedRelative,
  });

  if (!health.measurable) {
    return {
      measurable: false,
      reason: health.reason,
      population: population.length,
      resolvedEdges: graph.resolvedEdges,
      unresolvedRelativeCount: health.unresolvedRelativeCount,
      rounds: result.rounds,
      dead: [],
      inventory: [],
      unclassified: [],
      unacknowledged: [],
      staleAcknowledged: [],
    };
  }

  const inventory = buildShipmentDispositionInventory({
    rows: result.rows,
    dispositions: ACKNOWLEDGED_UNREACHABLE_MODULES,
  });
  const dead = inventory.filter((r) => r.dead);
  return {
    measurable: true,
    reason: null,
    // Every row, not only the dead ones: "which files keep this module alive" is the
    // first question anyone auditing a verdict here asks, and recomputing the graph to
    // answer it is how a reader ends up trusting the headline instead of checking it.
    rows: inventory,
    inventory,
    population: population.length,
    resolvedEdges: graph.resolvedEdges,
    unresolvedRelativeCount: health.unresolvedRelativeCount,
    rounds: result.rounds,
    dead,
    unclassified: findUnclassifiedShipmentModules(inventory),
    unacknowledged: dead.filter((r) => !ACKNOWLEDGED_UNREACHABLE_MODULES.has(r.module)),
    // An entry is STALE either because the module got wired or because it was deleted.
    // Both mean the same thing for the ratchet: a paid-down entry has to LEAVE the set,
    // or the set stops measuring anything.
    staleAcknowledged: [...ACKNOWLEDGED_UNREACHABLE_MODULES.keys()].filter(
      (m) => !result.dead.includes(m),
    ),
  };
}

/**
 * Git add-date for each named module, as epoch ms, in ONE batched `git log`.
 *
 * ⚠ CALLED ONLY ON THE ABOUT-TO-FAIL PATH. The query costs ~1.5s, the guard's whole
 * green run is ~6s, and the enforcing test spawns this script 20 times — paying it
 * unconditionally would push that test past its 50s cap for a value the green path
 * never reads. `unacknowledged` is empty on every healthy run, so this stays unpaid.
 *
 * Returns an EMPTY map on any failure rather than throwing: `partitionByGracePeriod`
 * fails open on an unknown date, so a degraded git turns the axis advisory instead of
 * red-pinning the fleet on a subprocess error.
 *
 * @param {string[]} modules repo-relative module paths
 * @returns {Map<string, number>} module -> epoch ms it was ADDED
 */
export function readModuleAddDates(modules) {
  const added = new Map();
  if (!modules.length) return added;
  try {
    const out = execFileSync(
      'git',
      ['log', '--diff-filter=A', '--name-only', '--format=@%ct', '--', ...modules],
      { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const wanted = new Set(modules);
    let stamp = null;
    for (const raw of out.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('@')) {
        const secs = Number(line.slice(1));
        stamp = Number.isFinite(secs) ? secs * 1000 : null;
        continue;
      }
      // `git log` walks newest-first (verified: stamps descend), so the FIRST stamp
      // seen for a path is its MOST RECENT add. Keep that one, not the earliest.
      // Only a delete-then-re-add distinguishes them, and there the recent date is the
      // fail-open answer: a module resurrected yesterday is someone's in-flight work,
      // and dating it from its original birth would judge it on its first day back.
      if (stamp !== null && wanted.has(line) && !added.has(line)) added.set(line, stamp);
    }
  } catch {
    return new Map();
  }
  return added;
}

/**
 * Committer times (ms) of HEAD's most recent ancestry, newest-first, or [] when git cannot
 * say. Feeds resolveGraceClock, which judges the grace against the tree being checked rather
 * than the wall clock (WI-10004093). A window, not HEAD alone: repair-queue admission commits
 * carry a deterministic 2000-01-01 stamp, so HEAD's own time is meaningless on a repair head.
 */
export function readRecentCommitTimesMs() {
  try {
    const out = execFileSync('git', ['log', `-n${GRACE_CLOCK_WINDOW}`, '--format=%ct', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });
    return out
      .split('\n')
      .map((line) => Number(line.trim()) * 1000)
      .filter((ms) => Number.isFinite(ms) && ms > 0);
  } catch {
    return [];
  }
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const censusOnly = argv.includes('--census');

  // Subject path is overridable so falsifiability can be proven against a COPY,
  // never by mutating this shared tree (CLAUDE.md § "Proving a guard is falsifiable":
  // git-sync sweeps the whole tree every few minutes, so a probe that edits
  // package.json in place can have its mutant committed by a passing sweep).
  const pkgPath = process.env.LINT_GUARD_REACHABILITY_PACKAGE_JSON || resolve(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const scripts = pkg.scripts ?? {};
  const { corpora, enforcingTests, files, trackedTestFiles } = buildCorpora();

  // Implementation sources for the coverage scan. Only guards the census actually has a
  // row for are read, so this adds a handful of file reads, not a second tree walk.
  const implSources = new Map();
  for (const name of selectGuardScripts(scripts)) {
    for (const p of resolveImplementationPaths(scripts[name])) {
      if (!implSources.has(p)) implSources.set(p, readIfExists(resolve(ROOT, p)));
    }
  }

  // ⚠ FAIL OPEN. The coverage axis credits a guard as fully covered when it is registered
  // in REPO_WIDE_INVARIANT_GUARDS — so if that source is unreadable, EVERY registered guard
  // would silently reclassify as `partial` and this leg (a blocking green-checkpoint leg)
  // would red-pin the whole fleet on a missing file rather than on a real defect.
  //
  // The rest of this script already errs toward "reachable" for exactly this reason: a false
  // negative costs a missed report, a false positive costs a fleet-wide gate run. Coverage
  // inherits that stance — no registration source means the axis is not measured at all.
  // Overridable for the same reason the package.json subject is: the fail-open branch
  // below can then be PROVEN against a copy outside the tree, instead of by deleting a
  // load-bearing file from a shared checkout that git-sync sweeps every few minutes.
  const affectedTestsSource = readIfExists(
    process.env.LINT_GUARD_REACHABILITY_AFFECTED_TESTS || resolve(ROOT, 'scripts/affected-tests.mjs'),
  );
  const coverageMeasurable = affectedTestsSource.includes('REPO_WIDE_INVARIANT_GUARDS');
  if (!coverageMeasurable) {
    console.warn(
      '⚠ coverage axis SKIPPED: scripts/affected-tests.mjs has no REPO_WIDE_INVARIANT_GUARDS block.\n' +
        '  Reporting enforcement only. (Failing here would red-pin the gate on a missing file.)',
    );
  }

  const workspaceDirs = discoverWorkspaceDirs(JSON.parse(readIfExists(resolve(ROOT, 'package.json')) || '{}'), files);

  // package name -> declared script names, for the INERT-registration axis. A workspace whose
  // package.json is unreadable/unparseable is simply OMITTED, which findInertRepoWideRegistrations
  // treats as declared (fail open) rather than as a violation it cannot substantiate.
  const scriptsByWorkspaceName = new Map();
  // package name -> workspace dir, for resolving `@papercusp/x/lib/...` specifiers on the
  // MODULE axis. Built from the same read, so the two cannot disagree about a workspace.
  const workspaceDirByName = new Map();
  for (const dir of workspaceDirs) {
    try {
      const wsPkg = JSON.parse(readIfExists(resolve(ROOT, dir, 'package.json')) || '{}');
      if (wsPkg.name) scriptsByWorkspaceName.set(wsPkg.name, new Set(Object.keys(wsPkg.scripts ?? {})));
      if (wsPkg.name) workspaceDirByName.set(wsPkg.name, dir);
    } catch {
      // omitted => fail open for this workspace
    }
  }

  const moduleAxis = runModuleReachability({ files, workspaceDirByName });
  const repoWidePairs = coverageMeasurable ? parseRepoWideRegistrationPairs(affectedTestsSource) : [];
  const inertRegistrations = findInertRepoWideRegistrations({ pairs: repoWidePairs, scriptsByWorkspaceName });
  const inertScripts = new Set(inertRegistrations.map((p) => p.script));

  // EFFECTIVE registrations — registered AND declared by the workspace named. Computed once
  // and used by BOTH axes: enforcement (a `repo-wide` blocking tier) and coverage (`full`).
  // They used to be derived separately, which is how they came to disagree.
  const effectiveRepoWideRegistered = new Set(
    [...parseRepoWideRegistrations(coverageMeasurable ? affectedTestsSource : '')].filter(
      (s) => !inertScripts.has(s),
    ),
  );

  const census = buildReachabilityCensus({
    scripts,
    corpora,
    // Both populations silence the "runs on NO blocking path" failure; only the DEBT set
    // is rationed by the watermark below (WI-39832).
    acknowledged: new Map([...ACKNOWLEDGED_UNREACHABLE, ...ACKNOWLEDGED_UNGATEABLE]),
    trackedTestFiles,
    repoWideRegistered: effectiveRepoWideRegistered,
    coverage: coverageMeasurable
      ? {
          enforcingTests,
          workspaceDirs,
          implSources,
          // EFFECTIVE registrations only — an INERT one (workspace does not declare the
          // script) is deliberately NOT credited, so it falls through to the ordinary
          // coverage analysis and is reported as the partial/unenforced guard it really is.
          repoWideRegistered: effectiveRepoWideRegistered,
        }
      : null,
  });

  // The module axis rides in the SAME machine-readable report. Two separate reports
  // would let a consumer read one and believe it had read the census.
  census.modules = moduleAxis;

  if (json) {
    console.log(JSON.stringify(census, null, 2));
    if (censusOnly) {
      // NOT process.exit(): this census is the machine-readable output people pipe to
      // jq, and exit() does not drain an async pipe write — a truncated census reads as
      // FEWER unreachable guards. See scripts/check-undrained-stdout-exit.mjs.
      process.exitCode = 0;
      return;
    }
  }

  const byTier = {};
  for (const r of census.rows) byTier[r.tier ?? 'UNREACHABLE'] = (byTier[r.tier ?? 'UNREACHABLE'] ?? 0) + 1;

  if (!json) {
    console.log(`lint-guard reachability — ${census.rows.length} declared guards`);
    for (const [tier, n] of Object.entries(byTier).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${tier}${tier === 'hook' ? '  (advisory — nudges, blocks nothing)' : ''}`);
    }
  }

  if (censusOnly) {
    if (!json && census.notEnforced.length) {
      console.log(`\nNOT ENFORCED (${census.notEnforced.length}) — no blocking path runs these:`);
      for (const r of census.notEnforced) {
        console.log(`  [${r.tier ?? 'nothing-runs-it'}] ${r.name}  ${r.impls.join(' ') || '(no resolvable implementation)'}`);
      }
    }
    if (!json && census.partiallyCovered.length) {
      console.log(`\nENFORCED BUT PARTIALLY COVERED (${census.partiallyCovered.length}) — a red would be seen, but not from everywhere:`);
      for (const r of census.partiallyCovered) {
        console.log(`  ${r.name}  —  ${r.coverage.reason}`);
      }
    }
    if (!json && census.coverageUnmeasured.length) {
      console.log(`\nCOVERAGE NOT MEASURED (${census.coverageUnmeasured.length}) — enforced; scan shape not comparable:`);
      for (const r of census.coverageUnmeasured) {
        console.log(`  ${r.name}  —  ${r.coverage.reason}`);
      }
    }
    if (!json) {
      if (!moduleAxis.measurable) {
        console.log(`\nMODULE AXIS NOT MEASURED — ${moduleAxis.reason}`);
      } else {
        console.log(
          `\nDETECTOR MODULES CALLED BY NOTHING (${moduleAxis.dead.length} of ${moduleAxis.population}) —` +
            ' built, often tested, on no production path:',
        );
        for (const r of moduleAxis.dead) {
          const why = r.testedButUnwired
            ? `TESTED-BUT-UNWIRED (${r.testImporters.length} test${r.testImporters.length === 1 ? '' : 's'})`
            : 'no test, no caller';
          const ack = ACKNOWLEDGED_UNREACHABLE_MODULES.get(r.module);
          console.log(`  [${why}] ${r.module}`);
          if (ack) console.log(`      acknowledged: ${typeof ack === 'string' ? ack : ack.reason}`);
        }
        if (moduleAxis.unclassified?.length) {
          console.log(
            `\nMODULES WITHOUT A VALID SHIPMENT DISPOSITION (${moduleAxis.unclassified.length}) — ` +
              'new dead modules need a caller, seam decision + test, or dead/delete decision:',
          );
          for (const row of moduleAxis.unclassified) {
            console.log(`  ${row.module}`);
            for (const error of row.shipmentDisposition?.errors ?? []) console.log(`      ${error}`);
          }
        }
      }
    }
    // Let Node drain any output written above before ending. `process.exit()` can
    // truncate a machine-readable report when stdout is a pipe (EI-19455452259628697).
    process.exitCode = 0;
    return;
  }

  let failed = false;

  // INERT registrations — see findInertRepoWideRegistrations. Reported FIRST because a guard
  // in this state is the most misleading of all the states this script distinguishes: it
  // looks deliberately wired (someone registered it, with a comment explaining why) and it
  // runs nowhere. There is no watermark/allowlist for it on purpose — unlike partial
  // coverage, this is never a considered trade-off, only ever a two-line mismatch.
  if (inertRegistrations.length) {
    failed = true;
    console.error(
      `\n❌ ${inertRegistrations.length} REPO_WIDE_INVARIANT_GUARDS registration(s) are INERT — the workspace does not declare the script:`,
    );
    for (const p of inertRegistrations) console.error(`     ${p.script}  →  ${p.workspace} declares no such script`);
    console.error('   affected-tests.mjs:815 skips these SILENTLY, so the guard runs on no path at all.');
    console.error('   Fix by declaring it in that workspace\'s package.json, e.g.:');
    console.error('     "<script>": "node ../../scripts/<its-checker>.mjs"');
  }

  if (census.staleAcknowledgements.length) {
    failed = true;
    console.error(`\n❌ ${census.staleAcknowledgements.length} STALE allowlist entr(ies) — the guard no longer exists:`);
    for (const n of census.staleAcknowledgements) console.error(`     ${n}`);
    console.error('   Remove them: they assert a pending decision about a script that is gone.');
  }

  // Gated on the registry having actually been READ, for the same reason as the two
  // partial-coverage checks below and with the same fail-OPEN stance as the skip notice above.
  // A registration is now one of the ways a guard is blocking, so with the registry unreadable
  // this axis cannot tell "nothing runs it" from "the thing that runs it is the file I could
  // not open" — and of those two wrong answers only the false POSITIVE red-pins the fleet on a
  // missing file rather than a real defect. Reported as a loud warning so an unmeasured run is
  // never mistaken for a clean one.
  const unacknowledgedUnenforced = coverageMeasurable ? census.unacknowledged : [];
  if (!coverageMeasurable && census.unacknowledged.length) {
    console.warn(
      `\n⚠ enforcement axis DEGRADED: ${census.unacknowledged.length} guard(s) look unenforced, but the\n` +
        '  registration source was unreadable, so a `repo-wide` registration could not be seen.\n' +
        '  NOT failing on them — this run cannot substantiate the finding.',
    );
  }
  if (unacknowledgedUnenforced.length) {
    failed = true;
    console.error(`\n❌ ${unacknowledgedUnenforced.length} lint guard(s) run on NO blocking path:`);
    for (const r of unacknowledgedUnenforced) {
      const why =
        r.tier === 'logic-test'
          ? 'only a UNIT TEST of its helpers — proves the detector works, runs it over nothing'
          : r.tier === 'hook'
            ? 'only a Claude hook — nudges one agent, blocks nothing'
            : 'nothing runs it at all';
      console.error(`     ${r.name}  →  ${r.impls.join(' ') || '(no resolvable implementation)'}`);
      console.error(`        ${why}`);
    }
    console.error('');
    console.error('   A guard that is neither wired nor retired is WORSE than no guard: it rots');
    console.error('   (false positives + baseline drift accrue invisibly) and its green gets quoted');
    console.error('   as evidence. Pick one, deliberately:');
    console.error('     • WIRE it — add it to a green-checkpoint leg, a CI job, or exercise it from a');
    console.error('       *.test.ts. FIRST measure its false-positive rate against the whole real tree');
    console.error('       and prove it still catches its historical incidents; porting an unwired guard');
    console.error('       unchanged is how you red-pin the fleet on defects that accrued while it slept.');
    console.error('     • RETIRE it — delete the script and its implementation.');
  }

  // Both partial-coverage checks are gated on the axis having actually been MEASURED.
  // Without this, an unmeasured run reports every acknowledged entry as "stale" (its
  // guard is absent from an empty partiallyCovered list) and fails the gate — the same
  // fail-closed trap the skip above exists to avoid, one step further down.
  const unacknowledgedPartial = coverageMeasurable
    ? census.partiallyCovered.filter((r) => !ACKNOWLEDGED_PARTIAL_COVERAGE.has(r.name))
    : [];
  if (unacknowledgedPartial.length) {
    failed = true;
    console.error(`\n❌ ${unacknowledgedPartial.length} lint guard(s) are enforced over only PART of what they scan:`);
    for (const r of unacknowledgedPartial) {
      console.error(`     ${r.name}  →  ${r.coverage.reason}`);
    }
    console.error('');
    console.error('   `test:affected` selects suites BY WORKSPACE, so a guard enforced only by a');
    console.error('   *.test.ts runs only when THAT test\'s workspace is independently affected — while');
    console.error('   the guard scans wider. A violation outside that workspace gets no local signal and');
    console.error('   first surfaces as a red FLEET gate. Fix it by registering the guard in');
    console.error('   REPO_WIDE_INVARIANT_GUARDS (scripts/affected-tests.mjs) with an `appliesTo`');
    console.error('   predicate, so it runs on every changed path it actually covers.');
  }

  const stalePartial = coverageMeasurable
    ? [...ACKNOWLEDGED_PARTIAL_COVERAGE.keys()].filter((n) => !census.partiallyCovered.some((r) => r.name === n))
    : [];
  if (stalePartial.length) {
    failed = true;
    console.error(`\n❌ ${stalePartial.length} STALE partial-coverage entr(ies) — no longer partially covered:`);
    for (const n of stalePartial) console.error(`     ${n}`);
    console.error('   Remove them; the ratchet only counts if a paid-down entry leaves the set.');
  }

  if (ACKNOWLEDGED_PARTIAL_COVERAGE.size > PARTIAL_COVERAGE_HIGH_WATERMARK) {
    failed = true;
    console.error(
      `\n❌ acknowledged-partial-coverage set exceeds its watermark: ${ACKNOWLEDGED_PARTIAL_COVERAGE.size} > ${PARTIAL_COVERAGE_HIGH_WATERMARK}.`,
    );
    console.error('   This set is SHRINK-ONLY. Register the guard repo-wide instead of appending here.');
  }

  if (ACKNOWLEDGED_UNREACHABLE.size > UNREACHABLE_HIGH_WATERMARK) {
    failed = true;
    console.error(
      `\n❌ acknowledged-unreachable set exceeds its watermark: ${ACKNOWLEDGED_UNREACHABLE.size} > ${UNREACHABLE_HIGH_WATERMARK}.`,
    );
    console.error('   This set is SHRINK-ONLY. Wire or retire a guard instead of appending here.');
  }

  // ── MODULE AXIS verdicts ────────────────────────────────────────────────────
  if (!moduleAxis.measurable) {
    // Fail OPEN and say so. See runModuleReachability's header: an unmeasurable graph
    // is an instrument fault, and red-pinning the fleet on one teaches everybody to
    // distrust this leg.
    console.warn(`⚠ module axis SKIPPED: ${moduleAxis.reason}.\n  Reporting the script axis only.`);
  } else {
    // Only modules PAST the grace period may fail the build. A module added minutes ago
    // is in-flight work mid-wiring, not certified-but-dead code, and git-sync commits
    // that intermediate state on its own schedule. See partitionByGracePeriod.
    // The date lookup runs ONLY here, where something is already about to fail.
    // Age is measured against HEAD's commit time, not Date.now(), so a frozen gate
    // candidate cannot flip red as wall-clock time passes (see resolveGraceClock).
    const graceClock = moduleAxis.unacknowledged.length
      ? resolveGraceClock({ commitTimesMs: readRecentCommitTimesMs(), wallClockMs: Date.now() })
      : null;
    if (graceClock?.source === 'wall-clock') {
      console.warn('⚠ HEAD commit times unreadable — grace period judged against the wall clock instead.');
    }
    const { judged: judgedDead, inFlight: inFlightDead } = graceClock
      ? partitionByGracePeriod({
          modules: moduleAxis.unacknowledged,
          addedAtByModule: readModuleAddDates(moduleAxis.unacknowledged.map((r) => r.module)),
          now: graceClock.now,
        })
      : { judged: [], inFlight: [] };

    if (inFlightDead.length) {
      // Report, never fail. Silence here would hide a module that is about to become
      // real debt the moment its grace expires.
      console.warn(
        `\n⚠ ${inFlightDead.length} unreachable detector module(s) are still IN FLIGHT ` +
          `(added < ${NEW_MODULE_GRACE_DAYS}d ago) — reported, NOT failed:`,
      );
      for (const r of inFlightDead) {
        const age = r.ageDays === null ? 'add-date unknown' : `${r.ageDays.toFixed(1)}d old`;
        console.warn(`     ${r.module} (${age})`);
      }
      console.warn('   Wire or delete before the grace expires, or this becomes a hard failure.');
    }

    if (judgedDead.length) {
      failed = true;
      console.error(
        `\n❌ ${judgedDead.length} detector module(s) under lib/release/ are called by NO production path:`,
      );
      for (const r of judgedDead) {
        console.error(`     ${r.module}`);
        if (r.testedButUnwired) {
          console.error(
            `       ⚠ ${r.testImporters.length} passing test${r.testImporters.length === 1 ? '' : 's'} import it — it LOOKS covered and enforces nothing.`,
          );
        }
        if (r.productionImporters.length) {
          console.error(
            `       reached only from module(s) that are themselves dead: ${r.productionImporters.slice(0, 3).join(', ')}`,
          );
        }
        // An import-edge graph cannot see the caller of a module a human runs as
        // `tsx <path>`. Saying "called by NO production path" about one of those, with
        // no further qualification, reads as "delete me" — and deletes a working tool.
        const entrypoint = detectEntrypointMarkers(readIfExists(resolve(ROOT, r.module)) ?? '');
        if (entrypoint.length) {
          console.error(
            `       ⚠ CLI ENTRYPOINT (${entrypoint.join(', ')}) — its caller is a person running \`tsx ${r.module}\`,`,
          );
          console.error(
            '         which this axis structurally cannot see. Retiring it removes operator tooling;',
          );
          console.error(
            '         "wire it" is usually wrong too. Prefer invoking it from a script/package.json so it is reachable.',
          );
        }
      }
      console.error('   WIRE it (call it from a blocking path) or DELETE it. A unit test is not a caller,');
      console.error('   and a plan code-truth citation proves the code EXISTS, never that anything RUNS it.');
    }

    const invalidAcknowledgedDispositions = (moduleAxis.unclassified ?? []).filter((row) =>
      ACKNOWLEDGED_UNREACHABLE_MODULES.has(row.module),
    );
    if (invalidAcknowledgedDispositions.length) {
      failed = true;
      console.error(
        `\n❌ ${invalidAcknowledgedDispositions.length} acknowledged detector module(s) have an invalid shipment disposition:`,
      );
      for (const row of invalidAcknowledgedDispositions) {
        console.error(`     ${row.module}`);
        for (const error of row.shipmentDisposition?.errors ?? []) console.error(`       ${error}`);
      }
      console.error(
        '   Acknowledged modules must carry a structured dead/delete decision or an approved seam decision plus test.',
      );
    }

    // ── The acknowledgement REASONS must match what was measured ────────────────
    // The list above pairs a path with prose a human typed, and that prose is what a
    // burn-down reads when it decides what to delete. Measured 2026-08-26: 3 of 20
    // reasons claimed "no caller" for modules with real production importers, and the
    // falsest of them nominated a leaf that two siblings import as the "strongest retire
    // candidate". Prose describing code is derived, pinned, or attested — never trusted.
    const inaccurateAcks = findInaccurateAcknowledgements({
      rows: moduleAxis.rows ?? [],
      acknowledgements: ACKNOWLEDGED_UNREACHABLE_MODULES,
    });
    if (inaccurateAcks.length) {
      failed = true;
      console.error(
        `\n❌ ${inaccurateAcks.length} acknowledged-unreachable REASON(s) contradict the measured import graph:`,
      );
      for (const v of inaccurateAcks) {
        console.error(`     ${v.module}`);
        console.error(`       reason claims: "${v.reason}"`);
        console.error(
          `       but ${v.claim === 'no-caller' ? 'it IS imported by' : 'it IS imported by test(s)'}: ${v.contradictedBy.slice(0, 3).join(', ')}`,
        );
      }
      console.error('   Correct the reason to match the measurement. These strings drive retire decisions,');
      console.error('   so a false one gets working code deleted — see plan green-main-fast-2026-08-25 D-018.');
    }

    if (moduleAxis.staleAcknowledged.length) {
      failed = true;
      console.error(
        `\n❌ ${moduleAxis.staleAcknowledged.length} STALE acknowledged-unreachable module entr(ies) — now wired or deleted:`,
      );
      for (const m of moduleAxis.staleAcknowledged) console.error(`     ${m}`);
      console.error('   Remove them; the ratchet only counts if a paid-down entry leaves the set.');
    }

    if (ACKNOWLEDGED_UNREACHABLE_MODULES.size > UNREACHABLE_MODULES_HIGH_WATERMARK) {
      failed = true;
      console.error(
        `\n❌ acknowledged-unreachable-modules set exceeds its watermark: ${ACKNOWLEDGED_UNREACHABLE_MODULES.size} > ${UNREACHABLE_MODULES_HIGH_WATERMARK}.`,
      );
      console.error('   This set is SHRINK-ONLY. Wire or delete the module instead of appending here.');
    }
  }

  if (failed) {
    // The JSON report was written before the diagnostics. Preserve the failure
    // status without aborting the asynchronous stdout write (EI-19455452259628697).
    process.exitCode = 1;
    return;
  }
  // State the acknowledged debt in the PASS line. A green that reads "everything is
  // enforced" while 13 guards are not is the same quotable-green this script exists to
  // stop — the number has to be visible in the ordinary output, not only on failure.
  const enforced = census.rows.length - census.notEnforced.length;
  // The two populations are reported SEPARATELY: rolling them into one number would let a
  // by-design exclusion read as debt that someone is expected to burn down — and burning
  // down `lint:cell-matrix` means wiring it, which red-pins the fleet (WI-39832).
  const ungateable = census.notEnforced.filter((r) => ACKNOWLEDGED_UNGATEABLE.has(r.name)).length;
  const debt = census.notEnforced.length - ungateable;
  if (!json) {
    console.log(
      `\n✓ no NEW unenforced lint guard. ${enforced}/${census.rows.length} enforced; ` +
        `${debt} acknowledged-unenforced (ceiling ${UNREACHABLE_HIGH_WATERMARK}, shrink-only)` +
        (ungateable ? `; ${ungateable} ungateable by design (never wire these)` : '') +
        '.',
    );
    if (census.notEnforced.length) {
      console.log('  Burn it down: `node scripts/check-lint-guard-reachability.mjs --census` lists each one and why.');
    }
    // The KNOWN LIMITATION at the top of this file has to travel WITH the number, not sit in a
    // source comment the reader of the number never opens. "68/82 enforced" invites exactly one
    // wrong conclusion — "the tree is protected" — and that conclusion has already been drawn
    // and already cost an outage: on 2026-08-03 a parse-breaking edit crash-looped :3170 for
    // 17min while every guard that could have caught it was, by THIS measure, fully enforced.
    // The coverage axis has to appear on the SAME line as the enforced count, not below it.
    // "68/82 enforced" was read as "the tree is protected" while a guard covering 1 of its 4
    // scanned roots sat inside that numerator (EI-19461064447747454) — a per-GUARD boolean
    // rendered as if it were a per-SCOPE one. Any reader of the number sees the qualifier now.
    if (census.partiallyCovered.length || census.coverageUnmeasured.length) {
      console.log(
        `  ⚠ of those ${enforced}: ${census.partiallyCovered.length} enforced over only PART of what they scan, ` +
          `${census.coverageUnmeasured.length} with coverage NOT measured.\n` +
          '    ENFORCED is a per-GUARD boolean, never a per-SCOPE one — `--census` breaks it down.',
      );
    }
    console.log(
      '  ⚠ ENFORCED = a blocking path RUNS it, never that it runs BEFORE the damage. Hosts that\n' +
        '    bundle the WORKING TREE (:3170, bg-host) are past every commit-time guard by construction.',
    );
    // The module debt goes in the PASS line for the same reason the script debt does: a
    // green that reads "guards are enforced" while 21 detector modules run nowhere is
    // exactly the quotable-green this file exists to stop.
    if (!moduleAxis.measurable) {
      console.log(`  ⚠ module axis NOT MEASURED — ${moduleAxis.reason}.`);
    } else {
      const tested = moduleAxis.dead.filter((r) => r.testedButUnwired).length;
      console.log(
        `  ⚠ separately, ${moduleAxis.dead.length}/${moduleAxis.population} lib/release detector MODULES are called by no ` +
          `production path (${tested} of them tested, so they read as covered)\n` +
          `    — acknowledged, ceiling ${UNREACHABLE_MODULES_HIGH_WATERMARK}, shrink-only. \`--census\` lists each one.`,
      );
    }
  }
  // Keep the JSON path machine-readable and let Node drain it before the process ends.
  process.exitCode = 0;
  return;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
