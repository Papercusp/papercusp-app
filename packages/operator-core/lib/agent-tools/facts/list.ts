/**
 * facts:list — read the live standing facts for one (scope, scopeRef)
 * (queen-memory-hybrid L1b). The same deterministic read the brief/dossier/
 * orient folds use, so what you see here is exactly what agents get folded.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { InvalidInputError } from '@papercusp/tooldef';
import {
  listFacts,
  countLiveFacts,
  factVersions,
  listFactEvictionDisclosures,
  FACT_SCOPES,
  FACTS_PER_SCOPE_CAP,
  DEAD_END_KEY_PREFIX,
  WALL_KEY_PREFIX,
  GUARD_RAIL_KEY_PREFIX,
  isPermanentFactExpiry,
  validateFactScope,
  type AgentFact,
} from '../../agent-facts/store';
import { resolveScopeRefFromCtx, resolveScopeRefAlias } from './scope-ctx';
import { markStaleSourceFacts, type FactSourceStaleness } from './stale-source';
import type { FactDependencyStaleness } from './dependency-staleness';
import {
  extractOperativeClauses,
  OPERATIVE_CLAUSE_CHARS_DEFAULT,
  OPERATIVE_CLAUSE_MAX_CLAUSES_DEFAULT,
} from '../../operative-clause';

/**
 * Keep the default projection honest about typed source anchors that failed
 * assert-time verification without paying for a provenance quote. A default
 * facts:list read is intentionally bounded; the quote/label remain available
 * through full:true, while this marker prevents `sourceRef: 'owner-turn'` (or
 * another unresolved typed ref) from reading as verified authority.
 */
function projectUnverifiedSourceProvenance(
  provenance: NonNullable<AgentFact['sourceProvenance']>,
): Record<string, unknown> {
  return {
    kind: provenance.kind,
    verified: false,
    ...(provenance.error ? { error: provenance.error.slice(0, 80) } : {}),
  };
}

/**
 * EI-10948 removed the old 50-row blow-up, but 25 excerpted rows still exceed the
 * universal ~1500-token result door on a broad harness read (EI-20242506233119355).
 * A later live probe showed that eight rows can still overflow when the rows carry
 * stale-source metadata (EI-20245738587790330). Four rows leave enough headroom for
 * the wrapper and per-fact metadata; explicit limits are clamped to this same
 * result-door-safe ceiling.
 */
export const FACTS_LIST_DEFAULT_LIMIT = 4;
/** Keep caller-supplied pages inside the same result-door-safe row ceiling. */
export const FACTS_LIST_MAX_LIMIT = FACTS_LIST_DEFAULT_LIMIT;
/**
 * Explicit census escape hatch: the widest PAGE this tool will return.
 *
 * ⚠ THIS IS NOT THE ENFORCED PER-SCOPE CAP, and calling it one is how an agent
 * concludes a scope holds at most 200 facts. That cap is
 * {@link FACTS_PER_SCOPE_CAP} (5000) and lives in the store; this is a
 * result-door row ceiling and lives here. The two are unrelated numbers, and on
 * 2026-09-05 they were 25x apart while `workspace` held 513 live facts — so
 * `all:true` returned 200 of 513 and any text promising "the complete
 * population" was false for the busiest scope on the box.
 *
 * A population larger than this is therefore NORMAL, not a runaway. When it
 * happens the response still says so via `truncatedByLimit` + `note_truncated`
 * (WI-38910), which is what keeps a short page honest — but the remedy offered
 * there must never be "pass all:true", because above this ceiling that is a
 * dead end. Narrow by `key`/scope instead.
 */
export const FACTS_LIST_ALL_LIMIT = 200;

/** Clamp a caller's page size to the result-door-safe row ceiling. PURE. */
export function clampFactsListLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return FACTS_LIST_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(limit), FACTS_LIST_MAX_LIMIT));
}

/** Resolve the store limit for a bounded page versus an explicitly requested census. PURE. */
export function factsListEffectiveLimit(limit?: number, all = false): number {
  return all ? FACTS_LIST_ALL_LIMIT : clampFactsListLimit(limit);
}

