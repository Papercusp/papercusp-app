#!/usr/bin/env node
/**
 * lint:migrations — migration-file discipline (audit P-074, EI-170).
 *
 * Four checks over libs/papercusp/libs/db/sql/*.sql (the live dir only —
 * archive/ holds pre-baseline history):
 *
 *   1. DUPLICATE NNN — two files sharing a numeric prefix. The reservations
 *      ledger (db:next-migration) prevents races going forward, but a renumber
 *      mistake or an unreserved hand-pick can still collide (205/206 both
 *      carry renumber-after-collision histories).
 *   2. RAW TRANSACTION CONTROL — top-level `BEGIN;` / `COMMIT;` / `ROLLBACK;`
 *      / `START TRANSACTION;` outside dollar-quoted bodies. The migration
 *      runner wraps every file in BEGIN … <ddl> … <ledger INSERT> … COMMIT
 *      (embedded-postgres-server/src/migration-runner.js) — an inner COMMIT
 *      ends that transaction early, so the apply+record pair stops being
 *      atomic and a mid-file failure leaves the ledger lying. plpgsql bodies
 *      ($$ … BEGIN … END … $$) are fine and ignored. Enforced from
 *      ENFORCED_FROM like the reservation check: 51 already-applied legacy
 *      files (116–200) carry their own BEGIN/COMMIT from before the
 *      runner-wraps contract — they are ledgered history (editing them would
 *      NOT re-run them; see the note on ENFORCED_FROM below) and are reported
 *      informationally only.
 *   3. UNGUARDED RENAME CONSTRAINT — a bare top-level `RENAME CONSTRAINT`.
 *      `ALTER TABLE IF EXISTS … RENAME CONSTRAINT` guards the TABLE, not the
 *      CONSTRAINT, so it throws 42704 whenever the constraint is absent — which
 *      is how migration 592 came to fail on EVERY database and break every
 *      fresh-DB integration test in the repo (WI-4547). It looks guarded, so
 *      review misses it; the guarded DO-block form passes. Enforced from
 *      ENFORCED_FROM (applied history is immutable and already survived).
 *   4. UNIQUE-INDEX SHAPE SWAP — dropping a table's index in the SAME migration
 *      that creates its unique replacement. PostgreSQL infers an `ON CONFLICT`
 *      target by MATCHING a unique index, so changing that index's shape breaks
 *      every spec written against the old one AT PLAN TIME — every write. On a
 *      shared database the migration lands when any operator boots while code
 *      lands per-deploy, so this breaks every not-yet-deployed reader even when
 *      the code fix rides in the same commit. Already caused three outages on
 *      these tables (461, 564, 689). Must be two-phase. Enforced from
 *      INDEX_SWAP_ENFORCED_FROM; `-- lint-migrations: allow-index-swap <reason>`
 *      opts a genuinely-safe swap out.
 *   4b. VIEW LOCK-ORDER INVERSION — `ALTER TABLE <t>` and THEN
 *      `CREATE OR REPLACE VIEW <v>` where `<v>` selects from `<t>`, with no
 *      up-front lock on `<v>`. A reader locks view → table; this locks table →
 *      view, which on a hot table deadlocks against a reader caught between the
 *      two. The failure MISLEADS: it first surfaces as `lock timeout`, and the
 *      documented lever for that (widening lock_timeout) queues the whole fleet
 *      and converted 721's timeout into a deadlock. Fix is two LOCK TABLE lines
 *      in reader order. Enforced from VIEW_LOCK_ORDER_ENFORCED_FROM;
 *      `-- lint-migrations: allow-view-lock-order <reason>` opts out.
 *      Dynamic `EXECUTE format(...)` pairs whose relation names cannot be
 *      recovered fail closed unless the author records the reviewed order with
 *      `-- lint-migrations: dynamic-view-lock-order <reason>`.
 *
 *   4c. VIEW DROP WITHOUT A DEPENDENT ACCOUNT — `DROP VIEW <v>` (bare OR
 *      CASCADE, static or via `EXECUTE format(...)`) with no stated reason why
 *      `<v>`'s dependents are safe. A bare drop of a depended-on view ERRORS at
 *      apply (678 crash-looped a real operator's boot); a CASCADE drop SILENTLY
 *      destroys the dependents and, because migrations run once, destroys them
 *      PERMANENTLY (374 removed harness_shared.fleet_assignment fleet-wide;
 *      375 restored it by hand). Enforced from VIEW_DROP_ENFORCED_FROM;
 *      `-- lint-migrations: allow-view-drop <reason>` opts out.
 *   5. UNRESERVED NUMBER — every NNN ≥ ENFORCED_FROM must have a row in
 *      harness_shared.migration_reservations (i.e. was allocated via
 *      db:next-migration, not `ls | tail`). Skipped with a notice when PG is
 *      unreachable (CI without a database).
 *
 * All checks but the last are pure-filesystem and always run. Exit 1 on any
 * violation.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import { resolveScriptPgUrl } from "./lib/pg-url.mjs";
import { selectExplicitBasenames } from "./lib/explicit-files.mjs";
import {
  isLiveCodeAt,
  stripSqlComments,
  stripSqlCommentsAndStrings,
} from "./lib/strip-comments-and-strings.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SQL_DIR = join(ROOT, "libs/papercusp/libs/db/sql");

/**
 * Reservation discipline starts here. Originally 215 (2026-06 dispatch), but
 * this lint's own SCAN was never wired into an automated gate (EI-6843) — only
 * a manual `npm run lint:migrations` invoked it, which nobody ran — so real
 * violations (3 duplicate-NNN pairs, 41 raw-tx-control files, ~75 unreserved
 * numbers) accumulated PAST 215 ungated for months, all already applied and
 * ledgered (effectively frozen — editing one now is a silent no-op on every DB
 * that already ran it; see WHY APPLIED FILES ARE FROZEN below).
 * Re-baselined to the current on-disk max (2026-07-04) so this
 * boundary reflects reality: everything through 493 is grandfathered as
 * already-tolerated legacy, and enforcement is now WIRED into the automated
 * suite (lint-migrations.test.ts's "real sql/ directory" describe block, which
 * `test:affected`/the green-checkpoint gate runs on every candidate) so a
 * FUTURE violation is caught immediately instead of silently repeating this
 * exact gap. Bump this again only when deliberately re-grandfathering more
 * historical debt — never to silence a genuinely NEW violation. */
export const ENFORCED_FROM = 494;

/**
 * WHY APPLIED FILES ARE FROZEN (and why it is NOT a checksum guard).
 *
 * Earlier revisions of this file claimed applied migrations are protected
 * because "the runner verifies each by sha256, so editing one would break its
 * recorded checksum". That is FALSE, and worth stating plainly because the
 * truth is a WORSE hazard, not a milder one.
 *
 * The runner (embedded-postgres-server/src/migration-runner.js) keys purely on
 * FILENAME: `harness_shared.schema_migrations` has `filename` as its PRIMARY
 * KEY, the applied set is built with `SELECT filename FROM …`, and the skip is
 * a bare `if (applied.has(f)) continue;`. A sha256 IS computed and INSERTed
 * alongside each row — but it is never SELECTed back, never compared, by the
 * runner or by anything else in the repo (migration-drift.ts likewise reads
 * `SELECT filename … ORDER BY filename`). It is a write-only audit column.
 *
 * So editing an already-applied migration does not break anything loudly. It
 * does something quieter and worse:
 *   - on every DB that already applied the file, the edit is a NO-OP — the
 *     file is skipped by filename and the new DDL never runs;
 *   - on a FRESH DB, the edited version DOES apply.
 * The two populations silently diverge, and because no checksum is ever
 * validated, NOTHING detects the divergence.
 *
 * Practical consequence: to change already-applied schema, always author a NEW
 * numbered migration (`node scripts/next-migration.mjs`). Do not edit the old
 * file, and do not bother "fixing" its sha256 row — no code reads it.
 */

/*
 * THE TWO MASKS BELOW, AND WHY THIS FILE NEEDS BOTH (WI-37800).
 *
 * These detectors used to share one private `stripSqlBodies`. That was wrong twice over, and
 * both faults were measured on the live corpus rather than reasoned about:
 *
 * 1. ITS TAG REGEX WAS WRONG, AND THE BUG WAS LOAD-BEARING. It matched `/^\$[A-Za-z_]*\$/`, but
 *    PostgreSQL allows DIGITS in a dollar-quote tag after the first character. So `$$` and
 *    `$body$` were sealed while `$mig377$` was NOT — leaving that body's DDL live. Whether a
 *    `DO` block's contents were visible to a lint therefore depended on whether its author
 *    happened to put a digit in the tag. Migration 377's in-`DO` unique-constraint swap was
 *    detected ONLY by that accident.
 *
 * 2. THE CALL SITES WANT OPPOSITE MASKS, so no single stripper — however correct — can serve
 *    them. Fixing the tag bug ALONE would have sealed `$mig377$` and silently dropped that
 *    detection (findUniqueIndexShapeSwap: 6 firing files -> 5), with every test still green,
 *    because no test covered it. The tag fix and this split had to land together.
 *
 * The axis is `dollarBodies`, and the right value follows from what a hit INSIDE a body means
 * for that particular detector — a false positive, or a real finding:
 */

/**
 * For detectors judging TOP-LEVEL SQL: a dollar-quoted body is an opaque literal.
 * A hit inside a body is a FALSE POSITIVE here — it is not top-level SQL, and for
 * `findUnguardedConstraintRename` the in-`DO` form is that lint's own documented FIX SHAPE,
 * so flagging it would flag the fix.
 */
const maskSealingBodies = (sqlText) => stripSqlCommentsAndStrings(sqlText);

/**
 * For detectors judging DDL WHEREVER IT EXECUTES: a dollar-quoted body is PL/pgSQL CODE.
 * Comments and strings inside the body are still blanked, but its statements stay live —
 * a DROP + re-ADD of a unique constraint inside a `DO` block really runs, and really breaks
 * every `ON CONFLICT` written against the old shape. Sealing it is a FALSE NEGATIVE on a
 * safety lint.
 */
const maskLiveBodies = (sqlText) => stripSqlCommentsAndStrings(sqlText, { dollarBodies: "code" });

