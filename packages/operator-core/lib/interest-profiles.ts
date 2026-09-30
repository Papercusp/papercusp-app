/* ══════════════════════════════════════════════════════════════════════════════
 * INTEREST PROFILES — what an agent in a given CONTEXT should be watching.
 *
 * P-010 of state-plane-interest-and-hardening-2026-08-21.
 *
 * ── WHY THIS IS A SEPARATE MODULE, NOT MORE FIELDS ON CellSpec ────────────────
 * Interest is a property of the READER, not of the cell. `gate.greenCheckpoint.verdict`
 * is the same cell whether a fleet leader or an item holder reads it; what differs is
 * whether they should be folded it, suggested it, or auto-armed on it. Pushing that
 * onto CellSpec would widen an interface whose axes are ratified, and would say
 * nothing at all about EVENTS, which are half of what an agent watches.
 *
 * So this follows the cell-transcription-detector precedent: declared data as a
 * module-scope readonly array, co-located with the registry it references.
 *
 * ── ⚠ THESE ROWS ARE DECLARED INTENT, NOT MEASURED DEMAND ─────────────────────
 * Every `why` below traces to an instruction the system ALREADY gives agents (the
 * su persona's leader-monitor mandate, its member operating loop, and CLAUDE.md's
 * "is my change live" guidance). None of them is justified by observed reads, and
 * this file must not be described as demand-driven.
 *
 * The measurement, recorded here so nobody re-derives it and reaches the opposite
 * conclusion: across all retained telemetry only 13 distinct cell names are read via
 * `state:read`. Of the 5 unregistered names, 2 are deliberate probes and 1 is a
 * truncated-name typo; the only genuine reaches for something unregistered are
 * `host.load` (2 callers) and `release.gate` (1), over 14 days. That is noise-level,
 * not demand. Existing read volume is therefore evidence about ADOPTION, and cannot
 * be used to argue that any row below is or is not wanted.
 *
 * ── HOW DRIFT IS PREVENTED (two different mechanisms, deliberately) ───────────
 * CELL references are imported CONSTANTS (`GATE_VERDICT_CELL.cell`), never retyped
 * string literals. This is the rule AGENT_GOAL_CELL states in its own comment: a
 * hand-typed id that drifts from the registry's fails SILENTLY, because `getCell`
 * simply returns undefined and the surface discloses nothing, forever. Importing the
 * const moves that whole failure class to compile time.
 *
 * EVENT references cannot get the same treatment — a family is a catalog string —
 * so they are covered at runtime by interest-profiles.test.ts, which also re-checks
 * the cells for the one thing the compiler cannot know: whether the spec is actually
 * REGISTERED, as opposed to merely defined.
 * ══════════════════════════════════════════════════════════════════════════════ */

import {
  BUILTIN_CELLS,
  DEPLOYED_SHA_CELL,
  GATE_VERDICT_CELL,
  GIT_PIPELINE_POSITION_CELL,
  HOST_MEMORY_PRESSURE_CELL,
} from './cell-registrations';
import {
  buildKey,
  catalogEntry,
  findRequiredParamPrefixMatch,
  findZeroParamSuffixMismatch,
  keyMatchesCatalog,
} from './events/await/catalog';
import type { PredicateOp } from './events/await/predicate-watch';
import type { ExternalBlockerRecord } from './external-blockers';

/**
 * The role an agent is occupying when the interest applies. An agent can occupy
 * several at once (a fleet leader is usually also an item holder); profiles are
 * additive, never exclusive.
 */
export type InterestContext =
  | 'fleet-leader'
  | 'fleet-member'
  | 'plan-holder'
  | 'item-holder'
  | 'blocked-item-holder'
  | 'claim-holder'
  | 'answer-requester'
  | 'owner-present';

/**
 * How strongly the system should act on the interest.
 *
 * - `fold`     — include the current value in what the agent is already being handed
 *                (an orient/brief fold). Costs a read, never a turn.
 * - `suggest`  — surface it as a recommendation the agent may act on.
 * - `auto-arm` — register the watch on the agent's behalf. Costs a turn when it
 *                fires, so it is reserved for conditions that genuinely need one.
 */
export type InterestTier = 'fold' | 'suggest' | 'auto-arm';

/**
 * Existing legs of the owner's canonical plans:attention surface that are owned
 * by the owner-present interest context (P-025 / D-019). This is a closed list on
 * purpose: a profile typo must fail validation instead of silently selecting no
 * source, and attention.ts must opt a new leg in here before it can claim registry
 * ownership.
 */
