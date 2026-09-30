/**
 * assumptions.ts — resolving a commitment's declared assumption keys against the
 * facts ledger (unified-agent-state-plane-2026-07-27 P-008 (d), per D-050/D-079).
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 *
 * D-050 gated the commitment class (`work_items:set_state` at a terminal state,
 * and `work_items:complete`) on a REQUIRED `assumptions` declaration, and named
 * one thing it deliberately did not do:
 *
 *   "Keys are FORMAT-checked, not resolved against `harness_shared.agent_facts`.
 *    `relayOf` refuses a dangling msg_id on the principle that a reference nobody
 *    can resolve is laundering, and the same argument applies here — but P-008
 *    owns the assumption substrate and has not landed."
 *
 * P-008 (a)(b)(c) have landed, so this discharges that debt.
 *
 * ⚠ D-079: the substrate was not the only thing missing. `assumptions` was
 * required, format-checked, and then referenced ZERO times downstream — neither
 * handler persisted it. So D-050's claim that the gate "enforces that an
 * assumption was STATED, not that it exists — which is strictly more than the
 * nothing that preceded it" was false as built: a declaration that is validated
 * and discarded is exactly nothing, plus a required field on every close.
 * PERSISTENCE therefore lands with resolution, and comes first — resolving keys
 * before persisting them would be decoration on a discarded value.
 *
 * ── WHAT COUNTS AS DANGLING (the question D-050 deferred to P-008) ──────────
 *
 * D-050: "is an expired key dangling, or merely old?" — MERELY OLD. Only total
 * non-existence refuses. `lapsed`, `superseded` and `retracted` all RESOLVE and
 * carry their condition, because:
 *
 *   • a SUSPECTED fact defaults to a SIX HOUR TTL, so treating lapse as dangling
 *     would refuse an agent who declared a suspected assumption and closed seven
 *     hours later — a gate that punishes the exact behaviour it exists to
 *     encourage;
 *   • a RETRACTED assumption is often retracted BECAUSE the work resolved it.
 *     Refusing would force the closer to lie with 'none';
 *   • a version-pinned ref that has since been SUPERSEDED is the D-026 staleness
 *     signal working as designed, not an error.
 *
 * The line is D-016's own division of labour: this GATE's question is structural
 * — "does this reference resolve at all". "Is it still TRUE" is a DETECTOR
 * question and stays P-011's. A lapsed fact is fully resolvable (body, author and
 * timestamp all readable); a key that never existed is not.
 *
 * ── WHY THE STAMP MATTERS MORE THAN THE REFUSAL ─────────────────────────────
 *
 * A bare key is only meaningful RELATIVE to the closer's own scope set, and that
 * context is gone the moment the item leaves the queue. So resolution stamps the
 * ABSOLUTE versioned ref (plus a body excerpt) onto the record: the closed item
 * then says which fact, which version, and what it said — self-contained, and
 * still readable after {@link sweepExpiredFacts} hard-deletes the row 30d past
 * expiry. That is the actual point of refusing dangles.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import {
  FACT_CONFIDENCE_LEVELS,
  FACT_KINDS,
  FACT_PROVENANCE_QUOTE_CHARS,
  factCitationRef,
  isAssumptionFact,
  type FactConfidence,
  type FactKind,
  type FactScope,
  type FactSelector,
} from './store';

function parseKindColumn(raw: string | null): FactKind | null {
  return raw != null && (FACT_KINDS as readonly string[]).includes(raw) ? (raw as FactKind) : null;
}

function parseConfidenceColumn(raw: string | null): FactConfidence | null {
  return raw != null && (FACT_CONFIDENCE_LEVELS as readonly string[]).includes(raw)
    ? (raw as FactConfidence)
    : null;
}

/**
 * The condition a declared assumption resolved to. Ordered from strongest to
 * weakest; only the last refuses.
 */
export const ASSUMPTION_CONDITIONS = [
  'live',
  'lapsed',
  'superseded',
  'retracted',
  'unresolved',
  'dangling',
] as const;
export type AssumptionCondition = (typeof ASSUMPTION_CONDITIONS)[number];

