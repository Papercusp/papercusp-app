#!/usr/bin/env tsx
/**
 * P-008 — the CLI for "PG is canonical for authored doc prose" (D-025).
 *
 * The RULES live in packages/operator-core/lib/harness/docs/authored-doc-projection.ts,
 * which docs:author and the tests import too — this file is only the corpus walk, the
 * database, and the reporting. Keeping the rules out of here is what stops the tool and
 * the CLI from disagreeing about what the canonical text IS.
 *
 * ⚠ THE TWO DIRECTIONS ARE NOT SYMMETRIC.
 *   PG → file  (default, --write) is the NORMAL direction: routine, safe, idempotent.
 *   file → PG  (--ingest) is the BOOTSTRAP direction: it is how the corpus became rows
 *   once, and after that it is exactly the move that would let a hand-edit to a projected
 *   file quietly become canonical. It refuses any row that already holds content unless
 *   --reconcile says so out loud.
 * Both live in ONE file precisely so their guards can be read against each other.
 *
 * This `.ts` file is the implementation and remains CJS-compatible for the existing
 * Vitest/projector internals. For Node/tsx consumers that need static named ESM imports,
 * use `scripts/project-authored-docs.mts`, the thin facade around this implementation.
 *
 *   node --import tsx scripts/project-authored-docs.mts             # dry run, both-way report
 *   node --import tsx scripts/project-authored-docs.mts --ingest    # bootstrap file → PG
 *   node --import tsx scripts/project-authored-docs.mts --write     # project PG → file
 *   node --import tsx scripts/project-authored-docs.mts --check     # CI: corpus == projection
 *   node --import tsx scripts/project-authored-docs.mts --ingest --reconcile \
 *     --doc=agent-insights/example.mdx                         # reconcile one exact doc
 *   node --import tsx scripts/project-authored-docs.mts --ingest --reconcile \
 *     --files=agent-insights/a.mdx,agent-insights/b.mdx         # reconcile an exact list
 *
 * P-009 (ephemeral corpus) adds two more, and their ORDER matters:
 *   --retire-orphans            # ONE-TIME: record in PG which rows are dead. Must run
 *                               # WHILE the corpus is still committed — it reads the
 *                               # working tree as the oracle, and P-009 destroys it.
 *   --materialize [--out=DIR]   # build-time: write every LIVE row to DIR. Unlike --write
 *                               # it does not intersect with existing files, because its
 *                               # job is to produce a corpus where none is committed.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyProjectionBanner,
  deriveFrontmatterIndex,
  ingestVerdict,
  projectionVerdict,
  sha256,
  splitFrontmatter,
} from '../packages/operator-core/lib/harness/docs/authored-doc-projection';
import { connectScriptPg } from './lib/pg-url.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const WORKSPACE_ID = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
export const HARNESS_SLUG = process.env.PAPERCUSP_HARNESS_SLUG ?? 'papercusp';

/** The section the corpus was FIRST inverted for (P-008). Retained as `listSectionDocs`'s
 *  default and as the `--section` shorthand; the projector itself is no longer scoped to it
 *  (WI-37747 widened it to the whole corpus). */
export const SECTION = 'agent-insights';

