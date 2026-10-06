/**
 * adv-agent-orders — the ORDERS half of the session popup's two-panel dossier
 * (session-chat-popup-direction-d-2026-08-02 P-011/P-012, owner ask 2026-08-02).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `adv-agent-detail.ts` answers "what is this agent DOING and HOLDING" — locks,
 * files, coord, events, loop, context. It answers nothing about what the agent
 * has been TOLD. That gap is the whole reason for the second panel: an agent's
 * behaviour is driven by standing orders that arrive in its system context and
 * NEVER appear in the transcript, so a human reading the conversation cannot
 * recover them by reading harder. Facts, registered modes and their reasons,
 * the resolved instruction precedence (including which generic rules are
 * SUPPRESSED right now), open owner directives, and the carry brief are all
 * durable and per-agent — they were simply never surfaced.
 *
 * ── Reuse, not re-derivation ────────────────────────────────────────────────
 * Every field here comes from an existing authority; this module composes, it
 * does not re-implement:
 *   - `buildControlAnchorState` → modes + loop + route + scope + carry warm/cold
 *   - `buildInstructionPrecedenceTrace` → the effective mission + suppressions.
 *     PURE (modes + route + scope in, trace out), which is why the single
 *     highest-value field on the panel is also nearly free.
 *   - `buildCarryBrief` → carry-note, held-item checkpoints, owner directives,
 *     walls, checks, standing facts, cited-ref drift, post-note inbox.
 *   - `getWakeModeOverride` / `getDefaultWakeMode` → auto vs manual.
 *
 * ── D-003: three states, never two ──────────────────────────────────────────
 * "The read failed", "the agent genuinely has none", and "the agent never wrote
 * one" are three DIFFERENT conclusions for anyone judging whether an agent is
 * healthy, and collapsing them is the exact failure `unavailableSignals` was
 * added to `getAgentSignals` to prevent (EI-18694403367371331). A key present in
 * `unavailable` means ITS read threw — render "unavailable", never the same look
 * as a legitimate empty. `carry.neverWritten` separates the third case.
 */
import { activeWorkspaceId } from './workspace-registry';
import { unsealRowsForOwner } from './personal-vault/shared-store-seal';
import { buildControlAnchorState } from './agent-tools/coordination/control-anchor';
import { buildInstructionPrecedenceTrace } from './instruction-lint';
import { buildCarryBrief, detectTerminalCitedRefs } from './carry-brief';
import {
  getDefaultWakeMode,
  getWakeModeOverride,
} from './agent-tools/coordination/wake-mode';
import type { CheckEntry, WallEntry } from './carry-note';
import { readOrientDisclosures, type RecordedOrientDisclosures } from './agent-orient-disclosures';
import {
  projectOrientationRows,
  resolveOrientationState,
  type OrientationRow,
} from './turn-start-orientation';

/** Which orders signal failed to read this call — see D-003 above. */
export type AgentOrdersSignalKey =
  | 'mission'
  | 'modes'
  | 'wakeMode'
  | 'carry'
  | 'disclosures'
  | 'obligationRows';

/**
 * The resolved instruction precedence, flattened for rendering.
 *
 * `suppressed` is the field with no equivalent anywhere else in the UI: it is
 * the list of generic playbook rules that do NOT apply to this agent right now
 * and WHY. Without it a reader sees an agent apparently ignoring a rule and has
 * no way to tell deliberate suppression from misbehaviour.
 */
export interface AgentOrdersMission {
  /** effectiveMission.constraint — e.g. "execute-owner-directed-scope". */
  constraint: string | null;
  source: string | null;
  explanation: string | null;
  /** The execution-authorization decision: confirm-first vs act-and-report. */
  authority: string | null;
  authoritySource: string | null;
  /** Rendered route — "self", or "fleet:<slug> (leader)". */
  route: string | null;
  /** Generic rules explicitly suppressed by the active modes/route. */
  suppressed: Array<{ key: string; value: string; source: string; reason: string }>;
}

export interface AgentOrdersMode {
  mode: string;
  reason: string | null;
  setBy: string | null;
  /** True when the OWNER directed this mode, vs an agent setting it on itself.
   *  A different weight of authority, so it is shown rather than implied. */
  ownerDirected: boolean;
  setAt: string | null;
}

