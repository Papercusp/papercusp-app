#!/usr/bin/env node
/**
 * check-no-raw-install-slug-filter.mjs — fail-loud guard against NEW read paths that
 * filter `harness_slug` by a routine's RAW `installSlug` (EI-19298972043721870).
 *
 * THE TRAP. Pot-membership enforcement canonicalizes the WRITE path: a row written
 * under a workspace-global label (`hive-canary`, `@singleton`, `*`, `operator`, `all`,
 * `operator:<ws>`, the bare workspace id — see WORKSPACE_GLOBAL_LABELS in
 * pot-membership.ts) is re-homed to the platform Pot. A READ that filters
 * `harness_slug = ${installSlug}` verbatim therefore matches ZERO ROWS, forever —
 * with no error and no warning.
 *
 * For a DETECTOR that is indistinguishable from "everything is healthy", which is why
 * it survived ~12 days unnoticed (EI-19298246923137692): six canaries sat open with
 * their reported-stamps NULL while the 15-minute SLA sweep reported success on every
 * single tick. A guard is the only thing that catches this class, because the failure
 * mode is silence.
 *
 * THE FIX at a flagged site is `routineStorageSlug(installSlug, workspaceId)`
 * (pot-membership.ts) — the SAME resolver the write path uses, so reads and writes
 * agree by construction, including for labels added to that set later.
 *
 *   node scripts/check-no-raw-install-slug-filter.mjs
 *
 * ⚠ A FLAGGED SITE IS NOT AUTOMATICALLY A BUG. Only relations subject to re-homing are
 * affected. A pot-scoped or install-scoped table is CORRECTLY read by the literal slug.
 * Resolve a hit by checking the RELATION, never by pattern-matching the call site — a
 * blind sweep would be wrong, which is exactly why the pre-existing sites are
 * grandfathered below rather than mass-rewritten.
 *
 * ⚠ `installSlug` stays correct for registry self-gating, pause resolution, log lines
 * and watchdogKeys (stable alarm identity). Only DB ROW ADDRESSING moves.
 *
 * The predicate (usesRawInstallSlugFilter) is exported + unit-tested
 * (packages/operator-core/lib/pot-membership-raw-slug-guard.test.ts) so the
 * "fails on a NEW raw filter" property is durably verified, not merely
 * green-on-a-clean-tree.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/** Permanently-allowed individual files. */
