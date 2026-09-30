/**
 * Plan-item provenance (plan-item-provenance-2026-09-29, P-001).
 *
 * The activation audit (plans:audit phase:'activation') maps the SOURCE CONVERSATION
 * FORWARD onto the plan: every owner requirement → the plan targets that carry it.
 * Nothing checked the REVERSE direction — that every plan ITEM traces back to something
 * the owner actually said. Worse, the forward map accepted any turn as a source ref, so
 * an agent citing its OWN assistant turn (or a machine-injected loop-fire replay of its
 * own goal text, which is recorded with speaker='user') "covered" the item it had just
 * invented (EI-24639344765147379).
 *
 * This module is the pure resolver for that reverse check. Given the audit's mappings, a
 * per-ref turn-origin verdict, the plan's current non-dropped items and the auditor's
 * explicit per-item declarations, it labels every item:
 *
 *   owner        — some non-rejected mapping targeting the item cites ≥1 OWNER turn.
 *   derived      — declared as derived from other targets, at least one of which is
 *                  itself owner-backed (transitively, via owner or derived items).
 *   agent-added  — explicitly declared as the agent's own addition, with a reason.
 *   unresolved   — none of the above; `reason` says which rung failed.
 *
 * TWO PROPERTIES ARE LOAD-BEARING:
 *
 * 1. Only an affirmative owner verdict counts. `unknown`, `not-user-turn` (assistant),
 *    `agent-injected`, `machine-surface` and `synthetic` never make an item
 *    owner-sourced. An unknown origin is not proof of fabrication either — it simply
 *    does not qualify, and the auditor can still declare the item derived/agent-added.
 * 2. An explicit declaration never overrides owner backing and never manufactures it: a
 *    `derived` declaration whose sources are not themselves owner-backed stays
 *    unresolved (`derived_source_not_owner_backed`), so derivation cannot launder an
 *    agent-only item into an owner-sourced one.
 */

import { parsePlan } from '@papercusp/plan-parser';
import {
  classifyHitTurnOrigin,
  TURN_ORIGIN_HEAD_CHARS,
  TURN_ORIGIN_TAIL_CHARS,
  turnOriginKey,
  type HitTurnOriginVerdict,
} from './agent-tools/sessions/turn-origin';
import { parseTurnRef } from './agent-tools/sessions/_shared';

/** The turn-origin verdicts that ARE owner speech (see turn-provenance/turn-ref). */
export const OWNER_TURN_VERDICTS: ReadonlySet<HitTurnOriginVerdict> = new Set<HitTurnOriginVerdict>([
  'owner-typed',
  'owner-turn',
  'owner-dialog',
]);

export function isOwnerTurnVerdict(verdict: HitTurnOriginVerdict | null | undefined): boolean {
  return verdict != null && OWNER_TURN_VERDICTS.has(verdict);
}

export type ItemProvenanceLabel = 'owner' | 'derived' | 'agent-added' | 'unresolved';

export type ItemProvenanceUnresolvedReason =
  /** No non-rejected mapping targets the item and nothing was declared. */
  | 'no_mapping'
  /** Mappings target the item, but every cited ref is non-owner (assistant, injected, unknown). */
  | 'no_owner_ref'
  /** Declared derived, but none of its `from` targets is owner-backed. */
  | 'derived_source_not_owner_backed'
  /** Declared agent-added without a non-empty reason. */
  | 'agent_added_reason_missing';

/** Auditor-supplied per-item declaration (plans:audit `itemProvenance`). */
export type ItemProvenanceDeclaration =
  | {
      itemId: string;
      kind: 'derived';
      /** Plan targets it derives from: P-NNN, D-NNN, R-N or section:<heading>. */
      from: string[];
      note?: string;
    }
  | {
      itemId: string;
      kind: 'agent-added';
      reason: string;
    };

export interface ProvenanceMappingInput {
  id: string;
  sourceRefs: string[];
  planTargets: string[];
  disposition: 'covered' | 'repaired' | 'rejected' | 'open';
}

export interface ItemProvenanceRef {
  ref: string;
  verdict: HitTurnOriginVerdict;
  owner: boolean;
}

