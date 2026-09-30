/**
 * The SQL corpus — the substitution registry's SECOND body of evidence
 * (plan `sql-escape-tool-routing-2026-08-12`, P-007 / D-003).
 *
 * The registry's first corpus is shell commands, extracted from session
 * transcripts. This one is raw SQL: every `dev:pg_query` call an agent made,
 * read out of `harness_shared.tool_invocations`. It exists because the audit
 * behind this plan found `dev:pg_query` to be the eighth-most-called tool on the
 * box, and a large share of that traffic is not analysis at all — it is an agent
 * hand-writing a `SELECT` because it does not know a verb already answers the
 * question.
 *
 * ── WHY THIS IS A CORPUS AND NOT A NEW AUDITOR ───────────────────────────────
 * Everything downstream of "an atom" is already corpus-agnostic: `sampleDistinct`
 * freezes a deterministic sample, `scrubIdentity` keeps the box's identity out of
 * committed fixtures, `auditPair` derives a verdict from `cover()`, `report`
 * renders it, and the routing generator projects it into CLAUDE.md. A parallel
 * SQL auditor would duplicate all of it — and would duplicate the drift that
 * machinery exists to prevent. So exactly two things are new, and they are the
 * two this file holds: the corpus READER (a query, not a JSONL extract) and the
 * ATOMIZER (a relation, not an argv head).
 *
 * ── WHAT AN ATOM IS HERE ─────────────────────────────────────────────────────
 * One normalised query. NOT one relation — see {@link SqlSubstitutionPair} for
 * why that distinction is load-bearing: `cover()` must be able to judge the
 * query's SHAPE, and a bare relation name carries none of it.
 *
 * The relation is what a pair MATCHES on, and it is resolved by
 * {@link plainSingleRelationRead} — P-001's extractor, imported rather than
 * reimplemented. That is D-003's rule and it is not a style preference: that same
 * function decides whether the in-tool routing advisory fires, so importing it
 * makes "the advisory an agent sees" and "the audit that earns the advisory" the
 * same judgement by construction. A second extractor would let them disagree,
 * which is D-001's failure ("a routing advisory must never out-run the tool's
 * actual coverage") re-created one layer down.
 */

import { getOrgPg } from '@papercusp/db-org';
import { plainSingleRelationRead } from '../pg-read-query';
import { sampleDistinct, scrubIdentity, type CorpusFixture } from './corpus';
import { MAX_MATCHABLE_ATOM_LENGTH } from './match';
import type { SampledCommand, SqlSubstitutionPair } from './types';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/** The tool whose calls ARE this corpus. */
export const SQL_CORPUS_TOOL = 'dev:pg_query';

/**
 * Normalise one raw query to a corpus atom, or null if it is not one.
 *
 * Collapsing whitespace is what makes `sampleDistinct` meaningful: the same read
 * written across three lines by one agent and on one line by another is ONE
 * shape, and a sample of twenty distinct shapes is worth far more than twenty
 * spellings of five. Comments and string literals are deliberately left intact —
 * they are part of what `cover()` judges, and stripping them here would hide the
 * predicate that decides whether a verb can express the query.
 *
 * The length cap is {@link MAX_MATCHABLE_ATOM_LENGTH}, shared with the shell
 * matcher for the same reason it exists there: a pair's optional `sqlShape` is a
 * regex from a registry, and a regex with nested quantifiers meeting a long
 * enough subject backtracks catastrophically. A 4,000-char query is a migration
 * body or a generated monster, not the hand-written single-table read this
 * corpus is about.
 */
export function normalizeSqlAtom(rawSql: string): string | null {
  if (typeof rawSql !== 'string') return null;
  const collapsed = rawSql.replace(/\s+/g, ' ').trim().replace(/;+$/, '').trim();
  if (!collapsed) return null;
  if (collapsed.length > MAX_MATCHABLE_ATOM_LENGTH) return null;
  return collapsed;
}

/**
 * The corpus atoms of one raw query — zero or one.
 *
 * Returns an ARRAY rather than a nullable atom purely so the SQL reader has the
 * same shape as `atomize()`, which lets the two corpus loaders stay structurally
 * identical instead of one being a special case.
 */
export function sqlAtomize(rawSql: string): string[] {
  const atom = normalizeSqlAtom(rawSql);
  return atom === null ? [] : [atom];
}

/**
 * Does this pair claim this atom?
 *
 * Three conditions, in the order that makes a failure cheapest to read:
 *  1. the atom is a PLAIN SINGLE-RELATION READ (the shared P-001 judgement — an
 *     analytic query is `dev:pg_query`'s legitimate job and no verb covers it);
 *  2. that relation is the pair's;
 *  3. the pair's optional `sqlShape` narrowing matches.
 *
 * Stateful regex flags are stripped from `sqlShape` before testing, the same
 * hazard `match.ts` guards for the shell corpus: a `/g` pattern reused across a
 * scan advances `lastIndex` and silently matches every other atom.
 */
export function sqlPairClaimsAtom(pair: SqlSubstitutionPair, atom: string): boolean {
  const read = plainSingleRelationRead(atom);
  if (!read) return false;
  if (!relationMatches(pair.relation, read)) return false;
  if (!pair.sqlShape) return true;
  const stateless = new RegExp(pair.sqlShape.source, pair.sqlShape.flags.replace(/[gy]/g, ''));
  return stateless.test(atom);
}