/** Top-level transaction-control statements found in a migration file. */
export function findRawTxControl(sqlText) {
  // SEALED: a `COMMIT` inside a PL/pgSQL body is not top-level transaction control.
  const stripped = maskSealingBodies(sqlText);
  const hits = [];
  const re =
    /^\s*(BEGIN\s*;|BEGIN\s+(?:TRANSACTION|WORK)\b|COMMIT\b|ROLLBACK\b|START\s+TRANSACTION\b)/gim;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    hits.push(m[1].trim().replace(/\s+/g, " "));
  }
  return hits;
}

/**
 * FROZEN offenders: applied files whose tx-control red no sanctioned action can clear.
 *
 * THE DEADLOCK THIS RESOLVES (WI-41119). Check #2 below fails any file ≥
 * ENFORCED_FROM carrying top-level BEGIN/COMMIT, and tells you to remove it. But
 * once that file is APPLIED, the migration-immutability guard (WI-38352) REFUSES
 * the edit — correctly, because the runner keys its ledger by filename, so an
 * edit would silently diverge fresh installs from applied ones (see WHY APPLIED
 * FILES ARE FROZEN above). A new migration cannot help either: this lint reads
 * the OLD FILE'S BYTES, which no later migration changes.
 *
 * So the two rails contradict each other and the check goes permanently red — and
 * because lint:migrations is a green-checkpoint GATE check
 * (apps/operator/lib/release/green-checkpoint.ts), that red-pins the gate
 * fleet-wide until someone notices why it cannot be fixed.
 *
 * WHY THIS IS A LIST AND NOT "exempt every applied file". The gate applies pending
 * migrations in its own preflight BEFORE judging. So a brand-new offender would
 * already be APPLIED — and therefore exempt — by the time the lint ran, which
 * would defang the check exactly when it is supposed to fire. Automatic exemption
 * is worse than no check. Entry here must be DELIBERATE.
 *
 * ADDING AN ENTRY IS NOT A FIX — IT IS AN ADMISSION that a bad migration escaped
 * to applied state. Fix the escape, not the symptom. This list is SHRINK-ONLY in
 * intent: it exists for files that are already frozen, never as a bypass for work
 * you could still correct. A listed file that is NOT actually applied is a HARD
 * ERROR (see unappliedFrozenExemptions) precisely so it cannot be used that way.
 */
export const FROZEN_TXCTL_EXEMPTIONS = new Map([
  [
    "923-typed-goal-plan-properties.sql",
    "Applied 2026-08-23T22:02:43Z (committed in the libs/papercusp submodule at 21:56:02Z, e9f98454). Carries BEGIN; / COMMIT;. The immutability guard refuses the edit this lint prescribes, so the red is otherwise permanent and gate-blocking. Filed as WI-41119.",
  ],
  [
    "972-completion-authority-content-identity-floor.sql",
    "Applied 2026-08-26T11:49:09Z (committed in the libs/papercusp submodule at 11:48:48Z, e3f8f4c7). Carries a top-level BEGIN; at line 47 and COMMIT; at line 128. The immutability guard refuses the edit this lint prescribes, so the red is otherwise permanent and gate-blocking — the third occurrence of the WI-41119 deadlock class (see also EI-21539300249506308, where the same intersection blocked lint:migration-forward-compat). On this check's own hazard model the residual risk is closed: the hazard is that an early COMMIT ends the runner-provided transaction and leaves LATER statements running unprotected, and here COMMIT; is the FINAL line of a 128-line file, so no statement follows it. The file applied cleanly and its ledger row exists.",
  ],
]);

/**
 * FROZEN offenders for the index-swap check (#6) — the WI-41119 deadlock, second
 * rule. The sanctioned fix for a genuinely-safe swap is the in-file
 * `-- lint-migrations: allow-index-swap <reason>` pragma, but once the file is
 * APPLIED the migration-immutability guard (WI-38352) refuses that edit exactly
 * like any other, so a safe-but-applied swap would red-pin the gate permanently.
 * Entry rules are identical to FROZEN_TXCTL_EXEMPTIONS: deliberate, reasoned,
 * SHRINK-ONLY in intent, and a listed file that is NOT actually applied is a
 * hard error (unappliedFrozenExemptions) so the list cannot become a bypass.
 * An entry must state why the swap is safe ON THE CHECK'S OWN HAZARD MODEL
 * (no ON CONFLICT can target the swapped index), not merely that it is applied.
 */
export const FROZEN_INDEX_SWAP_EXEMPTIONS = new Map([
  [
    "959-owned-trigger-source-account-identity.sql",
    "Applied 2026-08-25T21:55:23Z (sha 3bf8fbad). This swap was NOT safe in isolation: the deployed writer still targeted the dropped owner+kind ON CONFLICT arbiter, which caused the WI-41703 rollout incident. The file is frozen, so the required repair is the already-applied 960-restore-owned-trigger-legacy-arbiter.sql (2026-08-25T22:19:31Z, sha bb8a07b8), which recreates the exact old column set and predicate while retaining the new account-scoped index. On this check's hazard model, the complete applied chain now leaves every deployed ON CONFLICT target backed by a matching unique index; a later contract migration may remove the legacy arbiter only after the old writer is gone.",
  ],
  [
    "937-bulk-run-kind-plan-cleanup.sql",
    "Applied 2026-08-24T03:24:05Z (sha 882e5741). Re-keys bulk-run single-flight (workspace_id) → (workspace_id, run_kind). Verified safe on this check's own hazard model before exempting (WI-41214): no ON CONFLICT anywhere — the deployed papercup-release checkout included — targets the swapped index (the only ON CONFLICT on these tables is the attention_bulk_run_items PK, untouched); single-flight is enforced by catching 23505 and substring-matching the index NAME in bulk-run-store.ts, and the replacement name deliberately keeps 'one_active_per_workspace'; every old-code row carries run_kind='inbox-resolve' (column default), so the new index enforces the identical one-active-per-workspace rule for every deployed reader. The in-file allow-index-swap pragma is refused by the immutability guard because the file is applied.",
  ],
  [
    "1268-portal-relay-linked-installs.sql",
    "Applied 2026-09-30T13:44:35Z (committed in the libs/papercusp submodule at 13:45:15Z, 71e88dcf; WI-10004019). Re-predicates customer_workspaces_one_live_per_organization_uq from (workspace_id, organization_id) WHERE state <> 'deleted' to the same columns WHERE state <> 'deleted' AND kind = 'hosted', and moves customer_workspaces_host_fk onto a generated column. Verified safe on this check's own hazard model before exempting (gate red on candidate 599dbeeb, 2026-09-30): no ON CONFLICT targets the swapped index in the working tree, the deployed papercup-release checkout, or the bundled desktop sidecar serve.mjs. Every customer_workspaces insert uses ON CONFLICT (workspace_id, id) (the row identity) or a bare ON CONFLICT DO NOTHING. One-live admission is enforced by catching 23505 and matching the index NAME (ONE_LIVE_WORKSPACE_PER_ORGANIZATION_INDEX in workspace-admission-dependencies.ts), and the replacement keeps that name. kind defaults to 'hosted' and the deployed release writes only hosted rows, so the new index enforces the identical rule for every deployed writer. The dropped FK is not an ON CONFLICT arbiter. The in-file allow-index-swap pragma is refused by the immutability guard because the file is applied.",
  ],
]);

/**
 * Partition migration files by the tx-control rule.
 *
 * `entries` is `[{ file, text }]`. Returns offenders (a real failure), the
 * pre-ENFORCED_FROM grandfathered count, and the frozen-exempt files — reported
 * separately so an exemption is never silent.
 */
export function partitionRawTxControl(
  entries,
  { enforcedFrom = ENFORCED_FROM, exemptions = FROZEN_TXCTL_EXEMPTIONS } = {},
) {
  const offenders = [];
  const exempted = [];
  let grandfathered = 0;
  for (const { file, text } of entries) {
    const hits = findRawTxControl(text);
    if (!hits.length) continue;
    const num = Number.parseInt(/^(\d+)-/.exec(file)?.[1] ?? "0", 10);
    if (num < enforcedFrom) {
      grandfathered++;
    } else if (exemptions.has(file)) {
      exempted.push({ file, hits, reason: exemptions.get(file) });
    } else {
      offenders.push({ file, hits });
    }
  }
  return { offenders, grandfathered, exempted };
}

/**
 * Exemption entries that are NOT in the applied set — a hard error.
 *
 * This is what stops the list becoming a bypass. The ONLY justification for an
 * entry is "this file is frozen because it is already applied"; if it is not
 * applied, it is still editable and must simply be fixed. Requires a real applied
 * set, so callers skip it when PG is unreachable rather than inventing a verdict.
 */
export function unappliedFrozenExemptions(
  appliedFilenames,
  exemptions = FROZEN_TXCTL_EXEMPTIONS,
) {
  return [...exemptions.keys()].filter((f) => !appliedFilenames.has(f)).sort();
}

/**
 * Partition migration files by the unique-index shape-swap rule (check #6),
 * mirroring partitionRawTxControl so the CLI and the gate-wiring test cannot
 * disagree about a FROZEN file (the WI-41119 contract). Files below
 * `enforcedFrom` are grandfathered applied history (564/689) and skipped,
 * exactly as the inline loop did before.
 */
export function partitionIndexSwaps(
  entries,
  {
    enforcedFrom = INDEX_SWAP_ENFORCED_FROM,
    exemptions = FROZEN_INDEX_SWAP_EXEMPTIONS,
  } = {},
) {
  const offenders = [];
  const exempted = [];
  for (const { file, text } of entries) {
    const num = Number.parseInt(/^(\d+)-/.exec(file)?.[1] ?? "0", 10);
    if (num < enforcedFrom) continue;
    const hits = findUniqueIndexShapeSwap(text);
    if (!hits.length) continue;
    if (exemptions.has(file)) {
      exempted.push({ file, hits, reason: exemptions.get(file) });
    } else {
      offenders.push({ file, hits });
    }
  }
  return { offenders, exempted };
}