export const ALLOWLIST = new Set([
  // This guard itself: its prose contains the very pattern it bans (same reason
  // check-no-raw-setinterval allowlists its own definition site).
  'scripts/check-no-raw-install-slug-filter.mjs',

  // ── RELATION VERDICT: harness_shared.harness_escalations is NOT re-homed ──────────
  // WI-6978, audited 2026-08-02. A raw-installSlug filter on this relation is CORRECT
  // and must NOT be "fixed" into routineStorageSlug() — that would rewrite the read away
  // from the rows the writes actually produce. Recorded ONCE here and shared by every
  // file below that reads only this relation; re-audit if a writer ever starts resolving
  // the slug for this table.
  //
  // Settled on the RELATION, three independent ways, not on the call-site pattern:
  //  1. TRIGGERS — harness_escalations carries only capture_git_export_outbox,
  //     emit_change_notify and a tsv-update trigger. No trigger rewrites harness_slug,
  //     and no re-home trigger exists on ANY of the candidate tables: re-homing here is
  //     purely application-level (routineStorageSlug → resolveWorkItemPot), never a DB
  //     rewrite. So "check pg_trigger" alone cannot settle a relation — it returns empty
  //     for every table here, which LOOKS like a clean answer and is not one. Checking
  //     the WRITE PATHS is what settles it.
  //  2. WRITE PATHS — all ~19 source writers to harness_escalations insert a RAW slug
  //     (`${row.install_slug}` / `${harnessSlug}`); not one calls routineStorageSlug.
  //     (A repo-wide grep shows a single routineStorageSlug co-occurrence, in
  //     apps/operator/dist-host/hono-host.mjs — a whole-app BUILD BUNDLE, not a writer.)
  //     Reads and writes therefore agree, which is the property that matters.
  //  3. LIVE DATA — rows are stored under real harness slugs (papercusp 61 rows incl. a
  //     release-trigger row, newest 2026-08-02T07:42Z; papercup, oddsmith, quartermaster,
  //     per-instance slugs). Nothing is collapsed under the platform Pot, which is the
  //     signature the re-homing bug leaves behind.

  // Covers all 4 sites (the RELEASE_TRIGGER_FREEZE / FIRE_STALE escalation reads).
  'packages/operator-core/lib/release/green-stall-watchdog.ts',

  // GRADUATED 2026-08-02 (WI-6978). Covers both sites — :185 (the "already paged this
  // episode" latch read) and :265 (the recovery-leg UPDATE). harness_escalations is this
  // file's ONLY relation, so the verdict above applies whole.
  //
  // Two further reasons specific to THIS file, either of which is independently
  // sufficient — so it is not resting on the shared verdict alone:
  //  4. ITS OWN WRITE IS RAW — the INSERT at :228 stores `${installSlug}` verbatim.
  //     Read and write are in the same function and agree by construction, so this
  //     watchdog cannot be blinded to rows it produced itself.
  //  5. THE SLUG CANNOT BE A RE-HOMING TRIGGER — `installSlug` here is NOT a routine's
  //     `install_slug` (the thing the trap needs). :299 resolves it from
  //     `operatorHomeHarnessSlug()` — env PAPERCUSP_POT_HOME_SLUG, else the
  //     LEGACY_DEFAULT_HOME_HARNESS constant, which is 'papercusp'. That is a concrete
  //     hive slug by construction: never a member of WORKSPACE_GLOBAL_LABELS
  //     ({operator, *, @singleton, all, hive-canary}), and NOT the 'papercup' /
  //     'papercup-hive' pair that canonicalPotSlug() folds to the platform Pot — the
  //     second, easily-missed re-homing path. So even if this relation WERE re-homed,
  //     this call site could not reach the trap.
  //
  // Confirmed live: the row for phase 'release-deploy-staleness-watchdog' is stored
  // under harness_slug='papercusp' — exactly what :185/:265 filter on — not under the
  // platform Pot.
  'packages/operator-core/lib/release-deploy-staleness-watchdog.ts',

  // ── RELATION VERDICT: harness_shared.autoloop_state is NOT re-homed ───────────────
  // WI-6978, audited 2026-08-02. Covers the single flagged site in each of the two files
  // below (autoloop_state is the only relation either one filters by raw installSlug).
  //
  // The LIVE DATA here is the strongest evidence of any relation audited so far, because
  // it exhibits the re-homing trigger itself surviving un-rewritten:
  //   • 57 rows under harness_slug = '*' and 1 under '@singleton' — both members of
  //     WORKSPACE_GLOBAL_LABELS, i.e. precisely the labels that re-homing collapses to
  //     the platform Pot. Stored VERBATIM, so no re-home ran.
  //   • MEMBER slugs survive uncollapsed: 'oddsmith' (1) and 'papercusp-public-site' (4),
  //     where the re-homed harness_plans instead holds 'oddsmith-hive' /
  //     'papercusp-public-site-pot' and ZERO rows under the member slug. Same workspace,
  //     same registry, opposite storage shape — that contrast IS the discriminator.
  //   • 'papercup' survives (1 row) though canonicalPotSlug() folds exactly that slug to
  //     the platform Pot, so that second re-homing path is not applied either.
  // No writer resolves the slug by any of the five paths, and the harness-state table
  // registry independently classifies autoloop_state "per-install/per-workspace — NOT
  // slug-shared" (harness-state/table-registry.ts:335), which is the same conclusion
  // reached from the schema side.
  //
  // Both readers additionally derive installSlug through resolvePotHomeSlug(), which
  // canonicalises an alias but does NOT perform the member→Pot-home collapse — so the
  // value they filter on is the same raw-shaped slug the writes use.
  'packages/operator-core/lib/system-health/liveness-alarm.ts',
  'packages/operator-core/lib/overwatch/snapshot.ts',

  // (pot/mug-warm-session.ts held the same autoloop_state verdict here until it was
  // RETIRED to root `_retired/` with the Mug tier — retire-mug-kettle-su-only-2026-08-09
  // P-059. The guard does not scan `_retired/`, so the entry became dead and was removed.)

  // ── RELATION VERDICT: harness_shared.scout_routed_ideas is NOT re-homed ──────────
  // WI-6978, audited 2026-08-02. Four independent legs:
  //  1. LIVE DATA, definitive in BOTH directions — the strongest evidence of any
  //     relation in this audit. 865 rows sit under harness_slug='@singleton', a member
  //     of WORKSPACE_GLOBAL_LABELS, i.e. exactly a label re-homing collapses; stored
  //     verbatim, so no re-home ran. And the MEMBER slug 'oddsmith' survives with 16
  //     rows, where the re-homed harness_plans holds 21 under 'oddsmith-hive' and ZERO
  //     under 'oddsmith'. Same workspace, opposite storage shape.
  //  2. WRITE PATH — routed-ledger.ts:213 writes `harness_slug = ${input.harnessSlug}`
  //     RAW. ⚠ That file DOES call potHomeSlugForHarness (:195), but it feeds a
  //     DIFFERENT COLUMN (`source_hive`, the D-003 tag). A file-level resolver grep
  //     therefore returns a FALSE POSITIVE here — always confirm which column the
  //     resolved value lands in before reading a hit as "re-homed".
  //  3. THE READER'S OWN DOC says so independently: ungraded-filings-watchdog.ts:152
  //     — "the ledger row carries the pot's REAL workspace_id + harness_slug (the
  //     capture bridge stamps both)".
  //  4. REGISTRY — falls to DEFAULT (slug-shared, sync:'none'); not federated.
  'packages/operator-core/lib/scout/ungraded-filings-watchdog.ts',

  // ── RELATION VERDICT: harness_shared.plan_runs is NOT re-homed ───────────────────
  // WI-6978, audited 2026-08-02. Note this file is a MIXED case and the mix is the
  // whole point: its harness_plans sites (:108/:162 and the instance-plan INSERT) WERE
  // converted to routineStorageSlug, because that relation IS re-homed. What remains
  // raw are the two plan_runs ledger reads, which are correct:
  //  • WRITE PATHS — every writer stores the raw slug: this file's own ledger INSERT
  //    (`${installSlug}`) and agent-tools/plans/runs.ts:90 insertPlanRun
  //    (`args.harnessSlug?.trim() || operatorHomeHarnessSlug()`). No writer calls any
  //    of the five re-homing resolvers.
  //  • READ PATHS agree — plan_runs is elsewhere addressed self-referentially (runs.ts
  //    :446 mirrors the parent run's own harness_slug) or by a caller-supplied slug;
  //    nothing reads it under a Pot home.
  //  • REGISTRY — WORKSPACE_OWNED_EXPLICIT, sync:'none', "§7.4 LOCAL Plans =
  //    workspace-scoped" (harness-state/table-registry.ts:336).
  // Resolving these two would move the ledger READS off the rows the ledger WRITES —
  // the mirror image of the bug this guard exists to catch.
  'packages/operator-core/lib/harness/routines/plan-run-action.ts',

  // ── RELATION VERDICTS: pr_reviewer_settings + trusted_authors are NOT re-homed ────
  // WI-6978, audited 2026-08-02. Also a MIXED file: its harness_features_consolidated
  // read (:595, upsertFeaturePr) WAS converted — that relation IS re-homed via
  // work-items.ts:1316 resolveWorkItemPot. The two that stay raw:
  //  • pr_reviewer_settings (:527) — sole writer
  //    endpoint-route/routes/harness/pr-reviewer-settings.ts:622 inserts the raw slug,
  //    and the read directly above it in that same function filters the same raw slug,
  //    so read/write agree by construction. Registry: WORKSPACE_OWNED_EXPLICIT
  //    ("per-install/per-workspace"), sync:'none'.
  //  • trusted_authors (:546) — SECURITY-classed (table-registry.ts:371): sync forced
  //    to 'none', never crosses machines. No writer anywhere resolves the slug.
  // ⚠ Both relations DO co-occur with potHomeSlugForHarness in sync-resolver/index.ts,
  // which is a FALSE POSITIVE: that call (:2447) belongs to `hiveRoster.byHarness`.
  // These two reach the resolver through `prReviewerSettings.byHarness`, which passes
  // the harness slug through untouched.
  'packages/operator-core/lib/pr-host/poll-daemon.ts',
]);