/** The docs root, resolved the way the read + anchor systems resolve it. */
export function resolveDocsRoot(root: string = ROOT): string {
  const cfgPath = join(root, '.papercusp', 'docs.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : null;
  return join(root, cfg?.root ?? 'apps/operator-docs/src/content/docs');
}

/**
 * Docs written by ANOTHER generator, which this projector must not manage.
 *
 * Each of these is regenerated from a LIVE source — the defineTool registry, the PG plan
 * store, the blueprint catalog, the role registry, the insights index — by
 * `npm run gen:doc-projections`. Postgres therefore CANNOT be canonical for them: a PG row
 * would only ever be a stale snapshot of a registry that has already moved on. Two writers
 * for one file is the defect; the generator is the correct owner and this projector defers.
 *
 * Measured 2026-08-10 (WI-37747): widening this projector from `agent-insights` to the whole
 * corpus made it claim these five, and `gen:authored-docs:check` — a GATE — went red the
 * moment `gen:doc-projections` next ran, because each generator legitimately rewrote the file
 * the other considered settled. The drift guard caught it (it refused to overwrite rather
 * than erasing the generator's output), which is the only reason this surfaced as a red gate
 * instead of silent mutual clobbering.
 *
 * ⚠ This is an EXPLICIT list, deliberately, and not a sniff for the "do not edit by hand"
 * banner: this projector writes a near-identical banner of its own, and the two differ by a
 * single word, so a content rule would turn on a wording coincidence. The cost of the explicit
 * form is that a NEW generated doc is not auto-excluded — but that failure is loud and
 * self-locating (the gate reds, naming the file, and points here), which is exactly how this
 * one was found. `reference/generated-api-and-lib-reference.mdx` is deliberately ABSENT: it
 * carries THIS projector's banner and is genuinely PG-canonical.
 */
export const GENERATOR_OWNED_DOCS: ReadonlySet<string> = new Set([
  'reference/agent-insights-index.md',
  'reference/blueprint-catalog.md',
  'reference/plans-index.md',
  'reference/role-registry.md',
  'reference/tool-catalog.md',
]);

/** Shared walk: every .mdx/.md at or under `dir`, as doc_ids relative to `docsRoot`. */
function walkDocs(dir: string, docsRoot: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    // Skip dot-entries. Measured 2026-08-10: the corpus contains
    // `agent-insights/.papercusp/memory/raw.md` — agent scratch state that landed under
    // the docs root and is not a doc. Ingesting it would mint a canonical row for a file
    // nothing publishes, and projecting it back would give scratch state a banner
    // claiming Postgres owns it.
    if (entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walkDocs(abs, docsRoot, out);
    else if (/\.mdx?$/.test(entry)) {
      const docId = relative(docsRoot, abs).split(sep).join('/');
      if (GENERATOR_OWNED_DOCS.has(docId)) continue; // another generator owns this file
      out.push(docId);
    }
  }
  return out;
}

/** Every .mdx/.md under `<docsRoot>/<section>`, as doc_ids ("agent-insights/foo.mdx"). */
export function listSectionDocs(docsRoot: string, section: string = SECTION): string[] {
  return walkDocs(join(docsRoot, section), docsRoot).sort();
}

/**
 * Every doc in the corpus: ALL sections, PLUS the loose files sitting at the docs root
 * (`index.mdx`, `branding.mdx`, `performance.mdx`) which belong to no
 * section at all — a dirs-only walk drops those four silently, which is why this walks the
 * root itself rather than enumerating directories.
 *
 * THE FILESYSTEM IS THE SCOPE, deliberately, and that is the safety property rather than a
 * convenience. `content_mode='authored'` also covers per-harness project docs whose files
 * this repo does not own — measured 2026-08-10, four `plans/*.md` rows whose real files live
 * under an entirely different root. Deriving scope from what exists HERE cannot reach them:
 * they fall out as orphan rows and are left alone. A hand-maintained section list would have
 * to keep getting that right; this cannot get it wrong, and it picks up a new section with
 * no edit here.
 */
export function listCorpusDocs(docsRoot: string): string[] {
  return walkDocs(docsRoot, docsRoot).sort();
}

export interface ExactDocSelection {
  docIds: string[];
  errors: string[];
}

/**
 * Parse an explicit, exact document allowlist.
 *
 * `--section` is intentionally a convenience scope, not a concurrency boundary: a
 * section-wide reconcile can still race with a newer PG edit. `--doc` and `--files` are
 * the narrow form for that operation. Both accept a single path or a comma/newline-
 * separated list, and either flag may be repeated.
 */
export function parseExactDocSelection(argv: readonly string[]): ExactDocSelection {
  const rawValues: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const equals = arg.match(/^--(?:doc|files)=(.*)$/);
    if (equals) {
      rawValues.push(equals[1]);
      continue;
    }
    if (arg !== '--doc' && arg !== '--files') continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      errors.push(`${arg} requires an exact relative doc path (or a comma-separated list)`);
      continue;
    }
    rawValues.push(value);
    i += 1;
  }

  const docIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawValues) {
    for (const candidate of raw.split(/[\n,]/)) {
      const docId = candidate.trim().replace(/^\.\//, '');
      if (!docId) continue;
      const segments = docId.split('/');
      if (
        docId.startsWith('/') ||
        docId.includes('\\') ||
        segments.some((segment) => segment === '.' || segment === '..' || segment === '')
      ) {
        errors.push(`invalid exact doc path: ${candidate.trim()}`);
        continue;
      }
      if (!seen.has(docId)) {
        seen.add(docId);
        docIds.push(docId);
      }
    }
  }
  return { docIds, errors };
}