/**
 * Top-level `RENAME CONSTRAINT` statements — the 42704 footgun (WI-4547).
 *
 * `ALTER TABLE IF EXISTS t RENAME CONSTRAINT x TO y` READS as guarded and is NOT:
 * `IF EXISTS` covers the TABLE, not the CONSTRAINT. If the table exists but `x`
 * does not, Postgres still throws 42704 and aborts the whole migration.
 *
 * That is not hypothetical. Migration 592 (knowledge-packs rename) renamed five
 * constraints this way. One of them — `learning_pack_candidates_workspace_nonempty`
 * — had been destroyed long before by migration 377, which DROPPED the
 * `workspace_id` column (a CHECK constraint dies with its column). So it existed
 * on NO database, fresh or live: 592 failed deterministically EVERYWHERE, which
 * broke every fresh-DB integration test in the repo (createFreshPgDb applies the
 * full migration set) and would have failed the deploy's migration step too.
 *
 * The bug is invisible at review time precisely BECAUSE the statement looks
 * guarded, so a human check will keep missing it — hence a lint.
 *
 * The FIX SHAPE is a DO-block that renames only when the old name exists and the
 * new one does not (see 592). Because this check masks dollar-quoted bodies
 * (`maskSealingBodies`), a rename inside a `DO $$ … $$` block is invisible here and passes,
 * while a bare top-level one is caught — which is exactly the intended contract.
 * `ALTER INDEX IF EXISTS … RENAME TO` is genuinely guarded (the IF EXISTS binds
 * to the index itself) and is correctly not flagged.
 */
export function findUnguardedConstraintRename(sqlText) {
  // SEALED, and this one is load-bearing: the in-`DO` guarded rename is this lint's OWN
  // documented fix shape (see above). A body-live mask here would flag every correct fix,
  // starting with migration 592's.
  const stripped = maskSealingBodies(sqlText);
  const hits = [];
  const re = /\bRENAME\s+CONSTRAINT\s+("?[A-Za-z_][\w$]*"?)/gi;
  let m;
  while ((m = re.exec(stripped)) !== null) hits.push(m[1]);
  return hits;
}

/**
 * The migration-631 class: a re-slug UPDATE that assigns a literal to
 * work_items.harness_slug WITHOUT a collision guard. On a shipped SEED that already
 * has a row at the target slug for the same feature_id, a straight UPDATE dupes
 * work_items_pkey and CRASH-LOOPS the packaged operator on first boot — the v0.0.12
 * bug that was found only AFTER a ~45-minute build (a big slice of that release's
 * 12h). Collision-safe = the file EITHER de-dups colliders first (a DELETE FROM
 * work_items) OR guards the UPDATE with NOT EXISTS; migrations 630/631 do the
 * dedup-DELETE. Returns the offending UPDATE snippet(s) ONLY when the file has a
 * reslug UPDATE and no guard (so a guarded reslug — or a file with none — is clean).
 */
export function findUnguardedReslug(sqlText) {
  // The mask blanks string literals, so we detect the RE-SLUG structurally: an UPDATE on
  // work_items whose SET clause ASSIGNS harness_slug (not merely a harness_slug in the
  // WHERE). Capture the SET clause up to WHERE/RETURNING/; and require harness_slug to be
  // assigned inside it.
  //
  // SEALED — and this is the one call site where the obvious answer is WRONG, so it is
  // measured rather than reasoned (WI-37800).
  //
  // A reslug UPDATE inside a body really executes, so "see inside bodies" looks right here
  // exactly as it is right for findUniqueIndexShapeSwap. It is not, because THIS check is not
  // a pure detector: it detects an offence and then exempts a guarded UPDATE. Keep the
  // exemption scoped to the UPDATE being inspected (and its immediately preceding top-level
  // dedup DELETE); a guard token in an unrelated statement must not disarm the lint.
  //
  // Measured on 382-operator-issue-scope-removal.sql: with bodies live the check finds MORE
  // offences (2 reslug UPDATEs, not 1) and then reports NONE, because an unrelated
  // `DELETE FROM harness_shared.work_items` inside a trigger-function body reads as a dedup
  // guard for a top-level UPDATE 48 lines earlier that it has nothing to do with. A safety lint
  // that a stray token in unrelated body code can switch off is worse than one with a known
  // blind spot, so bodies stay sealed until in-body guard detection is separately scoped.
  const stripped = maskSealingBodies(sqlText);
  const re =
    /UPDATE\s+[\w".]*\bwork_items\b\s+(?:AS\s+\w+\s+)?SET\b([\s\S]*?)(?:;|$)/gi;
  const reslugs = [];
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const setClause = m[1].split(/\b(?:WHERE|RETURNING)\b/i, 1)[0];
    if (!/\bharness_slug\s*=/.test(setClause)) continue;

    // The collision guard may be part of this UPDATE's WHERE clause. A separate DELETE is
    // accepted only when it is the immediately preceding top-level statement, which matches
    // the migration-630/631 shape without letting an unrelated DELETE elsewhere in the file
    // exempt this UPDATE.
    const previousStatement =
      stripped
        .slice(0, m.index)
        .split(";")
        .map((statement) => statement.trim())
        .reverse()
        .find(Boolean) ?? "";
    const hasDedupDelete = /DELETE\s+FROM\s+[\w".]*\bwork_items\b/i.test(
      previousStatement,
    );
    const guardedUpdate = /\bNOT\s+EXISTS\b/i.test(m[0]);
    if (!hasDedupDelete && !guardedUpdate) {
      reslugs.push(m[0].replace(/\s+/g, " ").slice(0, 70));
    }
  }
  return reslugs;
}

/**
 * Flag a LITERAL default on a tenant-scoping column — the WI-5125 class.
 *
 * Seven consolidation migrations (116/118/119/120/170) each ended with:
 *
 *     ALTER VIEW <schema>.agent_chats ALTER COLUMN workspace_id SET DEFAULT 'default'
 *
 * under a comment reading "so writers that omit these on INSERT still pass
 * through". For `harness_slug` / `created_at` that reasoning holds — the view
 * knows its own slug and `now()` is always right. For `workspace_id` it does
 * NOT: the active workspace is only knowable IN-PROCESS (a request's
 * `x-papercusp-workspace` header → ALS, or the process pin), so a literal in
 * DDL is a GUESS that is wrong for every workspace except the one hardcoded.
 *
 * The consequence is not a loud failure but a silent one: a writer omitting the
 * column INSERTs successfully under the WRONG tenant. It shipped 181/181
 * mis-tenanted agent_chats rows, and the owner met it as a work-item Chat panel
 * that spun on "loading chat…" forever (the row existed; the workspace-scoped
 * read could never see it). A loud NOT NULL violation would have been caught in
 * minutes; the literal default turned it into weeks of invisible corruption.
 *
 * Scans RAW text, deliberately UNLIKE its siblings: these ALTERs live inside the
 * per-schema `DO $$ … $$` loop that a body-sealing mask removes, so such a scan
 * would see nothing and pass — the exact false-green this lint exists to prevent.
 *
 * The FIX SHAPE is to drop the literal and let the writer stamp the column
 * explicitly (`activeWorkspaceId()`), with `fill_workspace_id_from_projects()`
 * as a derive-net. A default that DERIVES — `current_setting(...)`, a function
 * call — is fine and is not flagged; only a quoted literal is.
 */