/**
 * Pre-existing sites, grandfathered pending the per-relation audit (step 3 of
 * EI-19298972043721870). These are LATENT, not live: the bug only bites when the
 * routine's `install_slug` is a workspace-global label. Measured exposure in
 * `papercusp-workspace` when this guard landed: `hive-canary` (4 routines, 2 active)
 * was the only ACTIVE workspace-global install slug — and it is exactly the one that
 * broke. `@singleton` (15 routines) and `*` (1) were all INACTIVE: a loaded gun, since
 * activating any one of them whose action reads by raw `installSlug` reproduces the
 * silent blindness immediately.
 *
 * This set MUST shrink to empty. Each entry either moves to `routineStorageSlug` or
 * earns an ALLOWLIST entry stating WHY its relation is not subject to re-homing.
 * A NEW file here is a hard guard failure, not a BASELINE addition — that is the ratchet.
 */
/*
 * ✅ THE AUDIT IS COMPLETE — BASELINE IS EMPTY (WI-6978, closed 2026-08-02). Every
 * relation below is settled and every file has either been CONVERTED or earned an
 * ALLOWLIST entry stating why its raw filter is correct. A new file here is a hard
 * guard failure; nothing may be added back.
 *
 * THE FINAL VERDICT TABLE — the durable output of the audit, kept because the next
 * person to touch any of these relations needs it and re-deriving it costs days:
 *
 *   RE-HOMED  (a raw-installSlug filter IS a bug — convert to routineStorageSlug)
 *     harness_plans                   write: resolvePlanScope → potHomeSlugForHarness
 *                                     (agent-tools/plans/source.ts:429; plans are
 *                                     Hive-scoped). Converted: plan-run-action ·
 *                                     ready-plan-autostart · draft-review-watchdog ·
 *                                     harness/routines/claim.
 *     harness_features_consolidated   write: work-items.ts:1316 resolveWorkItemPot,
 *                                     under FLAGS.POT_MEMBERSHIP_ENFORCEMENT (default
 *                                     ON). Converted: pr-host/poll-daemon:595.
 *
 *   NOT RE-HOMED  (a raw filter is CORRECT — do not "fix" these)
 *     harness_escalations · autoloop_state · scout_routed_ideas · plan_runs ·
 *     pr_reviewer_settings · trusted_authors
 *
 * LATENT, NOT LIVE-BROKEN when this landed: every affected routine in this workspace
 * runs with install_slug='papercusp', which IS the platform Pot home, so the re-home is
 * an identity there and the reads happened to work. That is exactly why it survived —
 * the bug arms itself the moment one of these routines is installed under a member
 * harness or a workspace-global label, and then fails SILENTLY.
 *
 * ── THE METHOD, and the two ways it lies to you ────────────────────────────────────
 * Kept in full because both failure modes produced a CONFIDENT WRONG VERDICT during
 * this audit, in OPPOSITE directions, and neither announced itself as uncertain.
 *
 *   (a) Resolve the RELATION at each flagged site (nearest enclosing
 *       FROM/INTO/UPDATE/JOIN). One file can touch several — poll-daemon touches three,
 *       plan-run-action two — and a mixed file needs every one settled before it moves.
 *   (b) Grep every writer for ALL FIVE re-homing resolvers: `routineStorageSlug`,
 *       `resolveWorkItemPot`, `canonicalPotSlug`, `potHomeSlugForHarness`,
 *       `PLATFORM_POT_SLUG`. Ignore apps/operator/dist-host/hono-host.mjs (a whole-app
 *       BUILD BUNDLE — it co-occurs with everything).
 *       ⚠ FALSE NEGATIVE: grepping only `routineStorageSlug` returns CLEAN on
 *         harness_plans, which re-homes via `potHomeSlugForHarness`. Caught one step
 *         before it graduated three genuinely-broken files.
 *       ⚠ FALSE POSITIVE: a resolver hit is NOT evidence until you open the INSERT and
 *         confirm the resolved value lands in `harness_slug` SPECIFICALLY. Twice here it
 *         did not: routed-ledger.ts:195 resolves into a different COLUMN (`source_hive`)
 *         while harness_slug stays raw at :213; sync-resolver/index.ts:2447 resolves for
 *         an unrelated QUERY (`hiveRoster.byHarness`). Reading either as "re-homed"
 *         yields a wrong "convert this" verdict.
 *   (c) LIVE DATA — the discriminator, proven both ways in one workspace: does a MEMBER
 *       slug survive, or only its Hive home? autoloop_state keeps 'oddsmith';
 *       harness_plans holds 21 rows under 'oddsmith-hive' and ZERO under 'oddsmith'.
 *       Cleanest single tell: rows under a workspace-global label ('*', '@singleton')
 *       CANNOT survive a re-homed relation — those labels are exactly what re-homing
 *       collapses. Finding the trigger itself surviving beats any amount of code reading.
 *       ⚠ STRUCTURALLY BLIND for the home harness: PLATFORM_POT_SLUG === 'papercusp' ===
 *         the operator home slug, so "collapsed to the platform Pot" and "correctly
 *         stored" are the SAME OBSERVATION there. Only NON-home slugs carry signal; a
 *         verdict resting on papercusp rows alone is vacuous.
 *       ⚠ NEVER pg_trigger — it is empty for every table here (re-homing is purely
 *         application-level), which reads exactly like a clean bill of health.
 *   (d) Check where the site's installSlug COMES FROM: one derived from
 *       operatorHomeHarnessSlug() is a concrete hive slug and can never trigger
 *       re-homing regardless of the relation.
 *
 * And the meta-lesson worth more than the table: "audit by relation" tells you what to
 * test TOGETHER, never what the answer IS. Two relations settled in the same session
 * came out opposite. Grouping the files by relation was right and cheap — but never let
 * the tidiness of a group imply its verdict.
 *
 * ── historical: the mid-audit state this replaced ──────────────────────────────────
 * ⚠ AUDIT BY RELATION, NOT BY FILE. The remaining entries cover 7 DISTINCT relations,
 * and the verdict is a property of the relation — so auditing one can clear several
 * files at once, and a file touching two relations needs BOTH settled before it moves.
 * Mapped 2026-08-02 (WI-6978) by resolving each flagged site to its nearest enclosing
 * FROM/INTO/UPDATE/JOIN:
 *
 *   harness_plans                   plan-run-action (x2) · ready-plan-autostart ·
 *                                   draft-review-watchdog
 *                                   ⚠ AUDITED — *IS* RE-HOMED (member → Hive home via
 *                                   potHomeSlugForHarness, resolvePlanScope
 *                                   agent-tools/plans/source.ts:429; plans are
 *                                   HIVE-scoped). These 3 need the CONVERSION to
 *                                   routineStorageSlug, NOT an ALLOWLIST entry.
 *                                   Live: 21 rows under 'oddsmith-hive', ZERO under the
 *                                   member slug 'oddsmith'.
 *   autoloop_state                  ✓ AUDITED — NOT re-homed; both files GRADUATED.
 *   plan_runs                       plan-run-action (x2)  ← likely NOT re-homed: the
 *                                   harness-state table registry classes it with
 *                                   autoloop_state as per-install/per-workspace, NOT
 *                                   slug-shared. Confirm before relying on it.
 *   scout_routed_ideas              ungraded-filings-watchdog
 *   pr_reviewer_settings            poll-daemon
 *   trusted_authors                 poll-daemon
 *   harness_features_consolidated   poll-daemon   ← a multi-tenant *_consolidated table:
 *                                   keyed (workspace_id, harness_slug, ...), so a raw
 *                                   filter can silently read ANOTHER TENANT's row
 *
 * The settled method (pg_trigger CANNOT do this — it returns empty for every table here,
 * which reads exactly like a clean bill of health):
 *   (a) resolve the RELATION at each flagged site;
 *   (b) grep every writer to it for ALL FIVE re-homing resolvers — `routineStorageSlug`,
 *       `resolveWorkItemPot`, `canonicalPotSlug`, `potHomeSlugForHarness`,
 *       `PLATFORM_POT_SLUG`;
 *   (c) confirm against live data — rows under real harness slugs mean NOT re-homed,
 *       rows collapsed under the Pot home mean re-homed;
 *   (d) check where the site's `installSlug` COMES FROM: one derived from
 *       operatorHomeHarnessSlug() is a concrete hive slug and can never trigger
 *       re-homing regardless of the relation.
 *
 * ⚠ (b) MUST grep all five, not just `routineStorageSlug`. That narrow grep produces a
 * confident WRONG "not re-homed" verdict: harness_plans re-homes via
 * `potHomeSlugForHarness` (resolvePlanScope, agent-tools/plans/source.ts:429 — plans are
 * HIVE-scoped, so a member harness collapses to its Hive home), which the narrow grep
 * misses entirely. Caught 2026-08-02 one step before it graduated 3 files that are in
 * fact genuinely broken.
 *
 * ⚠ (c) is BLIND for the home harness: PLATFORM_POT_SLUG === 'papercusp' === the operator
 * home slug, so "collapsed to the platform Pot" and "correctly stored under the real
 * slug" are indistinguishable there. The discriminator is whether NON-papercusp slugs
 * SURVIVE — e.g. harness_plans holds 21 rows under 'oddsmith-hive' and ZERO under the
 * member slug 'oddsmith', which is the collapse made visible.
 */