interface DocRow {
  doc_id: string;
  content: string;
  content_hash: string;
  /** Exact PG timestamptz text. Never read this as a JS Date: Date truncates
   * microseconds and makes the optimistic-concurrency equality predicate miss
   * an unchanged row. */
  updated_at: string;
  content_mode: string;
  /**
   * Lifecycle marker (migration 814). NULL = live; non-NULL = deliberately removed.
   *
   * Before this column existed, liveness was inferred from FILE PRESENCE — every mode
   * below intersects rows with `listCorpusDocs()`, so a row with no file was silently
   * treated as deleted. That inference is unavailable to `--materialize`, whose whole
   * job is to run where no files exist yet, which is why the column had to come first.
   */
  retired_at: string | null;
}

interface QueryResult<T = unknown> {
  rows: T[];
  rowCount?: number | null;
}

async function connect(): Promise<{
  query: <T = unknown>(q: string, v?: unknown[]) => Promise<QueryResult<T>>;
  end: () => Promise<void>;
}> {
  return (await connectScriptPg()) as unknown as {
    query: <T = unknown>(q: string, v?: unknown[]) => Promise<QueryResult<T>>;
    end: () => Promise<void>;
  };
}

/**
 * Authored rows for this harness. `section: null` reads the WHOLE corpus — which is safe
 * only because the caller intersects these rows with the files that actually exist (see
 * `listCorpusDocs`): a row this repo owns no file for stays an orphan and is left alone.
 */
export async function readAuthoredRows(
  client: { query: (q: string, v?: unknown[]) => Promise<QueryResult<DocRow>> },
  section: string | null = SECTION,
): Promise<Map<string, DocRow>> {
  const scoped = section !== null;
  const { rows } = await client.query(
    `SELECT doc_id, content, content_hash, updated_at::text AS updated_at, content_mode, retired_at
       FROM harness_shared.harness_docs
      WHERE workspace_id = $1 AND harness_slug = $2
        AND content_mode = 'authored'${scoped ? ' AND doc_id LIKE $3' : ''}
      ORDER BY doc_id`,
    scoped ? [WORKSPACE_ID, HARNESS_SLUG, `${section}/%`] : [WORKSPACE_ID, HARNESS_SLUG],
  );
  return new Map(rows.map((r) => [r.doc_id, r]));
}

export interface ExpectedDocVersion {
  /** The content_hash observed in the same snapshot as the file read. */
  contentHash: string;
  /** The updated_at observed in the same snapshot as the file read. */
  updatedAt: string;
}

/**
 * Write canonical prose onto a row.
 *
 * `content_mode` is deliberately absent from this UPDATE, for the same reason it is absent
 * from upsertDocRecord's: a composed row's mode is what protects CLAUDE.md from the wrong
 * projector, and this script only ever addresses rows already selected as `authored`.
 */