export interface ItemProvenanceResult {
  itemId: string;
  label: ItemProvenanceLabel;
  /** Present only when label === 'unresolved'. */
  reason?: ItemProvenanceUnresolvedReason;
  /** Mapping ids that target this item (non-rejected), in audit order. */
  mappingIds: string[];
  /** Every source ref those mappings cite, with its origin verdict. */
  refs: ItemProvenanceRef[];
  /** For derived: the `from` targets that were owner-backed. */
  derivedFrom?: string[];
  /** For agent-added: the declared reason. */
  agentReason?: string;
}

export interface ResolveItemProvenanceInput {
  /** Current non-dropped plan item ids (P-NNN). */
  itemIds: readonly string[];
  mappings: readonly ProvenanceMappingInput[];
  /** Verdict for a source ref; undefined means the turn could not be read → `unknown`. */
  originOf: (ref: string) => HitTurnOriginVerdict | undefined;
  declarations?: readonly ItemProvenanceDeclaration[];
}

export interface ItemProvenanceSummary {
  items: ItemProvenanceResult[];
  counts: Record<ItemProvenanceLabel, number>;
  /** Item ids whose label is 'unresolved', in input order. */
  unresolved: string[];
}

function refVerdict(originOf: ResolveItemProvenanceInput['originOf'], ref: string): HitTurnOriginVerdict {
  return originOf(ref) ?? 'unknown';
}

/**
 * Label every current plan item. Pure: no I/O, deterministic for its inputs.
 */
export function resolveItemProvenance(input: ResolveItemProvenanceInput): ItemProvenanceSummary {
  const liveMappings = input.mappings.filter((mapping) => mapping.disposition !== 'rejected');

  // Owner backing for ANY plan target (items, decisions, requirements, sections):
  // a target is owner-backed when some live mapping naming it cites an owner turn.
  const ownerBackedTargets = new Set<string>();
  const mappingsByTarget = new Map<string, ProvenanceMappingInput[]>();
  for (const mapping of liveMappings) {
    const hasOwnerRef = mapping.sourceRefs.some((ref) => isOwnerTurnVerdict(refVerdict(input.originOf, ref)));
    for (const target of new Set(mapping.planTargets)) {
      const list = mappingsByTarget.get(target) ?? [];
      list.push(mapping);
      mappingsByTarget.set(target, list);
      if (hasOwnerRef) ownerBackedTargets.add(target);
    }
  }

  const declarationByItem = new Map<string, ItemProvenanceDeclaration>();
  for (const declaration of input.declarations ?? []) {
    // First declaration wins; plans:audit rejects duplicates before reaching here.
    if (!declarationByItem.has(declaration.itemId)) declarationByItem.set(declaration.itemId, declaration);
  }

  const results = new Map<string, ItemProvenanceResult>();
  for (const itemId of input.itemIds) {
    const mappings = mappingsByTarget.get(itemId) ?? [];
    const refs: ItemProvenanceRef[] = [];
    const seen = new Set<string>();
    for (const mapping of mappings) {
      for (const ref of mapping.sourceRefs) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        const verdict = refVerdict(input.originOf, ref);
        refs.push({ ref, verdict, owner: isOwnerTurnVerdict(verdict) });
      }
    }
    const base = { itemId, mappingIds: mappings.map((mapping) => mapping.id), refs };
    if (ownerBackedTargets.has(itemId)) {
      results.set(itemId, { ...base, label: 'owner' });
      continue;
    }
    const declaration = declarationByItem.get(itemId);
    if (declaration?.kind === 'agent-added') {
      const reason = declaration.reason?.trim() ?? '';
      results.set(
        itemId,
        reason
          ? { ...base, label: 'agent-added', agentReason: reason }
          : { ...base, label: 'unresolved', reason: 'agent_added_reason_missing' },
      );
      continue;
    }
    results.set(itemId, {
      ...base,
      label: 'unresolved',
      reason: declaration?.kind === 'derived' ? 'derived_source_not_owner_backed' : mappings.length > 0 ? 'no_owner_ref' : 'no_mapping',
    });
  }

  // Derived items: fixed point, so a chain derived → derived → owner resolves, while a
  // cycle of derivations with no owner anchor never does.
  let changed = true;
  while (changed) {
    changed = false;
    for (const itemId of input.itemIds) {
      const current = results.get(itemId)!;
      if (current.label !== 'unresolved') continue;
      const declaration = declarationByItem.get(itemId);
      if (declaration?.kind !== 'derived') continue;
      const backed = [...new Set(declaration.from)].filter((target) => {
        if (target === itemId) return false;
        if (ownerBackedTargets.has(target)) return true;
        const other = results.get(target);
        return other?.label === 'owner' || other?.label === 'derived';
      });
      if (backed.length > 0) {
        const { reason: _reason, ...rest } = current;
        results.set(itemId, { ...rest, label: 'derived', derivedFrom: backed });
        changed = true;
      }
    }
  }

  const items = input.itemIds.map((itemId) => results.get(itemId)!);
  const counts: Record<ItemProvenanceLabel, number> = { owner: 0, derived: 0, 'agent-added': 0, unresolved: 0 };
  for (const item of items) counts[item.label] += 1;
  return { items, counts, unresolved: items.filter((item) => item.label === 'unresolved').map((item) => item.itemId) };
}