/**
 * The one condition that REFUSES a commitment (D-079 R3).
 *
 * ⚠ `unresolved` is NOT dangling, and the distinction is load-bearing: "the
 * ledger says this key does not exist" and "the ledger could not be consulted"
 * are different facts, and only the first is laundering. Collapsing them makes
 * Postgres availability a precondition for closing ANY work item — one blip and
 * every terminal close in the fleet refuses, with a message blaming the closer
 * for a key that is probably fine. This gate exists to stop a reference nobody
 * can resolve, not to hold completions hostage to a read.
 *
 * So resolution FAILS OPEN on a read error and fails CLOSED on a real absence.
 * The declaration is still persisted either way, carrying `unresolved` so a later
 * audit (and P-011's detector) can tell which closes were never actually checked.
 */
export function isDanglingCondition(c: AssumptionCondition): boolean {
  return c === 'dangling';
}

/**
 * A declared entry, parsed. Either a BARE key (resolved relative to the closer's
 * scope set) or an ABSOLUTE `fact:<scope>:<ref>:<key>@v<N>` ref.
 *
 * The absolute form is deliberately the grammar {@link factCitationRef} already
 * EMITS and `classifyPremiseRef` already PARSES — D-079 R2. Minting a second
 * citation grammar is the near-synonym failure D-041 renamed to fix, and would
 * make every such ref degrade to `opaque` at the message layer.
 */
export interface ParsedAssumptionRef {
  /** Exactly what the caller typed, trimmed. */
  raw: string;
  key: string;
  /** Present only for an absolute ref. */
  scope: FactScope | null;
  scopeRef: string | null;
  /** The `@v<N>` pin, when one was given. */
  versionId: number | null;
  absolute: boolean;
}

const FACT_SCOPE_SET = new Set<string>(['workspace', 'role', 'owner', 'harness', 'work_item']);

/**
 * Parse one declared entry. PURE.
 *
 * Returns `null` only for an entry that OPENS with the `fact:` marker but is not
 * a well-formed ref — a caller who reached for the absolute grammar and mistyped
 * it must be told, not silently demoted to a bare key whose "key" is the whole
 * malformed string (which would then dangle with a baffling message).
 */
export function parseAssumptionRef(raw: string): ParsedAssumptionRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('fact:')) {
    return { raw: trimmed, key: trimmed, scope: null, scopeRef: null, versionId: null, absolute: false };
  }

  // fact:<scope>:<ref>:<key>[@v<N>]  — workspace carries no ref: fact:workspace:<key>
  let rest = trimmed.slice('fact:'.length);
  let versionId: number | null = null;
  const at = rest.lastIndexOf('@v');
  if (at >= 0) {
    const n = Number(rest.slice(at + 2));
    if (!Number.isInteger(n) || n <= 0) return null;
    versionId = n;
    rest = rest.slice(0, at);
  }

  const firstColon = rest.indexOf(':');
  if (firstColon <= 0) return null;
  const scope = rest.slice(0, firstColon);
  if (!FACT_SCOPE_SET.has(scope)) return null;
  const tail = rest.slice(firstColon + 1);
  if (!tail) return null;

  if (scope === 'workspace') {
    return { raw: trimmed, key: tail, scope: 'workspace', scopeRef: null, versionId, absolute: true };
  }
  // Every other scope is `<ref>:<key>`. The KEY may not contain ':' (facts:assert
  // keys are slugs), so split on the FIRST colon and let the ref keep any others
  // — an ownerId like `su-8d9a…` is colon-free, but a role/harness ref need not be.
  const lastColon = tail.lastIndexOf(':');
  if (lastColon <= 0) return null;
  const scopeRef = tail.slice(0, lastColon);
  const key = tail.slice(lastColon + 1);
  if (!scopeRef || !key) return null;
  return { raw: trimmed, key, scope: scope as FactScope, scopeRef, versionId, absolute: true };
}

