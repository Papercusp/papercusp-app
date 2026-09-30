#!/usr/bin/env node
/**
 * lint:migration-forward-compat
 *
 * A migration runs against the SHARED database immediately. The operator serving
 * :3070 runs from the RELEASE checkout, which lags staging by a full
 * commit -> green-checkpoint -> deploy cycle. So for the whole length of that
 * cycle the database is NEWER than the code querying it.
 *
 * That means destructive DDL is not "a schema change" -- it is a live change to
 * the contract that the CURRENTLY DEPLOYED binary is still relying on.
 *
 * WHY THIS EXISTS (EI-18797473716313783, 2026-07-27):
 *   migration 689-agent-facts-append-versioning.sql did, in ONE file:
 *     CREATE UNIQUE INDEX agent_facts_identity_current ... WHERE superseded_at IS NULL;
 *     DROP INDEX IF EXISTS harness_shared.agent_facts_identity;   <-- the arbiter
 *   The deployed release's facts:assert used
 *     ON CONFLICT (workspace_id, scope, coalesce(scope_ref,''), key, coalesce(source_hive,''))
 *   with no WHERE predicate. Postgres cannot infer a PARTIAL unique index unless the
 *   conflict target repeats the predicate, so once the old non-partial index was
 *   dropped there was no inferable arbiter at all and EVERY facts:assert call failed
 *   fleet-wide with:
 *     "there is no unique or exclusion constraint matching the ON CONFLICT specification"
 *   The migration applied at 08:37:31Z. The code fix was written ~2h41m LATER, and the
 *   outage was not noticed for ~3 HOURS -- during which the mandated durable-conclusion
 *   path for every looping agent was silently failing.
 *
 * THE DISCIPLINE (expand / contract):
 *   Split it across two migrations. EXPAND first (add the new index/column, ship and
 *   deploy the code that uses it), CONTRACT later (drop the old one, once no deployed
 *   release still references it). Never both in one file.
 *
 * If a destructive statement genuinely IS safe for the deployed release, say so in the
 * migration with an explicit acknowledgment line:
 *
 *   -- FORWARD-COMPAT: <why the currently-deployed release does not use this>
 *
 * That is deliberately a human sentence, not a flag: the point is to force the author
 * to check the release checkout before dropping something out from under it.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { stripCommentsOnly, stripSqlComments } from './lib/strip-comments-and-strings.mjs';
import { selectExplicitBasenames } from './lib/explicit-files.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * Repo-relative form of the scanned directory, EXPORTED so the repo-wide invariant
 * guard that routes this lint (MIGRATION_SQL_DIR in scripts/affected-tests.mjs) can be
 * asserted against the directory this lint actually reads, rather than a hand-copied
 * duplicate of it. Mirrors SCHEMA_FILE_REL in check-partial-index-alignment.mjs, and
 * exists for the same reason: if the two silently disagree the guard stops firing and
 * the run stays green while no longer checking anything. (WI-9573)
 */
export const SQL_DIR_REL = 'libs/papercusp/libs/db/sql';
const SQL_DIR = join(__dirname, '..', ...SQL_DIR_REL.split('/'));

/**
 * A migration is authored in a parked filename before it is armed. The runner
 * intentionally ignores these suffixes, but the authoring-time dependency guard
 * must not: this is the exact window in which code can start naming a column that
 * the shared database does not have yet.
 */
export const PARKED_SUFFIXES = ['.DRAFT', '.PENDING-CODE-DEPLOY'];

/**
 * Production source roots searched for references to columns added by parked
 * migrations. Keep this explicit: scanning generated output, docs, or dependency
 * trees would turn a cheap authoring guard into a noisy repository grep.
 *
 * Exported so the affected-tests router can mirror the exact domain and attach the
 * guard when either the parked migration OR a source consumer changes.
 */
export const SOURCE_ROOTS = [
  'apps',
  'packages',
  'libs/papercusp/packages',
  'libs/papercusp/libs/db/src',
];

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const SOURCE_SKIP_DIRS = new Set([
  '.git',
  '__snapshots__',
  '_retired',
  'build',
  'coverage',
  'dist',
  'dist-host',
  'node_modules',
  'public',
  'target',
]);

/**
 * Migrations are immutable once applied, so historical files can never be fixed.
 * Enforce from the first migration authored after this guard landed.
 */
export const ENFORCE_FROM = 693;

/**
 * The acknowledgment token, EXPORTED for the same reason SQL_DIR_REL is: the
 * authoring-time PostToolUse nudge
 * (apps/operator/scripts/hooks/cc/posttooluse-migration-forward-compat-nudge.mjs)
 * must apply THIS marker, not a hand-copied duplicate. A second copy that
 * silently disagreed would let the nudge stay quiet on a file the gate then
 * reds on — reintroducing the exact discover-it-hours-later cost the nudge
 * exists to remove.
 *
 * NOTE for anyone tempted to seed a placeholder ack into new migrations: this
 * matches ANY non-whitespace after the colon, so `-- FORWARD-COMPAT: TODO` and
 * `-- FORWARD-COMPAT: <why>` both SATISFY it. A seeded placeholder would
 * therefore rubber-stamp every migration and silence the guard permanently.
 * scripts/next-migration.mjs deliberately emits prose that does NOT match;
 * `forward-compat-authoring-nudge.test.ts` pins that.
 */
export const ACK_MARKER = /^[ \t]*--[ \t]*FORWARD-COMPAT:[ \t]*\S/im;

const RULES = [
  {
    // KNOWN, ACCEPTED false positive: capture-drop-REBUILD. Widening a pgvector
    // column requires dropping and rebuilding its HNSW/IVFFlat index in the same
    // DO block (the index is bound to the column's dimensionality), so this static
    // scan sees the DROP without its paired rebuild. EI-19407054630567497 proposed
    // teaching the rule to recognise that shape. DECLINED after measurement —
    // recorded here, not only in the closed item, because this is where the next
    // agent arrives:
    //   1. Shape-detection trades certainty for inference in a LOAD-BEARING safety
    //      rule. This guards EI-18797473716313783, where a dropped ON CONFLICT
    //      arbiter broke facts:assert fleet-wide for ~3h. A false NEGATIVE here
    //      costs far more than the false positive it would remove.
    //   2. The false positive now costs one line, not an incident. Since the
    //      edit-time nudge hook landed (2026-08-03T20:12Z, EI-19462877357083817)
    //      the author is prompted BEFORE commit: mig 727 (pre-hook) red-pinned the
    //      fleet gate and took 5 commits to settle; mig 847 (post-hook, the ONLY
    //      recurrence since) carried the marker in its first commit — 1 commit,
    //      zero gate impact.
    //   3. Base rate, measured 2026-08-31: of 327 migrations >= 693, 15 contain
    //      DROP INDEX and 15/15 are acknowledged (14 inline, 1 sidecar). None
    //      unacknowledged. This is not a costly recurring class.
    // Acknowledge a genuine capture-drop-rebuild with `-- FORWARD-COMPAT: <why>`,
    // or a sidecar .forward-compat.json when the migration is ALREADY APPLIED and
    // editing it would trip migration-drift. Do NOT relax this regex.
    id: 'drop-index',
    re: /\bDROP\s+INDEX\b/i,
    why: 'drops an index the deployed release may be relying on as an ON CONFLICT arbiter (this is exactly EI-18797473716313783)',
  },
  {
    id: 'drop-constraint',
    re: /\bDROP\s+CONSTRAINT\b/i,
    why: 'removes a constraint the deployed release may depend on for upsert/validation behavior',
  },
  {
    id: 'drop-column',
    re: /\bDROP\s+COLUMN\b/i,
    why: 'removes a column the deployed release almost certainly still SELECTs or INSERTs',
  },
  {
    id: 'drop-table',
    re: /\bDROP\s+TABLE\b/i,
    why: 'removes a relation the deployed release may still query',
  },
  {
    id: 'rename',
    re: /\bRENAME\s+(?:TO|COLUMN|CONSTRAINT)\b/i,
    why: 'a rename is a drop plus an add as far as the deployed release is concerned',
  },
  {
    id: 'narrowing-unique-index',
    re: /\bCREATE\s+UNIQUE\s+INDEX\b[\s\S]*?\bWHERE\b/i,
    why: 'a PARTIAL unique index cannot serve an un-predicated ON CONFLICT -- deployed code that relied on a non-partial index of the same columns will fail to infer an arbiter',
  },
  {
    id: 'set-not-null',
    re: /\bALTER\s+COLUMN\b[\s\S]{0,120}?\bSET\s+NOT\s+NULL\b/i,
    why: 'the deployed release may still INSERT rows without this column',
  },
];