export const OWNER_ATTENTION_SOURCES = [
  'needs-human-work-items',
  'owner-walls',
  'open-owner-questions',
  'open-owner-escalations',
  'pending-owner-gates',
] as const;

export type OwnerAttentionSource = (typeof OWNER_ATTENTION_SOURCES)[number];

/**
 * What is being watched. A discriminated union rather than the bare
 * `cell id | event key` string the plan item described, because each variant
 * validates against a different registry and must fail closed on a typo.
 */
export type InterestWatch =
  | { readonly kind: 'cell'; readonly cell: string }
  | { readonly kind: 'event'; readonly family: string }
  | {
      /**
       * A source leg rendered by the owner's existing interactive attention
       * surface. The plans:attention invocation itself is the owner-presence
       * signal; this variant never creates a watch, wake, poll, or copied queue.
       */
      readonly kind: 'owner-attention';
      readonly source: OwnerAttentionSource;
    };

/** A predicate, reusing the state:subscribe / events:watch comparator vocabulary. */
export interface InterestCondition {
  readonly op: PredicateOp;
  readonly value?: unknown;
}

export interface InterestProfileRow {
  /** Who this interest belongs to. */
  readonly context: InterestContext;
  /** The cell or event family being watched. */
  readonly watch: InterestWatch;
  /** How strongly to act on it. */
  readonly tier: InterestTier;
  /**
   * The predicate that makes the watch fire. Required for an `auto-arm` CELL row —
   * `state:subscribe` cannot arm without one — and forbidden on a `fold` row, which
   * has nothing to trigger. An `auto-arm` EVENT row needs none: the emit IS the edge.
   */
  readonly on?: InterestCondition;
  /**
   * Names of the fields in the agent's own context that supply the watch's subject,
   * in order.
   *
   * For an EVENT, these fill the family's key params — and a row MUST name one per
   * REQUIRED param. That is not bookkeeping: `buildKey` on a family whose params are
   * unresolved produces a key nothing ever emits, so the waiter sleeps forever and
   * silently, which is the exact hazard predicate-watch documents.
   *
   * For a CELL, it names the caller-relative subject (the `as` argument) — several
   * cells answer about a different subject, or refuse to answer at all, without it.
   */
  readonly of?: readonly string[];
  /** Why this context should care. Traces to an existing instruction — see header. */
  readonly why: string;
}

/**
 * One opt-in watch recommendation.  The object is deliberately the exact next
 * tool call plus its rationale: accepting it is one call, while merely receiving
 * it has no side effect.
 */
export type SuggestedWatch =
  | {
      readonly tool: 'state:subscribe';
      readonly args: {
        readonly cell: string;
        readonly on?: InterestCondition;
        readonly as?: string;
        readonly note: string;
      };
      readonly why: string;
    }
  | {
      readonly tool: 'events:await';
      readonly args: {
        readonly event: string;
        readonly note: string;
      };
      readonly why: string;
    };

function suggestionNote(reason: string, why: string): string {
  return `${reason}: ${why}`;
}

function dedupeSuggestedWatches(rows: readonly SuggestedWatch[]): SuggestedWatch[] {
  return [...new Map(rows.map((row) => [`${row.tool}:${JSON.stringify(row.args)}`, row])).values()];
}

/**
 * Resolve the `suggest` rows for one live context into calls that can be invoked
 * verbatim. Missing runtime subjects omit the affected row rather than returning
 * a malformed key/cell call: a suggestion that cannot be accepted is not a
 * suggestion.
 */
export function suggestedWatchesForContext(input: {
  context: InterestContext;
  subjects?: Readonly<Record<string, string | undefined>>;
  reason: string;
  rows?: readonly InterestProfileRow[];
}): SuggestedWatch[] {
  const subjects = input.subjects ?? {};
  const rows = (input.rows ?? INTEREST_PROFILES).filter(
    (row) => row.context === input.context && row.tier === 'suggest',
  );
  const suggestions: SuggestedWatch[] = [];

  for (const row of rows) {
    const note = suggestionNote(input.reason, row.why);
    if (row.watch.kind === 'cell') {
      const subjectField = row.of?.[0];
      const subject = subjectField ? subjects[subjectField] : undefined;
      if (subjectField && !subject) continue;
      suggestions.push({
        tool: 'state:subscribe',
        args: {
          cell: row.watch.cell,
          ...(row.on ? { on: row.on } : {}),
          ...(subject ? { as: subject } : {}),
          note,
        },
        why: row.why,
      });
      continue;
    }

    if (row.watch.kind !== 'event') continue;
    const entry = catalogEntry(row.watch.family);
    if (!entry) continue; // validateInterestProfiles catches registry drift; never emit a dead call here.
    const params: Record<string, string | undefined> = {};
    let complete = true;
    entry.params.forEach((param, index) => {
      const field = row.of?.[index];
      const value = field ? subjects[field] : undefined;
      if (param.required && !value) complete = false;
      params[param.name] = value;
    });
    if (!complete) continue;
    suggestions.push({
      tool: 'events:await',
      args: { event: buildKey(row.watch.family, params), note },
      why: row.why,
    });
  }

  return dedupeSuggestedWatches(suggestions);
}