export function findLiteralTenantDefault(sqlText) {
  const hits = [];
  // Strip COMMENTS ONLY — not dollar-quoted bodies (see the note above: the real
  // ALTERs live inside a DO $$ … $$ loop). Without this, a migration that
  // DOCUMENTS the trap by quoting the offending DDL — as 616, its own fix, does —
  // gets flagged for the words in its comment. A lint that fires on the fix for
  // the bug it detects is a lint people delete.
  //
  // `stripSqlComments` is the CANONICAL mask and delivers exactly that contract
  // (EI-20073035509369492): it blanks comments — including comments nested inside a
  // `$tag$` body — while leaving all body CODE live, so the DO-loop ALTERs above are
  // still seen. It replaced a private `--[^\n]*` + `/* */` pair that was NOT quote-aware:
  //
  //   INSERT INTO t(note) VALUES ('see -- below'); ALTER TABLE t ALTER COLUMN workspace_id SET DEFAULT 'ws_1';
  //
  // that `--` is inside a STRING LITERAL, so the old regex deleted the rest of the line
  // and took the real ALTER with it — a false NEGATIVE on the exact DDL this detects.
  // ⚠ NOT `stripSqlCommentsAndStrings`: it seals `$tag$` bodies wholesale, which would
  // make this detector blind to the DO-loop ALTERs that are its main quarry.
  sqlText = stripSqlComments(sqlText);
  // ALTER [VIEW|TABLE] <rel> ALTER [COLUMN] <tenant-col> SET DEFAULT '<literal>'
  const re =
    /ALTER\s+(?:VIEW|TABLE)\s+[^\n;]*?\bALTER\s+(?:COLUMN\s+)?["']?(workspace_id|hive_slug|tenant_id)["']?\s+SET\s+DEFAULT\s+('(?:[^']|'')*'|%L)/gi;
  let m;
  while ((m = re.exec(sqlText)) !== null)
    hits.push({ column: m[1], value: m[2] });
  return hits;
}

/**
 * Group migration filenames by numeric prefix; return duplicate groups whose
 * number is ≥ `enforcedFrom` (default ENFORCED_FROM). A duplicate BELOW that
 * line is pre-existing, already-applied, ledgered history — the runner keys
 * applied migrations by full FILENAME (not just the numeric prefix), so a
 * historical same-number pair with distinct names never actually collided at
 * runtime; it's a human-ambiguity smell, not a live defect, and renaming an
 * already-applied file now would break its recorded checksum. Grandfathering
 * mirrors the same enforcedFrom boundary the tx-control + reservation checks
 * already use (EI-6843: the boundary must track reality, not just intent — it
 * was stale for years while this lint went unrun, letting real duplicates
 * accumulate ungated; see ENFORCED_FROM's own history note).
 */
export function duplicateNumberGroups(filenames, enforcedFrom = ENFORCED_FROM) {
  const byNum = new Map();
  for (const f of filenames) {
    const m = /^(\d+)-/.exec(f);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (!byNum.has(n)) byNum.set(n, []);
    byNum.get(n).push(f);
  }
  return [...byNum.entries()]
    .filter(([num, files]) => files.length > 1 && num >= enforcedFrom)
    .map(([num, files]) => ({ num, files: files.sort() }));
}

/**
 * Enforcement boundary for the UNIQUE-INDEX SHAPE SWAP check (below).
 *
 * Deliberately its OWN boundary rather than the shared ENFORCED_FROM: three
 * already-applied files (113, 461, 564, 689) carry this pattern, and two of them
 * (564, 689) sit ABOVE ENFORCED_FROM. Applied migrations are effectively frozen
 * — editing one now would NOT re-run it on any DB that already applied it (see
 * WHY APPLIED FILES ARE FROZEN above) — so they are grandfathered and this lint
 * exists to stop the NEXT one.
 * 690 is the current max on disk; enforcement starts at the next number.
 *
 * Bump this ONLY when deliberately re-grandfathering more applied history —
 * NEVER to silence a genuinely new violation. To ship a swap that is actually
 * safe, use the documented pragma instead (see findUniqueIndexShapeSwap).
 */
export const INDEX_SWAP_ENFORCED_FROM = 691;

/**
 * ACCESS EXCLUSIVE acknowledgment boundary (EI-21698566084995732).
 *
 * Its OWN boundary, above every migration on disk when the guard landed, for the
 * usual reason: 17 historical files carry `DISABLE TRIGGER` (295, 325, 360, 361,
 * 374, 382, 391, 638, 649, 656, 864, 865, 867, 868, 870, 950), they are applied
 * and ledgered, and the runner verifies each by sha256 — editing one now would
 * break its recorded checksum. This stops a NEW migration from copying the shape
 * unexamined.
 */
export const EXCLUSIVE_LOCK_ENFORCED_FROM = 1022;

/**
 * The acknowledgment token. Same shape and same contract as
 * check-migration-forward-compat's ACK_MARKER: it matches ANY non-whitespace
 * after the colon, so it is satisfied by a placeholder. That is deliberate — the
 * guard's job is to force the author to ANSWER the question at authoring time,
 * not to grade the answer. For the same reason scripts/next-migration.mjs must
 * never seed a line matching this, or every migration is rubber-stamped.
 */
export const EXCLUSIVE_LOCK_ACK = /^[ \t]*--[ \t]*EXCLUSIVE-LOCK:[ \t]*\S/im;

/**
 * Tables whose ACCESS EXCLUSIVE stall is fleet-wide rather than local. Used ONLY
 * to escalate the message — the guard fires on every table regardless, so this
 * list going stale can never open a hole (it can only under-dramatize one).
 */
const EXCLUSIVE_LOCK_HOT_TABLES = new Set([
  "work_items",
  "plan_items",
  "coord_messages",
  "harness_plans",
  "tool_invocations",
]);

/**
 * `ALTER TABLE … DISABLE/ENABLE TRIGGER` acquires an ACCESS EXCLUSIVE lock on the
 * target table. On a hot table that is not merely slow: a PENDING exclusive
 * request queues every subsequent READER behind it, so an attempt that only
 * waits still stalls the fleet. Migrations auto-apply at boot, so an armed file
 * carrying this can fail — or stall — during startup, precisely when the box is
 * busiest. Measured on 1020 under live fleet load: five attempts, all
 * `canceling statement due to lock timeout`.
 *
 * Comments AND string literals are masked (`maskLiveBodies`) while `$$` body CODE
 * stays live: a DISABLE TRIGGER inside a DO block really executes, whereas
 * 1020's `-- NOTE: deliberately NO ALTER TABLE ... DISABLE TRIGGER USER` prose
 * must read clean. Both directions are pinned in
 * migration-exclusive-lock-guard.test.ts.
 *
 * @param {string} sqlText raw migration text
 * @returns {{ table: string, action: string, target: string, hot: boolean }[]}
 */
export function findUnacknowledgedExclusiveLock(sqlText) {
  // The ack is a COMMENT, so it is tested against the RAW text — masking would
  // erase the very line being looked for.
  if (EXCLUSIVE_LOCK_ACK.test(sqlText)) return [];
  const stripped = maskLiveBodies(sqlText);
  const re =
    /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w".]+)\s+(DISABLE|ENABLE)\s+(?:ALWAYS\s+|REPLICA\s+)?TRIGGER\s+([\w".]+)/gi;
  const hits = [];
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const table = m[1];
    hits.push({
      table,
      action: m[2].toUpperCase(),
      target: m[3].toUpperCase(),
      hot: EXCLUSIVE_LOCK_HOT_TABLES.has(bareName(table)),
    });
  }
  return hits;
}

/**
 * Enforcement boundary for the VIEW LOCK-ORDER INVERSION check (below).
 *
 * Its OWN boundary, for the usual reason: 11 already-applied files carry the
 * shape (136, 178, 374, 382, 418, 432, 485, 551, 554, 555, 677) — measured over
 * all 875 files in the live dir, not estimated — and they are applied+ledgered,
 * so editing one now would break its recorded sha256 without re-running it.
 * 677 is the highest; enforcement starts at the next number. This stops the
 * NEXT one.
 *
 * Bump this ONLY when deliberately re-grandfathering more applied history —
 * NEVER to silence a genuinely new violation. Use the documented pragma for a
 * swap that is actually safe (see findViewLockOrderInversion).
 *
 * 2026-09-17 — 678 -> 1172, re-grandfathering ONE file: 1171-event-key-payload-
 * schema.sql (identities-v1 P-029). It ALTERs harness_shared.event_key_registry
 * and then CREATE OR REPLACE VIEWs event_key_registry_attested over it, with no
 * prior LOCK on the view: a textbook inversion by this check's own definition.
 *
 * It is grandfathered rather than fixed for the SAME reason as the 11 above, and
 * for no other: it was already APPLIED and ledgered (2026-09-17T08:47:29Z,
 * sha256 28d5ca3f…) by boot auto-apply before any gate check ran, so editing the
 * file now would break its recorded sha256 without re-running it. That is the
 * honest case this boundary exists for — an applied file that can no longer be
 * edited — NOT the dishonest one it warns about.
 *
 * Two things keep this from being a silent exemption:
 *   - The inversion is cold, not hot: event_key_registry is absent from
 *     EXCLUSIVE_LOCK_HOT_TABLES and the table was hours old, so the detector
 *     reports hot:false and the apply in fact succeeded on its first attempt.
 *   - The PROCESS defect — boot auto-apply admitting a migration this gate check
 *     would have rejected, which then red-pins the gate after the fact — is filed
 *     separately. Grandfathering closes the gate red; it does not close that.
 *
 * Enforcement still resumes immediately above the offender, so every future
 * migration is checked exactly as before. This stops the NEXT one.
 */
export const VIEW_LOCK_ORDER_ENFORCED_FROM = 1172;

/**
 * Opt-out pragma, same shape and contract as `allow-index-swap`: it forces the
 * author to STATE why the inversion is safe here, not to prove it.
 */
export const VIEW_LOCK_ORDER_ACK =
  /^[ \t]*--[ \t]*lint-migrations:[ \t]*allow-view-lock-order[ \t]+\S/im;

/**
 * Required account for an unresolved dynamic ALTER-table → view-replace pair.
 * When table/view names come from PL/pgSQL variables, only the author can state
 * the complete relation order they reviewed. Requiring a non-empty reason makes
 * that claim visible at the exact migration site instead of silently treating
 * dynamic SQL as safe.
 */
export const DYNAMIC_VIEW_LOCK_ORDER_ACK =
  /^[ \t]*--[ \t]*lint-migrations:[ \t]*dynamic-view-lock-order[ \t]+\S/im;

/**
 * The migration-721 class (EI-19320370563025481): a file that `ALTER TABLE <t>`
 * and THEN `CREATE OR REPLACE VIEW <v>` where `<v>` selects from `<t>`, without
 * first taking the lock on `<v>`.
 *
 * WHY THIS DEADLOCKS, AND WHY THE OBVIOUS FIX IS THE WRONG ONE. A reader of the
 * view locks **view → base table**. This migration locks **table (ALTER) → view
 * (CREATE OR REPLACE)**. That inversion is a textbook lock-order deadlock, and
 * on a fleet-hot table there is ALWAYS a reader mid-way between the two objects:
 *
 *     Process A waits for AccessExclusiveLock on engineer_issues; blocked by B.
 *     Process B waits for AccessShareLock      on work_items;      blocked by A.
 *
 * The failure actively misleads. Attempt 1's symptom is `canceling statement due
 * to lock timeout`, which reads as "the table is busy, wait longer" — and the
 * documented lever for that (`lock_timeout_sec`) makes it WORSE: a longer wait on
 * ACCESS EXCLUSIVE queues the entire fleet behind you (FIFO), and on 721 it
 * converted the timeout into a deadlock. Diagnosing pg_stat_activity/pg_locks
 * first correctly rules out the documented long-holder case, which makes plain
 * contention look even more like the answer. The real cause is in the file.
 *
 * The fix is two lines at the top of the transaction — take both locks up front,
 * in READER order — after which 721 applied on attempt 1 under the same traffic
 * that had just failed 7 attempts:
 *
 *     LOCK TABLE harness_shared.engineer_issues IN ACCESS EXCLUSIVE MODE;
 *     LOCK TABLE harness_shared.work_items      IN ACCESS EXCLUSIVE MODE;
 *
 * Dynamic `EXECUTE format('ALTER TABLE %s …')` / `EXECUTE format('CREATE OR
 * REPLACE VIEW %s …')` pairs cannot expose their relation identity to this
 * text-only detector. They fail closed unless the author records the reviewed
 * reader-order account with `-- lint-migrations: dynamic-view-lock-order
 * <reason>`. The generic allow-view-lock-order pragma remains the explicit
 * opt-out for a genuinely safe inversion.
 *
 * PRECISION. Two shapes are deliberately NOT flagged, because neither can
 * deadlock: (a) the view re-declared BEFORE the ALTER — that is already reader
 * order; (b) a base table CREATEd in the same migration — a brand-new relation
 * has no concurrent reader to invert against. Excluding (b) is what takes the
 * measured population from 13 files to 11 (846 creates its tables in-file).
 *
 * Comments and string literals are masked (`maskLiveBodies`) while `$$` body CODE
 * stays live, matching the exclusive-lock guard: DDL inside a DO block really
 * executes, whereas prose describing the hazard must read clean.
 *
 * @param {string} sqlText raw migration text
 * @returns {{ view: string, table: string, hot: boolean, dynamic?: boolean }[]}
 */