export async function writeContent(
  client: { query: (q: string, v?: unknown[]) => Promise<QueryResult> },
  docId: string,
  content: string,
  expected: ExpectedDocVersion,
): Promise<boolean> {
  const frontmatter = deriveFrontmatterIndex(content);
  const result = await client.query(
    `UPDATE harness_shared.harness_docs
        SET content = $4, content_hash = $5, frontmatter = $6::jsonb, updated_at = now()
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3
        AND content_hash = $7 AND updated_at = $8
      RETURNING doc_id`,
    [
      WORKSPACE_ID,
      HARNESS_SLUG,
      docId,
      content,
      sha256(content),
      frontmatter === null ? null : JSON.stringify(frontmatter),
      expected.contentHash,
      expected.updatedAt,
    ],
  );
  return result.rows.length > 0 || result.rowCount === 1;
}

/**
 * Mark a row retired (soft delete — `content` is deliberately kept, so the doc stays
 * searchable and recoverable). Idempotent: a row already retired keeps its ORIGINAL
 * timestamp and reason, so re-running the backfill can never rewrite history or make a
 * long-dead doc look freshly removed.
 */
export async function retireRow(
  client: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  docId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE harness_shared.harness_docs
        SET retired_at = now(), retired_reason = $4, updated_at = now()
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3
        AND retired_at IS NULL`,
    [WORKSPACE_ID, HARNESS_SLUG, docId, reason],
  );
}

/** The reason recorded by the one-time `--retire-orphans` backfill. */
export const BACKFILL_RETIRE_REASON =
  'backfill (P-009, migration 814): no file on disk while the working tree was still the liveness oracle';

/**
 * Whether `--retire-orphans` may trust the working tree as the liveness oracle.
 * Returns a refusal message, or null to proceed.
 *
 * This lives OUT here, as a pure function, because it is the only thing standing between a
 * mistimed invocation and a mass retirement of the whole corpus. The mode reads FILE ABSENCE
 * as proof a doc is dead, which is sound only while the corpus is still committed AND the
 * checkout is complete — so the dangerous inputs are precisely the ones that look like
 * "lots of dead docs": an empty tree (P-009 already untracked it), or a partial checkout.
 * Both are indistinguishable from a real mass deletion by row/file counts alone, so this
 * refuses instead of guessing.
 */
export function retireOrphansRefusal(counts: {
  fileCount: number;
  orphanCount: number;
  rowCount: number;
}): string | null {
  const { fileCount, orphanCount, rowCount } = counts;
  if (fileCount === 0) {
    return (
      `zero files on disk, so file-absence proves nothing here. This mode reads the WORKING ` +
      `TREE as the oracle for which docs are live; an empty tree would retire all ${rowCount} ` +
      `rows — the whole corpus.`
    );
  }
  if (orphanCount > fileCount) {
    return (
      `${orphanCount} orphan rows exceed ${fileCount} files on disk. That ratio says the tree ` +
      `is not a complete checkout of the corpus.`
    );
  }
  return null;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const ingest = argv.includes('--ingest');
  const reconcile = argv.includes('--reconcile');
  const check = argv.includes('--check');
  const retireOrphans = argv.includes('--retire-orphans');
  const materialize = argv.includes('--materialize');
  const outArg = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length) ?? null;

  if (write && ingest) {
    console.error('✗ --write and --ingest are opposite directions; run them separately.');
    return 2;
  }
  if ([write, ingest, retireOrphans, materialize].filter(Boolean).length > 1) {
    console.error('✗ --write / --ingest / --retire-orphans / --materialize are separate modes; run one at a time.');
    return 2;
  }
  if (outArg !== null && !materialize) {
    console.error('✗ --out= only applies to --materialize.');
    return 2;
  }

  // `--section=<name>` scopes a run to one section. The default is the WHOLE corpus:
  // per-section runs exist so each section's round trip can be proven on its own rather
  // than inferred from an aggregate green (WI-37747).
  const sectionArg = argv.find((a) => a.startsWith('--section='))?.slice('--section='.length) ?? null;
  const exactSelection = parseExactDocSelection(argv);
  if (exactSelection.errors.length) {
    for (const error of exactSelection.errors) console.error(`✗ ${error}`);
    return 2;
  }

  const docsRoot = resolveDocsRoot();

  // ── NO-DB DEGRADE, read-only modes ONLY ────────────────────────────────────────────
  // `--check` is a DRIFT DETECTOR, and a detector has to be runnable everywhere the thing
  // it detects can change — which means inside `test:affected`, which also runs in GitHub
  // CI where there is no papercusp Postgres. Without this branch the check exits 1 on the
  // connection failure, so wiring it anywhere off-box would fail EVERY run and teach the
  // fleet to ignore it — the same "informational leg that is always red" flap D-002/D-009
  // already cost this repo once. Skipping cleanly is what makes the guard WIREABLE; the
  // precedent is `gen-doc-plans-index.ts`, which catches an unreachable DB and exits 0.
  //
  // ⚠ DELIBERATELY NOT extended to --write / --ingest. Those MUTATE (the tree or the rows),
  // and a mutation that silently no-ops because its database was unreachable is a worse
  // failure than a loud one: the caller believes 873 files were projected when nothing was.
  // A skipped CHECK under-reports drift for one run; a skipped WRITE corrupts the premise
  // every later run is judged against.
  let client: Awaited<ReturnType<typeof connect>>;
  try {
    client = await connect();
  } catch (err) {
    // `--retire-orphans` and `--materialize` are held to the SAME rule as --write/--ingest,
    // for the same reason: both mutate (rows, and the tree). A materialize that silently
    // no-ops because PG was unreachable is the worst failure of the set — today it leaves
    // the committed corpus in place and looks fine, but once P-009's untracking lands the
    // same silent skip produces an EMPTY docs site from a build that exited 0. A caller who
    // genuinely wants the fall-back-to-committed-files behaviour must choose it explicitly.
    if (!write && !ingest && !retireOrphans && !materialize) {
      console.log(
        `project-authored-docs: SKIPPED — Postgres unreachable, so corpus drift cannot be measured here.\n` +
          `  This is NOT a pass: nothing was checked. Re-run where the operator DB is reachable.\n` +
          `  reason: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
    throw err;
  }
  let failed = false;
  try {
    const allFiles = exactSelection.docIds.length || !sectionArg
      ? listCorpusDocs(docsRoot)
      : listSectionDocs(docsRoot, sectionArg);
    const missing = exactSelection.docIds.filter((docId) => !allFiles.includes(docId));
    if (missing.length) {
      console.error(`✗ exact selection contains ${missing.length} file(s) not present in the docs corpus:`);
      for (const docId of missing) console.error(`  - ${docId}`);
      return 2;
    }
    const files = exactSelection.docIds.length
      ? allFiles.filter((docId) => exactSelection.docIds.includes(docId))
      : allFiles;
    const rowSnapshot = await readAuthoredRows(client, exactSelection.docIds.length ? null : sectionArg);
    const rows = exactSelection.docIds.length
      ? new Map([...rowSnapshot].filter(([docId]) => exactSelection.docIds.includes(docId)))
      : rowSnapshot;
    const fileSet = new Set(files);

    console.log(`project-authored-docs: ${WORKSPACE_ID}/${HARNESS_SLUG}/${sectionArg ?? '(whole corpus)'}`);
    console.log(`  docs root      ${relative(ROOT, docsRoot)}`);
    if (exactSelection.docIds.length) console.log(`  exact files    ${exactSelection.docIds.join(', ')}`);
    console.log(`  files          ${fmt(files.length)}`);
    console.log(`  rows           ${fmt(rows.size)} (content_mode='authored')`);

    // ── MODE: --retire-orphans — the ONE-TIME liveness backfill (P-009 step 2) ──────────
    // Records into PG what only the working tree currently knows: which authored rows are
    // dead. MUST run while the corpus is still committed. Once P-009 untracks it, every doc
    // is absent from disk and this mode would retire the ENTIRE corpus — so it refuses to
    // run when the tree cannot be the oracle, rather than trusting the caller's timing.
    if (retireOrphans) {
      const orphans = [...rows.values()].filter((r) => !fileSet.has(r.doc_id));
      const alreadyRetired = orphans.filter((r) => r.retired_at !== null).length;
      const toRetire = orphans.filter((r) => r.retired_at === null);

      console.log(`\n  RETIRE ORPHANS (one-time liveness backfill)`);
      const refusal = retireOrphansRefusal({
        fileCount: files.length,
        orphanCount: orphans.length,
        rowCount: rows.size,
      });
      if (refusal) {
        console.error(`    ✗ REFUSING: ${refusal}`);
        return 1;
      }
      for (const row of toRetire) {
        await retireRow(client, row.doc_id, BACKFILL_RETIRE_REASON);
      }
      console.log(`    live           ${fmt(files.length)} row(s) have a file and stay live`);
      console.log(`    retired        ${fmt(toRetire.length)} row(s) had no file and are now marked retired`);
      if (alreadyRetired) console.log(`    already        ${fmt(alreadyRetired)} row(s) were retired before this run (left untouched)`);
      console.log(`\n  ✓ liveness is now recorded in Postgres, not inferred from the filesystem.`);
      return 0;
    }

    // ── MODE: --materialize — build-time projection of the LIVE corpus (P-009 step 3) ───
    // Writes every non-retired authored row to `--out=` (default: the real docs root).
    // Unlike --write, this does NOT intersect with the files that already exist: that is
    // the entire point, since it must produce a complete corpus where none is committed.
    if (materialize) {
      const outRoot = outArg ? resolve(ROOT, outArg) : docsRoot;
      const live = [...rows.values()].filter((r) => r.retired_at === null);
      const retired = rows.size - live.length;
      const tally = { wrote: 0, empty: 0, current: 0 };

      console.log(`\n  MATERIALIZE (PG → ${relative(ROOT, outRoot) || '.'})`);
      if (retired === 0 && rows.size > 0) {
        // Not fatal, but worth saying out loud: before the backfill ran, EVERY row looks
        // live, so a materialize here would resurrect docs that were deliberately deleted.
        console.log(`    ⚠ no row is marked retired — if --retire-orphans has not run yet, this`);
        console.log(`      will write back docs that were deliberately deleted. Run it first.`);
      }
      // Skipping the file INTERSECTION is the point of this mode; skipping the OVERWRITE
      // GUARD would be a bug. While the corpus is still committed (P-009 not yet complete)
      // this mode runs against a tree agents are actively editing, so it honours the same
      // refusal --write does: never overwrite bytes that are neither the canonical content
      // nor a projection we wrote, because those bytes are somebody's unsaved edit. Once
      // the corpus is untracked the target starts empty and this can only report 'absent'.
      const clobbered: string[] = [];
      for (const row of live) {
        if (!row.content) {
          tally.empty += 1; // an empty row would materialize an empty page
          continue;
        }
        const abs = join(outRoot, row.doc_id);
        const nextText = applyProjectionBanner(row.content, row.doc_id);
        const onDisk = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
        const fileMtimeMs = onDisk === null ? null : statSync(abs).mtimeMs;
        const verdict = projectionVerdict({
          onDisk,
          contentHash: row.content_hash,
          nextText,
          fileMtimeMs,
          canonicalUpdatedAt: row.updated_at,
        });
        if (!verdict.ok) {
          clobbered.push(row.doc_id);
          continue;
        }
        if (verdict.reason === 'already-current') {
          tally.current += 1;
          continue;
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, nextText, 'utf8');
        tally.wrote += 1;
      }
      console.log(`    wrote          ${fmt(tally.wrote)} file(s) from live rows`);
      if (tally.current) console.log(`    identical      ${fmt(tally.current)} file(s) already matched`);
      console.log(`    retired        ${fmt(retired)} row(s) skipped (deliberately removed docs)`);
      if (tally.empty) console.log(`    empty row      ${fmt(tally.empty)} row(s) hold no content and were skipped`);
      if (clobbered.length) {
        console.error(`\n    ✗ REFUSED to overwrite ${clobbered.length} hand-edited file(s):`);
        for (const id of clobbered.slice(0, 10)) console.error(`      - ${id}`);
        if (clobbered.length > 10) console.error(`      … and ${clobbered.length - 10} more`);
        console.error(`      Their bytes are neither canonical content nor a projection we wrote.`);
        console.error(`      Preserve the edit into PG with: --ingest --reconcile   (NEVER --write)`);
        return 1;
      }
      return 0;
    }

    const orphanRows = [...rows.keys()].filter((id) => !fileSet.has(id));
    const untracked = files.filter((id) => !rows.has(id));
    const noFrontmatter: string[] = [];

    if (ingest) {
      const tally = { bootstrap: 0, current: 0, drifted: 0, create: 0, reconciled: 0 };
      const drifted: string[] = [];
      const conflicts: string[] = [];
      for (const docId of files) {
        const text = readFileSync(join(docsRoot, docId), 'utf8');
        const row = rows.get(docId) ?? null;
        const { verdict, content } = ingestVerdict({ fileText: text, row });
        tally[verdict] += 1;
        if (verdict === 'create' || verdict === 'current') continue;
        if (verdict === 'drifted') {
          drifted.push(docId);
          if (!reconcile) continue;
        }
        if (!splitFrontmatter(content).present) noFrontmatter.push(docId);
        // `row` is present for both writable verdicts: a missing row is `create`, which
        // remains an explicit anchor step rather than an implicit INSERT here.
        if (!row) continue;
        const updated = await writeContent(client, docId, content, {
          contentHash: row.content_hash,
          updatedAt: row.updated_at,
        });
        if (!updated) {
          // The row changed after readAuthoredRows() took its snapshot. The CAS predicate
          // makes this a refusal, never a stale overwrite of newer canonical PG prose.
          conflicts.push(docId);
          failed = true;
          continue;
        }
        if (verdict === 'drifted') tally.reconciled += 1;
      }
      console.log(`\n  INGEST (file → PG, the bootstrap direction)`);
      console.log(`    bootstrap    ${fmt(tally.bootstrap)} row(s) had empty content and were populated`);
      console.log(`    current      ${fmt(tally.current)} already identical`);
      console.log(`    no row       ${fmt(tally.create)} file(s) have no harness_docs row (anchor them first)`);
      if (drifted.length) {
        console.log(`    drifted      ${fmt(drifted.length)} file(s) differ from canonical PG content`);
        for (const d of drifted.slice(0, 10)) console.log(`      - ${d}`);
        if (!reconcile) {
          console.error(
            `\n    ✗ REFUSING to ingest ${drifted.length} drifted file(s). PG is canonical for these docs, so a\n` +
              `      file that differs is an EDIT MADE IN THE WRONG PLACE, and ingesting it would promote it to\n` +
              `      canonical silently — the exact inversion this plan removes. Read the diff, and if the\n` +
              `      file's text should win, re-run with --reconcile to accept it deliberately.`,
          );
          failed = true;
        } else {
          console.log(`    ✓ reconciled ${fmt(tally.reconciled)} (accepted the FILE as canonical, deliberately)`);
        }
      }
      if (conflicts.length) {
        console.error(`\n    ✗ REFUSING ${conflicts.length} write(s): canonical PG changed after the snapshot was read`);
        for (const conflict of conflicts.slice(0, 10)) console.error(`      - ${conflict}`);
        if (conflicts.length > 10) console.error(`      … and ${conflicts.length - 10} more`);
        console.error(`      No stale file content was written over those newer rows. Re-run from a fresh snapshot and an explicit --doc/--files allowlist.`);
      }
    } else {
      const tally = { wrote: 0, current: 0, absent: 0, empty: 0 };
      const drifted: string[] = [];
      for (const docId of files) {
        const row = rows.get(docId);
        if (!row) continue;
        if (!row.content) {
          tally.empty += 1; // never project an empty row over a real file
          continue;
        }
        const abs = join(docsRoot, docId);
        const nextText = applyProjectionBanner(row.content, docId);
        const onDisk = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
        const fileMtimeMs = onDisk === null ? null : statSync(abs).mtimeMs;
        const verdict = projectionVerdict({
          onDisk,
          contentHash: row.content_hash,
          nextText,
          fileMtimeMs,
          canonicalUpdatedAt: row.updated_at,
        });
        if (!verdict.ok) {
          drifted.push(docId);
          failed = true;
          continue;
        }
        if (verdict.reason === 'already-current') {
          tally.current += 1;
          continue;
        }
        if (verdict.reason === 'absent') tally.absent += 1;
        if (write) {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, nextText, 'utf8');
        }
        tally.wrote += 1;
      }
      console.log(`\n  PROJECT (PG → file, the normal direction)`);
      console.log(`    identical    ${fmt(tally.current)} file(s) already match the projection`);
      console.log(`    ${write ? 'wrote       ' : 'would write '} ${fmt(tally.wrote)}${tally.absent ? ` (${tally.absent} absent from disk)` : ''}`);
      if (tally.empty) console.log(`    empty row    ${fmt(tally.empty)} row(s) hold no content — run --ingest first`);
      if (drifted.length) {
        console.error(`\n    ✗ REFUSING to overwrite ${drifted.length} file(s) whose bytes are neither canonical content`);
        console.error(`      nor a projection we wrote — somebody edited the FILE. Writing would erase that edit.`);
        for (const d of drifted.slice(0, 10)) console.error(`      - ${d}`);
        console.error(`      Resolve: move the edit into PG (docs:author { overwrite: true }), or accept the file`);
        console.error(`      with: node --import tsx scripts/project-authored-docs.mts --ingest --reconcile`);
      }
      if (check && (tally.wrote > 0 || drifted.length > 0)) {
        console.error(
          `\n    ✗ --check: the corpus is NOT byte-identical to its projection (${tally.wrote} would change,` +
            ` ${drifted.length} drifted). A freshly-ingested corpus must project to zero changes.`,
        );
        failed = true;
      }
    }

    // Both lists are ACTIONABLE (orphans -> decide to delete the row; untracked -> anchor the
    // file), so a silently-capped list is worse than useless: it prints a count of N, shows 5,
    // and gives the reader no signal that the other N-5 exist. Print the whole list, and when a
    // cap is genuinely needed say so ON the output rather than leaving a bounded list looking total.
    const listAll = (items: string[], cap = 200): void => {
      for (const d of items.slice(0, cap)) console.log(`      - ${d}`);
      if (items.length > cap) console.log(`      … +${fmt(items.length - cap)} more (truncated at ${fmt(cap)})`);
    };

    if (orphanRows.length) {
      console.log(`\n  orphan rows    ${fmt(orphanRows.length)} row(s) have no file on disk (deleted docs; left alone)`);
      listAll(orphanRows);
    }
    if (untracked.length) {
      console.log(`  untracked      ${fmt(untracked.length)} file(s) have no row (anchor via docs:author / harness_docs:anchor)`);
      listAll(untracked);
    }
    if (noFrontmatter.length) {
      console.log(`  no frontmatter ${fmt(noFrontmatter.length)} file(s) carry none — projected without a banner`);
    }
    if (!write && !ingest) console.log('\n  ✓ dry run — nothing written. --write to project, --ingest to bootstrap.');
  } finally {
    await client.end();
  }
  return failed ? 1 : 0;
}

// Symlink-robust self-exec guard: node realpaths import.meta.url while process.argv[1]
// keeps the invoked path, so comparing them naively fails through the workspace symlink.
//
// `.then` rather than top-level await, deliberately: tsx transforms this implementation to CJS, where
// a top-level await is a hard transform error ("not supported with the cjs output format")
// — the script would not run at all, which is how this was found.
if (
  process.argv[1] &&
  (resolve(process.argv[1]).endsWith(`${sep}project-authored-docs.ts`) ||
    resolve(process.argv[1]).endsWith(`${sep}project-authored-docs.mts`))
) {
  void main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      process.exit(1);
    },
  );
}