/**
 * Strip SQL comments so prose describing DDL is never mistaken for DDL.
 *
 * Uses the CANONICAL shared mask (EI-20073035509369492). The private regex pair this
 * replaced -- `/\*...*\/` then `--[^\n]*` -- was not quote-aware, which made this guard
 * fail at its own job in a way no test covered:
 *
 *   INSERT INTO t(note) VALUES ('see -- below'); ALTER TABLE t ALTER COLUMN c SET NOT NULL;
 *
 * The `--` there is INSIDE a string literal, so the naive regex erased the rest of the
 * line -- taking the real SET NOT NULL with it and reporting the file CLEAN. A guard whose
 * whole purpose is catching destructive DDL silently missed a destructive DDL. Pinned by a
 * falsifying control in the self-test below.
 *
 * ⚠ COMMENTS-ONLY, deliberately -- NOT `stripSqlCommentsAndStrings`. The RULES below match
 * DDL KEYWORDS, and the strings variant seals `$tag$` bodies wholesale, which would hide
 * REAL DDL inside a DO block (a false NEGATIVE on a forward-compat guard). The comments-only
 * mask recurses into those bodies instead: body CODE stays live, body COMMENTS get masked.
 * Both directions are pinned in the self-test.
 */
function stripComments(sql) {
  return stripSqlComments(sql);
}

/**
 * The single detection rule. EXPORTED so the authoring-time nudge reuses it
 * verbatim rather than re-implementing the regex set (see ACK_MARKER's note).
 * Returns the matched RULES entries ({ id, re, why }), empty when clean.
 */
/**
 * Split stripped SQL into individual statements.
 *
 * WHY THIS EXISTS (EI-20745458722827468): several rules use `[\s\S]*?` to span a clause
 * that may wrap lines — `narrowing-unique-index` looks for a WHERE after CREATE UNIQUE
 * INDEX. Tested against the WHOLE FILE that wildcard also spans STATEMENT BOUNDARIES, so
 * the rule fired whenever a unique index appeared anywhere before any WHERE anywhere
 * later — even a WHERE belonging to a different, non-unique index. That is not a partial
 * unique index; it is "a unique index exists, and the file mentions WHERE later", which
 * is a routine and entirely safe shape (an identity unique index plus a partial index for
 * a hot filtered read). Matching per statement makes each rule mean what it says.
 *
 * Splitting on `;` is safe here because comments (which may contain semicolons) are
 * already stripped, and a `$$`-quoted DO block is kept whole below.
 *
 * @param {string} code comment-stripped SQL
 * @returns {string[]}
 */
function splitStatements(code) {
  const statements = [];
  let current = '';
  let inDollarBlock = false;
  for (let i = 0; i < code.length; i += 1) {
    // A DO $$ ... $$ block legitimately contains semicolons; keep it intact so its
    // inner statements are still each seen as part of one enclosing statement rather
    // than being sliced mid-block.
    if (code.startsWith('$$', i)) {
      inDollarBlock = !inDollarBlock;
      current += '$$';
      i += 1;
      continue;
    }
    if (code[i] === ';' && !inDollarBlock) {
      statements.push(current);
      current = '';
      continue;
    }
    current += code[i];
  }
  if (current.trim()) statements.push(current);
  return statements;
}

export function violationsFor(sqlText) {
  const code = stripComments(sqlText);
  const statements = splitStatements(code);
  // A rule fires when ANY single statement violates it — never on a wildcard that
  // wandered across statements into an unrelated one.
  return RULES.filter((r) => statements.some((s) => r.re.test(s)));
}

/**
 * True when `file` is a migration this guard ENFORCES on — i.e. `NNN-*.sql`
 * with NNN >= ENFORCE_FROM. Exported so the nudge applies the same cutoff and
 * never nags about a historical migration that can no longer be edited.
 */
export function isEnforcedMigrationFile(file) {
  if (!file.endsWith('.sql')) return false;
  const dash = file.indexOf('-');
  if (dash <= 0) return false;
  const num = Number.parseInt(file.slice(0, dash), 10);
  return Number.isFinite(num) && num >= ENFORCE_FROM;
}

/**
 * True when a filename is an armed migration or a parked migration artifact.
 * The main lint uses this instead of `endsWith('.sql')` so a DRAFT can reach the
 * dependency check while destructive-DDL enforcement remains limited to armed SQL.
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isMigrationArtifactFile(file) {
  return file.endsWith('.sql') || PARKED_SUFFIXES.some((suffix) => file.endsWith(`.sql${suffix}`));
}

/** True when `file` is an enforced migration that has not been armed yet. */
export function isDraftMigrationFile(file) {
  const suffix = PARKED_SUFFIXES.find((candidate) => file.endsWith(`.sql${candidate}`));
  return suffix ? isEnforcedMigrationFile(file.slice(0, -suffix.length)) : false;
}