/** Structural problems in a declaration list, collected (not short-circuited). */
export interface ItemProvenanceDeclarationProblem {
  itemId: string;
  code: 'provenance_item_unknown' | 'provenance_item_duplicate' | 'provenance_derived_from_empty' | 'provenance_reason_empty';
  detail: string;
}

export function validateItemProvenanceDeclarations(
  declarations: readonly ItemProvenanceDeclaration[],
  itemIds: readonly string[],
): ItemProvenanceDeclarationProblem[] {
  const known = new Set(itemIds);
  const seen = new Set<string>();
  const problems: ItemProvenanceDeclarationProblem[] = [];
  for (const declaration of declarations) {
    if (!known.has(declaration.itemId)) {
      problems.push({
        itemId: declaration.itemId,
        code: 'provenance_item_unknown',
        detail: `${declaration.itemId} is not a current non-dropped item of this plan`,
      });
    }
    if (seen.has(declaration.itemId)) {
      problems.push({
        itemId: declaration.itemId,
        code: 'provenance_item_duplicate',
        detail: `${declaration.itemId} has more than one provenance declaration`,
      });
    }
    seen.add(declaration.itemId);
    if (declaration.kind === 'derived' && declaration.from.filter((target) => target.trim()).length === 0) {
      problems.push({
        itemId: declaration.itemId,
        code: 'provenance_derived_from_empty',
        detail: `${declaration.itemId} is declared derived but names no source target`,
      });
    }
    if (declaration.kind === 'agent-added' && !declaration.reason?.trim()) {
      problems.push({
        itemId: declaration.itemId,
        code: 'provenance_reason_empty',
        detail: `${declaration.itemId} is declared agent-added without a reason`,
      });
    }
  }
  return problems;
}

// ─── Audit-time evaluation (P-002) ────────────────────────────────────────────

/** Current non-dropped item ids of a plan revision, in document order. */
export function currentPlanItemIds(planContent: string): string[] {
  return parsePlan(planContent).items
    .filter((item) => item.storedStatus !== 'dropped')
    .map((item) => item.id);
}

/** Resolves a batch of canonical session_turn refs to origin verdicts. Missing refs
 *  are simply absent from the map (→ `unknown`), never guessed. */
export type RefOriginLookup = (refs: readonly string[]) => Promise<Map<string, HitTurnOriginVerdict>>;

/**
 * DB-backed lookup: ONE round trip over harness_shared.session_turns, classifying each
 * turn's HEAD with the same classifier sessions:search uses (turn-origin.ts property 1:
 * never an excerpt). Arrays go through sql.array() so each stays one SQL argument on
 * getOrgPg (the same reason audit.ts's under-read query uses it).
 */
export type TurnSql = {
  <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  array?: (values: unknown[]) => unknown;
};

/** One cited turn as read from the corpus: its speaker, the first `chars` characters of
 *  its text, and the origin verdict classified from that text's head. */
export interface SourceTurn {
  speaker: string | null;
  text: string | null;
  verdict: HitTurnOriginVerdict;
}