/**
 * Auto vs manual wake.
 *
 * Load-bearing beyond display: the popup's composer sends `wake:'required'` and
 * reports "Sent". For a MANUAL-mode agent that wake is STAGED for the owner to
 * release, not delivered — so the message is a silent no-op reported as success.
 * The panel surfaces this so the composer can say "Staged" instead (P-002).
 */
export interface AgentOrdersWakeMode {
  effective: string;
  /** True when this agent has its own override rather than inheriting default. */
  overridden: boolean;
  defaultMode: string;
}

export interface AgentOrdersDirective {
  id: number;
  /** The owner's words, verbatim — never a paraphrase. */
  verbatimText: string;
  recordedBy: string;
  createdAtMs: number;
  sourceTurnRef: string | null;
  dispositionStatus: string | null;
}

export interface AgentOrdersFact {
  key: string;
  body: string;
  sourceRef?: string | null;
  /** Set when the fact's verified typed source has drifted since assert time. */
  possiblyStale?: boolean;
  /**
   * P-011: other agents already wrote to this key, or a prior version was settled
   * UNDECIDABLE (contested-fold.ts). ORTHOGONAL to `possiblyStale`, which is why
   * both render: `possiblyStale` says the fact's own source moved underneath it,
   * `contested` says people disagreed about the answer. A fact can be either,
   * both, or neither, and collapsing them into one "suspect" badge would lose
   * which question the reader has to go settle.
   *
   * ABSENT when uncontested — never `false`. This surface must not grow a
   * reassuring "uncontested" badge: the fold only looks at superseded rows, so
   * absence means "no dispute in the version chain", not "verified agreed".
   */
  contested?: {
    settledUndecidable: boolean;
    settledBy: string | null;
    priorAuthors: string[];
    priorVersions: number;
    note: string;
  };
}

export interface AgentOrdersHeldItem {
  id: string;
  title: string | null;
  checkpoint: string | null;
  checkpointUpdatedAtMs: number | null;
  /** Item-scoped progress anchor used to distinguish an old untouched checkpoint
   *  from work that continued after the checkpoint was written. */
  lastProgressAtMs: number | null;
}

/**
 * The carry brief — what the agent is tracking as it works, and (the part with
 * no visual form before this) HOW OLD each piece of it is.
 *
 * Four fields here exist purely to date the carry (`noteUpdatedAtMs`,
 * `heldItems[].checkpointUpdatedAtMs`, `heldItems[].lastProgressAtMs`, `postNoteInbox`) plus `citedRefsTerminal`,
 * which carry-brief.ts calls the #1 stale-conclusion tell: a work-item the note
 * cites that has since gone terminal. A checkpoint written a dozen turns ago is
 * close to worthless and the model already knows it — so age renders as loudly
 * as content.
 */
export interface AgentOrdersCarry {
  /** warm = each wake resumes live context; cold = each wake rebuilds from the
   *  checkpoint, which makes the checkpoint the agent's ONLY memory. Decides
   *  how severe a given staleness is — see {@link carryStaleness}. */
  mode: 'warm' | 'cold' | null;
  generation: number | null;
  loopActive: boolean;
  loopIntervalSec: number | null;
  /** The loop carry-note verbatim (did / left / insight / next). */
  note: string | null;
  noteUpdatedAtMs: number | null;
  /** TRUE only when we successfully read and the agent has written no note.
   *  Distinct from a failed read, which lands in `unavailable` (D-003). */
  neverWritten: boolean;
  heldItems: AgentOrdersHeldItem[];
  checks: CheckEntry[];
  citedRefs: string[];
  /** Cited refs that have since gone terminal — the drift tell. */
  citedRefsTerminal: string[];
  /** Directed mail that landed AFTER the note was written; the note predates it. */
  postNoteInbox: { count: number; lines: string[] } | null;
  /** Armed event awaits that survive the boundary and WILL wake a successor. */
  awaits: Array<{ eventKey: string; note: string | null }>;
}