/**
 * ---------------------------------------------------------------------------
 * Typed, candidate-bound acknowledgement sidecar for an APPLIED migration.
 * Ruling: stable-candidate-related-gate-2026-08-23#D-092. Root cause:
 * EI-21539300249506308.
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS. Before this, a migration that crossed into immutability
 * carrying destructive DDL had NO satisfiable route through this lint:
 *
 *   - add `-- FORWARD-COMPAT:` inline  -> migration-immutability-guard (WI-38352)
 *     refuses any write to a file already recorded in schema_migrations;
 *   - rename to `.sql.PENDING-CODE-DEPLOY` -> the scan below maps parked names
 *     back to their effective `.sql` name, so parking changes nothing (measured:
 *     the rename was executed, the guard stayed rc=1, and it was reverted);
 *   - raise ENFORCE_FROM past it -> that constant is a one-time historical
 *     watermark, not a rolling cutoff; moving it silently un-enforces every
 *     migration in between.
 *
 * Two guards, each individually correct, were jointly unsatisfiable, and this
 * lint is gate-blocking: the intersection was a permanent red that froze every
 * agent's deploys. ENFORCE_FROM already handles migrations that were immutable
 * BEFORE the guard landed; nothing handled one that becomes immutable AFTER it,
 * which is every future occurrence.
 *
 * THE SHAPE OF THE FIX. The acknowledgement moves OUT of the immutable file into
 * a sidecar that sits beside it. That is the whole trick: the sidecar is mutable,
 * so every refusal it can produce is ACTIONABLE — which is what makes it safe to
 * fail closed here, where failing closed on the migration itself produced the
 * un-actionable deadlock above.
 *
 * It is deliberately far stricter than the inline `-- FORWARD-COMPAT:` marker it
 * sits beside (that marker accepts any non-whitespace, `TODO` included). Every
 * field is typed and machine-checkable, and ANY defect refuses the whole sidecar
 * rather than honouring a partially-valid one.
 *
 *   {
 *     "kind": "migration-forward-compat-ack",
 *     "version": 1,
 *     "migration": "975-remove-owned-trigger-legacy-arbiter.sql",
 *     "appliedSha256": "<sha256 of that file's exact bytes>",
 *     "requiresDeployedCommit": "<40-hex commit containing the compatible writer>",
 *     "requiresDeployedNote": "what that commit changed, in one line",
 *     "rationale": "why the deployed release tolerates this DDL",
 *     "workItem": "EI-21539300249506308",
 *     "reviewBy": "YYYY-MM-DD",
 *     "postDeploy": "remove-sidecar" | "renew-review"
 *   }
 *
 * The two bindings that carry the weight:
 *   - appliedSha256 pins the acknowledgement to EXACT BYTES. schema_migrations
 *     stores sha256 of the applied file, and immutability means the file on disk
 *     still IS those bytes — so recomputing the hash here verifies the ledger
 *     binding offline, with no database dependency in a lint that runs inside the
 *     gate. Edit the migration and the sidecar stops applying to it.
 *   - requiresDeployedCommit pins it to a CANDIDATE. The sidecar is honoured only
 *     in a tree that actually contains the compatible writer, so it cannot travel
 *     backwards to a checkout where the DDL really would break the live release.
 *
 * On "unapplied/editable": a sidecar is refused outright for a `.DRAFT` or
 * `.PENDING-CODE-DEPLOY` artifact. Those are editable by construction, so their
 * author must use the inline marker. Armed-and-immutable is the only case this
 * exists for, and the immutability guard is what enforces the other half.
 */
export const SIDECAR_SUFFIX = '.forward-compat.json';
export const SIDECAR_KIND = 'migration-forward-compat-ack';
export const SIDECAR_VERSION = 1;

/** Exact permitted key set. An unknown key refuses the sidecar (no free-form fields). */
export const SIDECAR_KEYS = Object.freeze([
  'kind',
  'version',
  'migration',
  'appliedSha256',
  'requiresDeployedCommit',
  'requiresDeployedNote',
  'rationale',
  'workItem',
  'reviewBy',
  'postDeploy',
]);

const SIDECAR_POST_DEPLOY = new Set(['remove-sidecar', 'renew-review']);
const SIDECAR_HEX40 = /^[0-9a-f]{40}$/;
const SIDECAR_HEX64 = /^[0-9a-f]{64}$/;
const SIDECAR_WORK_ITEM = /^(?:WI|EI|F)-\d+$/;
const SIDECAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Prose that carries no information. This is the specific weakness of ACK_MARKER
 * (`-- FORWARD-COMPAT: TODO` satisfies it) that D-092 requires the typed route to
 * close, so a placeholder rationale must refuse rather than pass.
 */
const SIDECAR_PLACEHOLDER = /^(?:todo|tbd|fixme|xxx|wip|n\/?a|none|null|placeholder|unknown|\W*)$/i;

/** The sidecar filename for a migration, keyed on its EFFECTIVE `.sql` name. */
export function sidecarNameFor(effectiveFile) {
  return `${effectiveFile}${SIDECAR_SUFFIX}`;
}

/** The effective `.sql` name for a migration artifact (strips any parked suffix). */
export function effectiveMigrationName(file) {
  return PARKED_SUFFIXES.reduce(
    (name, suffix) => (name.endsWith(suffix) ? name.slice(0, -suffix.length) : name),
    file,
  );
}

/** sha256 of a migration's bytes — the same value schema_migrations records. */
export function migrationSha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Resolve whether `sha` is a commit in this repo that is an ANCESTOR of HEAD.
 * Returns true / false / null, where **null means "could not determine"** and the
 * caller must fail closed on it. Never throws.
 *
 * @param {{ exec?: (file: string, args: string[], options?: Record<string, unknown>) => unknown, cwd?: string }} [options]
 * @returns {(sha: string) => boolean | null}
 */
export function makeAncestorResolver({ exec = execFileSync, cwd = join(__dirname, '..') } = {}) {
  return (sha) => {
    const run = (args) => exec('git', args, { cwd, stdio: 'ignore' });
    try {
      run(['cat-file', '-e', `${sha}^{commit}`]);
    } catch {
      return null; // unknown commit -> undetermined, not "not an ancestor"
    }
    try {
      run(['merge-base', '--is-ancestor', sha, 'HEAD']);
      return true;
    } catch (error) {
      // git exits 1 for "resolved, but not an ancestor". Anything else is a
      // broken instrument, which must NOT read as a clean negative.
      return error && error.status === 1 ? false : null;
    }
  };
}

/**
 * Decide whether a sidecar acknowledges its migration. PURE — every input is
 * passed in, so the whole refusal matrix is testable without touching the tree.
 *
 * Returns { present, honored, refusals }. `present:false` means no sidecar exists
 * (not a refusal); `honored:false` with refusals means one exists and was REJECTED.
 *
 * @param {{
 *   artifactFile?: string,
 *   effectiveFile?: string,
 *   sidecarText?: string | null,
 *   migrationSha?: string | null,
 *   isAncestorOfHead?: (sha: string) => boolean | null,
 *   now?: Date,
 * }} [input]
 * @returns {{ present: boolean, honored: boolean, refusals: string[] }}
 */