export const BASELINE = new Set([
  // ✅ EMPTY as of 2026-08-02 (WI-6978). The grandfathered set went 9 → 5 → 0.
  //
  // Disposition of all nine, so nobody re-litigates one:
  //   CONVERTED to routineStorageSlug (their relation IS re-homed)
  //     scout/ready-plan-autostart.ts        harness_plans (3 sites — see below)
  //     scout/draft-review-watchdog.ts       harness_plans
  //     harness/routines/plan-run-action.ts  harness_plans (2 reads + the instance
  //                                          INSERT; its plan_runs sites stay raw)
  //     harness/routines/claim.ts            harness_plans (3 sites — see below)
  //     pr-host/poll-daemon.ts               harness_features_consolidated (1 of its 3)
  //   ALLOWLISTED with a stated relation verdict (their relation is NOT re-homed)
  //     release/green-stall-watchdog.ts · release-deploy-staleness-watchdog.ts
  //     system-health/liveness-alarm.ts · overwatch/snapshot.ts
  //     scout/ungraded-filings-watchdog.ts · pot/mug-warm-session.ts
  //     (+ the mixed files plan-run-action.ts and poll-daemon.ts, which are BOTH
  //      converted and allowlisted — one entry each, covering their remaining relations)
  //
  // ⚠ claim.ts and two of ready-plan-autostart's three sites were NEVER IN THIS SET:
  // they spell the filter `${routine.installSlug}` / `${args.installSlug}` and the old
  // predicate matched only the bare identifier, so the guard could not see them. They
  // surfaced only when usesRawInstallSlugFilter was widened
  // (EI-19340006901835339). Which is the standing lesson: an empty BASELINE means
  // "nothing the predicate can see", never "nothing exists". If you find a new spelling
  // of an unresolved install slug, WIDEN THE PREDICATE — do not re-open this set.
]);