export interface AgentOrders {
  ownerId: string;
  mission: AgentOrdersMission | null;
  modes: AgentOrdersMode[];
  wakeMode: AgentOrdersWakeMode | null;
  /** Owner-gated blockers, verbatim. `claim` is the ask; `recheck` is the probe. */
  walls: WallEntry[];
  directives: AgentOrdersDirective[];
  /** May exceed `directives.length` — the underlying fetch is bounded. */
  directivesTotalOpen: number;
  facts: AgentOrdersFact[];
  carry: AgentOrdersCarry | null;
  /** The six disclosure markers this agent's most recent `coord:orient` carried
   *  — what its OWN reads left out (P-005, D-008).
   *
   *  `null` is load-bearing and must NOT be rendered as an empty disclosure
   *  line: it means this session has recorded nothing (it has not oriented since
   *  the recording existed, or the read failed), which is a different statement
   *  from `disclosures: {}` — the positive one that its last orient cut nothing.
   *  Collapsing the two re-creates on screen the exact false-clean reading the
   *  whole marker family exists to prevent.
   *
   *  Optional so the fixtures that construct an AgentOrders in files this change
   *  does not touch keep compiling (the `lint:required-field-strands` trigger);
   *  `getAgentOrders` always populates it for real traffic. */
  disclosures?: RecordedOrientDisclosures | null;
  /**
   * P-018: THE OBLIGATION + DELTA ROWS, projected from the SAME declaration
   * turn-start renders — `projectOrientationRows(state, 'agent-orders')`.
   *
   * ⚠ This is not a prettier copy of the fields above it. `walls`,
   * `directives` and `facts` are the carry-brief's raw records — what is ON
   * FILE for this agent. These rows are what the agent was TOLD, rendered by
   * the registry's own segments at the registry's own priority. The two can
   * legitimately differ (a directive on file that the turn-start budget never
   * reached is a real finding, and one an observer can now SEE), which is
   * exactly why both are carried rather than one being derived from the other.
   *
   * `null` is load-bearing and must not be rendered as "no obligations": it
   * means the orientation state could not be resolved, which is a gap in OUR
   * read, not a clean bill for the agent. Same D-003 rule the rest of this
   * payload follows — see `unavailable`.
   */
  obligationRows?: OrientationRow[] | null;
  /** Signal keys whose read THREW this call (D-003). Empty = all resolved,
   *  even where some legitimately came back empty. */
  unavailable: AgentOrdersSignalKey[];
}

/** How stale a carried artifact is, given the agent's carry mode.
 *
 *  PURE → unit-tested. The thresholds are deliberately different per mode
 *  rather than a single global scale: for a COLD agent the checkpoint IS its
 *  memory across wakes, so a stale one is a correctness problem; for a WARM
 *  agent the same age is merely unhelpful, because its live context still
 *  carries the detail. Same number, different verdict.
 */
export function carryStaleness(
  ageMs: number | null,
  mode: 'warm' | 'cold' | null,
): 'fresh' | 'aging' | 'stale' | 'unknown' {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return 'unknown';
  const minutes = ageMs / 60_000;
  if (mode === 'cold') {
    if (minutes <= 5) return 'fresh';
    if (minutes <= 20) return 'aging';
    return 'stale';
  }
  if (minutes <= 20) return 'fresh';
  if (minutes <= 90) return 'aging';
  return 'stale';
}

/** Render a fleet route the way the panel shows it. PURE → unit-tested. */
export function renderRoute(route: {
  kind: string;
  fleet?: string;
  role?: string | null;
}): string {
  if (route.kind === 'fleet' && route.fleet) {
    return route.role ? `fleet:${route.fleet} (${route.role})` : `fleet:${route.fleet}`;
  }
  return route.kind;
}

/** Shape of the precedence trace we consume. Declared structurally rather than
 *  imported so a change to the trace's own internals cannot break this render. */
interface PrecedenceTraceLike {
  effectiveMission?: {
    constraint?: string;
    source?: string;
    explanation?: string;
  };
  decisions?: Array<{
    key?: string;
    status?: string;
    effective?: { value?: string; source?: string };
    suppressed?: Array<{ value?: string; source?: string; reason?: string }>;
    reason?: string;
  }>;
}