/** One resolved assumption — what gets STAMPED onto the commitment record. */
export interface ResolvedAssumption {
  /** Exactly what the caller declared. Kept so the record shows the citation as
   *  typed, not only as normalized. */
  declared: string;
  /** The ABSOLUTE versioned ref this resolved to; null when dangling. */
  ref: string | null;
  key: string;
  scope: FactScope | null;
  scopeRef: string | null;
  versionId: number | null;
  condition: AssumptionCondition;
  /** A short quote of the fact body, so the record survives the expiry sweep. */
  excerpt?: string;
  /** The key matched in MORE THAN ONE scope; `ref` names the most-specific hit. */
  ambiguous?: boolean;
  /**
   * The resolved fact's own `kind` (EI-19298742806956600 / D-019's modality
   * discriminator) — null when the row never declared one, or when there is no
   * row (dangling / unresolved). Stamped here, not just resolved live, because
   * the fact this ref points at can be swept 30d past expiry (see the file
   * header) — after that only what was stamped on the close survives.
   */
  kind: FactKind | null;
  /** The resolved fact's `confidence` at resolution time; feeds the SAME legacy
   *  assumption test {@link isAssumptionFact} uses (`kind` absent, confidence
   *  `'suspected'`) — see `isAssumption` below. */
  confidence: FactConfidence | null;
  /**
   * Was this citation actually an ASSUMPTION (the unverified premise the field
   * exists to capture), per {@link isAssumptionFact}? `null` when there is no
   * row to judge (dangling / unresolved) — never coerced to `false`, because
   * "not an assumption" and "nothing to check" are different findings.
   *
   * ── WHY THIS EXISTS (EI-19298742806956600) ──────────────────────────────
   * The dangling-reference gate only ever checked that the cited key RESOLVES —
   * it never inspected `kind`, so a closer citing a `kind:'conclusion'`,
   * `confidence:'verified'` fact (the thing they already CONFIRMED, semantically
   * the opposite of an unverified premise) satisfies the gate exactly as well as
   * a real assumption. Measured live: 25/25 sampled citations were
   * verified conclusions, 0/25 were `kind:'assumption'`. This field makes that
   * distinguishable without a second ledger read, and {@link nonAssumptionKindAdvisory}
   * turns it into a WARN-ONLY signal (never a refusal — see that function's own
   * header for why tightening this into a refusal is deliberately NOT done yet).
   */
  isAssumption: boolean | null;
  /**
   * EI-21194879039423312 — the entry OPENED with `fact:` but was not a
   * well-formed ref ({@link parseAssumptionRef} returned null). Diagnostic only:
   * a caller who reached for the absolute grammar and mistyped it must be shown
   * the accepted forms, not told to "assert it first" as if the key were real.
   */
  malformed?: true;
  /**
   * Same-key facts that exist OUTSIDE what this close searched — found by the
   * dangling follow-up probe (same workspace partition, local hive), rendered
   * as absolute refs via {@link factCitationRef}. This is the hint whose absence
   * turned the Aug-22 refusal into a dead end: the closer cited the DISPLAYED
   * form of an existing fact, was told to "cite an absolute ref", and had no way
   * to learn where the fact actually lived.
   */
  nearMisses?: string[];
  /**
   * The workspace partition the search ran in, stamped on dangling entries so
   * the refusal names WHERE it looked instead of leaving "does not resolve"
   * ambiguous between scopes and tenants.
   */
  searchedWorkspace?: string;
}

/**
 * The scopes a closer's BARE key is resolved against, in PRECEDENCE order
 * (most specific first): the item being closed, then the closer, then their role,
 * then their harness, then the workspace.
 *
 * Most-specific-wins because a closer citing a bare key almost always means the
 * one THEY asserted; a workspace-wide fact that happens to share the slug is the
 * coincidence, not the intent. PURE — unit-tested without PG.
 */
export function assumptionSelectorsFor(ctx: {
  workItemId?: string | null;
  ownerId?: string | null;
  role?: string | null;
  harnessSlug?: string | null;
}): FactSelector[] {
  const out: FactSelector[] = [];
  const push = (scope: FactScope, ref: string | null | undefined) => {
    const r = (ref ?? '').trim();
    if (r) out.push({ scope, scopeRef: r });
  };
  push('work_item', ctx.workItemId);
  push('owner', ctx.ownerId);
  push('role', ctx.role);
  push('harness', ctx.harnessSlug);
  out.push({ scope: 'workspace', scopeRef: null });
  return out;
}