/** Tell callers when their explicit page size was reduced for result-door safety. PURE. */
export function factsListLimitDisclosure(limit?: number): Record<string, unknown> | undefined {
  if (limit === undefined) return undefined;
  const applied = clampFactsListLimit(limit);
  return applied < limit
    ? { limitCapped: { requested: limit, applied, reason: 'result_door_budget' } }
    : undefined;
}
/** Excerpt width — enough to identify a fact + decide whether to retract it. */
export const FACTS_LIST_EXCERPT_CHARS = 180;
export const FACTS_LIST_EXCERPT_NOTE =
  'Bodies are EXCERPTED (see body_truncated / body_full_chars) — but any OPERATIVE clause (ALWAYS/NEVER/MUST/DO NOT…) found past the cut is preserved verbatim after the ⚠ OPERATIVE marker. Pass full:true — ideally with a tighter limit — for whole bodies.';

/**
 * P-002 (knowledge-at-symptom-time-2026-08-09): how much of the budget the preserved operative
 * clauses may take, on top of the excerpt head. Deliberately small — EI-10948 shrank this response
 * for a real reason, and the fix must not quietly undo it. Only facts that actually carry an
 * imperative past the cut pay anything at all.
 */
export const FACTS_LIST_OPERATIVE_CHARS = OPERATIVE_CLAUSE_CHARS_DEFAULT;
export const FACTS_LIST_OPERATIVE_MAX_CLAUSES = OPERATIVE_CLAUSE_MAX_CLAUSES_DEFAULT;

/**
 * P-002: pull the imperative clauses out of a fact body.
 *
 * The incident: two standing facts that would have prevented a wrong owner-facing diagnosis were
 * folded into an agent's second tool call of the session and BOTH were cut mid-instruction — one
 * rendered literally as "... is NOT self-validating. ALWAYS cross-read acco…", severing the verb
 * inside the word "accounts:status". The excerpt kept the fact's EVIDENCE (which the reader can
 * re-derive) and discarded its INSTRUCTION (which is the only part that changes behaviour). A
 * head-only slice optimises for identifying a fact; a reader needs to know what it tells them to do.
 *
 * The implementation now lives in `../../operative-clause` (EI-19952485326105760) — shared with the
 * carry-brief held-item checkpoint render, which hit the same head-only-slice defect for a
 * SUPERSESSION rather than an imperative. Re-exported here so existing importers (this module's own
 * `operative-clause-preservation.test.ts`) keep working unchanged.
 */
export { extractOperativeClauses };

/**
 * Project one fact for the list response: excerpt the body and drop the bounded
 * provenance quote unless `full`. Unverified typed provenance remains as a small
 * marker so an unresolved anchor cannot read as verified authority. PURE — unit-tested
 * without PG.
 */