function isConcreteCatalogEvent(key: string): boolean {
  return (
    keyMatchesCatalog(key) &&
    !findRequiredParamPrefixMatch(key) &&
    !findZeroParamSuffixMismatch(key)
  );
}

/**
 * P-016's claim-time mapping. A typed event blocker already names the exact
 * event to await. A gate blocker borrows the item-holder gate profile's rationale:
 * when its ref is a real catalog key (the canonical case is
 * `release:green:<pipeline>`) the exact event await wins; legacy/free-form gate
 * refs fall back to the profile's gate cell subscription instead of inventing a
 * key that nothing emits.
 */
export function suggestedWatchesForItemBlockers(input: {
  itemId: string;
  blockers: readonly ExternalBlockerRecord[] | null | undefined;
  rows?: readonly InterestProfileRow[];
}): SuggestedWatch[] {
  const active = (input.blockers ?? []).filter((blocker) => blocker.status === 'active');
  if (active.length === 0) return [];

  const rows = input.rows ?? INTEREST_PROFILES;
  const gateProfile = rows.find(
    (row) =>
      row.context === 'item-holder' &&
      row.tier === 'suggest' &&
      row.watch.kind === 'cell' &&
      row.watch.cell === GATE_VERDICT_CELL.cell,
  );
  const suggestions: SuggestedWatch[] = [];

  for (const blocker of active) {
    if (blocker.kind === 'event' && isConcreteCatalogEvent(blocker.ref)) {
      const why = blocker.summary || `Work-item ${input.itemId} is blocked on ${blocker.ref}`;
      suggestions.push({
        tool: 'events:await',
        args: { event: blocker.ref, note: suggestionNote(`Because ${input.itemId} is blocked`, why) },
        why,
      });
      continue;
    }
    if (blocker.kind !== 'gate' || !gateProfile) continue;

    if (isConcreteCatalogEvent(blocker.ref)) {
      suggestions.push({
        tool: 'events:await',
        args: {
          event: blocker.ref,
          note: suggestionNote(`Because ${input.itemId} is gate-blocked`, gateProfile.why),
        },
        why: gateProfile.why,
      });
    } else {
      suggestions.push(
        ...suggestedWatchesForContext({
          context: 'item-holder',
          reason: `Because ${input.itemId} is gate-blocked (${blocker.ref})`,
          rows: [gateProfile],
        }),
      );
    }
  }

  return dedupeSuggestedWatches(suggestions);
}

/**
 * THE registry. Order is display order, grouped by context.
 *
 * ⚠ Adding a row is cheap; adding an `auto-arm` row is not — it spends one of the
 * agent's turns every time it fires. Default to `fold`, and reserve `auto-arm` for a
 * condition where a late reaction has a real cost.
 */