export function evaluateForwardCompatSidecar({
  artifactFile,
  effectiveFile = effectiveMigrationName(artifactFile ?? ''),
  sidecarText,
  migrationSha,
  isAncestorOfHead = () => null,
  now = new Date(),
} = {}) {
  if (sidecarText == null) return { present: false, honored: false, refusals: [] };

  const refusals = [];
  const refuse = (reason) => refusals.push(reason);
  const nonEmptyString = (value, min) =>
    typeof value === 'string' && value.trim().length >= min && !SIDECAR_PLACEHOLDER.test(value.trim());

  let doc;
  try {
    doc = JSON.parse(sidecarText);
  } catch (error) {
    return { present: true, honored: false, refusals: [`sidecar is not valid JSON (${error.message})`] };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { present: true, honored: false, refusals: ['sidecar must be a JSON object'] };
  }

  const unknown = Object.keys(doc).filter((key) => !SIDECAR_KEYS.includes(key));
  if (unknown.length > 0) refuse(`unknown key(s): ${unknown.join(', ')} (no free-form fields)`);
  const missing = SIDECAR_KEYS.filter((key) => !(key in doc));
  if (missing.length > 0) refuse(`missing required key(s): ${missing.join(', ')}`);

  if (doc.kind !== SIDECAR_KIND) refuse(`kind must be exactly "${SIDECAR_KIND}"`);
  if (doc.version !== SIDECAR_VERSION) refuse(`version must be ${SIDECAR_VERSION}`);

  // Effective-name mapping: the sidecar names the ARMED `.sql`, never a parked name.
  if (doc.migration !== effectiveFile) {
    refuse(`migration "${doc.migration}" does not match this migration (${effectiveFile})`);
  }

  // Unapplied / editable: a parked or draft artifact can still be edited, so its
  // author must use the inline marker instead of a sidecar.
  if (artifactFile !== effectiveFile) {
    refuse(`sidecar is not allowed for the editable artifact ${artifactFile} — add an inline -- FORWARD-COMPAT: line instead`);
  }

  // Ledger binding: exact applied bytes.
  if (typeof doc.appliedSha256 !== 'string' || !SIDECAR_HEX64.test(doc.appliedSha256)) {
    refuse('appliedSha256 must be 64 lowercase hex characters');
  } else if (typeof migrationSha !== 'string' || !SIDECAR_HEX64.test(migrationSha)) {
    refuse('could not hash the migration file to verify appliedSha256');
  } else if (doc.appliedSha256 !== migrationSha) {
    refuse(`appliedSha256 does not match this migration's bytes (file is ${migrationSha})`);
  }

  // Candidate binding: the compatible writer must be present in THIS tree.
  if (typeof doc.requiresDeployedCommit !== 'string' || !SIDECAR_HEX40.test(doc.requiresDeployedCommit)) {
    refuse('requiresDeployedCommit must be a 40-character lowercase commit sha');
  } else {
    const ancestry = isAncestorOfHead(doc.requiresDeployedCommit);
    if (ancestry === true) {
      // satisfied
    } else if (ancestry === false) {
      refuse(`requiresDeployedCommit ${doc.requiresDeployedCommit} is not an ancestor of HEAD — this tree does not contain the compatible writer`);
    } else {
      refuse(`requiresDeployedCommit ${doc.requiresDeployedCommit} could not be resolved in this repository`);
    }
  }

  if (!nonEmptyString(doc.requiresDeployedNote, 12)) {
    refuse('requiresDeployedNote must say what that commit changed (>= 12 chars, no placeholder)');
  }
  if (!nonEmptyString(doc.rationale, 24)) {
    refuse('rationale must explain why the deployed release tolerates this DDL (>= 24 chars, no placeholder)');
  }
  if (typeof doc.workItem !== 'string' || !SIDECAR_WORK_ITEM.test(doc.workItem)) {
    refuse('workItem must be a work-item ref such as EI-123, WI-123 or F-123');
  }

  // Stale sidecar. Refusing here is safe precisely because the sidecar is mutable:
  // the fix is to renew or delete it, which is always available.
  if (typeof doc.reviewBy !== 'string' || !SIDECAR_DATE.test(doc.reviewBy)) {
    refuse('reviewBy must be a YYYY-MM-DD date');
  } else {
    const deadline = Date.parse(`${doc.reviewBy}T23:59:59.999Z`);
    if (!Number.isFinite(deadline)) refuse(`reviewBy "${doc.reviewBy}" is not a real date`);
    else if (deadline < now.getTime()) refuse(`sidecar is stale — reviewBy ${doc.reviewBy} has passed; renew or remove it`);
  }

  if (typeof doc.postDeploy !== 'string' || !SIDECAR_POST_DEPLOY.has(doc.postDeploy)) {
    refuse(`postDeploy must be one of: ${[...SIDECAR_POST_DEPLOY].join(', ')}`);
  }

  return { present: true, honored: refusals.length === 0, refusals };
}

/**
 * Read + evaluate the sidecar for one migration artifact on disk.
 *
 * @param {string} directory
 * @param {string} artifactFile
 * @param {{
 *   migrationText?: string,
 *   isAncestorOfHead?: (sha: string) => boolean | null,
 *   now?: Date,
 *   readFile?: (path: string, encoding: string) => string,
 * }} [options]
 * @returns {{ present: boolean, honored: boolean, refusals: string[], sidecarFile: string }}
 */
export function readForwardCompatSidecar(
  directory,
  artifactFile,
  { migrationText, isAncestorOfHead, now, readFile = readFileSync } = {},
) {
  const effectiveFile = effectiveMigrationName(artifactFile);
  const sidecarFile = sidecarNameFor(effectiveFile);
  let sidecarText = null;
  try {
    sidecarText = readFile(join(directory, sidecarFile), 'utf8');
  } catch (error) {
    if (!isMissingFileError(error)) {
      return {
        present: true,
        honored: false,
        sidecarFile,
        refusals: [`sidecar could not be read (${error.message})`],
      };
    }
  }
  const verdict = evaluateForwardCompatSidecar({
    artifactFile,
    effectiveFile,
    sidecarText,
    migrationSha: typeof migrationText === 'string' ? migrationSha256(migrationText) : null,
    isAncestorOfHead,
    now,
  });
  return { ...verdict, sidecarFile };
}

/**
 * Extract column identifiers introduced by an ALTER TABLE ADD COLUMN statement.
 * Comments are masked first, while SQL string bodies remain visible so a real
 * EXECUTE statement inside a DO block is still checked. This intentionally covers
 * the narrow, mechanically decidable class behind EI-20208711931756460.
 */
export function addedColumnsFor(sqlText) {
  const code = stripComments(sqlText);
  const columns = [];
  const seen = new Set();
  const addColumn = /\bADD\s+COLUMN(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))/gi;
  for (const match of code.matchAll(addColumn)) {
    const column = match[1] ?? match[2];
    if (!seen.has(column)) {
      seen.add(column);
      columns.push(column);
    }
  }
  return columns;
}

/**
 * Extract the table identifiers an ALTER TABLE statement targets, WITHOUT the schema
 * qualifier (`harness_shared.local_backends` -> `local_backends`), because source code
 * names the bare table far more often than the schema-qualified one.
 *
 * This exists to qualify the column scan below. A bare column-name match alone is far too
 * broad: measured on migration 843, the column `lifecycle` matched **357 source files**,
 * none of which had anything to do with `local_backends` — plugin lifecycle, release
 * lifecycle, work-item lifecycle. That flood is not a conservative guard, it is the thing
 * that makes authors reach for the `-- FORWARD-COMPAT:` escape hatch to silence a lint they
 * (correctly) read as broken, which is how a REAL forward-compat break gets waved through.
 */
const NAME_COMPONENT = /^(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))/;