interface RawRow {
  id: string | number;
  scope: FactScope;
  scope_ref: string | null;
  key: string;
  body: string;
  retracted_at: string | null;
  superseded_at: string | null;
  expired: boolean;
  kind: string | null;
  confidence: string | null;
}

function excerptOf(body: string): string {
  const b = body.trim();
  return b.length <= FACT_PROVENANCE_QUOTE_CHARS ? b : `${b.slice(0, FACT_PROVENANCE_QUOTE_CHARS)}…`;
}

/**
 * Resolve every declared entry against the ledger.
 *
 * Reads the FULL history — retracted, expired and superseded rows included —
 * because `foldFacts` filters all three out and therefore cannot tell "lapsed"
 * from "never existed", which is the only distinction this gate turns on.
 *
 * LOCAL partition only (`source_hive IS NULL`), matching {@link factVersions}: a
 * foreign hive's fact with the same slug is not the one the closer asserted.
 */
export async function resolveAssumptions(
  declared: readonly string[],
  selectors: readonly FactSelector[],
  opts: { workspaceId?: string } = {},
  inject?: Sql,
): Promise<ResolvedAssumption[]> {
  const parsed = declared.map((d) => ({ declared: d.trim(), parsed: parseAssumptionRef(d) }));
  const keys = Array.from(
    new Set(parsed.map((p) => p.parsed?.key).filter((k): k is string => Boolean(k))),
  );
  if (keys.length === 0) {
    return parsed.map((p) => malformedOrDangling(p.declared, p.parsed));
  }

  // Absolute refs may name a scope OUTSIDE the closer's selector set — that is
  // the whole point of an absolute citation — so the read spans the union of both.
  const scopes = Array.from(
    new Set([
      ...selectors.map((s) => s.scope),
      ...parsed.map((p) => p.parsed?.scope).filter((s): s is FactScope => Boolean(s)),
    ]),
  );
  const refs = Array.from(
    new Set([
      ...selectors.map((s) => (s.scopeRef ?? '').trim()),
      ...parsed.map((p) => (p.parsed?.scopeRef ?? '').trim()),
    ]),
  );

  // The (scope, ref) pairs are matched EXACTLY in JS below; SQL takes the cheap
  // cross-product prefilter because the row set is tiny by construction (≤10
  // keys × FACTS_PER_SCOPE_CAP) and a dynamic tuple-IN buys nothing here.
  let rows: RawRow[];
  try {
    // Resolving the pool and the active workspace sit INSIDE the try alongside the
    // query: each can throw on its own (no configured org pg, no active workspace),
    // and every one of those is "could not consult the ledger", not "your key is a
    // dangling reference".
    const sql = inject ?? getOrgPg().sql;
    const ws = opts.workspaceId ?? activeWorkspaceId();
    rows = await sql<RawRow[]>`
      SELECT id, scope, scope_ref, key, body,
             retracted_at::text AS retracted_at,
             superseded_at::text AS superseded_at,
             (expires_at <= now()) AS expired,
             kind, confidence
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${ws}
         AND source_hive IS NULL
         AND key = ANY(${keys}::text[])
         AND scope = ANY(${scopes as string[]}::text[])
         AND coalesce(scope_ref,'') = ANY(${refs}::text[])
       ORDER BY id DESC`;
  } catch {
    // FAIL OPEN — see isDanglingCondition. A read that could not run says nothing
    // about whether these references exist, and refusing on it would make one PG
    // blip block every terminal close in the fleet.
    return parsed.map((p) => ({
      declared: p.declared,
      ref: null,
      key: p.parsed?.key ?? p.declared,
      scope: p.parsed?.scope ?? null,
      scopeRef: p.parsed?.scopeRef ?? null,
      versionId: p.parsed?.versionId ?? null,
      condition: 'unresolved' as const,
      kind: null,
      confidence: null,
      isAssumption: null,
    }));
  }

  const results = parsed.map((p) => resolveOne(p.declared, p.parsed, rows, selectors));

  // EI-21194879039423312 — a bare "does not resolve" is how the Aug-22 close
  // dead-ended: the caller cited an EXISTING fact's displayed form, was told to
  // "cite an absolute ref", and had nothing left to try. Stamp every dangle with
  // where the search ran, and probe the same partition for same-key rows living
  // outside the searched identities so the refusal can NAME them. Best-effort:
  // a probe failure changes no verdict (the main read above already decided).
  const dangles = results.filter((r) => r.condition === 'dangling');
  if (dangles.length > 0) {
    try {
      const probeSql = inject ?? getOrgPg().sql;
      const ws = opts.workspaceId ?? activeWorkspaceId();
      for (const d of dangles) d.searchedWorkspace = ws;
      const missKeys = Array.from(new Set(dangles.filter((d) => !d.malformed).map((d) => d.key)));
      if (missKeys.length > 0) {
        const near = await probeSql<Array<{ id: string | number; scope: FactScope; scope_ref: string | null; key: string }>>`
          SELECT id, scope, scope_ref, key
            FROM harness_shared.agent_facts
           WHERE workspace_id = ${ws}
             AND source_hive IS NULL
             AND key = ANY(${missKeys}::text[])
           ORDER BY id DESC`;
        const refsByKey = new Map<string, string[]>();
        for (const r of near) {
          const list = refsByKey.get(r.key) ?? [];
          if (list.length < 4) {
            list.push(factCitationRef({ scope: r.scope, scopeRef: r.scope_ref, key: r.key, id: Number(r.id) }));
          }
          refsByKey.set(r.key, list);
        }
        for (const d of dangles) {
          const hits = refsByKey.get(d.key);
          if (hits && hits.length > 0) d.nearMisses = hits;
        }
      }
    } catch {
      // Hints are best-effort — see the block comment above.
    }
  }
  return results;
}