export const INTEREST_PROFILES: readonly InterestProfileRow[] = [
  // ── fleet-leader ───────────────────────────────────────────────────────────
  // The persona tells a leader to PARK on the fleet's transition events rather than
  // re-read state on a timer, because the payload names WHICH member changed — which
  // no poll can tell you — and arrives when it happens rather than up to an interval late.
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-member-dead' },
    tier: 'auto-arm',
    of: ['fleet.slug'],
    why: 'A dead member strands whatever it claimed. Only a running leader relaunches it, and every wake spent not knowing is a lane sitting idle — this is the single failure the leader-monitor mandate exists to catch.',
  },
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-member-left' },
    tier: 'auto-arm',
    of: ['fleet.slug'],
    why: 'A cleanly departed, non-wakeable member can still hold claims; the leader must inspect assignments before deciding whether any work is reclaimable.',
  },
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-drained' },
    tier: 'auto-arm',
    of: ['fleet.slug'],
    why: "The drain edge is the leader's own loop:end condition. Discovering it a interval late keeps a finished fleet burning wakes.",
  },
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-member-stalled' },
    tier: 'suggest',
    of: ['fleet.slug'],
    why: 'A stalled member is indistinguishable from a slow one without looking; surfacing it lets the leader bench the lane instead of waiting on it.',
  },
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-context-critical' },
    tier: 'auto-arm',
    of: ['fleet.slug'],
    why: 'A member near its context ceiling is about to lose state. The leader can have it checkpoint before that happens rather than after.',
  },
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-claim-released' },
    tier: 'auto-arm',
    of: ['fleet.slug'],
    why: 'A released claim is work that just became re-placeable; folding it into the leader brief is what makes reclaiming orphans a read rather than a sweep.',
  },
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-admission-blocked' },
    tier: 'auto-arm',
    of: ['fleet.slug'],
    why: 'An admission refusal means the fleet cannot place work under its current claim spec. The leader owns revising that spec or placement before the lane silently starves.',
  },
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-item-completed' },
    tier: 'fold',
    of: ['fleet.slug'],
    why: 'Burn-down delta. Cheap to fold, and it is the number the leader reports; waking a turn for it would not be.',
  },

  // ── fleet-member ───────────────────────────────────────────────────────────
  {
    context: 'fleet-member',
    watch: { kind: 'event', family: 'work-item-claimable' },
    tier: 'auto-arm',
    why: 'The member operating loop mandates exactly ONE park on this key when the lane drains, so the pool refilling re-wakes the member instead of it burning empty scheduler polls. The key is global and the payload carries the discriminator, so the wake is a HINT — scheduler:get_next on the wake turn stays the authoritative claim.',
  },

  // ── plan-holder ────────────────────────────────────────────────────────────
  {
    context: 'plan-holder',
    watch: { kind: 'cell', cell: GATE_VERDICT_CELL.cell },
    tier: 'fold',
    why: 'A red gate blocks promotion for every item in the plan at once, so it is the plan holder\'s problem before it is any single item\'s. Folded rather than armed because the holder should learn it on the next read, not be woken per flip.',
  },
  {
    context: 'plan-holder',
    watch: { kind: 'event', family: 'plan-item' },
    tier: 'suggest',
    of: ['plan.slug', 'planItem.id'],
    why: 'The done edge on a specific item is what unblocks dependents. Both key params are required, which is why two context fields are named — a family this parameterized is precisely where an unresolved key would strand a waiter silently.',
  },

  // ── item-holder ────────────────────────────────────────────────────────────
  {
    context: 'item-holder',
    watch: { kind: 'cell', cell: GATE_VERDICT_CELL.cell },
    tier: 'suggest',
    on: { op: 'changed' },
    why: 'CLAUDE.md makes greening a red gate the job of whoever it blocks, not a queue to wait in. Suggesting the verdict on change is what turns that from a rule an agent must remember into one it is reminded of.',
  },
  {
    context: 'item-holder',
    watch: { kind: 'cell', cell: DEPLOYED_SHA_CELL.cell },
    tier: 'suggest',
    on: { op: 'changed' },
    why: 'A change is not live until the serving sha moves. This is the cell that answers it; the deployed position tick is a git fact and does not.',
  },
  {
    context: 'item-holder',
    watch: { kind: 'cell', cell: GIT_PIPELINE_POSITION_CELL.cell },
    tier: 'fold',
    of: ['workItem.primaryPath'],
    why: 'Answers "is my edit live, and if not the ONE lever" in a single read. It is per-path: without the subject it reports about a different one, which is why the path is named here rather than left to the caller.',
  },
  {
    context: 'item-holder',
    watch: { kind: 'cell', cell: HOST_MEMORY_PRESSURE_CELL.cell },
    tier: 'fold',
    why: 'Host pressure is the standard false explanation for a slow or flaky run. Folding the measured value lets an agent check the claim instead of asserting it — the persona forbids blaming load without the mechanism.',
  },

  // ── P-024 narrow auto-arm widening (D-018) ─────────────────────────────────
  {
    context: 'blocked-item-holder',
    watch: { kind: 'event', family: 'work-item-done' },
    tier: 'auto-arm',
    of: ['blocker.id'],
    why: 'A named blocker settling is the concrete edge that can make this held item actionable again; missing it strands an already-owned lane behind a dependency that no longer exists.',
  },
  {
    context: 'blocked-item-holder',
    watch: { kind: 'event', family: 'work-item-unblocked' },
    tier: 'auto-arm',
    of: ['workItem.id'],
    why: 'The dependent unblocked edge proves its last live blocker cleared. Waking only that holder avoids polling every dependency and avoids waking on partial progress.',
  },
  {
    context: 'claim-holder',
    watch: { kind: 'event', family: 'claim-released' },
    tier: 'auto-arm',
    of: ['workItem.id'],
    why: 'A claim disappearing through release, reaping, or reassignment changes who owns the lane; the prior holder must not continue working under a silently stale claim.',
  },
  {
    context: 'answer-requester',
    watch: { kind: 'event', family: 'conversation-answered' },
    tier: 'auto-arm',
    of: ['conversation.id'],
    why: 'A concrete answer resolves the requester\'s decision edge. Auto-arming that one request avoids hidden polling without subscribing the requester to unrelated conversations.',
  },
  {
    context: 'answer-requester',
    watch: { kind: 'event', family: 'escalation-resolved' },
    tier: 'auto-arm',
    of: ['escalation.id'],
    why: 'An escalation resolution is the exact edge the requester needs to resume; binding one await to that escalation keeps the wake attributable and lifecycle-scoped.',
  },

  // ── owner-present (P-025 / D-019) ─────────────────────────────────────────
  // plans:attention is already the canonical owner Inbox and selected-session
  // pending-question substrate. These rows select its existing source legs; they
  // do not create another delivery system. Fold = ambient queue/wall content in
  // that surface. Suggest = an explicit pending ask/escalation worth foregrounding.
  {
    context: 'owner-present',
    watch: { kind: 'owner-attention', source: 'needs-human-work-items' },
    tier: 'fold',
    why: 'Needs-human work-items are already the typed owner-gated queue. Folding that existing source into the owner surface makes the queue visible without an agent re-broadcasting it.',
  },
  {
    context: 'owner-present',
    watch: { kind: 'owner-attention', source: 'owner-walls' },
    tier: 'fold',
    why: 'Registered carry-note walls are the durable record of work waiting on the owner. Folding the existing source prevents those walls from depending on an agent status report being seen.',
  },
  {
    context: 'owner-present',
    watch: { kind: 'owner-attention', source: 'open-owner-questions' },
    tier: 'suggest',
    why: 'An open owner question has an explicit answer disposition. Suggesting the existing conversation source foregrounds that pending ask without manufacturing a wake.',
  },
  {
    context: 'owner-present',
    watch: { kind: 'owner-attention', source: 'open-owner-escalations' },
    tier: 'suggest',
    why: 'An unresolved owner escalation is a directed request for intervention. Suggesting the existing escalation source keeps it actionable in the owner surface without another transport.',
  },
  {
    context: 'owner-present',
    watch: { kind: 'owner-attention', source: 'pending-owner-gates' },
    tier: 'suggest',
    why: 'A pending session gate is the client-agnostic backstop for an owner ask. Suggesting the existing gate source keeps blocked sessions visible without polling or waking the owner.',
  },
];