export function projectFact(
  f: AgentFact & { sourceStale?: FactSourceStaleness; depsStale?: FactDependencyStaleness },
  full: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    scope: f.scope,
    ref: f.scopeRef,
    key: f.key,
    sourceRef: f.sourceRef,
    createdBy: f.createdBy,
    updatedAt: f.updatedAt,
    expiresAt: f.expiresAt,
    ...(f.retractedAt !== undefined ? { retractedAt: f.retractedAt } : {}),
    ...(f.retractedBy !== undefined ? { retractedBy: f.retractedBy } : {}),
    ...(f.retractionReason !== undefined ? { retractionReason: f.retractionReason } : {}),
    ...(f.audienceScope ? { audienceScope: f.audienceScope } : {}),
    // WI-6052: confidence is now persisted — surface it same as audienceScope
    // (omitted when unset, matching the legacy/unbadged shape).
    ...(f.confidence ? { confidence: f.confidence } : {}),
    // EI-20191740437408337: never hide the fact that a value is a moving
    // snapshot; this metadata stays visible even when the body is excerpted.
    ...(f.measurement ? { measurement: f.measurement } : {}),
    // P-010: the executable recheck contract is control metadata, never body
    // detail, so excerpting the body must not hide it.
    ...(f.recheck ? { recheck: f.recheck } : {}),
    // P-008 (b): kind/claim follow the same omitted-when-unset convention. `kind`
    // absent means "not declared", which is a real and distinct state from
    // 'conclusion' — see FACT_KINDS on why it is never backfilled.
    ...(f.kind ? { kind: f.kind } : {}),
    ...(f.claim ? { claim: f.claim } : {}),
    // The staleness flags are NEVER excerpted away — they are the reason to read
    // the list. `stale` = the source WORK-ITEM closed (EI-10947, a hint);
    // `dependsStale` = a DECLARED cell dependency actually changed (P-008 b, a
    // mechanical verdict). Two different questions, deliberately two fields: a
    // reader must be able to tell "the anchor closed, this may be stale" from
    // "the value you relied on is now X".
    ...(f.sourceStale ? { stale: f.sourceStale } : {}),
    ...(f.dependsOn?.length ? { dependsOn: f.dependsOn } : {}),
    ...(f.depsStale ? { dependsStale: f.depsStale } : {}),
  };
  if (full) return { ...base, body: f.body, sourceProvenance: f.sourceProvenance };
  const unverifiedSourceProvenance =
    f.sourceProvenance && !f.sourceProvenance.verified
      ? projectUnverifiedSourceProvenance(f.sourceProvenance)
      : undefined;
  const withSourceMarker = {
    ...base,
    ...(unverifiedSourceProvenance ? { sourceProvenance: unverifiedSourceProvenance } : {}),
  };
  const body = f.body ?? '';
  const cut = body.length > FACTS_LIST_EXCERPT_CHARS;
  if (!cut) return { ...withSourceMarker, body };
  const head = body.slice(0, FACTS_LIST_EXCERPT_CHARS);
  // P-002: truncate the EVIDENCE, never the INSTRUCTION. A fact's imperative is the only part that
  // changes a reader's behaviour, and it is routinely written last — so a head-only slice discards
  // precisely the payload while keeping the narration.
  const operative = extractOperativeClauses(body, head);
  return {
    ...withSourceMarker,
    body: operative.length ? `${head}… ⚠ OPERATIVE: ${operative.join(' ')}` : `${head}…`,
    body_truncated: true,
    body_full_chars: body.length,
    // Explicit flag so a caller can MEASURE how often the head alone would have lost the instruction.
    ...(operative.length ? { body_operative_preserved: true } : {}),
  };
}

/**
 * Whether a version returned by the key-scoped lookup is the CURRENT live row.
 *
 * `factVersions` deliberately returns history, including expired/retracted rows,
 * because that is what the `versions:true` mode needs. The key-scoped mode must
 * apply the live-fold predicates again so a historical row can never turn a
 * missing current fact into a false positive.
 */