function malformedOrDangling(declared: string, parsed: ParsedAssumptionRef | null): ResolvedAssumption {
  return {
    declared,
    ref: null,
    key: parsed?.key ?? declared,
    scope: parsed?.scope ?? null,
    scopeRef: parsed?.scopeRef ?? null,
    versionId: parsed?.versionId ?? null,
    condition: 'dangling',
    kind: null,
    confidence: null,
    isAssumption: null,
    malformed: parsed === null ? (true as const) : undefined,
  };
}

/** Build the `kind`/`confidence`/`isAssumption` triple for a resolved row — the
 *  one place that reads {@link isAssumptionFact}, so every construction site below
 *  agrees with the ledger's canonical predicate. */
function assumptionFieldsOf(row: RawRow): Pick<ResolvedAssumption, 'kind' | 'confidence' | 'isAssumption'> {
  const kind = parseKindColumn(row.kind);
  const confidence = parseConfidenceColumn(row.confidence);
  return { kind, confidence, isAssumption: isAssumptionFact({ kind, confidence }) };
}

function conditionOfRow(r: RawRow): AssumptionCondition {
  if (r.retracted_at) return 'retracted';
  if (r.expired) return 'lapsed';
  return 'live';
}

function resolveOne(
  declared: string,
  parsed: ParsedAssumptionRef | null,
  rows: readonly RawRow[],
  selectors: readonly FactSelector[],
): ResolvedAssumption {
  if (!parsed) return malformedOrDangling(declared, parsed);

  const matching = rows.filter((r) => r.key === parsed.key);

  // ── absolute ref: exactly one identity, possibly version-pinned ────────────
  if (parsed.absolute) {
    const ref = (parsed.scopeRef ?? '').trim();
    const identity = matching.filter(
      (r) => r.scope === parsed.scope && (r.scope_ref ?? '').trim() === ref,
    );
    if (identity.length === 0) return malformedOrDangling(declared, parsed);

    if (parsed.versionId != null) {
      const pinned = identity.find((r) => Number(r.id) === parsed.versionId);
      // A pinned version that is superseded — or that the version sweep already
      // reclaimed while the identity lives — is D-026 staleness, not a dangle.
      if (!pinned || pinned.superseded_at) {
        const current = identity.find((r) => !r.superseded_at) ?? identity[0];
        return {
          declared,
          ref: factCitationRef({ ...current, scopeRef: current.scope_ref, id: Number(current.id) }),
          key: parsed.key,
          scope: current.scope,
          scopeRef: current.scope_ref,
          versionId: Number(current.id),
          condition: 'superseded',
          excerpt: excerptOf(current.body),
          ...assumptionFieldsOf(current),
        };
      }
      return {
        declared,
        ref: factCitationRef({ ...pinned, scopeRef: pinned.scope_ref, id: Number(pinned.id) }),
        key: parsed.key,
        scope: pinned.scope,
        scopeRef: pinned.scope_ref,
        versionId: Number(pinned.id),
        condition: conditionOfRow(pinned),
        excerpt: excerptOf(pinned.body),
        ...assumptionFieldsOf(pinned),
      };
    }

    const current = identity.find((r) => !r.superseded_at) ?? identity[0];
    return {
      declared,
      ref: factCitationRef({ ...current, scopeRef: current.scope_ref, id: Number(current.id) }),
      key: parsed.key,
      scope: current.scope,
      scopeRef: current.scope_ref,
      versionId: Number(current.id),
      condition: conditionOfRow(current),
      excerpt: excerptOf(current.body),
      ...assumptionFieldsOf(current),
    };
  }

  // ── bare key: most-specific scope wins (D-079 R2) ──────────────────────────
  let chosen: RawRow | undefined;
  let hitScopes = 0;
  for (const sel of selectors) {
    const ref = sel.scope === 'workspace' ? '' : (sel.scopeRef ?? '').trim();
    const inScope = matching.filter(
      (r) => r.scope === sel.scope && (r.scope_ref ?? '').trim() === ref,
    );
    if (inScope.length === 0) continue;
    hitScopes += 1;
    if (!chosen) chosen = inScope.find((r) => !r.superseded_at) ?? inScope[0];
  }
  if (!chosen) return malformedOrDangling(declared, parsed);

  return {
    declared,
    ref: factCitationRef({ ...chosen, scopeRef: chosen.scope_ref, id: Number(chosen.id) }),
    key: parsed.key,
    scope: chosen.scope,
    scopeRef: chosen.scope_ref,
    versionId: Number(chosen.id),
    condition: conditionOfRow(chosen),
    excerpt: excerptOf(chosen.body),
    ...assumptionFieldsOf(chosen),
    ...(hitScopes > 1 ? { ambiguous: true } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RE-CHECK (WI-6465, per D-102)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a declared basis stands NOW, re-checked against the ledger long after the
 * close that declared it.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A NEW PRODUCER ───────────────────────
 *
 * D-102 settled WI-6465: the assumption vertical's missing piece was never a
 * producer. {@link resolveDeclaredAssumptions} ALREADY writes a fully-resolved,
 * version-pinned edge (`fact:<scope>:<ref>:<key>@vN`) onto every terminal close.
 * What had never existed is anything that re-resolves it.
 *
 * That gap is exactly the hazard D-050 collected the field for: *"a terminal
 * close removes the item from the shared queue, so an assumption that was wrong
 * leaves with it."* Measured on the live corpus the day this landed: of 30
 * declared bases across 29 closes, **5 had already moved** (2 superseded, 4
 * retracted, 1 both) — every one of them under a closed item nobody would
 * re-read.
 *
 * ⚠ THE COMPARISON MUST USE THE STORED ABSOLUTE PINNED REF, NEVER THE BARE
 * `declared` STRING. A bare key is meaningful only relative to the CLOSER's own
 * scope set (see {@link assumptionSelectorsFor}), and that context is gone once
 * the item leaves the queue — re-resolving it later against a different agent's
 * selectors silently answers a question about a different fact. Stamping the
 * absolute ref is precisely what D-079 did it for.
 */
export const BASIS_MOVEMENTS = [
  /** Same version, live, not retracted. The ground has not moved. */
  'unchanged',
  /** A newer version of the same identity exists — the content was revised. */
  'superseded',
  /** The identity was retracted outright. */
  'retracted',
  /** Still the pinned version, but it has aged out of folds. */
  'lapsed',
  /** The identity is gone from the ledger entirely (swept 30d past expiry): only
   *  the stamped excerpt survives, so the basis can no longer be verified. */
  'vanished',
  /** No pin to compare against — a declaration predating the version stamp.
   *  NEVER folded into `unchanged`: "we cannot tell" is not "nothing moved". */
  'undeterminable',
] as const;
export type BasisMovement = (typeof BASIS_MOVEMENTS)[number];

/** One stored declaration, paired with the ledger's CURRENT state of the same
 *  identity. The shape the re-check compares — deliberately free of PG types so
 *  the classification below is unit-testable without a database. */
export interface DeclaredBasisRow {
  /** The condition resolution recorded AT CLOSE TIME. */
  conditionAtClose: AssumptionCondition | null;
  /** The version the close pinned. */
  pinnedVersion: number | null;
  /** Newest version of that identity now; null when the identity is gone. */
  currentVersion: number | null;
  retractedNow: boolean;
  expiredNow: boolean;
}

/**
 * Classify one declared basis. PURE.
 *
 * ORDER IS THE DESIGN: a reader is told the STRONGEST news about the basis, not
 * the first true thing. A fact that was revised and then retracted is reported
 * `retracted`, because "this claim was withdrawn" strictly dominates "this claim
 * changed" for someone deciding whether to re-open a closed item. Likewise
 * `superseded` outranks `lapsed`: revised content is a stronger signal than the
 * same content merely ageing out of folds.
 */
export function classifyBasisMovement(row: DeclaredBasisRow): BasisMovement {
  if (row.currentVersion == null) return 'vanished';
  if (row.retractedNow) return 'retracted';
  // A declaration with no pin cannot be compared at all. Checked AFTER the two
  // verdicts above because those hold regardless of the pin — an identity that
  // vanished or was retracted is news even for an unpinned declaration.
  if (row.pinnedVersion == null) return 'undeterminable';
  if (row.currentVersion > row.pinnedVersion) return 'superseded';
  if (row.expiredNow) return 'lapsed';
  return 'unchanged';
}

/** True when the basis is no longer what the close rested on. `undeterminable`
 *  is excluded BY CONSTRUCTION — counting an uncomparable row as unmoved would
 *  convert missing data into a clean bill of health, which is the failure mode
 *  the sibling staleness metric already names as its own. */
export function basisHasMoved(m: BasisMovement): boolean {
  return m !== 'unchanged' && m !== 'undeterminable';
}

/**
 * The conditions that mean the closer was ALREADY resting on something
 * not-current AT THE MOMENT IT CLOSED — a strictly different question from
 * {@link basisHasMoved}, and D-102 forbids fusing them: a basis a PEER revised
 * after the close says nothing about the closer's diligence, while one that was
 * already superseded when they cited it does.
 *
 * `unresolved` is excluded: the ledger could not be consulted at close time (see
 * {@link isDanglingCondition}), so it is missing data, not a stale citation.
 */
export function wasStaleAtDeclaration(c: AssumptionCondition | null): boolean {
  return c === 'superseded' || c === 'retracted' || c === 'lapsed';
}

/** True when a close-time condition supports a verdict either way. Mirrors the
 *  exclusion above so the numerator and denominator cannot drift apart. */
export function isComparableAtDeclaration(c: AssumptionCondition | null): boolean {
  return c != null && c !== 'unresolved' && c !== 'dangling';
}

/**
 * The refusal a commitment gets when one or more declared assumptions do not
 * resolve. Shared so `work_items:set_state` and `work_items:complete` refuse
 * IDENTICALLY — D-050: "a half-verification that resolves on one tool and not
 * the other is worse than none."
 */
export function danglingAssumptionsMessage(
  dangling: readonly ResolvedAssumption[],
  selectors: readonly FactSelector[],
): string {
  const names = dangling.map((d) => `"${d.declared}"`).join(', ');
  const scopes = selectors
    .map((s) => (s.scope === 'workspace' ? 'workspace' : `${s.scope}:${(s.scopeRef ?? '').trim()}`))
    .join(', ');
  const wsNames = Array.from(
    new Set(dangling.map((d) => d.searchedWorkspace).filter((w): w is string => Boolean(w))),
  );
  const searched = wsNames.length > 0 ? ` (workspace partition: ${wsNames.join(', ')})` : '';
  const parts: string[] = [
    `assumption ${dangling.length === 1 ? 'key' : 'keys'} ${names} ${dangling.length === 1 ? 'does' : 'do'} ` +
      `not resolve to any fact — searched ${scopes}${searched}.`,
    // EI-21194879039423312 — the grammar spelled out, because an unexposed
    // syntax reads as a REJECTED one: the Aug-22 closer cited the exact
    // displayed form of an existing fact, got the same refusal, and concluded
    // their citation SHAPE was the problem.
    'Accepted citation forms: a BARE facts:assert key ("my-fact-key"); or an ABSOLUTE ref ' +
      '`fact:<scope>:[<ref>:]<key>[@v<factRowId>]` — workspace scope carries NO ref segment ' +
      '(`fact:workspace:<key>`), every other scope is `fact:<scope>:<ref>:<key>`, and the optional ' +
      '`@v<N>` pins fact row id N exactly as facts:list and a stamped ref display it.',
  ];
  for (const d of dangling) {
    if (d.malformed) {
      parts.push(
        `"${d.declared}" opens with fact: but is not a well-formed ref — compare it against the ` +
          'forms above (scopes: workspace, role, owner, harness, work_item).',
      );
    } else if (d.nearMisses && d.nearMisses.length > 0) {
      parts.push(
        `"${d.declared}": a fact with this key EXISTS at ${d.nearMisses.map((r) => `\`${r}\``).join(', ')} — ` +
          'outside what this close searched. Cite one of those refs verbatim, or re-assert the fact ' +
          'into your own scopes with facts:assert.',
      );
    } else if (d.searchedWorkspace) {
      parts.push(`"${d.declared}" has no row at all in workspace ${d.searchedWorkspace} (local hive).`);
    }
  }
  parts.push(
    'A reference nobody can resolve is laundering (D-050/D-079): assert it first with ' +
      'facts:assert { scope, key, body, kind:"assumption" }, cite an absolute ref from the accepted ' +
      'forms above if it lives outside your own scopes, or pass "none" if this close rests on nothing ' +
      'you recorded. An EXPIRED or RETRACTED key still resolves — only a key that never existed is refused.',
  );
  return parts.join(' ');
}

/**
 * WARN-ONLY advisory (EI-19298742806956600) for a declaration that RESOLVES —
 * so `danglingAssumptionsMessage` never fires for it — but cites a fact that was
 * never asserted as an assumption. Never refuses: see this repo's own finding for
 * why tightening this into a refusal today would be strictly worse than doing
 * nothing (a producer population of 3 assumption-kind facts fleet-wide, against
 * 45 commitment-class closes that cited a real key in the sampled window — a hard
 * `kind:'assumption'` requirement would turn every one of those into a `"none"`
 * declarer, the opposite of the behaviour D-050 wants to encourage). This is
 * candidate fix (1) from that finding: measure + nudge, don't refuse yet.
 *
 * Only fires for entries that actually resolved to a fact (`isAssumption` is a
 * real `false`, not `null` — a dangling/unresolved entry has nothing to judge and
 * is `danglingAssumptionsMessage`'s problem, not this one's).
 */
export function nonAssumptionKindAdvisory(resolved: readonly ResolvedAssumption[]): string | undefined {
  const cited = resolved.filter((r) => r.isAssumption === false);
  if (cited.length === 0) return undefined;
  const names = cited
    .map((r) => `"${r.declared}" (kind:${r.kind ?? 'none'}${r.confidence ? `, confidence:${r.confidence}` : ''})`)
    .join(', ');
  return (
    `assumptions cites ${names} — that resolves fine, but the fact itself was never asserted as an ` +
    `assumption (kind:"assumption", or the legacy confidence:"suspected" form). An assumption is the ` +
    'UNVERIFIED premise that would invalidate this close if it turned out wrong; citing an already-verified ' +
    'conclusion here carries none of that risk and will not auto-invalidate if the ground moves later. If ' +
    'this really is a premise you have not independently verified, consider re-asserting it with ' +
    'facts:assert { kind:"assumption", dependsOn:[...] } and citing that instead. This is advisory only — ' +
    'the close is not blocked.'
  );
}
