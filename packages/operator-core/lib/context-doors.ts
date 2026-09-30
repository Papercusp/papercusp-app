/**
 * Per-hop context doors (deterministic-context-carry P-006, ornith-overflow brief).
 *
 * A "hop" = ONE provider round-trip: one model response plus the tool results appended
 * before the next provider request (NOT the user-visible agent turn). The harness bounds
 * what a single hop can add to context — `maxTurn` — so the compaction thresholds
 * (P-007: soft = window − (2×maxTurn + overhead), hard = window − maxTurn) hold by
 * CONSTRUCTION, never by observation of past turns (owner-rejected feedback loops, D-001).
 *
 * DECIDED formula [owner 2026-07-14, plan D-007]:
 *   maxTurn = min(15K, max(8K, effectiveWindow / 26))
 * Knees: the 8K floor binds below ~208K windows (Ornith 204.8K → 8K); the 15K cap binds
 * above ~390K; /26 scales in between. `maxTurn` is the SUM of the per-door caps, and when
 * the formula lands below (or above) the base door-sum the doors scale proportionally
 * inside it — default split at the 8K floor: output 4K / tool results 2×1.5K /
 * injections 1K.
 *
 * Enforcement legs (who consumes which door):
 *   output     → the `max_tokens` request param (psu-launcher rewrites the per-session
 *                model registry; MIRRORED in psu-launcher.mjs — it cannot import TS,
 *                same lockstep rule as OMP_LOCAL_MODEL_PREFIXES);
 *   resultEach → per-tool-result cap with spill-to-disk behind a pointer;
 *   injections → the wake/coord injection path's per-delivery cap, same spill contract.
 *
 * These constants are adjustable DEFAULTS via the P-023 config surface
 * (context-doors-config.ts → config:doors-get/-set/-set-session): every compute function
 * takes an optional DoorConstants (default BAKED_DOOR_CONSTANTS, byte-identical when
 * un-configured); keep every knob here, exported, so that module wires one place.
 */

/** The output-door floor sum: below ~208K windows every model gets exactly this hop budget. */
export const MAX_TURN_FLOOR_TOKENS = 8_000;
/** Cap: above ~390K windows the hop budget stops growing (context is rent — a bigger
 *  window is headroom for the SESSION, not licence for bigger hops). */
export const MAX_TURN_CAP_TOKENS = 15_000;
/** Window divisor between the knees; /26 deliberately lands virtually every fleet model
 *  AT the 8K floor (the value measured essentially free: 2/4048 length-stops). */
export const MAX_TURN_WINDOW_DIVISOR = 26;

/** Door proportions of maxTurn — the default split at the 8K floor (output 4K / results
 *  2×1.5K / injections 1K). output + resultSlots×resultEach + injections === 1. */
export const DOOR_SPLIT = Object.freeze({
  output: 0.5,
  resultEach: 0.1875,
  resultSlots: 2,
  injections: 0.125,
});

/** The full constant set the door/threshold math runs on. The BAKED values below are the
 *  decided defaults; the P-023 config surface (context-doors-config.ts) resolves an
 *  EFFECTIVE set (workspace defaults ⟵ per-session override) and passes it in — every
 *  compute function defaults to BAKED so an un-configured system is byte-identical. */
export interface DoorConstants {
  maxTurnFloorTokens: number;
  maxTurnCapTokens: number;
  maxTurnWindowDivisor: number;
  doorSplit: { output: number; resultEach: number; resultSlots: number; injections: number };
  compactionOverheadTokens: number;
}

/** maxTurn for an effective window (tokens): min(cap, max(floor, window/divisor)). */
export function computeMaxTurn(effectiveWindow: number, c: DoorConstants = BAKED_DOOR_CONSTANTS): number {
  const w = Number(effectiveWindow);
  if (!Number.isFinite(w) || w <= 0) return c.maxTurnFloorTokens;
  return Math.min(c.maxTurnCapTokens, Math.max(c.maxTurnFloorTokens, Math.floor(w / c.maxTurnWindowDivisor)));
}

export interface TurnDoors {
  /** The per-hop ingestion budget the doors sum to. */
  maxTurn: number;
  /** Model output cap → the `max_tokens` request param. */
  output: number;
  /** Per-tool-result cap (spill-to-disk beyond it). */
  resultEach: number;
  /** Concurrent tool-result slots the split budgets for. */
  resultSlots: number;
  /** System/coord injection cap per delivery (spill-to-disk beyond it). */
  injections: number;
}