export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.includes('/.next/') ||
  f.includes('/build/') ||
  f.includes('/storybook-static/') ||
  f.includes('/code-server/') ||
  f.includes('/env-sidecars/') ||
  f.includes('/spa/assets/') ||
  f.includes('/holepunch-spike/') ||
  /\.(test|spec)\.[cm]?tsx?$/.test(f) ||
  !/\.(ts|mjs|cjs)$/.test(f);

/** Strip block + line comments so PROSE describing the trap isn't flagged as the trap. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * The tell: a SQL filter comparing `harness_slug` to an UNRESOLVED install slug —
 * either the bare `${installSlug}` identifier or any member expression ending in it
 * (`${args.installSlug}`, `${routine.installSlug}`, `${opts.ctx.installSlug}`).
 *
 * It stays narrow in the direction that matters: `harness_slug = ${storageSlug}` /
 * `${planStorageSlug}` / `${await routineStorageSlug(...)}` — the FIX — does not match,
 * because the final path segment must literally be `installSlug`. Comments are stripped
 * first. Pure (text → boolean) so it unit-tests.
 *
 * ⚠ THE MEMBER-EXPRESSION ARM IS NOT A REFINEMENT — it closed a hole that made this
 * guard's headline claim vacuous (EI-19340006901835339, WI-6978). The original pattern
 * matched the BARE identifier only, so `${args.installSlug}` and `${routine.installSlug}`
 * were invisible, and the guard printed "✓ no NEW offenders" over a corpus it had never
 * examined. That is precisely the absence-rendering-as-a-clean-verdict shape this file
 * exists to catch — the same reasoning the `unscannedPresent` logic below applies to the
 * FILE SET, applied to the PATTERN. Measured when widened: 6 previously-unseen sites in
 * 3 files, 5 of them genuine latent bugs on the re-homed `harness_plans` relation
 * (harness/routines/claim.ts ×3, scout/ready-plan-autostart.ts ×2).
 *
 * The sharpest case was scout/ready-plan-autostart.ts, which was ALREADY grandfathered
 * for its bare-identifier site: an auditor could have fixed that one site, watched the
 * guard go green, and shipped with two more broken filters in the very same file.
 *
 * So: if you ever find a NEW way to spell an unresolved install slug, widen this
 * predicate — do not add the file to a baseline.
 */