/** Rows that apply to a given context. */
export function interestProfilesFor(context: InterestContext): InterestProfileRow[] {
  return INTEREST_PROFILES.filter((row) => row.context === context);
}

/**
 * The plans:attention source legs selected by a live context. Dedupe preserves
 * registry order so a repeated row cannot cause a source to execute twice.
 */
export function ownerAttentionSourcesFor(
  context: InterestContext,
  rows: readonly InterestProfileRow[] = INTEREST_PROFILES,
): OwnerAttentionSource[] {
  return [
    ...new Set(
      rows.flatMap((row) =>
        row.context === context && row.watch.kind === 'owner-attention' ? [row.watch.source] : [],
      ),
    ),
  ];
}

export type InterestProfileRule =
  | 'unregistered-cell'
  | 'unknown-event-family'
  | 'auto-arm-cell-without-predicate'
  | 'fold-with-predicate'
  | 'unresolved-required-params'
  | 'unknown-owner-attention-source'
  | 'owner-attention-auto-arm'
  | 'owner-attention-with-condition'
  | 'owner-attention-with-subject';

export interface InterestProfileViolation {
  readonly rule: InterestProfileRule;
  readonly row: InterestProfileRow;
  /** What is wrong, and where the remedy is. */
  readonly detail: string;
}