export function isLiveFact(
  f: Pick<AgentFact, 'expiresAt' | 'retractedAt' | 'supersededAt'> | undefined,
  nowMs = Date.now(),
): boolean {
  if (!f || f.supersededAt != null || f.retractedAt != null) return false;
  if (isPermanentFactExpiry(f.expiresAt)) return true;
  const expiresAtMs = Date.parse(f.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

/** Pick the live row from the newest-first version result, if one exists. PURE. */
export function findLiveFactVersion(
  versions: readonly AgentFact[],
  nowMs = Date.now(),
): AgentFact | undefined {
  return versions.find((version) => isLiveFact(version, nowMs));
}

const FACT_SLOT_KEY_PREFIXES = [DEAD_END_KEY_PREFIX, WALL_KEY_PREFIX, GUARD_RAIL_KEY_PREFIX] as const;

/**
 * Slot asserts encode their type in the stored key. Preserve exact-key semantics
 * for already-prefixed callers, while allowing the original key passed to
 * facts:assert to resolve when exactly one typed slot owns it.
 */
export function factSlotAliasCandidates(key: string): string[] {
  const lower = key.toLowerCase();
  if (FACT_SLOT_KEY_PREFIXES.some((prefix) => lower.startsWith(prefix))) return [];
  return FACT_SLOT_KEY_PREFIXES.map((prefix) => `${prefix}${key}`);
}

export type FactKeyMatch =
  | { kind: 'none' }
  | { kind: 'match'; key: string; fact: AgentFact }
  | { kind: 'ambiguous'; keys: string[] };

/** Choose an exact or alias key result without ever guessing across slots. PURE. */
export function selectFactKeyMatch(
  requestedKey: string,
  exact: AgentFact | undefined,
  aliases: ReadonlyArray<{ key: string; fact: AgentFact | undefined }>,
): FactKeyMatch {
  if (exact) return { kind: 'match', key: requestedKey, fact: exact };
  const matches = aliases.filter(
    (row): row is { key: string; fact: AgentFact } => row.fact !== undefined,
  );
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous', keys: matches.map((match) => match.key) };
  return { kind: 'match', key: matches[0].key, fact: matches[0].fact };
}

export default defineTool({
  name: 'facts:list',
  capability: 'coord:read',
  description:
    'List live (unexpired, unretracted) standing facts for one scope — the exact set future briefs/dossiers/orients will fold. workspace scope takes no scopeRef.',
  guidance: {
    when:
      'Before asserting (avoid duplicates — re-assert the same key to refresh instead), when auditing what a role/harness is being told every turn, or when hunting a stale fact to retract.',
    notWhen: 'Semantic search over background knowledge — that is memory:search.',
    chaining:
      'facts:list → facts:assert (refresh) / facts:retract (stale). Pass key to verify ONE live fact directly when list projection could make absence ambiguous; add versions:true + key to read what that fact said BEFORE it was corrected.',
    seeAlso: ['facts:assert', 'facts:retract'],
    // EI-21377394191283993 — a caller reached for `q` expecting a text search over
    // facts and got a bare unrecognized-key rejection. This store has no text index:
    // reads are exact-key or bounded-scope. Say that, and name BOTH substitutes.
    // D-004 local form: `key` is a declared key here, so this renders as a same-tool
    // rename rather than sending the caller to another tool.
    argRedirects: {
      q: 'key — this store has NO text search: `key` is an EXACT match, not a substring. Know the key? RENAME the arg. Hunting by wording instead? List the scope (`scope` + optional `scopeRef`) and read the returned keys, or use memory:search for semantic recall over background knowledge',
      query:
        'key — facts are addressed by exact key, never by query text. RENAME the arg if you know the key; otherwise list the scope and scan the keys, or use memory:search for meaning-based recall',
    },
  },
  requirePrincipal: false,
  // EI-20244379119118480: this handler uses the fact store's dedicated org-pool
  // accessors and never reads ctx.tx. Do not hold the dispatcher's ambient
  // workspace transaction across the stale-source/dependency reads; under fleet
  // pressure that idle org-app slot can make facts:list wait for the 45s acquire
  // deadline before its own read even starts.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: z.object({
    // EI-21149876417311061 (+ the `scope: Invalid option` family: EI-21161865091989242,
    // EI-21320781883732426, EI-22368562068872107) — the ONE filing shape in this cluster
    // that no `argRedirects` entry can ever reach. `scope` IS a declared key, so the
    // rejection is an invalid ENUM VALUE, and `invalidInputCorrections` only runs over
    // UNRECOGNIZED KEYS — a redirect authored here would never fire. The teaching has to
    // live on the field itself, which is the only surface the caller sees.
    //
    // The measured guess is `scope: 'plan'`, and it is a reasonable one: facts are folded
    // into plan-bound briefs, plan slugs address nearly everything else in this catalog,
    // and the bare "expected one of workspace|role|owner|harness|work_item" names the
    // five without saying that plan-scoped standing state has a DIFFERENT home. Naming
    // that home is what stops the retry loop.
    scope: z
      .enum(FACT_SCOPES)
      .describe(
        `Which scope's live facts to list — exactly one of ${FACT_SCOPES.join(' | ')}. There is deliberately NO \`plan\` scope: a standing claim that binds a PLAN belongs in that plan's Decisions (plans:add-decision), which is addressable and auditable afterwards, where a fact is not. For a plan-lane conclusion that must ride every orient, scope it to the \`harness\` the plan lives in, or to the \`work_item\` executing it.`,
      ),
    scopeRef: z.string().max(120).optional(),
    scope_ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef.'),
    ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef.'),
    harness: z.string().max(120).optional().describe('Alias for scopeRef when scope:"harness" (EI-7371) — prefer scopeRef.'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Max facts (default ${FACTS_LIST_DEFAULT_LIMIT}; positive values are clamped to ${FACTS_LIST_MAX_LIMIT} for ordinary result-door pages). With all:true, the wider page ceiling of ${FACTS_LIST_ALL_LIMIT} applies — a PAGE bound, not the enforced per-scope cap (${FACTS_PER_SCOPE_CAP}); a scope may legitimately hold more facts than one page can return.`,
      ),
    full: z
      .boolean()
      .optional()
      .describe(
        'Return COMPLETE fact bodies instead of excerpts. Default false — bodies are excerpted (with body_truncated + body_full_chars) so a busy scope cannot blow the tool-output budget (EI-10948). Use when you need a fact verbatim, ideally with a tighter `limit`.',
      ),
    all: z
      .boolean()
      .optional()
      .describe(
        `Widen the page to at most ${FACTS_LIST_ALL_LIMIT} rows instead of the result-door-safe ${FACTS_LIST_MAX_LIMIT}-row page. ⚠ This is a PAGE ceiling, NOT the enforced per-scope cap (${FACTS_PER_SCOPE_CAP}) — a scope can hold more live facts than this returns, so all:true is not a guarantee of completeness. Check \`truncatedByLimit\`/\`total\` in the response before treating the result as the whole population; above ${FACTS_LIST_ALL_LIMIT} narrow by \`key\` or scope rather than re-requesting all:true. Large results may spill to the result-door scratch cursor; use projection or key for a smaller read. Orthogonal to full:true, which controls body excerpts.`,
      ),
    key: z
      .string()
      .max(200)
      .optional()
      .describe(
        'With versions:true, the single fact key whose history to read; without versions, query ONE live fact directly (useful when a bounded list cannot establish absence).',
      ),
    versions: z
      .boolean()
      .optional()
      .describe(
        'P-008: return the VERSION HISTORY of one `key` (newest first) instead of the live list — what this fact said before it was corrected, each version with its own immutable `id` and the `supersedesId` of the one it replaced. Requires `key`. Superseded versions are pruned 30d after replacement, so history is bounded.',
      ),
  }),
  async handler(args, ctx) {
    // EI-7517: default an omitted scopeRef from the caller's context (owner = me,
    // harness = this harness, role = my role) so `facts:list { scope: 'owner' }`
    // lists YOUR facts without having to pass your own id — symmetry with assert.
    // EI-7371: resolve common misnamed aliases (scope_ref/ref/harness) first.
    const scopeRef = await resolveScopeRefFromCtx(args.scope, resolveScopeRefAlias(args.scope, args), ctx);
    // Keep the read-side identity contract aligned with facts:assert/retract. If
    // context cannot supply a ref for a non-workspace scope, querying NULL is not
    // an empty scope — it is an invalid selector that can mislead a follow-up
    // facts:assert into writing against the wrong census.
    const scopeErr = validateFactScope(args.scope, scopeRef);
    if (scopeErr) throw new InvalidInputError(`facts:list — ${scopeErr}`);
    // P-008 (a): the version-history read. Deliberately a MODE on facts:list
    // rather than a new `facts:versions` tool — same scope resolution, same
    // projection, same aliases; a second tool would be a bespoke state-read
    // surface for a question this one already answers ("what does this fact
    // say"), just along the time axis.
    if (args.versions === true) {
      const key = (args.key ?? '').trim();
      if (!key) {
        return {
          data: {
            ok: false,
            error: 'key_required',
            detail: 'versions:true reads ONE fact\'s history — pass `key`. Omit `versions` for the live list.',
          },
        };
      }
      const versions = await factVersions({
        scope: args.scope,
        scopeRef: scopeRef ?? null,
        key,
        limit: clampFactsListLimit(args.limit),
      });
      const limitDisclosure = factsListLimitDisclosure(args.limit);
      return {
        data: {
          ok: true,
          mode: 'versions',
          key,
          count: versions.length,
          ...(limitDisclosure ?? {}),
          ...(args.full !== true ? { excerpted: true, note: FACTS_LIST_EXCERPT_NOTE } : {}),
          // `current: true` is the reader's anchor — without it a history list
          // reads as N equally-valid claims, which is the confusion versioning
          // exists to remove.
          versions: versions.map((v) => ({
            ...projectFact(v, args.full === true),
            id: v.id ?? null,
            supersedesId: v.supersedesId ?? null,
            supersededAt: v.supersededAt ?? null,
            current: (v.supersededAt ?? null) === null,
          })),
        },
      };
    }
    // EI-19437221871431967: a projected/bounded list cannot prove that one
    // known short-TTL fact is absent. Read the newest version for the key and
    // apply the live predicates explicitly, returning a single-row shape that
    // keeps existence distinguishable from list truncation.
    const key = args.key?.trim();
    if (key) {
      const exactVersions = await factVersions({
        scope: args.scope,
        scopeRef: scopeRef ?? null,
        key,
        limit: 1,
      });
      const exact = findLiveFactVersion(exactVersions);
      let aliasRows: Array<{ key: string; fact: AgentFact | undefined }> = [];
      if (!exact) {
        const aliases = factSlotAliasCandidates(key);
        aliasRows = await Promise.all(
          aliases.map(async (alias) => ({
            key: alias,
            fact: findLiveFactVersion(
              await factVersions({
                scope: args.scope,
                scopeRef: scopeRef ?? null,
                key: alias,
                limit: 1,
              }),
            ),
          })),
        );
      }
      const match = selectFactKeyMatch(key, exact, aliasRows);
      if (match.kind === 'ambiguous') {
        return {
          data: {
            ok: false,
            mode: 'key',
            error: 'ambiguous_slot_key',
            key,
            detail: 'The unprefixed key exists in multiple typed fact slots; retry with one exact key.',
            candidates: match.keys,
          },
        };
      }
      const live = match.kind === 'match' ? match.fact : undefined;
      const resolvedKey = match.kind === 'match' ? match.key : key;
      const rows = live ? [projectFact(live, args.full === true)] : [];
      return {
        data: {
          ok: true,
          mode: 'key',
          key,
          ...(resolvedKey !== key ? { resolvedKey, matchedSlotAlias: true } : {}),
          found: live !== undefined,
          count: rows.length,
          ...(args.full !== true ? { excerpted: true, note: FACTS_LIST_EXCERPT_NOTE } : {}),
          facts: rows,
        },
      };
    }
    const facts = await listFacts(
      { scope: args.scope, scopeRef: scopeRef ?? null },
      { limit: factsListEffectiveLimit(args.limit, args.all === true) },
    );
    // EI-10947: flag facts whose source work-item has CLOSED — facts:list is where an
    // agent goes "hunting a stale fact to retract" (see guidance), so this is exactly
    // where the answer belongs. Fail-soft: unmarked on any lookup error.
    const marked = await markStaleSourceFacts(facts);
    // P-008 (b): and re-check every DECLARED cell dependency. This is the read
    // an agent makes when hunting a stale fact, so it is where a mechanical
    // "the cell you relied on changed from X to Y" belongs. Costs nothing when
    // no listed fact declared a dependency (the common case today) — each
    // DISTINCT cell is dispatched at most once for the whole page. Fail-soft.
    let annotated: Array<(typeof marked)[number] & { depsStale?: FactDependencyStaleness }> = marked;
    if (marked.some((f) => f.dependsOn?.length)) {
      try {
        const { resolveAgentIdentity } = await import('../coordination/identity');
        const { cellReaderFromCtx } = await import('../cell-reader-ctx');
        const { markStaleDependencyFacts } = await import('./dependency-staleness');
        const { reader, env } = cellReaderFromCtx(resolveAgentIdentity(ctx), ctx);
        annotated = await markStaleDependencyFacts(marked, reader, env);
      } catch {
        annotated = marked;
      }
    }
    // EI-10948: bodies are up to 500 chars and the default limit was 50, so a busy
    // harness returned ~56k chars — over the tool-output budget, a HARD error, spilled
    // to a file. The irony that hurt: the one read that shows you your stale facts was
    // the one that blew up. Excerpt by default, exactly as work_items:list already does.
    const rows = annotated.map((f) => projectFact(f, args.full === true));
    const limitDisclosure = args.all === true ? undefined : factsListLimitDisclosure(args.limit);
    // WI-38910: `count` is the PAGE SIZE, and the page is 4 rows by default. Read
    // alone it is indistinguishable from a census — on this box `count: 4` came
    // back for a workspace scope holding hundreds of live facts. That matters
    // because agents are instructed to read standing facts BEFORE asserting: a
    // dedup check against 4 of N cannot see the key it is looking for, and the
    // duplicate assert that follows EVICTS a peer's still-valid fact (the busy
    // scopes sit permanently at FACTS_PER_SCOPE_CAP).
    //
    // So the census is reported unconditionally, NOT only when the caller passed
    // an explicit `limit` — the default no-arg call is both the most common one
    // and the one with no disclosure at all today. Fail-soft: a census that
    // errors must not break the read it annotates, but it must also never
    // silently degrade into a confident-looking number, so on failure `total` is
    // omitted and `totalUnknown` says why.
    let census: { total?: number; totalUnknown?: string } = {};
    try {
      const total = await countLiveFacts(
        { scope: args.scope, scopeRef: scopeRef ?? null },
        { audiences: 'all' },
      );
      census = { total };
    } catch {
      census = { totalUnknown: 'census_query_failed' };
    }
    // EI-19485000346355077: this scope's absence of a key you expect is ambiguous
    // between "cap-evicted" and "never asserted" — ordinary readers had no path to
    // that distinction (see listFactEvictionDisclosures' doc). Fail-soft: a
    // disclosure-read error must never break the list it annotates.
    let evictionDisclosures: Record<string, unknown> = {};
    try {
      const disclosures = await listFactEvictionDisclosures([{ scope: args.scope, scopeRef: scopeRef ?? null }]);
      if (disclosures.length > 0) evictionDisclosures = { evictionDisclosure: disclosures[0] };
    } catch {
      // silent — this is a supplementary signal, not a hard dependency of the list read
    }
    const truncatedByLimit = census.total !== undefined && census.total > rows.length;
    return {
      data: {
        ok: true,
        count: rows.length,
        ...census,
        ...(truncatedByLimit
          ? {
              truncatedByLimit: true,
              note_truncated:
                `Showing ${rows.length} of ${census.total} live facts in this scope — ` +
                `\`count\` is the PAGE SIZE, not the census. The page is the ${rows.length} most ` +
                `recently updated. Pass \`key\` to check one specific fact (the read to make ` +
                `before asserting, so you amend the existing row instead of racing it), or ` +
                `narrow the scope. ` +
                ((census.total ?? 0) > FACTS_LIST_ALL_LIMIT
                  ? `⚠ This scope holds ${census.total} live facts, MORE than the ` +
                    `${FACTS_LIST_ALL_LIMIT}-row ceiling \`all:true\` can return — so all:true ` +
                    `would still truncate and is NOT a way to enumerate this population. ` +
                    `Narrow by \`key\` or scope instead. `
                  : `To enumerate the complete population, pass \`all:true\`; large ` +
                    `responses may spill to the result-door scratch cursor. `) +
                `The ordinary page is capped at ${FACTS_LIST_MAX_LIMIT} to stay inside the ` +
                `result door.`,
            }
          : {}),
        ...(limitDisclosure ?? {}),
        ...(args.full !== true ? { excerpted: true, note: FACTS_LIST_EXCERPT_NOTE } : {}),
        ...evictionDisclosures,
        facts: rows,
      },
    };
  },
});