/**
 * Read a batch of canonical session_turn refs in ONE round trip over
 * harness_shared.session_turns, classifying each turn's HEAD with the same classifier
 * sessions:search uses (turn-origin.ts property 1: never an excerpt). Refs that do not
 * parse, or whose turn is absent, are simply missing from the result — never guessed.
 * Arrays go through sql.array() so each stays one SQL argument on getOrgPg.
 *
 * Shared by the audit-time origin lookup (P-002) and the provenance read model (P-004),
 * so the verdict a plan was audited against and the one the owner sees come from the
 * same query.
 */
export async function fetchSourceTurns(
  sql: TurnSql,
  workspaceId: string,
  refs: readonly string[],
  chars: number = TURN_ORIGIN_HEAD_CHARS,
): Promise<Map<string, SourceTurn>> {
  const out = new Map<string, SourceTurn>();
  const keyed = [...new Set(refs)]
    .map((ref) => ({ ref, parsed: parseTurnRef(ref) }))
    .filter((entry): entry is { ref: string; parsed: NonNullable<ReturnType<typeof parseTurnRef>> } => entry.parsed != null);
  if (keyed.length === 0) return out;
  const wrap = (values: unknown[]) => (sql.array ? sql.array(values) : values);
  const width = Math.max(chars, TURN_ORIGIN_HEAD_CHARS);
  const rows = await sql<
    Array<{ source_kind: string; session_id: string; turn_idx: number; speaker: string | null; head: string | null; tail: string | null }>
  >`
    SELECT turns.source_kind, turns.session_id, turns.turn_idx, turns.speaker,
           left(turns.text, ${width}) AS head,
           right(turns.text, ${TURN_ORIGIN_TAIL_CHARS}) AS tail
      FROM harness_shared.session_turns AS turns
     WHERE (turns.workspace_id = ${workspaceId} OR turns.workspace_id = 'default')
       AND EXISTS (
         SELECT 1
           FROM unnest(
             ${wrap(keyed.map((entry) => entry.parsed.sourceKind))}::text[],
             ${wrap(keyed.map((entry) => entry.parsed.sessionId))}::text[],
             ${wrap(keyed.map((entry) => entry.parsed.turnIdx))}::int[]
           ) AS wanted(source_kind, session_id, turn_idx)
          WHERE wanted.source_kind = turns.source_kind
            AND wanted.session_id = turns.session_id
            AND wanted.turn_idx = turns.turn_idx
       )`;
  const byKey = new Map<string, SourceTurn>();
  for (const row of rows) {
    const head = row.head ?? null;
    byKey.set(turnOriginKey({ sourceKind: row.source_kind, sessionId: row.session_id, turnIdx: Number(row.turn_idx) }), {
      speaker: row.speaker ?? null,
      text: head === null ? null : head.slice(0, chars),
      // The tail lets a paste-wrapped injection longer than the head still unwrap
      // (WI-10004057) — without it such a turn counts as OWNER evidence.
      verdict: classifyHitTurnOrigin(
        row.speaker,
        head === null ? null : head.slice(0, TURN_ORIGIN_HEAD_CHARS),
        row.tail,
      ).verdict,
    });
  }
  for (const { ref, parsed } of keyed) {
    const turn = byKey.get(turnOriginKey(parsed));
    if (turn) out.set(ref, turn);
  }
  return out;
}

export function dbRefOriginLookup(sql: TurnSql, workspaceId: string): RefOriginLookup {
  return async (refs) => {
    const out = new Map<string, HitTurnOriginVerdict>();
    for (const [ref, turn] of await fetchSourceTurns(sql, workspaceId, refs)) out.set(ref, turn.verdict);
    return out;
  };
}

/**
 * The per-audit verdict persisted on the activation payload (plan D-005): the per-item
 * labels AND the per-ref origin verdicts they were computed from, so the lifecycle gate
 * never re-classifies transcripts and the read model can show what the audit saw.
 */
export interface StoredItemProvenanceCheck {
  version: 1;
  /** True when this audit was held to the rule (refused on any unresolved item). */
  enforced: boolean;
  /** Current non-dropped items at the audited revision, with their label. */
  items: Record<string, ItemProvenanceLabel>;
  /** Items that were unresolved at this audit (always empty when enforced). */
  unresolved: string[];
  /** Origin verdict of every cited source ref; a ref absent here was unreadable (unknown). */
  refOrigins: Record<string, HitTurnOriginVerdict>;
}