/**
 * Resolve ONE `ALTER TABLE` target from the text following the statement header.
 *
 * Returns `{ table }` when the whole qualified name parsed, `{ unresolved }` when it did
 * not. Walking component-by-component is the entire point: it distinguishes a name that
 * ENDED (`harness_shared.adv_sessions`) from one CUT OFF at a dot (`harness_shared.` +
 * something that is not an identifier). One regex cannot tell those apart — its capture
 * just stops early and hands back a bare SCHEMA name wearing a table's clothes.
 *
 * The shape that matters is the standard dynamic-DDL idiom
 * `EXECUTE format('ALTER TABLE harness_shared.%I ...', t)`: `%` cannot start an
 * identifier, so the old single-regex capture yielded the token `harness_shared`
 * (EI-22144711421464181).
 */
function parseAlterTarget(rest) {
  let cursor = 0;
  for (;;) {
    const component = NAME_COMPONENT.exec(rest.slice(cursor));
    if (!component) return { unresolved: rest.slice(0, 60).split('\n')[0].trim() };
    const name = component[1] ?? component[2];
    cursor += component[0].length;
    const dot = /^\s*\.\s*/.exec(rest.slice(cursor));
    if (!dot) return { table: name };
    cursor += dot[0].length;
  }
}

/**
 * Extract what the ALTER TABLE statements target, split into the tables we RESOLVED and
 * the targets we could NOT resolve.
 *
 * The split is the safety property. `tables` is only sound as an EXCLUSION filter when it
 * is COMPLETE, and a dynamic target means it is not — so callers must consult `unresolved`
 * rather than assuming a non-empty list describes every altered table.
 */
export function alterTargetsFor(sqlText) {
  const code = stripComments(sqlText);
  const alterTableHead = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?/gi;
  const tables = new Set();
  const unresolved = [];
  for (const head of code.matchAll(alterTableHead)) {
    const target = parseAlterTarget(code.slice(head.index + head[0].length));
    if (target.table !== undefined) tables.add(target.table);
    else if (!unresolved.includes(target.unresolved)) unresolved.push(target.unresolved);
  }
  return { tables: [...tables], unresolved };
}

export function alteredTablesFor(sqlText) {
  return alterTargetsFor(sqlText).tables;
}

function sourceFileExtension(file) {
  return extname(file).toLowerCase();
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(sourceFileExtension(file));
}

function isMissingFileError(error) {
  return Boolean(error && typeof error === 'object' && error.code === 'ENOENT');
}

/**
 * Read a path found by a directory scan after re-stat'ing it.
 *
 * A parked migration is an in-flight authoring artifact: reservation and rename
 * can remove it after readdirSync returned its name. Re-stat narrows the normal
 * race window, while the read catch closes the final stat/read window. Callers
 * choose whether ENOENT is tolerable; other errors always remain fatal.
 *
 * @param {string} filePath
 * @param {{ allowMissing?: boolean, readFile?: Function, stat?: Function }} options
 * @returns {string|null}
 */
export function readScannedFile(filePath, { allowMissing = false, readFile = readFileSync, stat = statSync } = {}) {
  try {
    stat(filePath);
  } catch (error) {
    if (allowMissing && isMissingFileError(error)) return null;
    throw error;
  }

  try {
    return readFile(filePath, 'utf8');
  } catch (error) {
    if (allowMissing && isMissingFileError(error)) return null;
    throw error;
  }
}

/**
 * Read the names returned by a directory scan, tolerating only explicitly
 * allowed files that disappear while the scan is in flight.
 *
 * @param {string} directory
 * @param {string[]} files
 * @param {{ allowMissing?: boolean|((file: string) => boolean), readFile?: Function, stat?: Function }} options
 * @returns {Array<{file: string, text: string}>}
 */
export function readScannedFiles(directory, files, { allowMissing = false, readFile = readFileSync, stat = statSync } = {}) {
  const loaded = [];
  for (const file of files) {
    const tolerateMissing = typeof allowMissing === 'function' ? allowMissing(file) : allowMissing;
    const text = readScannedFile(join(directory, file), { allowMissing: tolerateMissing, readFile, stat });
    if (text !== null) loaded.push({ file, text });
  }
  return loaded;
}

function sourceCommentsMasked(text, file) {
  return sourceFileExtension(file) === '.sql' ? stripSqlComments(text) : stripCommentsOnly(text, file);
}

function sourceFilesForRepo() {
  const files = [];

  function walk(absDir) {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || SOURCE_SKIP_DIRS.has(entry.name)) continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      const file = relative(resolve(__dirname, '..'), abs).split(sep).join('/');
      if (!entry.isFile() || !isSourceFile(file) || file.startsWith(`${SQL_DIR_REL}/`)) continue;
      const text = readScannedFile(abs, { allowMissing: true });
      if (text !== null) files.push({ file, text });
    }
  }

  const repoRoot = resolve(__dirname, '..');
  for (const root of SOURCE_ROOTS) {
    const abs = join(repoRoot, ...root.split('/'));
    if (existsSync(abs)) walk(abs);
  }
  return files;
}

/**
 * Find source files that already reference columns introduced by a parked
 * migration. `sourceFiles` is injectable so unit tests can prove the detector on
 * small fixtures without writing into the shared checkout.
 *
 * `unresolvedTargets` is non-empty when an ALTER TABLE target could not be parsed (a dynamic
 * `%I`/`%s`). The table filter is SKIPPED in that case — see the reasoning at the call site —
 * so the caller can explain why its result set is column-name-only and broad.
 *
 * @param {string} sqlText
 * @param {Array<{file: string, text: string}>} sourceFiles
 * @returns {{ columns: string[], references: Array<{column: string, file: string, line: number}>, unresolvedTargets: string[] }}
 */
export function findDraftColumnReferences(sqlText, sourceFiles = []) {
  const columns = addedColumnsFor(sqlText);
  const { tables, unresolved } = alterTargetsFor(sqlText);
  // A file cannot be reading `<table>.<column>` if it never mentions `<table>`. Requiring both
  // is what makes the scan usable for a column whose name is also an ordinary programming word.
  // If no table could be parsed we fall back to the column-only match, so an SQL shape this
  // regex does not understand is still scanned exactly as strictly as it was before.
  //
  // A PARTIAL list gets that same fallback, for the same reason. Excluding a file because it
  // mentions none of the tables is only sound when we know ALL of them; with an unresolved
  // dynamic target we do not, and a partial list would silently exclude the very file that
  // reads the dynamically-altered table. "I parsed 4 of 5 targets" is not "I know the targets"
  // — so the honest states are FULLY RESOLVED (qualify) or NOT (don't), with no middle.
  const qualifyingTables = unresolved.length > 0 ? [] : tables;
  const tableTokens = qualifyingTables.map((t) => new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(t)}(?![A-Za-z0-9_$])`, 'i'));
  const references = [];
  for (const column of columns) {
    const token = new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(column)}(?![A-Za-z0-9_$])`, 'i');
    for (const source of sourceFiles) {
      if (source.file.startsWith(`${SQL_DIR_REL}/`)) continue;
      const masked = sourceCommentsMasked(source.text, source.file);
      const match = token.exec(masked);
      if (!match || match.index === undefined) continue;
      if (tableTokens.length && !tableTokens.some((t) => t.test(masked))) continue;
      references.push({
        column,
        file: source.file,
        line: masked.slice(0, match.index).split('\n').length,
      });
    }
  }
  // Reported so a caller can SAY why the scan was unqualified. An unexplained flood is what
  // trains authors to reach for the ACK marker; a named cause tells them the actual remedy.
  return { columns, references, unresolvedTargets: unresolved };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * NON-VACUITY SELF-TEST (D-076 section 4).
 *
 * A structural scan that silently matches nothing reports GREEN and is worse than no
 * gate at all. Before trusting a clean run we prove the detector still fires on a
 * known-positive and stays quiet on a known-negative. These fixtures are embedded so
 * the self-test cannot rot when files move on disk.
 */