/**
 * Validate profile rows against the live cell registry and event catalog.
 *
 * Takes `rows` rather than reading INTEREST_PROFILES directly so the test can run
 * this exact logic against deliberately-wrong control rows and prove each rule CAN
 * fail. A guard that has only ever been run against known-good data is not a guard,
 * and the alternative — mutating the real registry to prove it — is unsafe on a
 * swept shared tree.
 *
 * ⚠ Every rule PUSHES. Rules are independent, never else-if chained: a row can
 * violate several at once and a caller is entitled to see all of them, exactly as
 * validateCellSpec reports its full rejection set.
 */
export function validateInterestProfiles(
  rows: readonly InterestProfileRow[],
): InterestProfileViolation[] {
  const violations: InterestProfileViolation[] = [];
  const registered = new Set(BUILTIN_CELLS.map((spec) => spec.cell));

  for (const row of rows) {
    if (row.watch.kind === 'cell') {
      const { cell } = row.watch;
      if (!registered.has(cell)) {
        violations.push({
          rule: 'unregistered-cell',
          row,
          detail: `cell '${cell}' is not in BUILTIN_CELLS. A profile pointing at an unregistered cell resolves to undefined and discloses nothing, silently — add the cell to cell-registrations.ts or drop the row.`,
        });
      }
      if (row.tier === 'auto-arm' && !row.on) {
        violations.push({
          rule: 'auto-arm-cell-without-predicate',
          row,
          detail: `cell '${cell}' is auto-arm but declares no 'on'. state:subscribe cannot arm without a predicate, so this row would silently never fire.`,
        });
      }
    } else if (row.watch.kind === 'event') {
      const { family } = row.watch;
      const entry = catalogEntry(family);
      if (!entry) {
        violations.push({
          rule: 'unknown-event-family',
          row,
          detail: `event family '${family}' is not in EVENT_CATALOG. events:await patterns are EXACT-match, so a key built from an unknown family never fires and the waiter sleeps forever.`,
        });
      } else {
        const required = entry.params.filter((p) => p.required);
        const supplied = row.of?.length ?? 0;
        if (supplied < required.length) {
          violations.push({
            rule: 'unresolved-required-params',
            row,
            detail: `event family '${family}' requires ${required.length} key param(s) (${required
              .map((p) => p.name)
              .join(', ')}) but 'of' names ${supplied} context field(s). An unresolved key param produces a key nothing emits — a silent forever-wait.`,
          });
        }
      }
    } else {
      const { source } = row.watch;
      if (!(OWNER_ATTENTION_SOURCES as readonly string[]).includes(source)) {
        violations.push({
          rule: 'unknown-owner-attention-source',
          row,
          detail: `owner-attention source '${source}' is not in OWNER_ATTENTION_SOURCES. Add the source to the typed registry and wire its plans:attention leg, or correct the profile typo.`,
        });
      }
      if (row.tier === 'auto-arm') {
        violations.push({
          rule: 'owner-attention-auto-arm',
          row,
          detail: `owner-attention source '${source}' cannot auto-arm. Opening or using the owner surface is the presence signal; machinery never wakes the owner. Use fold or suggest.`,
        });
      }
      if (row.on) {
        violations.push({
          rule: 'owner-attention-with-condition',
          row,
          detail: `owner-attention source '${source}' declares 'on', but the existing interactive surface has no watch predicate. Drop the condition; source selection is presence-driven.`,
        });
      }
      if (row.of?.length) {
        violations.push({
          rule: 'owner-attention-with-subject',
          row,
          detail: `owner-attention source '${source}' declares 'of', but the canonical owner feed resolves its own workspace/harness scope. Drop the caller-relative subject.`,
        });
      }
    }

    if (row.tier === 'fold' && row.on) {
      violations.push({
        rule: 'fold-with-predicate',
        row,
        detail: `a 'fold' row declares 'on', but folding has no edge to trigger on — the predicate would be silently ignored. Use tier 'suggest' or 'auto-arm', or drop the predicate.`,
      });
    }
  }

  return violations;
}

/** Every distinct cell id referenced by any profile. */
export function referencedCellIds(): string[] {
  return [...new Set(INTEREST_PROFILES.flatMap((r) => (r.watch.kind === 'cell' ? [r.watch.cell] : [])))];
}

/** Every distinct event family referenced by any profile. */
export function referencedEventFamilies(): string[] {
  return [...new Set(INTEREST_PROFILES.flatMap((r) => (r.watch.kind === 'event' ? [r.watch.family] : [])))];
}