/** The per-door caps for an effective window: the DOOR_SPLIT proportions applied to
 *  computeMaxTurn. Doors scale inside maxTurn in BOTH directions (D-007 amendment (a) —
 *  at the 8K floor this is exactly the default 4K/1.5K×2/1K split). */
export function computeTurnDoors(effectiveWindow: number, c: DoorConstants = BAKED_DOOR_CONSTANTS): TurnDoors {
  const maxTurn = computeMaxTurn(effectiveWindow, c);
  return {
    maxTurn,
    output: Math.floor(maxTurn * c.doorSplit.output),
    resultEach: Math.floor(maxTurn * c.doorSplit.resultEach),
    resultSlots: c.doorSplit.resultSlots,
    injections: Math.floor(maxTurn * c.doorSplit.injections),
  };
}

/** Fixed per-hop overhead reserve for the compaction thresholds (P-007): request envelope,
 *  system-prompt growth, tokenizer estimate error — the slack between "one more maxTurn hop
 *  fits" and reality. 4000 reproduces the plan's decided operating points exactly:
 *  Ornith 204.8K → soft ~90.2% / hard ~96.1%; 400K → soft 91.5% / hard 96.25%. */
export const COMPACTION_OVERHEAD_TOKENS = 4_000;

/** The decided defaults [owner 2026-07-14, plan D-007] as one DoorConstants value.
 *  Declared after every constant it references (module-eval order); the compute functions
 *  above reference it only in default-parameter position, which evaluates at call time. */
export const BAKED_DOOR_CONSTANTS: DoorConstants = Object.freeze({
  maxTurnFloorTokens: MAX_TURN_FLOOR_TOKENS,
  maxTurnCapTokens: MAX_TURN_CAP_TOKENS,
  maxTurnWindowDivisor: MAX_TURN_WINDOW_DIVISOR,
  doorSplit: DOOR_SPLIT,
  compactionOverheadTokens: COMPACTION_OVERHEAD_TOKENS,
});

export interface CompactionThresholds {
  /** soft = window − (2×maxTurn + overhead): nudge self-compaction — two full hops of headroom
   *  remain, so a clean deliberate compaction still fits. */
  softTokens: number;
  /** hard = window − maxTurn: the mechanical tier (shake / forced backstop, no model call) —
   *  exactly one maxTurn hop of headroom, held by CONSTRUCTION via the P-006 doors. */
  hardTokens: number;
  softPct: number;
  hardPct: number;
}

/** Two-tier compaction thresholds derived from the effective window + the decided maxTurn
 *  formula (P-007, D-001: limits + enforced constants only — never history/telemetry). */
export function computeCompactionThresholds(effectiveWindow: number, c: DoorConstants = BAKED_DOOR_CONSTANTS): CompactionThresholds {
  const w = Number(effectiveWindow);
  const maxTurn = computeMaxTurn(w, c);
  const window = Number.isFinite(w) && w > 0 ? w : maxTurn * 4; // degenerate input: still return sane, low thresholds
  const softTokens = Math.max(0, window - (2 * maxTurn + c.compactionOverheadTokens));
  const hardTokens = Math.max(softTokens, window - maxTurn);
  return {
    softTokens,
    hardTokens,
    softPct: Math.floor((softTokens / window) * 100),
    hardPct: Math.floor((hardTokens / window) * 100),
  };
}

/** Conservative chars→tokens estimate for door enforcement at seams with no tokenizer.
 *  4 chars/token over-counts most English prose slightly (real ratios run ~3.5–4.5), i.e.
 *  the door errs PERMISSIVE — enforcement here is a budget rail, not an exact meter. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Split `text` at an injection door of `doorTokens`: `kept` is the head that fits the
 *  budget (cut at a line boundary where one exists in the final 20% of the window, so a
 *  sentence isn't sheared mid-word), `overflow` is the remainder (null when everything
 *  fits). Pure — the caller owns the spill file and the pointer line. */
export function capInjectionText(text: string, doorTokens: number): { kept: string; overflow: string | null } {
  const budgetChars = Math.max(1, Math.floor(doorTokens * CHARS_PER_TOKEN_ESTIMATE));
  if (text.length <= budgetChars) return { kept: text, overflow: null };
  const window = text.slice(0, budgetChars);
  const lastBreak = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
  const cut = lastBreak > budgetChars * 0.8 ? lastBreak : budgetChars;
  return { kept: text.slice(0, cut), overflow: text.slice(cut) };
}