/** Flatten a precedence trace into the panel's mission shape. PURE → unit-tested. */
export function missionFromTrace(
  trace: PrecedenceTraceLike | null | undefined,
  route: string | null,
): AgentOrdersMission | null {
  if (!trace) return null;
  const decisions = trace.decisions ?? [];
  const auth = decisions.find((d) => d.key === 'execution-authorization');
  const suppressed: AgentOrdersMission['suppressed'] = [];
  for (const d of decisions) {
    for (const s of d.suppressed ?? []) {
      suppressed.push({
        key: d.key ?? '(unknown)',
        value: s.value ?? '(unknown)',
        source: s.source ?? '',
        reason: s.reason ?? '',
      });
    }
  }
  return {
    constraint: trace.effectiveMission?.constraint ?? null,
    source: trace.effectiveMission?.source ?? null,
    explanation: trace.effectiveMission?.explanation ?? null,
    authority: auth?.effective?.value ?? null,
    authoritySource: auth?.effective?.source ?? null,
    route,
    suppressed,
  };
}

/**
 * Gather the full orders payload for ONE agent.
 *
 * Every leg is independently best-effort: a single broken source degrades its
 * own section to "unavailable" rather than taking down the panel (and, per
 * D-003, never masquerades as an empty one).
 */
export async function getAgentOrders(owner: string): Promise<AgentOrders> {
  const workspaceId = activeWorkspaceId() ?? 'default';
  const unavailable: AgentOrdersSignalKey[] = [];

  const [controlState, carryBrief, wakeMode, disclosures, obligationRows] = await Promise.all([
    buildControlAnchorState(owner, workspaceId).catch(() => {
      unavailable.push('modes');
      return null;
    }),
    buildCarryBrief(owner, { workspaceId }).catch(() => {
      unavailable.push('carry');
      return null;
    }),
    (async (): Promise<AgentOrdersWakeMode | null> => {
      const [override, dflt] = await Promise.all([
        getWakeModeOverride(owner),
        getDefaultWakeMode(),
      ]);
      return {
        effective: override ?? dflt,
        overridden: override != null,
        defaultMode: dflt,
      };
    })().catch(() => {
      unavailable.push('wakeMode');
      return null;
    }),
    // P-005: what the agent's own last orient told it that it did NOT see.
    // `readOrientDisclosures` swallows its own errors into `null`, so this
    // .catch is the belt to that braces — and either way the result is the same
    // honest reading: no recording, rendered as nothing rather than as a clean.
    readOrientDisclosures(owner).catch(() => {
      unavailable.push('disclosures');
      return null;
    }),
    // P-018: the SAME projection turn-start renders, at the `agent-orders`
    // sink. Joins this Promise.all rather than running after it so the fold
    // costs wall-clock in parallel with the carry-brief gather it sits beside;
    // the panel is fetch-gated on being open (SessionChatModal P-015), so a
    // closed Orders rail still pays nothing.
    //
    // `committed: null` on purpose — BASELINE, not the agent's live cursor.
    // Turn-start suppresses rows it already delivered (the watermark half of
    // this plan); an OBSERVER asking "what is standing right now" must see the
    // full set, or a directive would vanish from the screen precisely because
    // it had been delivered once. The projection is identical either way: the
    // cursor is an argument to it, not a fork of it.
    (async (): Promise<OrientationRow[] | null> => {
      const state = await resolveOrientationState(owner, workspaceId);
      return projectOrientationRows(state, 'agent-orders', null);
    })().catch(() => {
      unavailable.push('obligationRows');
      return null;
    }),
  ]);

  // The mission trace is PURE given the control state, so it costs one function
  // call — no IO of its own. It is omitted (not faked) when the control read
  // failed: a fabricated "confirm-first" default would be a false statement
  // about the agent's authority, which is worse than an honest blank.
  let mission: AgentOrdersMission | null = null;
  if (controlState) {
    try {
      const trace = buildInstructionPrecedenceTrace({
        // The trace's `source` is a closed union of the surfaces that build one.
        // We derive ours from the SAME control-anchor state that surface uses,
        // so we declare it honestly rather than widening the union for a reader.
        source: 'control-anchor',
        ownerId: owner,
        modes: controlState.modes,
        route: controlState.route,
        scope: controlState.scope,
      }) as PrecedenceTraceLike;
      mission = missionFromTrace(trace, renderRoute(controlState.route));
    } catch {
      unavailable.push('mission');
    }
  } else {
    unavailable.push('mission');
  }

  const modes: AgentOrdersMode[] = [];
  if (controlState) {
    // The control anchor carries only the mode IDS; the reasons/attribution live
    // on the mode registry rows the carry brief does not fetch. Re-read them
    // rather than rendering a bare id — "AUTO" alone cannot tell an owner
    // whether THEY set it or the agent set it on itself.
    try {
      const { getModes } = await import('./modes/store');
      const rows = await getModes(workspaceId, owner);
      for (const r of rows) {
        modes.push({
          mode: r.mode,
          reason: r.reason ?? null,
          setBy: r.setBy ?? null,
          ownerDirected: Boolean(r.ownerDirected),
          setAt: r.setAt ? String(r.setAt) : null,
        });
      }
    } catch {
      if (!unavailable.includes('modes')) unavailable.push('modes');
    }
  }

  let carry: AgentOrdersCarry | null = null;
  if (carryBrief) {
    const citedRefs = carryBrief.citedRefs ?? [];
    // WI-10005548 / D-006: a checkpoint a restricted agent wrote is stored as a
    // sealed stub. This panel is the owner's, and the owner is always a permitted
    // reader, so it shows the text. (The agent's own brief keeps the stub.)
    const heldItems = await unsealRowsForOwner(carryBrief.heldItems ?? [], {
      workspaceId,
      textOf: (h) => h.checkpoint,
      withText: (h, checkpoint) => ({ ...h, checkpoint }),
    });
    carry = {
      mode: (controlState?.carry as 'warm' | 'cold' | undefined) ?? null,
      generation: null,
      loopActive: Boolean(carryBrief.loop?.active),
      loopIntervalSec: carryBrief.loop?.intervalSec ?? null,
      note: carryBrief.loop?.carryNote ?? null,
      noteUpdatedAtMs: carryBrief.loop?.carryNoteUpdatedAtMs ?? null,
      // We read successfully and there is no note — that is a FINDING about the
      // agent (it never checkpointed its loop), not a gap in our data.
      neverWritten: !carryBrief.loop?.carryNote,
      heldItems: heldItems.map((h) => ({
        id: h.id,
        title: h.title ?? null,
        checkpoint: h.checkpoint ?? null,
        checkpointUpdatedAtMs: h.checkpointUpdatedAtMs ?? null,
        lastProgressAtMs: h.lastProgressAtMs ?? null,
      })),
      checks: carryBrief.checks ?? [],
      citedRefs,
      citedRefsTerminal: detectTerminalCitedRefs(citedRefs),
      postNoteInbox: carryBrief.postNoteInbox ?? null,
      awaits: carryBrief.awaits ?? [],
    };
  }

  return {
    ownerId: owner,
    mission,
    modes,
    wakeMode,
    walls: carryBrief?.walls ?? [],
    directives: (carryBrief?.directives ?? []).map((d) => ({
      id: d.id,
      verbatimText: d.verbatimText,
      recordedBy: d.recordedBy,
      createdAtMs: d.createdAtMs,
      sourceTurnRef: d.sourceTurnRef ?? null,
      dispositionStatus: d.dispositionStatus ?? null,
    })),
    directivesTotalOpen: carryBrief?.directivesTotalOpen ?? 0,
    // Matched BY KEY, not by index: `factsStaleness` only carries entries for
    // facts that qualify for an embedding comparison, so it is routinely SHORTER
    // than `facts` and positionally misaligned. Indexing it would attach one
    // fact's staleness verdict to a different fact — a wrong answer that looks
    // perfectly well-formed.
    facts: (carryBrief?.facts ?? []).map((f) => ({
      key: f.key,
      body: f.body,
      sourceRef: f.sourceRef ?? null,
      possiblyStale:
        carryBrief?.factsStaleness?.find((s) => s.key === f.key)?.verdict === 'possibly-stale',
      // P-011: passed THROUGH, never recomputed — buildCarryBrief already folded
      // it in one batched query over the whole fact set. Spread conditionally so
      // an uncontested fact carries no key at all: see the DTO note on why this
      // must not become `contested: f.contested ?? false`.
      ...(f.contested ? { contested: f.contested } : {}),
    })),
    carry,
    disclosures,
    obligationRows,
    unavailable,
  };
}