export function usesRawInstallSlugFilter(text) {
  return /harness_slug\s*=\s*\$\{\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\s*\.\s*)*installSlug\s*\}/.test(
    stripComments(text),
  );
}

/**
 * The CLEAN-path verdict line. Pure (counts → string) so the property that matters —
 * an incomplete corpus NEVER renders as a clean bill of health — is unit-testable
 * rather than green-on-a-clean-tree only.
 *
 * EI-19298378364087215. This guard establishes a NEGATIVE ("no file filters
 * harness_slug by a raw installSlug"), and an incomplete enumeration cannot establish
 * a negative at all. In an archive-extracted release/checkpoint checkout,
 * `git ls-files --recurse-submodules` cannot descend into ANY submodule (no `.git` to
 * descend into) — measured 2026-08-02: `git -C papercup-checkpoint submodule status`
 * prints the uninitialised `-` prefix for every one of the 39. The scan then silently
 * covers the superproject alone and a "✓ no NEW offenders" line would be asserting a
 * repo-wide absence from ~79% of the repo.
 *
 * Keyed on `unscannedPresent`, NOT on bare `unscanned`, for the reason
 * check-vacuous-negative-assertions.mjs documents at its own call site: this repo
 * permanently carries one deliberately-absent submodule (libs/zero-harness, retired
 * and uninitialised on purpose), so an alarm keyed on `unscanned` fires on every run
 * in a perfectly healthy tree and is trained away — worthless exactly when it matters.
 *
 * Deliberately does NOT change the exit code. An archive-extracted checkout is BY
 * DESIGN, so failing there would red the gate permanently and get this guard
 * allowlisted out of existence. What is wrong in that tree is the CLAIM, not the
 * build: so the verdict is downgraded and the reader is told it is not a pass.
 */