/**
 * Does the relation this query reads match the one the pair names?
 *
 * A pair may name the relation BARE (`schema_migrations`) or SCHEMA-QUALIFIED
 * (`information_schema.columns`), and the difference is meaningful rather than
 * stylistic:
 *
 *  - BARE is right for a papercusp table, where a query may or may not write the
 *    `harness_shared.` prefix and both spellings are the same read. Matching bare
 *    against bare is what makes those one population instead of two.
 *  - QUALIFIED is right when the SCHEMA is the whole point. `information_schema`
 *    has a table literally called `columns` and another called `tables`; a bare
 *    match on those names would claim any query against a user table that
 *    happened to share one, and route it to a tool that answers about catalog
 *    metadata. A pair may therefore demand the qualifier, and pays for it by
 *    matching only the qualified spelling — which for `information_schema` is the
 *    only spelling that resolves anyway.
 *
 * Deliberately NOT done with `sqlShape`: a shape that tested the schema prefix
 * would be a relation test wearing a narrowing filter's clothes, i.e. the second
 * extractor D-003 forbids.
 */
function relationMatches(declared: string, read: { relation: string; asWritten: string }): boolean {
  return declared.includes('.') ? declared.toLowerCase() === read.asWritten.toLowerCase() : declared === read.relation;
}

/** How far back the corpus reader looks when the caller does not say. */
export const SQL_CORPUS_DEFAULT_WINDOW_DAYS = 14;

/** Hard cap on rows pulled in one corpus read — this table carries millions. */
export const SQL_CORPUS_MAX_ROWS = 50_000;

export interface SqlCorpusOptions {
  workspaceId: string;
  /** Lookback window; defaults to {@link SQL_CORPUS_DEFAULT_WINDOW_DAYS}. */
  windowDays?: number;
  /** Row cap; clamped to {@link SQL_CORPUS_MAX_ROWS}. */
  limit?: number;
  /** Injectable for tests; defaults to the org pool. */
  client?: OrgSql;
}

interface SqlCorpusRow {
  sid: string | null;
  ts: string | Date;
  sql: string | null;
}

/**
 * Read the SQL corpus out of the invocation ledger.
 *
 * ── Two filters that are correctness, not tidiness ───────────────────────────
 *
 *  1. `is_agent_coord_owner_id(coord_owner_id, role)`. That column also carries
 *     system, UI, test, mcp-call and loopback principals (its own column comment
 *     says so). Counting those as agent demand would inflate exactly the number
 *     this plan is trying to move, and would attribute a routine's own bookkeeping
 *     query to an agent who never wrote one.
 *
 *  2. `status = 'ok'`. A query that ERRORED tells you nothing about whether a verb
 *     could have served it — it tells you the agent mistyped a column. Auditing
 *     failures would let a pair earn coverage over queries that never ran.
 *
 * Ordered NEWEST-FIRST under the cap: when the window holds more calls than the
 * cap admits, the sample should describe how agents write queries NOW, not what
 * the retention window happens to still hold from a fortnight ago.
 */
export async function fetchSqlCorpusAtoms(opts: SqlCorpusOptions): Promise<SampledCommand[]> {
  const sql = opts.client ?? getOrgPg().sql;
  const windowDays = Math.max(1, Math.floor(opts.windowDays ?? SQL_CORPUS_DEFAULT_WINDOW_DAYS));
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? SQL_CORPUS_MAX_ROWS)), SQL_CORPUS_MAX_ROWS);

  const rows = (await sql`
    SELECT coord_owner_id AS sid,
           invoked_at     AS ts,
           args_json->>'sql' AS sql
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${opts.workspaceId}
       AND tool_name = ${SQL_CORPUS_TOOL}
       AND status = 'ok'
       AND args_json->>'sql' IS NOT NULL
       AND invoked_at >= now() - make_interval(days => ${windowDays})
       AND harness_shared.is_agent_coord_owner_id(coord_owner_id, role)
     ORDER BY invoked_at DESC
     LIMIT ${limit}
  `) as unknown as SqlCorpusRow[];

  const out: SampledCommand[] = [];
  for (const row of rows) {
    if (!row.sql) continue;
    const ts = row.ts instanceof Date ? row.ts.toISOString() : String(row.ts);
    for (const atom of sqlAtomize(row.sql)) {
      out.push({ sid: row.sid ?? 'unknown', ts, atom });
    }
  }
  return out;
}

/**
 * Freeze one SQL pair's evidence into the same fixture shape the shell corpus
 * uses, so `loadFixture` / `auditPair` read it with no translation layer.
 *
 * The scrub runs AFTER sampling for the same reason it does in `buildFixture`:
 * selection stays a pure function of the corpus, so a fixture diff means the
 * CORPUS changed and not the sampler. It runs AT ALL because these atoms are
 * verbatim agent-written SQL committed to tracked source — and a real query
 * carries real paths (`'/home/<someone>/…'` inside a literal is ordinary in this
 * corpus). `lint:no-box-identity` has already held `main` red once over exactly
 * this class of leak in a sibling fixture.
 */
export async function buildSqlFixture(
  pair: SqlSubstitutionPair,
  opts: SqlCorpusOptions & { size: number; evidenceRef: string; extractedAt: string },
): Promise<CorpusFixture> {
  const all = await fetchSqlCorpusAtoms(opts);
  const matching = all.filter((entry) => sqlPairClaimsAtom(pair, entry.atom));
  return {
    evidenceRef: opts.evidenceRef,
    extractedAt: opts.extractedAt,
    totalAtoms: matching.length,
    totalSessions: new Set(matching.map((entry) => entry.sid)).size,
    sample: sampleDistinct(matching, opts.size).map((entry) => ({
      ...entry,
      atom: scrubIdentity(entry.atom),
    })),
  };
}