function selfTest() {
  const positive = `
    CREATE UNIQUE INDEX IF NOT EXISTS agent_facts_identity_current
      ON harness_shared.agent_facts (workspace_id, scope, key)
      WHERE superseded_at IS NULL;
    DROP INDEX IF EXISTS harness_shared.agent_facts_identity;
  `;
  const negative = `
    -- This migration only talks about how we used to DROP INDEX things.
    -- It also mentions DROP COLUMN and RENAME TO purely in prose.
    CREATE TABLE IF NOT EXISTS harness_shared.some_new_table (
      id text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS some_new_table_created ON harness_shared.some_new_table (created_at);
  `;

  /**
   * The shape that used to false-positive (EI-20745458722827468): a NON-partial unique
   * index, followed later in the same file by a PARTIAL but NON-unique index. Nothing
   * here narrows an ON CONFLICT arbiter — the WHERE belongs to a different statement and
   * a different index — so the detector must stay quiet. Without this fixture the
   * statement-scoping fix is untested, and the rule could silently regress to matching
   * across statements again.
   */
  const negativeCrossStatement = `
    CREATE TABLE IF NOT EXISTS harness_shared.census_probe (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL,
      surface_id text NOT NULL,
      retired_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS census_probe_identity
      ON harness_shared.census_probe (workspace_id, surface_id);
    CREATE INDEX IF NOT EXISTS census_probe_live
      ON harness_shared.census_probe (workspace_id)
      WHERE retired_at IS NULL;
  `;

  const failures = [];

  const posHits = violationsFor(positive).map((r) => r.id);
  if (!posHits.includes('drop-index')) {
    failures.push('detector did NOT fire on a known-positive DROP INDEX fixture');
  }
  if (!posHits.includes('narrowing-unique-index')) {
    failures.push('detector did NOT fire on a known-positive partial-unique-index fixture');
  }

  const crossHits = violationsFor(negativeCrossStatement).map((r) => r.id);
  if (crossHits.includes('narrowing-unique-index')) {
    failures.push(
      'detector fired ACROSS STATEMENTS on a non-partial unique index followed by a partial ' +
        'NON-unique index (EI-20745458722827468) — the wildcard is spanning statements again',
    );
  }

  const negHits = violationsFor(negative).map((r) => r.id);
  if (negHits.length > 0) {
    failures.push(
      `detector fired on a known-negative fixture (comment text mistaken for DDL): ${negHits.join(', ')}`,
    );
  }

  /*
   * MASK CONTRACT (EI-20073035509369492). The three fixtures below pin WHICH mask this
   * guard may use. They are falsifying controls, not coverage padding: each one FAILED
   * under a mask this guard plausibly could have been given.
   */

  // (a) A `--` inside a STRING LITERAL is not a comment. The private regex this guard used
  //     until 2026-08-10 erased the rest of the line, swallowing the real SET NOT NULL and
  //     reporting CLEAN -- the exact failure this guard exists to prevent. Fails on any
  //     non-quote-aware mask.
  const commentInString = `INSERT INTO t(note) VALUES ('see -- below'); ALTER TABLE t ALTER COLUMN c SET NOT NULL;`;
  if (!violationsFor(commentInString).some((r) => r.id === 'set-not-null')) {
    failures.push(
      'detector MISSED real DDL following a `--` inside a string literal (mask is not quote-aware)',
    );
  }

  // (b) REAL DDL inside a dollar-quoted body must still fire. Fails under
  //     stripSqlCommentsAndStrings, which seals `$tag$` bodies wholesale -- a false NEGATIVE.
  const ddlInBody = `DO $$ BEGIN\n  ALTER TABLE t ALTER COLUMN c SET NOT NULL;\nEND $$;`;
  if (!violationsFor(ddlInBody).some((r) => r.id === 'set-not-null')) {
    failures.push(
      'detector MISSED real DDL inside a dollar-quoted body (mask seals `$$` bodies -- must be comments-only)',
    );
  }

  // (c) A COMMENT inside a dollar-quoted body is still a comment. Fails under a mask that
  //     skips `$tag$` bodies instead of recursing into them -- a false POSITIVE.
  const commentInBody = `DO $$ BEGIN\n  -- ALTER TABLE t ALTER COLUMN c SET NOT NULL;\n  PERFORM 1;\nEND $$;`;
  const bodyCommentHits = violationsFor(commentInBody).map((r) => r.id);
  if (bodyCommentHits.length > 0) {
    failures.push(
      `detector fired on a COMMENTED-OUT statement inside a dollar-quoted body (mask skips bodies instead of recursing): ${bodyCommentHits.join(', ')}`,
    );
  }

  if (!ACK_MARKER.test('-- FORWARD-COMPAT: the deployed release never reads this column')) {
    failures.push('acknowledgment marker did not match a valid FORWARD-COMPAT line');
  }
  if (ACK_MARKER.test('-- FORWARD-COMPAT:')) {
    failures.push('acknowledgment marker matched an EMPTY FORWARD-COMPAT line (must require a reason)');
  }

  const draftFixture = `
    -- ADD COLUMN IF NOT EXISTS commented_out text;
    ALTER TABLE harness_shared.adv_sessions
      ADD COLUMN IF NOT EXISTS ended_signal text;
  `;
  const draftRefs = findDraftColumnReferences(draftFixture, [
    { file: 'packages/operator-core/lib/adv-sessions.ts', text: 'const q = sql`SELECT ended_signal FROM adv_sessions`;\n' },
    { file: 'packages/operator-core/lib/comment.ts', text: '// ended_signal is documented here, not read\n' },
  ]);
  if (!draftRefs.columns.includes('ended_signal')) {
    failures.push('draft dependency detector did NOT extract an ADD COLUMN identifier');
  }
  if (
    !draftRefs.references.some(
      (ref) => ref.column === 'ended_signal' && ref.file === 'packages/operator-core/lib/adv-sessions.ts',
    )
  ) {
    failures.push('draft dependency detector did NOT find a source reference');
  }
  if (draftRefs.references.some((ref) => ref.file.endsWith('/comment.ts'))) {
    failures.push('draft dependency detector treated a source comment as a reference');
  }

  // ---------------------------------------------------------------------------
  // Typed sidecar (D-092). The dangerous direction is HONOURING something it
  // should refuse, because that waves a forward-incompatible migration straight
  // through a gate-blocking lint. Every refusal case is asserted here so a broken
  // evaluator cannot report green — and the CALIBRATION case below is what stops
  // an evaluator that refuses everything from passing all the negative cases.
  // ---------------------------------------------------------------------------
  const sidecarSql = 'DROP INDEX CONCURRENTLY IF EXISTS harness_shared.some_uidx;\n';
  const sidecarNow = new Date('2026-01-01T00:00:00.000Z');
  const validSidecar = {
    kind: SIDECAR_KIND,
    version: SIDECAR_VERSION,
    migration: '900-selftest-fixture.sql',
    appliedSha256: migrationSha256(sidecarSql),
    requiresDeployedCommit: 'a'.repeat(40),
    requiresDeployedNote: 'writer switched to the four-column tuple',
    rationale: 'the deployed release no longer names the dropped index in any ON CONFLICT arbiter',
    workItem: 'EI-21539300249506308',
    reviewBy: '2026-06-01',
    postDeploy: 'remove-sidecar',
  };
  const evaluateSidecar = (overrides = {}, options = {}) =>
    evaluateForwardCompatSidecar({
      artifactFile: options.artifactFile ?? '900-selftest-fixture.sql',
      sidecarText:
        options.sidecarText !== undefined ? options.sidecarText : JSON.stringify({ ...validSidecar, ...overrides }),
      migrationSha: migrationSha256(sidecarSql),
      isAncestorOfHead: options.isAncestorOfHead ?? (() => true),
      now: sidecarNow,
    });

  // CALIBRATION: a fully valid sidecar MUST be honoured, or every negative case
  // below passes for the wrong reason.
  const calibration = evaluateSidecar();
  if (!calibration.honored) {
    failures.push(
      `sidecar evaluator REFUSED a fully valid sidecar (calibration failed): ${calibration.refusals.join('; ')}`,
    );
  }

  const mustRefuse = [
    ['mismatched appliedSha256 (not the applied bytes)', () => evaluateSidecar({ appliedSha256: 'b'.repeat(64) })],
    ['malformed appliedSha256', () => evaluateSidecar({ appliedSha256: 'not-a-hash' })],
    [
      'requiresDeployedCommit that is NOT an ancestor of HEAD',
      () => evaluateSidecar({}, { isAncestorOfHead: () => false }),
    ],
    [
      'requiresDeployedCommit whose ancestry could not be determined',
      () => evaluateSidecar({}, { isAncestorOfHead: () => null }),
    ],
    ['malformed requiresDeployedCommit', () => evaluateSidecar({ requiresDeployedCommit: 'HEAD~1' })],
    ['placeholder rationale', () => evaluateSidecar({ rationale: 'TODO' })],
    ['empty rationale', () => evaluateSidecar({ rationale: '   ' })],
    ['placeholder requiresDeployedNote', () => evaluateSidecar({ requiresDeployedNote: 'tbd' })],
    ['malformed workItem', () => evaluateSidecar({ workItem: 'ticket-7' })],
    ['stale reviewBy', () => evaluateSidecar({ reviewBy: '2025-12-31' })],
    ['non-date reviewBy', () => evaluateSidecar({ reviewBy: 'soon' })],
    ['unknown postDeploy value', () => evaluateSidecar({ postDeploy: 'ignore-it' })],
    ['unknown key (free-form field)', () => evaluateSidecar({ note: 'extra' })],
    ['wrong kind', () => evaluateSidecar({ kind: 'something-else' })],
    ['wrong version', () => evaluateSidecar({ version: 2 })],
    [
      'migration name that does not match the file',
      () => evaluateSidecar({ migration: '901-other-migration.sql' }),
    ],
    ['malformed JSON', () => evaluateSidecar({}, { sidecarText: '{ not json' })],
    ['a JSON array instead of an object', () => evaluateSidecar({}, { sidecarText: '[]' })],
    [
      'a PARKED (still-editable) artifact',
      () =>
        evaluateSidecar({}, { artifactFile: '900-selftest-fixture.sql.PENDING-CODE-DEPLOY' }),
    ],
    [
      'a DRAFT (still-editable) artifact',
      () => evaluateSidecar({}, { artifactFile: '900-selftest-fixture.sql.DRAFT' }),
    ],
  ];
  for (const [label, run] of mustRefuse) {
    const verdict = run();
    if (verdict.honored) failures.push(`sidecar evaluator HONOURED ${label} — it must refuse`);
    else if (verdict.refusals.length === 0) failures.push(`sidecar evaluator refused ${label} with NO stated reason`);
  }

  // A missing sidecar is an ABSENCE, never a refusal — the migration simply has
  // no acknowledgement and falls through to the normal offender path.
  const absent = evaluateSidecar({}, { sidecarText: null });
  if (absent.present || absent.honored || absent.refusals.length > 0) {
    failures.push('a MISSING sidecar was reported as present/honoured/refused instead of absent');
  }

  // Effective-name mapping: a sidecar is keyed on the ARMED `.sql` name, so
  // parking or unparking a migration never strands or silently orphans it.
  for (const artifact of [
    '975-fixture.sql',
    '975-fixture.sql.DRAFT',
    '975-fixture.sql.PENDING-CODE-DEPLOY',
  ]) {
    const mapped = sidecarNameFor(effectiveMigrationName(artifact));
    if (mapped !== `975-fixture.sql${SIDECAR_SUFFIX}`) {
      failures.push(`sidecar name for ${artifact} mapped to ${mapped}, not the effective .sql name`);
    }
  }

  // The ancestry resolver must report a broken instrument as UNDETERMINED (null),
  // never as a clean "not an ancestor" — a false negative there would refuse a
  // valid sidecar, and a false positive would honour an invalid one.
  // `mergeBaseStatus: null` means the merge-base call SUCCEEDS (an ancestor).
  const ancestryProbe = ({ commitResolves = true, mergeBaseStatus = null } = {}) =>
    makeAncestorResolver({
      exec: (_bin, args) => {
        if (args[0] === 'cat-file') {
          if (commitResolves) return '';
          const error = new Error('not a valid object name');
          error.status = 128;
          throw error;
        }
        if (mergeBaseStatus === null) return '';
        const error = new Error('merge-base');
        error.status = mergeBaseStatus;
        throw error;
      },
    })('c'.repeat(40));
  if (ancestryProbe() !== true) {
    failures.push('ancestry resolver did not report a real ancestor as true (calibration failed)');
  }
  if (ancestryProbe({ commitResolves: false }) !== null) {
    failures.push('ancestry resolver did not report an unresolvable commit as undetermined');
  }
  if (ancestryProbe({ mergeBaseStatus: 1 }) !== false) {
    failures.push('ancestry resolver did not report git exit 1 as "not an ancestor"');
  }
  if (ancestryProbe({ mergeBaseStatus: 129 }) !== null) {
    failures.push('ancestry resolver reported a BROKEN git invocation as a clean negative');
  }

  return failures;
}