export function formatCleanVerdict({ scanned, grandfathered, unscannedPresent }) {
  if (unscannedPresent > 0) {
    return (
      `⚠ INCOMPLETE — cannot establish "no NEW raw-installSlug harness_slug filters". ` +
      `${scanned} file(s) read, but ${unscannedPresent} submodule(s) whose files are ON DISK ` +
      `were never enumerated, so an offender inside them is reported exactly like an absent one. ` +
      `Treat this as UNKNOWN, not as a pass; re-run where the enumeration is whole ` +
      `(${grandfathered} grandfathered pending per-relation audit).`
    );
  }
  return (
    `✓ no NEW raw-installSlug harness_slug filters (${scanned} files scanned; ` +
    `${grandfathered} grandfathered pending per-relation audit).`
  );
}

function main() {
  const scan = listTrackedFiles(ROOT);
  const { files: tracked, unscannedPresent } = scan;
  const files = tracked.filter((f) => !isExcluded(f) && !ALLOWLIST.has(f));
  const offenders = [];
  const baselineStillDirty = new Set();
  /** Files this run actually READ — the only ones it can conclude anything about. */
  const evaluated = new Set();

  for (const f of files) {
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue; // deleted between enumeration and read
    }
    evaluated.add(f);
    if (!usesRawInstallSlugFilter(text)) continue;
    if (BASELINE.has(f)) baselineStillDirty.add(f);
    else offenders.push(f);
  }

  // A BASELINE entry that is now CLEAN should be removed, or the ratchet silently
  // loosens: a stale grandfather keeps protecting a file that no longer needs it, so a
  // regression in that same file would be admitted without failing.
  //
  // ⚠ Gated on `evaluated`, not on mere absence from baselineStillDirty. A file this run
  // never READ is UNKNOWN, not clean — and an absence-ratchet that treats the two alike
  // demands you delete a grandfather that is still dirty, which ADMITS the very
  // regression the entry exists to catch. That is not hypothetical: it is the same
  // defect that made child-output-guard's ratchet emit `fixed — DELETE this key` against
  // an archive-extracted checkout (EI-19298378364087215). Every BASELINE path is in the
  // superproject today, so no submodule blindness reaches this line yet; keying it on
  // what was actually read means a future entry under libs/* cannot reintroduce it.
  const staleBaseline = [...BASELINE].filter((f) => evaluated.has(f) && !baselineStillDirty.has(f));
  const unverifiableBaseline = [...BASELINE].filter((f) => !evaluated.has(f));

  if (unverifiableBaseline.length) {
    console.error(
      `\n  ⚠ ${unverifiableBaseline.length} BASELINE entr(ies) were never read this run — ` +
        `NOT judged clean, and deliberately not reported as stale:\n` +
        unverifiableBaseline.map((f) => '    ' + f).join('\n'),
    );
  }

  if (!offenders.length && !staleBaseline.length) {
    console.log(
      formatCleanVerdict({
        scanned: evaluated.size,
        grandfathered: baselineStillDirty.size,
        unscannedPresent: unscannedPresent.length,
      }) + describeUnscanned(scan),
    );
    return;
  }

  if (staleBaseline.length) {
    console.error('\n  BASELINE entries that are now CLEAN — remove them from');
    console.error('  scripts/check-no-raw-install-slug-filter.mjs so the ratchet keeps its teeth:\n');
    for (const f of staleBaseline) console.error('    ' + f);
  }

  if (offenders.length) {
    console.error('\n  NEW read path(s) filtering harness_slug by a RAW installSlug.\n');
    console.error('  A row written under a workspace-global label is RE-HOMED to the platform Pot,');
    console.error('  so this filter can match ZERO rows forever — silently, which for a detector is');
    console.error('  indistinguishable from "everything is healthy" (EI-19298246923137692).\n');
    console.error('  Use routineStorageSlug(installSlug, workspaceId) from pot-membership.ts, which');
    console.error('  resolves through the SAME path the WRITE side uses.\n');
    console.error('  If this relation is genuinely NOT re-homed (pot-scoped / install-scoped table),');
    console.error('  add it to ALLOWLIST with the reason — check the RELATION, not the call site.\n');
    for (const o of offenders) console.error('    ' + o);
    console.error(`\n  ${offenders.length} offender(s). See EI-19298972043721870.`);
  }
  process.exit(1);
}

// Run the scan only when invoked as a CLI — importing the module (for the unit test)
// must NOT exec git / exit the process. Symlink-robust (WI-1443).
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}