export function findViewLockOrderInversion(sqlText) {
  // The ack is a COMMENT, so it is tested against the RAW text — masking would
  // erase the very line being looked for.
  if (VIEW_LOCK_ORDER_ACK.test(sqlText)) return [];
  const stripped = maskLiveBodies(sqlText);
  const IDENT = '(?:"?[\\w$]+"?\\.)?"?[\\w$]+"?';

  // Dynamic form: string contents are masked, so anchor on the live EXECUTE
  // token in raw source. We cannot recover relation identities from `%s` / `%I`
  // plus PL/pgSQL variables, but we can prove the dangerous statement order.
  // This is the exact shape migration 1154 used when the static detector
  // incorrectly returned clean and the live apply convoyed readers.
  const dynamicAlterRe = /\bEXECUTE\s+format\s*\(\s*(['"])\s*ALTER\s+TABLE\b/gi;
  const dynamicViewRe = /\bEXECUTE\s+format\s*\(\s*(['"])\s*CREATE\s+OR\s+REPLACE\s+VIEW\b/gi;
  const dynamicAlters = [];
  const dynamicViews = [];
  let dynamic;
  while ((dynamic = dynamicAlterRe.exec(sqlText)) !== null) {
    if (isLiveCodeAt(sqlText, stripped, dynamic.index)) dynamicAlters.push(dynamic.index);
  }
  while ((dynamic = dynamicViewRe.exec(sqlText)) !== null) {
    if (isLiveCodeAt(sqlText, stripped, dynamic.index)) dynamicViews.push(dynamic.index);
  }
  const unresolvedDynamicOrder = dynamicAlters.some((alterIdx) =>
    dynamicViews.some((viewIdx) => alterIdx < viewIdx),
  );
  if (unresolvedDynamicOrder && !DYNAMIC_VIEW_LOCK_ORDER_ACK.test(sqlText)) {
    return [{ view: '<dynamic-view>', table: '<dynamic-table>', hot: true, dynamic: true }];
  }

  const alters = [];
  const alterRe = new RegExp(
    `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${IDENT})`,
    "gi",
  );
  let a;
  while ((a = alterRe.exec(stripped)) !== null)
    alters.push({ table: bareName(a[1]), idx: a.index });
  if (!alters.length) return [];

  // A relation CREATEd in this same file has no pre-existing reader, so no
  // reader can hold the opposing lock order against it.
  const createdHere = new Set();
  const createRe = new RegExp(
    `\\bCREATE\\s+(?:UNLOGGED\\s+|TEMP\\s+|TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`,
    "gi",
  );
  let c;
  while ((c = createRe.exec(stripped)) !== null)
    createdHere.add(bareName(c[1]));

  const locks = [];
  const lockRe = new RegExp(`\\bLOCK\\s+(?:TABLE\\s+)?(${IDENT})`, "gi");
  let l;
  while ((l = lockRe.exec(stripped)) !== null)
    locks.push({ rel: bareName(l[1]), idx: l.index });

  const hits = new Map();
  const viewRe = new RegExp(
    `\\bCREATE\\s+OR\\s+REPLACE\\s+VIEW\\s+(${IDENT})\\s+AS`,
    "gi",
  );
  let v;
  while ((v = viewRe.exec(stripped)) !== null) {
    const view = bareName(v[1]);
    const end = stripped.indexOf(";", v.index);
    const body = stripped.slice(v.index, end === -1 ? stripped.length : end);
    const refs = new Set();
    const refRe = new RegExp(`\\b(?:FROM|JOIN)\\s+(${IDENT})`, "gi");
    let r;
    while ((r = refRe.exec(body)) !== null) refs.add(bareName(r[1]));

    for (const al of alters) {
      if (!refs.has(al.table)) continue;
      if (al.idx > v.index) continue; // view first = reader order, already safe
      if (createdHere.has(al.table)) continue; // new relation: no reader to race
      const lockedFirst = locks.some(
        (lk) => lk.rel === view && lk.idx < al.idx,
      );
      if (lockedFirst) continue;
      hits.set(`${view}<${al.table}`, {
        view,
        table: al.table,
        hot: EXCLUSIVE_LOCK_HOT_TABLES.has(al.table),
      });
    }
  }
  return [...hits.values()];
}

/**
 * Enforcement boundary for the VIEW-DROP DEPENDENCY check (below).
 *
 * Its OWN boundary, same reason as the two above: 21 already-applied files
 * carry a DROP VIEW (24 statements — measured over every file in the live dir,
 * drafts included, not estimated), and they are applied+ledgered, so editing
 * one now would break its recorded sha256 without re-running it. The highest
 * number present is 1039; enforcement starts at the next. This stops the NEXT
 * one.
 *
 * Bump this ONLY when deliberately re-grandfathering more applied history —
 * NEVER to silence a genuinely new violation. Use the documented pragma for a
 * drop that is actually safe (see findUnguardedViewDrop).
 */
export const VIEW_DROP_ENFORCED_FROM = 1040;

/**
 * Opt-out pragma, same shape and contract as `allow-view-lock-order`: it forces
 * the author to STATE why the drop is safe here, not to prove it.
 *
 * THIS IS THE ONLY OPT-OUT, AND THAT IS DELIBERATE. The obvious second one —
 * auto-exempting a file that mentions `pg_get_viewdef`, since capture/replay is
 * the sanctioned safe form — is a trap this repo has already measured once:
 * a marker-based lint can be disabled by "helpfully" seeding its own marker
 * (EI-19462877357083817, where `-- FORWARD-COMPAT: TODO` satisfied the ack
 * regex as fully as a real reason). A bare `pg_get_viewdef` token anywhere in
 * the file would silence every drop in it, including one the author never
 * considered. Capture/replay is instead a REASON to write in the pragma, where
 * it is attributable.
 */
export const VIEW_DROP_ACK =
  /^[ \t]*--[ \t]*lint-migrations:[ \t]*allow-view-drop[ \t]+\S/im;

/**
 * The migration-678 / migration-374 class (EI-18748424931934157): a file that
 * drops a view without having accounted for what depends on it.
 *
 * TWO INCIDENTS, FAILING IN OPPOSITE DIRECTIONS — which is why both spellings
 * are flagged rather than just CASCADE:
 *
 *   - BARE DROP fails LOUDLY. 678 shipped `DROP VIEW harness_shared.
 *     harness_features_consolidated`, which every per-harness `harness_features`
 *     view depends on. Postgres refuses to drop a view that has dependents, so
 *     the migration errored at a real operator's boot — "cannot drop view …
 *     because other objects depend on it" — and crash-looped it.
 *   - CASCADE fails SILENTLY, which is worse. 374 ran `DROP VIEW
 *     harness_shared.work_items CASCADE` to promote a table, and the CASCADE
 *     took every dependent with it — including harness_shared.fleet_assignment,
 *     whose canonical body lives in migration 358. Migrations run ONCE, so 358
 *     never re-created it: on every DB that applied 374 the view was gone
 *     PERMANENTLY, blinding fleet:assignments, scheduler:running, the reclaim
 *     sweep and the UI fleet view until 375 restored it by hand.
 *
 * WHY A LINT AND NOT A REVIEW CONVENTION. 678's author DID write a safety note;
 * it reasoned the change was safe because "677 shipped minutes ago and nothing
 * has been built on the column". That was TRUE about the column and IRRELEVANT
 * to the view — the dependency is on the view itself. A reviewer would very
 * plausibly wave that through, which is precisely why the guard has to be
 * mechanical.
 *
 * WHAT THIS CHECK CAN AND CANNOT KNOW. It is pure text: it has no database, so
 * it CANNOT tell whether a given view actually has dependents. It therefore does
 * not try to. It asks a weaker question it can answer honestly — "was the
 * dependent question answered at all?" — and the pragma is where the answer
 * goes. That is the whole value: it converts a silent assumption into a written
 * claim, at authoring time, on the exact statement class that produced both
 * incidents. The stronger guard is the per-harness dependent view seeded in
 * libs/test-config/src/baseline-schema-global-setup.ts, which tests the real
 * property; this is the cheap belt that also covers a FRESH container, where
 * that probe cannot be seeded until after the first replay.
 *
 * MASKING — AND WHY NEITHER MASK ALONE WORKS HERE. The statement appears in
 * three textual positions in the live corpus, and they want opposite treatment:
 *
 *   1. top-level code      `DROP VIEW IF EXISTS harness_shared.work_items;`
 *   2. inside a DO body    `DROP VIEW harness_shared.work_items CASCADE;` (374)
 *   3. dynamic, in a STRING literal
 *                          `EXECUTE format('DROP VIEW %I.%I', s, 'x')`
 *
 * Masking strings kills (3); not masking them lets PROSE fire — and 375's own
 * header quotes `DROP VIEW harness_shared.work_items CASCADE;` while explaining
 * the incident, so a raw scan would flag the file written to document the
 * hazard. This is exactly the case `isLiveCodeAt` exists for: match on RAW text,
 * then ask whether the match's ANCHOR is live program text. Form (1)/(2) anchor
 * on `DROP`; form (3) anchors on the string's OPENING QUOTE, which is live code
 * even though its contents are blanked. Inside a comment BOTH anchors are
 * blanked, so prose reads clean in both directions. Bodies stay live
 * (`maskLiveBodies`) because 374's drop really executes.
 *
 * @param {string} sqlText raw migration text
 * @returns {{ view: string, dynamic: boolean, cascade: boolean }[]}
 */
export function findUnguardedViewDrop(sqlText) {
  // The ack is a COMMENT, so it is tested against the RAW text — masking would
  // erase the very line being looked for.
  if (VIEW_DROP_ACK.test(sqlText)) return [];
  const masked = maskLiveBodies(sqlText);
  // `%` so the dynamic `format('DROP VIEW %I.%I', …)` placeholders parse as an
  // identifier rather than terminating the match.
  const IDENT = '(?:"?[\\w$%]+"?\\.)?"?[\\w$%]+"?';
  const hits = new Map();

  // Forms (1) and (2): the statement is program text. Anchor on DROP.
  //
  // The CASCADE tail is a zero-width LOOKAHEAD, not a consumed group, and that is
  // load-bearing. Consuming `[^;]*` makes the match run to the next semicolon —
  // so a PHANTOM (a comment mentioning the statement) swallows a REAL drop that
  // follows it before the next `;`, `lastIndex` advances past both, and the real
  // hit is never offered to the oracle. That is a false NEGATIVE manufactured by
  // a guard aimed at false positives; the regression test "scans past a phantom
  // to a real drop later in the file" pins it.
  const codeRe = new RegExp(
    `\\bDROP\\s+(?:MATERIALIZED\\s+)?VIEW\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})(?=([^;]*))`,
    "gi",
  );
  let m;
  while ((m = codeRe.exec(sqlText)) !== null) {
    if (!isLiveCodeAt(sqlText, masked, m.index)) continue;
    const view = bareName(m[1]);
    hits.set(`code:${view}`, {
      view,
      dynamic: false,
      cascade: /\bCASCADE\b/i.test(m[2] ?? ""),
    });
  }

  // Form (3): the statement is string CONTENT, so its own characters are
  // blanked. Anchor on the opening quote, which is program text.
  const dynRe = new RegExp(
    `(['"])\\s*DROP\\s+(?:MATERIALIZED\\s+)?VIEW\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})(?=([^'"]*))`,
    "gi",
  );
  let d;
  while ((d = dynRe.exec(sqlText)) !== null) {
    if (!isLiveCodeAt(sqlText, masked, d.index)) continue;
    const view = bareName(d[2]);
    hits.set(`dyn:${view}`, {
      view,
      dynamic: true,
      cascade: /\bCASCADE\b/i.test(d[3] ?? ""),
    });
  }

  return [...hits.values()];
}

/** Bare relation/index name: drop quotes and any schema qualifier. */
function bareName(ident) {
  const s = String(ident).replace(/"/g, "");
  const dot = s.lastIndexOf(".");
  return (dot === -1 ? s : s.slice(dot + 1)).toLowerCase();
}

/**
 * The migration-461/689 class: DROPPING a table's unique index in the SAME
 * migration that creates its replacement.
 *
 * WHY THIS IS A BREAKING CHANGE, AND WHY REVIEW KEEPS MISSING IT. PostgreSQL
 * infers an `ON CONFLICT` target by MATCHING A UNIQUE INDEX. Change that index's
 * shape — add/remove a partial `WHERE` predicate, change the column set, change
 * an expression — and every `ON CONFLICT` spec written against the OLD shape
 * matches NO index and fails AT PLAN TIME. Not just on conflicting rows: EVERY
 * WRITE.
 *
 * On a SHARED database that is a deploy-ordering trap, not a code bug. The
 * migration lands the instant ANY operator boots, while the matching code lands
 * only on each operator's OWN deploy — so between those two moments every
 * not-yet-deployed reader is writing against an index that no longer exists. The
 * migration and its code fix can be authored perfectly, in one commit, and the
 * outage still happens.
 *
 * THIS TABLE HAS NOW DONE IT THREE TIMES. Migration 461 widened
 * `agent_facts_identity` from 4 columns to 5; the surviving 4-column spec errored
 * every assert and there were ZERO fact writes until it was caught on 2026-07-03.
 * Migration 564 repeated the shape on `memory_canonical` ("rebuild the identity to
 * include the source dimension" — the same authored pattern, verbatim). Migration
 * 689 then made `agent_facts_identity` PARTIAL (`WHERE superseded_at IS NULL`) and
 * dropped the old one in the same file, taking `facts:assert` down fleet-wide for
 * the whole window between the migration reaching the shared DB and the code
 * reaching the `:3070` release operator — a full hour, during which agents that
 * did not check the return value silently lost conclusions they believed durable.
 * 689's own header even DOCUMENTS this exact failure mode and still shipped it,
 * which is precisely why this needs to be mechanical rather than a review note.
 *
 * THE FIX SHAPE IS TWO-PHASE, and it is always available:
 *   migration N   — CREATE the new index, LEAVE the old one in place.
 *   (deploy the code that uses the new shape everywhere)
 *   migration N+k — DROP the old index.
 * Both shapes coexist in phase one, so old and new readers each still infer.
 *
 * SCOPE. Flags a file that creates a UNIQUE index on table T and drops SOME index
 * on T. Table-scoped on purpose: migration 506 drops an index on `spawned_agents`
 * and creates unrelated unique indexes on four other tables ~190 lines away, which
 * a naive creates-unique-and-drops rule would false-positive on. The dropped
 * index's own shape is deliberately NOT consulted — a DROP names only the index,
 * never its definition, so it is unknowable from this file; and since two-phase is
 * always possible, "dropped it in the same migration" is sufficient to flag.
 *
 * BOTH SIDES ALSO COUNT THEIR CONSTRAINT-BACKED FORM. A UNIQUE *constraint* is
 * implemented BY a unique index and is inferable by `ON CONFLICT` in exactly the
 * same way, so `ALTER TABLE t ADD CONSTRAINT c UNIQUE (...)` creates the same
 * hazard as `CREATE UNIQUE INDEX`, and `ALTER TABLE t DROP CONSTRAINT c` destroys
 * an inference target as surely as `DROP INDEX`. Matching only the INDEX spelling
 * left the check with a bypass reachable by an idiom this repo already uses 14
 * times (`ADD CONSTRAINT … UNIQUE`): the identical 689 outage authored as
 * `ALTER TABLE … DROP CONSTRAINT` + `CREATE UNIQUE INDEX … WHERE` sailed straight
 * through. A guard whose whole purpose is to be mechanical rather than a review
 * note must not have a spelling-shaped hole in it.
 *
 * A DROP CONSTRAINT is counted whatever the constraint's TYPE, so dropping a mere
 * CHECK constraint in the same migration that creates a unique index on that table
 * does flag. That is deliberate and consistent with how the INDEX side already
 * behaves: `DROP CONSTRAINT` names only the constraint, never its definition, so
 * whether it was the UNIQUE one backing somebody's `ON CONFLICT` is not knowable
 * from this file. Since two-phase is always available, the conservative reading is
 * the safe one — and the pragma is there for the author who knows better.
 *
 * A constraint action names its table in the `ALTER TABLE`, so for those drops the
 * table is matched EXACTLY and the `<table>_` name heuristic is skipped — that
 * heuristic exists only because a bare `DROP INDEX` does not say which table it
 * belonged to. Exact beats heuristic in both directions: it catches a constraint
 * whose name does not begin with its table (`uniq_facts_ident` on `agent_facts`),
 * and it will not fire on a same-named constraint dropped from a DIFFERENT table.
 *
 * ESCAPE HATCH. A swap that is genuinely safe (a brand-new table with no
 * deployed readers, an index no `ON CONFLICT` can target) may carry
 *
 *     -- lint-migrations: allow-index-swap <why it is safe>
 *
 * anywhere in the file. It requires a written reason precisely so the claim is
 * reviewable — an unexplained pragma is itself flagged.
 */
export function findUniqueIndexShapeSwap(sqlText) {
  const raw = String(sqlText);
  // Pragma is a COMMENT, so read it from raw text before stripping.
  // The reason must be on the SAME line as the pragma: a `\s+` here would let the
  // newline satisfy it and the next statement stand in as the "reason", so a bare
  // unexplained pragma would silently opt out — the exact hole this check exists
  // to close.
  if (/--[ \t]*lint-migrations:[ \t]*allow-index-swap[ \t]+\S+/i.test(raw))
    return [];

  // BODIES LIVE: migration 377's in-`DO` DROP+re-ADD of a unique constraint is real DDL that
  // really executes. It was detected before only because the old private tag regex failed to
  // recognise `$mig377$`; this makes that intentional rather than accidental.
  const stripped = maskLiveBodies(raw);

  const IDENT = '(?:"?[\\w$]+"?\\.)?"?[\\w$]+"?';

  // Drops, each as { name, table }. `table` is null for a bare DROP INDEX (the
  // statement does not say which table the index belonged to) and exact for a
  // constraint drop, which always names its table in the ALTER TABLE.
  const dropped = [];
  const dropRe = new RegExp(
    `\\bDROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${IDENT})`,
    "gi",
  );
  let d;
  while ((d = dropRe.exec(stripped)) !== null)
    dropped.push({ name: bareName(d[1]), table: null });

  // Creates, each as { index, table, partial }.
  const created = [];
  const createRe = new RegExp(
    `\\bCREATE\\s+UNIQUE\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s+ON\\s+(${IDENT})([^;]*)`,
    "gi",
  );
  let c;
  while ((c = createRe.exec(stripped)) !== null) {
    created.push({
      index: bareName(c[1]),
      table: bareName(c[2]),
      partial: /\bWHERE\b/i.test(c[3] ?? ""),
    });
  }

  // The constraint-backed spelling of BOTH sides. One ALTER TABLE can carry
  // several comma-separated actions (`ADD CONSTRAINT a UNIQUE (x), DROP
  // CONSTRAINT b`), so scan each statement's action list rather than assuming one
  // action per statement.
  const alterRe = new RegExp(
    `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})([^;]*)`,
    "gi",
  );
  let a;
  while ((a = alterRe.exec(stripped)) !== null) {
    const table = bareName(a[1]);
    const actions = a[2] ?? "";

    const dropConRe = new RegExp(
      `\\bDROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})`,
      "gi",
    );
    let dc;
    while ((dc = dropConRe.exec(actions)) !== null) {
      dropped.push({ name: bareName(dc[1]), table });
    }

    // `UNIQUE (` — the parenthesis is required so a column-level `ADD COLUMN x
    // text UNIQUE` (which creates no new inference target for existing writers)
    // is not mistaken for a table-level unique constraint. The constraint name is
    // optional: `ADD UNIQUE (cols)` is legal and PG names it for you.
    const addConRe = new RegExp(
      `\\bADD\\s+(?:CONSTRAINT\\s+(${IDENT})\\s+)?UNIQUE\\s*\\(`,
      "gi",
    );
    let ac;
    while ((ac = addConRe.exec(actions)) !== null) {
      created.push({
        index: ac[1] ? bareName(ac[1]) : `${table} (unnamed UNIQUE constraint)`,
        table,
        // A UNIQUE constraint cannot carry a predicate, so it is never partial.
        partial: false,
      });
    }
  }

  if (!dropped.length || !created.length) return [];

  const hits = [];
  for (const { index, table, partial } of created) {
    const conflicts = dropped.filter((dr) =>
      dr.table === null
        ? // PG's conventional index naming is `<table>_<cols>_idx`, and an identity
          // index is named for its table. Require the table name as a prefix so an
          // unrelated drop elsewhere in a large migration does not match.
          dr.name === table || dr.name.startsWith(`${table}_`)
        : // Constraint drop: the table is stated, so compare it exactly.
          dr.table === table,
    );
    if (!conflicts.length) continue;
    hits.push({
      index,
      table,
      partial,
      dropped: [...new Set(conflicts.map((dr) => dr.name))],
    });
  }
  return hits;
}

/** NNN ≥ enforcedFrom present on disk but absent from the reservations set. */
export function unreservedNumbers(
  fileNums,
  reservedNums,
  enforcedFrom = ENFORCED_FROM,
) {
  return fileNums
    .filter((n) => n >= enforcedFrom && !reservedNums.has(n))
    .sort((a, b) => a - b);
}

/** Files whose numeric reservation exists but names a DIFFERENT migration. */
export function reservationFilenameMismatches(
  files,
  reservations,
  { appliedFilenames = new Set(), enforcedFrom = ENFORCED_FROM } = {},
) {
  const byNumber = new Map(
    reservations.map((row) => [Number(row.num), row.filename ?? null]),
  );
  const mismatches = [];
  for (const file of files) {
    const num = Number.parseInt(/^(\d+)-/.exec(file)?.[1] ?? "0", 10);
    if (num < enforcedFrom || !byNumber.has(num)) continue;
    const reservedFilename = byNumber.get(num);
    if (
      reservedFilename === `${String(num).padStart(3, "0")}-TODO-rename.sql` &&
      appliedFilenames.has(file)
    )
      continue;
    if (reservedFilename !== file)
      mismatches.push({ num, file, reservedFilename });
  }
  return mismatches.sort(
    (a, b) => a.num - b.num || a.file.localeCompare(b.file),
  );
}

async function fetchReservationState() {
  // env → .env.local → embedded-pg discovery file → native :5432 dev fallback.
  const url = resolveScriptPgUrl().url;

  const postgres = (await import("postgres")).default;
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    const reservations =
      await sql`SELECT num, filename FROM harness_shared.migration_reservations`;
    const applied =
      await sql`SELECT filename FROM harness_shared.schema_migrations`;
    return {
      reservations,
      appliedFilenames: new Set(applied.map((row) => String(row.filename))),
    };
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

async function main() {
  const available = readdirSync(SQL_DIR).filter((f) =>
    f.endsWith(".sql") || f.endsWith(".sql.DRAFT") || f.endsWith(".sql.PENDING-CODE-DEPLOY")
  );
  let selected;
  try {
    selected = selectExplicitBasenames(process.argv.slice(2), available);
  } catch (error) {
    console.error(`lint:migrations: ${error.message}`);
    process.exit(2);
  }
  const files = selected ?? available.filter((f) => f.endsWith(".sql"));
  let failed = false;

  // 1. duplicate numeric prefixes
  const dups = duplicateNumberGroups(files);
  if (dups.length) {
    failed = true;
    console.error(
      "✗ duplicate migration numbers (renumber via db:next-migration):",
    );
    for (const { num, files: group } of dups)
      console.error(`   ${num}: ${group.join(" · ")}`);
  }

  // 2. raw top-level transaction control (enforced ≥ ENFORCED_FROM;
  //    pre-contract applied files are grandfathered, reported as a count)
  const { offenders, grandfathered, exempted } = partitionRawTxControl(
    files.map((f) => ({ file: f, text: readFileSync(join(SQL_DIR, f), "utf8") })),
  );
  for (const { file, hits } of offenders) {
    failed = true;
    console.error(
      `✗ ${file}: top-level transaction control (${hits.join(", ")}) — the runner provides the transaction; remove it`,
    );
  }
  if (grandfathered) {
    console.log(
      `· ${grandfathered} pre-${ENFORCED_FROM} applied file(s) carry legacy BEGIN/COMMIT — grandfathered (ledgered history, do not edit)`,
    );
  }
  // Never silent: an exemption is an admission that a bad migration reached
  // applied state, so it stays visible on every run.
  for (const { file, hits } of exempted) {
    console.log(
      `· ${file}: top-level transaction control (${hits.join(", ")}) — FROZEN (already applied; the immutability guard refuses the edit). See FROZEN_TXCTL_EXEMPTIONS / WI-41119.`,
    );
  }

  // 3. unguarded RENAME CONSTRAINT (the 42704 footgun — WI-4547)
  for (const f of files) {
    const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? "0", 10);
    if (num < ENFORCED_FROM) continue; // applied history: immutable, and it already survived
    const hits = findUnguardedConstraintRename(
      readFileSync(join(SQL_DIR, f), "utf8"),
    );
    if (!hits.length) continue;
    failed = true;
    console.error(
      `✗ ${f}: bare RENAME CONSTRAINT (${hits.join(", ")}) — \`ALTER TABLE IF EXISTS\` guards the TABLE, not the CONSTRAINT, so this throws 42704 and aborts the migration when the constraint is absent (e.g. an earlier migration dropped its column). Wrap it in a DO block that renames only if the old name exists and the new one does not — see 592-knowledge-packs-rename.sql.`,
    );
  }

  // 4. literal default on a tenant-scoping column (the WI-5125 class)
  //
  // Grandfathered below ENFORCED_FROM for the same reason as the rename check:
  // 116/118/119/120/170 still carry this DDL, they are already applied, and the
  // runner verifies each applied file by sha256 — editing one now would break its
  // recorded checksum. Migration 616 already corrected their EFFECT on live
  // databases (drops the literals, attaches the derive-trigger); this lint stops a
  // NEW migration from re-introducing the trap.
  for (const f of files) {
    const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? "0", 10);
    if (num < ENFORCED_FROM) continue;
    const hits = findLiteralTenantDefault(
      readFileSync(join(SQL_DIR, f), "utf8"),
    );
    if (!hits.length) continue;
    failed = true;
    console.error(
      `✗ ${f}: literal DEFAULT on a tenant-scoping column (${hits
        .map((h) => `${h.column} SET DEFAULT ${h.value}`)
        .join(
          ", ",
        )}) — the active workspace is only knowable IN-PROCESS (request header → ALS, or the process pin), so a literal here is a GUESS that silently files rows under the WRONG tenant while the INSERT still reports success. This shipped 181 mis-tenanted agent_chats rows and surfaced as a chat panel spinning forever (WI-5125). Drop the default and stamp the column explicitly in the writer (activeWorkspaceId()); a derive-net belongs in a BEFORE INSERT trigger (harness_shared.fill_workspace_id_from_projects) — see 616-workspace-stamp-consolidated-views.sql and /internal/docs/agent-insights/consolidated-view-literal-workspace-default.`,
    );
  }

  // 5. unguarded work_items harness_slug re-slug (the migration-631 crash-loop class)
  for (const f of files) {
    const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? "0", 10);
    if (num < ENFORCED_FROM) continue; // applied history: immutable, already ran
    const hits = findUnguardedReslug(readFileSync(join(SQL_DIR, f), "utf8"));
    if (!hits.length) continue;
    failed = true;
    console.error(
      `✗ ${f}: work_items.harness_slug re-slug UPDATE with no collision guard (${hits.join(" · ")}) — on a shipped seed that already has a row at the target slug for the same feature_id this dupes work_items_pkey and CRASH-LOOPS the packaged operator on first boot (the v0.0.12 migration-631 bug, caught only after a ~45-min build). De-dup colliders first with a DELETE FROM harness_shared.work_items (mirror 630/631), or guard the UPDATE with "AND NOT EXISTS (SELECT 1 … row already at the target slug …)".`,
    );
  }

  // 6. unique-index SHAPE SWAP in one migration (the 461/564/689 class)
  //
  // Its own boundary (INDEX_SWAP_ENFORCED_FROM), not ENFORCED_FROM: 564 and 689
  // already carry this pattern above 494 and are applied+ledgered, so they are
  // grandfathered exactly like the other checks' legacy files.
  const swaps = partitionIndexSwaps(
    files.map((f) => ({ file: f, text: readFileSync(join(SQL_DIR, f), "utf8") })),
  );
  for (const { file: f, hits } of swaps.offenders) {
    failed = true;
    console.error(
      `✗ ${f}: drops a ${hits.map((h) => h.table).join("/")} index in the SAME migration that creates its unique replacement (${hits
        .map(
          (h) =>
            `${h.index}${h.partial ? " [partial]" : ""} ← drops ${h.dropped.join(", ")}`,
        )
        .join(
          " · ",
        )}) — PostgreSQL infers an ON CONFLICT target by MATCHING a unique index, so changing that index's shape (partial predicate, column set, expression) makes every ON CONFLICT spec written against the old shape match NO index and fail AT PLAN TIME: every write, not just conflicting ones. On a SHARED database the migration lands the instant ANY operator boots while the matching code lands only per-deploy, so this is a breaking change to every not-yet-deployed reader even when the code fix is in the same commit. It has already caused this outage three times on these tables (461 → zero fact writes until 2026-07-03; 564 repeated it on memory_canonical; 689 took facts:assert down fleet-wide for an hour). Make it TWO-PHASE: migration N creates the new index and LEAVES the old one, then migration N+k drops the old one once the code is deployed everywhere. If the swap is genuinely safe, say why with "-- lint-migrations: allow-index-swap <reason>".`,
    );
  }
  // Never silent, same contract as the txctl exemptions above.
  for (const { file: f, hits } of swaps.exempted) {
    console.log(
      `· ${f}: same-migration unique-index shape swap (${hits
        .map((h) => h.index)
        .join(
          ", ",
        )}) — FROZEN (already applied; the immutability guard refuses the in-file allow-index-swap pragma). See FROZEN_INDEX_SWAP_EXEMPTIONS.`,
    );
  }

  // 6b. unacknowledged ACCESS EXCLUSIVE lock (the 868/1020 class)
  //
  // Its own boundary (EXCLUSIVE_LOCK_ENFORCED_FROM), not ENFORCED_FROM: 17 files
  // below it already carry DISABLE TRIGGER and are applied+ledgered, grandfathered
  // exactly like the other checks' legacy files.
  for (const f of files) {
    const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? "0", 10);
    if (num < EXCLUSIVE_LOCK_ENFORCED_FROM) continue;
    const hits = findUnacknowledgedExclusiveLock(
      readFileSync(join(SQL_DIR, f), "utf8"),
    );
    if (!hits.length) continue;
    failed = true;
    const hot = hits.filter((h) => h.hot);
    console.error(
      `✗ ${f}: ${hits
        .map((h) => `ALTER TABLE ${h.table} ${h.action} TRIGGER ${h.target}`)
        .join(" · ")} takes an ACCESS EXCLUSIVE lock with no -- EXCLUSIVE-LOCK: acknowledgment${
        hot.length
          ? ` — and ${hot
              .map((h) => h.table)
              .join(", ")} is one of the hottest tables in the system`
          : ""
      }. A PENDING exclusive request queues every subsequent READER behind it, so an attempt that merely WAITS still stalls reads fleet-wide; and because migrations auto-apply at boot, an armed file carrying this can fail — or stall — during startup, precisely when the box is busiest. Measured on 1020 under live fleet load: five attempts, all "canceling statement due to lock timeout" (EI-21698566084995732). Usually you do not need it at all: 868/870/950 disabled triggers because they rewrote \`status\` and wanted the state-change stamping silent, but a payload-only UPDATE wants those triggers LIVE — emit_change_notify_trg is the sync invalidation that makes the repair show up in the UI. Delete the DISABLE/ENABLE pair if the triggers are wanted (1020 did, and its guard re-passed with all 24 user triggers live). If the lock is genuinely required, say why with "-- EXCLUSIVE-LOCK: <why this table can take ACCESS EXCLUSIVE at apply time>".`,
    );
  }

  // 6d. view drop without a dependent account (the 678 / 374 class —
  //     EI-18748424931934157, WI-6219)
  //
  // Its own boundary (VIEW_DROP_ENFORCED_FROM), not ENFORCED_FROM: 21
  // applied+ledgered files already carry a DROP VIEW, the highest at 1039.
  for (const f of files) {
    const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? "0", 10);
    if (num < VIEW_DROP_ENFORCED_FROM) continue;
    const hits = findUnguardedViewDrop(readFileSync(join(SQL_DIR, f), "utf8"));
    if (!hits.length) continue;
    failed = true;
    const cascading = hits.filter((h) => h.cascade);
    console.error(
      `✗ ${f}: ${hits
        .map(
          (h) =>
            `DROP VIEW ${h.view}${h.cascade ? " CASCADE" : ""}${h.dynamic ? " (dynamic, via EXECUTE format)" : ""}`,
        )
        .join(
          " · ",
        )} — nothing in this file states what depends on ${hits.length === 1 ? "it" : "them"}, and dropping a view is only safe once that is known.${
        cascading.length
          ? ` ${cascading.map((h) => h.view).join(", ")} uses CASCADE, which is the SILENT direction: it drops every dependent without naming one, and because migrations run ONCE the dependent's own CREATE never runs again — migration 374 dropped harness_shared.work_items CASCADE and took harness_shared.fleet_assignment with it (canonical body in 358), blinding fleet:assignments, scheduler:running, the reclaim sweep and the UI fleet view on every DB that applied it, until 375 restored it by hand.`
          : ` A BARE drop of a depended-on view does not silently succeed — Postgres refuses it ("cannot drop view … because other objects depend on it"), so this fails at APPLY time, and migrations auto-apply at boot: that is how 678 crash-looped a real operator.`
      } PREFER \`CREATE OR REPLACE VIEW\`, which keeps dependents intact and is enough whenever the column list is unchanged. If the shape really must change, capture the dependents with pg_get_viewdef, drop CASCADE, then replay them in the same transaction. Note the reasoning trap this check exists for: 678's author DID write a safety note, but it reasoned about the COLUMN ("nothing has been built on it") when the dependency was on the VIEW. State why the DEPENDENTS are safe — not the column — with "-- lint-migrations: allow-view-drop <reason>".`,
    );
  }

  // 6c. view lock-order inversion (the 721 class — EI-19320370563025481)
  //
  // Its own boundary (VIEW_LOCK_ORDER_ENFORCED_FROM), not ENFORCED_FROM: 11
  // applied+ledgered files already carry the shape, the highest at 677.
  for (const f of files) {
    const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? "0", 10);
    if (num < VIEW_LOCK_ORDER_ENFORCED_FROM) continue;
    const hits = findViewLockOrderInversion(
      readFileSync(join(SQL_DIR, f), "utf8"),
    );
    if (!hits.length) continue;
    failed = true;
    const hot = hits.filter((h) => h.hot);
    const first = hits[0];
    console.error(
      `✗ ${f}: ${hits
        .map((h) => h.dynamic
          ? 'dynamic ALTER TABLE … then dynamic CREATE OR REPLACE VIEW (relation order unresolved)'
          : `ALTER TABLE ${h.table} … then CREATE OR REPLACE VIEW ${h.view} (which selects from ${h.table})`)
        .join(
          " · ",
        )} — this takes the two locks in the INVERSE of reader order and deadlocks${
        hot.length
          ? `, and ${hot.map((h) => h.table).join(", ")} is one of the hottest tables in the system`
          : ""
      }. A reader of the view locks view → base table; this file locks table (ALTER) → view (CREATE OR REPLACE), so with a live fleet there is always a reader mid-way between the two objects: "Process A waits for AccessExclusiveLock on ${first.view}, blocked by B; process B waits for AccessShareLock on ${first.table}, blocked by A." THE OBVIOUS FIX IS THE WRONG ONE: attempt 1's symptom is "canceling statement due to lock timeout", which reads as ordinary contention, but widening lock_timeout_sec makes it WORSE — a longer wait on ACCESS EXCLUSIVE queues the entire fleet behind you (FIFO), and on 721 it converted the timeout into a deadlock (5 attempts exhausted, then "deadlock detected" at the view statement). Take BOTH locks up front, in READER order, at the top of the transaction:\n     LOCK TABLE ${first.view} IN ACCESS EXCLUSIVE MODE;\n     LOCK TABLE ${first.table} IN ACCESS EXCLUSIVE MODE;\n   721 then applied on ATTEMPT 1 under the same traffic that had just failed 7 attempts. Re-declaring the view BEFORE the ALTER is equally safe (that is already reader order). If the inversion is genuinely safe here, say why with "-- lint-migrations: allow-view-lock-order <reason>".`,
    );
  }

  // 7. unreserved numbers (PG optional)
  const runnerFiles = files.filter((f) => f.endsWith(".sql"));
  const fileNums = runnerFiles
    .map((f) => /^(\d+)-/.exec(f)?.[1])
    .filter(Boolean)
    .map((n) => Number.parseInt(n, 10));
  try {
    const { reservations, appliedFilenames } = await fetchReservationState();
    const reserved = new Set(reservations.map((row) => Number(row.num)));
    const unreserved = unreservedNumbers(fileNums, reserved);
    if (unreserved.length) {
      failed = true;
      console.error(
        `✗ migration number(s) ≥${ENFORCED_FROM} on disk without a reservation row (use db:next-migration): ${unreserved.join(", ")}`,
      );
    }
    // The guard on the frozen-exemption list: every entry must ACTUALLY be
    // applied. An entry that is not applied is still editable, so it must be
    // fixed rather than excused — this is what stops the list becoming a bypass.
    const bogus = unappliedFrozenExemptions(appliedFilenames);
    if (bogus.length) {
      failed = true;
      console.error(
        `✗ FROZEN_TXCTL_EXEMPTIONS lists file(s) that are NOT applied, so they are not frozen and must be fixed, not exempted: ${bogus.join(", ")}`,
      );
    }
    const bogusSwaps = unappliedFrozenExemptions(
      appliedFilenames,
      FROZEN_INDEX_SWAP_EXEMPTIONS,
    );
    if (bogusSwaps.length) {
      failed = true;
      console.error(
        `✗ FROZEN_INDEX_SWAP_EXEMPTIONS lists file(s) that are NOT applied, so they are not frozen and must be fixed (two-phase, or the in-file allow-index-swap pragma), not exempted: ${bogusSwaps.join(", ")}`,
      );
    }
    const mismatches = reservationFilenameMismatches(runnerFiles, reservations, {
      appliedFilenames,
    });
    if (mismatches.length) {
      failed = true;
      console.error("✗ migration reservation filename mismatch(es):");
      for (const mismatch of mismatches) {
        console.error(
          `   ${mismatch.file}: number ${mismatch.num} is reserved for ${mismatch.reservedFilename ?? "<null>"}`,
        );
      }
    }
  } catch (e) {
    console.log(
      `· reservation check skipped (PG unreachable: ${e?.code ?? e?.message ?? e})`,
    );
  }

  if (failed) process.exit(1);
  console.log(
    `✓ lint:migrations — ${files.length} files clean (dup-NNN, raw BEGIN/COMMIT, RENAME CONSTRAINT, tenant DEFAULT, work_items reslug guard, index-shape swap≥${INDEX_SWAP_ENFORCED_FROM}, view lock-order≥${VIEW_LOCK_ORDER_ENFORCED_FROM}, view drop≥${VIEW_DROP_ENFORCED_FROM}, reservation number+filename≥${ENFORCED_FROM})`,
  );
}

// `migration-preapply-lint.ts` imports the pure predicates above, which pulls this module into
// plain-node host bundles. A raw import.meta.url/argv comparison becomes true for every inlined
// module and ran this CLI scan during :3170 boot (EI-21543544916409140). Keep the shared
// bundle-aware guard here; do not hand-roll another path comparison.
if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