function main() {
  const selfTestFailures = selfTest();
  if (selfTestFailures.length > 0) {
    console.error('check-migration-forward-compat: SELF-TEST FAILED -- the checker itself is broken.');
    console.error('Refusing to report green, because a broken detector reports green on everything.\n');
    for (const f of selfTestFailures) console.error(`  - ${f}`);
    process.exit(1);
  }

  if (!existsSync(SQL_DIR)) {
    console.error(`check-migration-forward-compat: migrations dir not found: ${SQL_DIR}`);
    console.error('Refusing to report green on a scan that found nothing to scan.');
    process.exit(1);
  }

  const available = readdirSync(SQL_DIR).filter(isMigrationArtifactFile);
  let selected;
  try {
    selected = selectExplicitBasenames(process.argv.slice(2), available);
  } catch (error) {
    console.error(`check-migration-forward-compat: ${error.message}`);
    process.exit(2);
  }
  const all = selected ?? available;
  if (all.length === 0) {
    console.error(`check-migration-forward-compat: zero migration artifacts in ${SQL_DIR}`);
    console.error('Refusing to report green on an empty scan.');
    process.exit(1);
  }

  const inScope = all
    .map((file) => ({ file, effective: effectiveMigrationName(file) }))
    .filter(({ effective }) => isEnforcedMigrationFile(effective))
    .map(({ file, effective }) => ({ file, num: Number.parseInt(effective.slice(0, effective.indexOf('-')), 10) }))
    .sort((a, b) => a.num - b.num);

  const isAncestorOfHead = makeAncestorResolver();
  const offenders = [];
  const acknowledged = [];
  for (const { file, text } of readScannedFiles(SQL_DIR, inScope.map(({ file }) => file))) {
    const hits = violationsFor(text);
    if (hits.length === 0) continue;
    if (ACK_MARKER.test(text)) continue;

    // The migration itself is immutable once applied, so the acknowledgement may
    // live in a typed sidecar beside it (D-092). Any defect refuses the WHOLE
    // sidecar — a partially-valid one never waves a migration through.
    const sidecar = readForwardCompatSidecar(SQL_DIR, file, { migrationText: text, isAncestorOfHead });
    if (sidecar.honored) {
      acknowledged.push({ file, sidecarFile: sidecar.sidecarFile });
      continue;
    }
    offenders.push({ file, hits, sidecar: sidecar.present ? sidecar : null });
  }

  const draftOffenders = [];
  const draftFiles = all.filter(isDraftMigrationFile).sort();
  if (draftFiles.length > 0) {
    const sourceFiles = sourceFilesForRepo();
    for (const { file, text } of readScannedFiles(SQL_DIR, draftFiles, { allowMissing: true })) {
      const dependency = findDraftColumnReferences(text, sourceFiles);
      if (dependency.references.length > 0) draftOffenders.push({ file, ...dependency });
    }
  }

  if (offenders.length > 0 || draftOffenders.length > 0) {
    if (offenders.length > 0) {
      console.error('Forward-incompatible migration(s): destructive DDL with no FORWARD-COMPAT acknowledgment.\n');
      console.error('The database migrates NOW; :3070 keeps running the older release checkout until the');
      console.error('next commit -> green-checkpoint -> deploy cycle finishes. Destructive DDL therefore');
      console.error('breaks code that is still live.\n');
      for (const { file, hits, sidecar } of offenders) {
        console.error(`  ${file}`);
        for (const h of hits) console.error(`      [${h.id}] ${h.why}`);
        if (sidecar) {
          console.error(`      sidecar ${sidecar.sidecarFile} was REJECTED:`);
          for (const reason of sidecar.refusals) console.error(`        - ${reason}`);
        }
      }
      console.error('\nFix by splitting into expand/contract:');
      console.error('  1. EXPAND  - add the new index/column; ship and DEPLOY the code that uses it.');
      console.error('  2. CONTRACT - a LATER migration drops the old one, once no deployed release uses it.');
      console.error('\nOr, if the deployed release genuinely does not touch it, record why in the migration:');
      console.error('  -- FORWARD-COMPAT: <why the currently-deployed release does not use this>');
      console.error('\nAlready APPLIED, so that line can no longer be added? The migration is immutable');
      console.error('(migration-immutability-guard / WI-38352). Write a typed sidecar beside it instead:');
      console.error(`  ${sidecarNameFor('<NNN-name>.sql')}`);
      console.error('It must bind the applied bytes (appliedSha256) and the commit that carries the');
      console.error('compatible writer (requiresDeployedCommit, must be an ancestor of HEAD), plus');
      console.error('requiresDeployedNote, rationale, workItem, reviewBy and postDeploy. Any defect');
      console.error('refuses the whole sidecar. See stable-candidate-related-gate-2026-08-23#D-092.');
      console.error('\nBackground: EI-18797473716313783 (migration 689 dropped an ON CONFLICT arbiter and');
      console.error('broke facts:assert fleet-wide for ~3 hours); EI-21539300249506308 (the deadlock this');
      console.error('sidecar route resolves).');
    }
    if (draftOffenders.length > 0) {
      console.error('\nDraft migration(s) already referenced by source before they were armed:\n');
      console.error('The runner ignores *.DRAFT and *.PENDING-CODE-DEPLOY files. A source read that');
      console.error('names a column from one of those files breaks every live operator until the');
      console.error('migration is armed and applied. Keep dependent code out of the draft, or arm/apply');
      console.error('the migration before shipping the code that reads it.\n');
      for (const { file, columns, references, unresolvedTargets } of draftOffenders) {
        console.error(`  ${file} adds: ${columns.join(', ')}`);
        if (unresolvedTargets?.length) {
          // Without this line the author sees a flood of files that plainly have nothing to do
          // with the migration, concludes the lint is broken, and silences it with the ACK
          // marker. The cause is specific and the remedy is cheap, so say both.
          console.error(`      [unqualified] could not resolve the ALTER TABLE target: ${unresolvedTargets.join(' | ')}`);
          console.error('      -> the table filter was SKIPPED, so the list below is column-name-only and broad.');
          console.error('      -> spell the ALTER TABLE target out literally (a dynamic %I/%s target is unparseable)');
          console.error('         so the scan can narrow to the tables you actually alter.');
        }
        for (const ref of references) console.error(`      [add-column] ${ref.column} referenced by ${ref.file}:${ref.line}`);
      }
    }
    process.exit(1);
  }

  for (const { file, sidecarFile } of acknowledged) {
    console.log(`check-migration-forward-compat: ${file} acknowledged by sidecar ${sidecarFile}`);
  }
  console.log(
    `check-migration-forward-compat: OK (${inScope.length} migration(s) at or after ${ENFORCE_FROM} checked, ${all.length} total on disk, ${acknowledged.length} acknowledged by sidecar)`,
  );
}

// Run the CLI ONLY when executed directly — never on import. The authoring-time
// nudge imports this module for `violationsFor` / `ACK_MARKER`, and an
// unguarded `main()` would run the whole repo scan (and possibly process.exit(1))
// inside a PostToolUse hook that must always fail open.
// `migration-preapply-lint.ts` imports the pure predicates above, so this module is also inlined
// into the host bundle. The shared guard is compiled false in that bundle while preserving direct
// `node scripts/check-migration-forward-compat.mjs` execution.
if (isCliEntry(import.meta.url)) main();