export interface ActivationItemProvenanceEvaluation {
  /** Structural declaration problems — the audit must refuse on any. */
  problems: ItemProvenanceDeclarationProblem[];
  summary: ItemProvenanceSummary;
  /** The server-written verdict to store on the audit (plan D-005). */
  check: StoredItemProvenanceCheck;
  /** True when the audit must refuse `item_provenance_missing`. */
  refuse: boolean;
  /** Set when the audit records with unresolved items (legacy plan). */
  warning?: string;
}

/**
 * Decide the reverse-coverage verdict for one activation audit.
 *
 * Enforcement (plan D-00x, R-2/R-3): a plan's FIRST activation audit is always
 * enforced, as is any re-audit of a plan whose previous audit was enforced. A plan
 * whose earlier audits predate item provenance is grandfathered: its re-audit records
 * `enforced:false` with the unresolved items as a warning — unless every item already
 * resolves, in which case it ratchets onto enforcement from then on.
 */
export async function evaluateActivationItemProvenance(input: {
  planContent: string;
  mappings: readonly ProvenanceMappingInput[];
  declarations: readonly ItemProvenanceDeclaration[];
  /** The previous activation audit's stored check; null = no previous audit. */
  previous: { exists: boolean; check?: { enforced: boolean } | null };
  lookupOrigins: RefOriginLookup;
}): Promise<ActivationItemProvenanceEvaluation> {
  const itemIds = currentPlanItemIds(input.planContent);
  const problems = validateItemProvenanceDeclarations(input.declarations, itemIds);
  const origins = await input.lookupOrigins(input.mappings.flatMap((mapping) => mapping.sourceRefs));
  const summary = resolveItemProvenance({
    itemIds,
    mappings: input.mappings,
    originOf: (ref) => origins.get(ref),
    declarations: input.declarations.filter((declaration) => itemIds.includes(declaration.itemId)),
  });
  const legacy = input.previous.exists && input.previous.check?.enforced !== true;
  const enforced = !legacy || summary.unresolved.length === 0;
  const items: Record<string, ItemProvenanceLabel> = {};
  for (const item of summary.items) items[item.itemId] = item.label;
  return {
    problems,
    summary,
    check: { version: 1, enforced, items, unresolved: summary.unresolved, refOrigins: Object.fromEntries(origins) },
    refuse: problems.length === 0 && enforced && summary.unresolved.length > 0,
    ...(!enforced
      ? {
          warning:
            `${summary.unresolved.length} item(s) have no owner source, derivation or agent-added declaration ` +
            `(${summary.unresolved.join(', ')}). This plan's earlier activation audits predate item provenance, so ` +
            'the audit was recorded unenforced; declare them via itemProvenance to bring the plan under the rule.',
        }
      : {}),
  };
}

/** Per-item refusal problems for `item_provenance_missing`. */
export function itemProvenanceMissingProblems(summary: ItemProvenanceSummary): Array<{ itemId: string; code: string; detail: string }> {
  const explain: Record<ItemProvenanceUnresolvedReason, string> = {
    no_mapping: 'no mapping targets it — map the owner turn that asked for it, or declare it derived/agent-added',
    no_owner_ref: 'its mappings cite only assistant, machine-injected or unreadable turns — cite the owner turn, or declare it derived/agent-added',
    derived_source_not_owner_backed: 'it is declared derived, but none of its sources is owner-backed',
    agent_added_reason_missing: 'it is declared agent-added without a reason',
  };
  return summary.items
    .filter((item) => item.label === 'unresolved')
    .map((item) => ({
      itemId: item.itemId,
      code: item.reason ?? 'no_mapping',
      detail: `${item.itemId}: ${explain[item.reason ?? 'no_mapping']}`,
    }));
}

/** Human label used by tool messages and the GUI (kept here so both read one source). */
export function itemProvenanceLabelText(label: ItemProvenanceLabel): string {
  switch (label) {
    case 'owner':
      return 'You asked for this';
    case 'derived':
      return 'Follows from something you asked for';
    case 'agent-added':
      return 'Added by the agent';
    case 'unresolved':
      return 'No source found';
  }
}
