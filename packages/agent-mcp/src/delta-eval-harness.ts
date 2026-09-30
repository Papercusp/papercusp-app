/**
 * Delta replay/eval harness — the measurement instrument Lane A owes Phase 4+
 * (agent-tool-delta-protocol-2026-06-22, P-003; gates the exemplar P-014 and the
 * rollout/flag-flip P-016).
 *
 * WHY THIS EXISTS. `harness_shared.tool_invocations` stores arg SHAPE (≤32KB) +
 * result SIZE only — NEVER result bodies (`dispatch-stack.ts`). So a replay that
 * wants to know "what would a delta have cost, and would the merge be correct?"
 * cannot read historical bodies back; it must RE-EXECUTE the tool to obtain real
 * `next`/`base` snapshots, then run them through this engine. This module is the
 * pure, deterministic core of that loop:
 *
 *   1. `computeListDelta(base, next)` — a provably-correct, agent-facing list
 *      delta (D-003 semantic shape) over canonical state, NOT a server-side
 *      projection diff. (`projection-index`'s `computeDelta` is the store's
 *      internal put/delete index maintenance keyed by `sourceId|key|entryId`;
 *      D-002 is explicit that it is "not a consumer cursor" — so this is a new,
 *      justified surface, not a fork of it.)
 *   2. `applyListDelta(base, delta)` — the MERGE. `apply(base, compute(base,next))`
 *      deep-equals `next` for every transition (add / update / remove / reorder /
 *      identical). This round-trip IS the de-risk oracle the owner BUILD decision
 *      (D-007/D-008) rests on: a "silently wrong merge" becomes a failing assert.
 *   3. `evalSnapshotTransition(base, next)` — token-measures the four modes a real
 *      BPE tokenizer (`o200k_base`, the `result-format-benchmark` proxy) sees:
 *      full-JSON / full-TOON-compact / `not_modified` / semantic-delta — and
 *      reports the winner + the merge-correctness verdict.
 *
 * Reuses, never reinvents: `@papercusp/result-encoding` (`encode`/TOON), Lane B's
 * `@papercusp/tooldef` delta-protocol (`encodeDeltaCursor`, the small-response
 * bypass threshold), and `js-tiktoken`. Pure + side-effect-free → unit tier; the
 * real-tool re-execution that feeds it lives in the integration test alongside.
 */

import { encode } from '@papercusp/result-encoding';
import { encodeDeltaCursor, DELTA_SMALL_RESPONSE_BYTES } from '@papercusp/tooldef';

// PERF (FCP): `js-tiktoken` ships multi-MB BPE rank tables (`o200k_base` ≈ 5.5MB).
// This module is reachable from the `@papercusp/agent-mcp` barrel, which the
// operator webview imports — a STATIC `import` here put
// that 5.5MB into the eager client boot bundle and was the dominant ~2s
// first-contentful-paint cost (E2E perf sweep 2026-06-23; the tokenizer is
// eval-only — `tokens`/`evalSnapshotTransition` have no prod caller). Dynamic-import
// it so it splits into a lazy chunk loaded only when the eval path actually runs.
// See /internal/docs/performance (rule 14 / A5 module-init side-effect).
let _encPromise: Promise<{ encode(s: string): unknown[] }> | undefined;
function loadEnc(): Promise<{ encode(s: string): unknown[] }> {
  if (!_encPromise) {
    _encPromise = import('js-tiktoken').then((m) => m.getEncoding('o200k_base'));
  }
  return _encPromise;
}

/** Token count of a string under the frontier-proxy tokenizer. Async: the tokenizer is lazy-loaded (see above). */
export async function tokens(s: string): Promise<number> {
  return (await loadEnc()).encode(s).length;
}

export type Row = Record<string, unknown>;

export interface DeltaEvalOpts {
  /** Stable identity field on each row. Default `'id'`; `plans:list` rows use `'slug'`. */
  itemKey?: string;
}

/** Why a transition degrades to a full re-send instead of a delta (telemetry + the harness signal). */
export type FullReason = 'base_absent' | 'no_item_key' | 'duplicate_key';

/**
 * The agent-facing read-delta. Correctness-complete by construction: `put` carries
 * the full body of every added/updated row, `remove` the dropped ids, and `order`
 * the EXACT id sequence of `next` — so `applyListDelta` reconstructs `next` byte-for
 * -byte regardless of reorder/insert complexity (cheap: `order` is ids only, the
 * expensive bodies ride only on changed rows). `put` with id∈base ⇒ "updated";
 * id∉base ⇒ "added" (the D-003 `change` discriminator is derivable, kept off the
 * wire to save tokens).
 */
export type ListDelta =
  | { mode: 'not_modified'; counts: { total: number } }
  | { mode: 'full'; reason: FullReason }
  | {
      mode: 'delta';
      put: Array<{ id: string; data: Row }>;
      remove: string[];
      order: string[];
      counts: { added: number; updated: number; removed: number; total: number };
      /** Hash of `next` — the client verifies its merged result against this (D-002). */
      checksum: string;
    };

/** Deterministic FNV-1a over the canonical JSON of `next` — the merge-verification checksum. */
export function checksumRows(rows: Row[], itemKey: string): string {
  // Canonicalize: stable row order by id + stable key order, so the checksum is
  // identity-stable (two equal lists hash equal regardless of input ordering noise).
  const canonical = JSON.stringify(
    [...rows].map((r) => stableStringify(r)).sort(),
  ) + `|k=${itemKey}|n=${rows.length}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** JSON.stringify with deterministic key ordering (so equal objects stringify equal). */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function idOf(row: Row, itemKey: string): string | null {
  const raw = row[itemKey];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  return null;
}

/**
 * Compute the semantic list delta from `base` → `next`. `base === null` means the
 * model/client has NO base in context (post-compaction / fresh turn) → `full`
 * (D-004/D-006: a delta against an absent base is unmergeable). Returns `full`
 * with a reason for any condition that makes a safe delta impossible (missing or
 * duplicate identity keys — D-002: "must not claim safe removed deltas" without
 * stable identity).
 */
export function computeListDelta(base: Row[] | null, next: Row[], opts: DeltaEvalOpts = {}): ListDelta {
  const itemKey = opts.itemKey ?? 'id';
  if (base === null) return { mode: 'full', reason: 'base_absent' };

  const baseMap = new Map<string, Row>();
  for (const r of base) {
    const id = idOf(r, itemKey);
    if (id === null) return { mode: 'full', reason: 'no_item_key' };
    if (baseMap.has(id)) return { mode: 'full', reason: 'duplicate_key' };
    baseMap.set(id, r);
  }

  const nextMap = new Map<string, Row>();
  const order: string[] = [];
  for (const r of next) {
    const id = idOf(r, itemKey);
    if (id === null) return { mode: 'full', reason: 'no_item_key' };
    if (nextMap.has(id)) return { mode: 'full', reason: 'duplicate_key' };
    nextMap.set(id, r);
    order.push(id);
  }

  const put: Array<{ id: string; data: Row }> = [];
  let added = 0;
  let updated = 0;
  for (const [id, r] of nextMap) {
    const prev = baseMap.get(id);
    if (prev === undefined) {
      put.push({ id, data: r });
      added++;
    } else if (stableStringify(prev) !== stableStringify(r)) {
      put.push({ id, data: r });
      updated++;
    }
  }
  const remove: string[] = [];
  for (const id of baseMap.keys()) {
    if (!nextMap.has(id)) remove.push(id);
  }

  const orderUnchanged =
    base.length === next.length && base.every((r, i) => idOf(r, itemKey) === order[i]);
  if (put.length === 0 && remove.length === 0 && orderUnchanged) {
    return { mode: 'not_modified', counts: { total: next.length } };
  }

  return {
    mode: 'delta',
    put,
    remove,
    order,
    counts: { added, updated, removed: remove.length, total: next.length },
    checksum: checksumRows(next, itemKey),
  };
}

/**
 * Apply a delta to a base, reconstructing `next` EXACTLY. The merge-correctness
 * oracle: `applyListDelta(base, computeListDelta(base, next))` deep-equals `next`.
 * Throws on a `full` delta (nothing to merge — the caller must use the full body)
 * or on an inconsistent delta (an `order` id with no source row).
 */
export function applyListDelta(base: Row[], delta: ListDelta, opts: DeltaEvalOpts = {}): Row[] {
  const itemKey = opts.itemKey ?? 'id';
  if (delta.mode === 'full') {
    throw new Error(`applyListDelta: mode 'full' (${delta.reason}) carries no body — use the full snapshot`);
  }
  if (delta.mode === 'not_modified') {
    return [...base];
  }
  const map = new Map<string, Row>();
  for (const r of base) {
    const id = idOf(r, itemKey);
    if (id !== null) map.set(id, r);
  }
  for (const id of delta.remove) map.delete(id);
  for (const { id, data } of delta.put) map.set(id, data);
  const out: Row[] = [];
  for (const id of delta.order) {
    const r = map.get(id);
    if (r === undefined) {
      throw new Error(`applyListDelta: order references id ${JSON.stringify(id)} with no row (corrupt delta)`);
    }
    out.push(r);
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Token measurement — the four modes a client/LLM actually sees on the wire.
 * Mirrors the framework's serialized forms (the `format: toon` / `mode:` marker
 * lines from delta-integration.test.ts) so the numbers reflect real transport.
 * ────────────────────────────────────────────────────────────────────────── */

/** A representative delta cursor (Lane B's real encoder) so the envelope cost is real, not guessed. */
function evalCursor(checksum: string): string {
  return encodeDeltaCursor({ v: 1, fp: 'eval', rev: checksum });
}

/** Bulk envelope shape the dominant tools ship (`{ data: rows }`) — TOON's object-with-array path. */
function envelope(rows: Row[]): { ok: true; data: Row[] } {
  return { ok: true, data: rows };
}

export interface ModeTokens {
  /** Full body as compact JSON. */
  fullJson: number;
  /** Full body as TOON-compact (the current default for array results). */
  fullToon: number;
  /** `not_modified` — counts + cursor only, body suppressed. Present only when the view is unchanged. */
  notModified: number | null;
  /** Semantic delta — changed bodies + id order + cursor. Present only when a delta is possible. */
  delta: number | null;
}

export interface SnapshotEval {
  mode: ListDelta['mode'];
  reason?: FullReason;
  tokens: ModeTokens;
  /** Smallest applicable mode. */
  winner: 'not_modified' | 'delta' | 'full_toon' | 'full_json';
  /**
   * delta/not_modified tokens as a % saving vs the BEST full encoding
   * (`min(fullJson, fullToon)`) — the honest baseline, since TOON-compact is not
   * universally smaller than JSON (it loses on nested-object row shapes like
   * `plans:list`, where the delta/not_modified path is the only real win).
   */
  savedVsFullPct: number | null;
  /** The merge round-trips: applyListDelta(base, delta) deep-equals next. `null` when mode==='full'. */
  correct: boolean | null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Evaluate one snapshot transition `base → next`: token-cost every applicable mode,
 * pick the winner, and verify the delta merge. `base === null` models a missing
 * base (post-compaction) → the only correct answer is a full re-send.
 */
export async function evalSnapshotTransition(base: Row[] | null, next: Row[], opts: DeltaEvalOpts = {}): Promise<SnapshotEval> {
  const fullJsonText = JSON.stringify(envelope(next));
  const fullToonText = `format: toon\n${encode(envelope(next), 'toon')}`;
  const fullJson = await tokens(fullJsonText);
  const fullToon = await tokens(fullToonText);

  const delta = computeListDelta(base, next, opts);
  const smallResponse = Buffer.byteLength(fullJsonText) < DELTA_SMALL_RESPONSE_BYTES;

  let notModified: number | null = null;
  let deltaTok: number | null = null;
  let correct: boolean | null = null;

  if (delta.mode === 'not_modified') {
    const cursor = evalCursor(checksumRows(next, opts.itemKey ?? 'id'));
    notModified = await tokens(`mode: not_modified\ncount: ${delta.counts.total}\ncursor: ${cursor}`);
    // base must equal next for not_modified to be honest; verify.
    correct = base !== null && deepEqual(base, next);
  } else if (delta.mode === 'delta') {
    const cursor = evalCursor(delta.checksum);
    const wire = { put: delta.put, remove: delta.remove, order: delta.order, counts: delta.counts };
    deltaTok = await tokens(`mode: delta\nformat: toon\n${encode(wire, 'toon')}\ncursor: ${cursor}`);
    correct = base !== null && deepEqual(applyListDelta(base, delta, opts), next);
  }

  // Winner: the negotiator serves the smallest faithful mode. The small-response
  // bypass forces full (a delta round-trip can't beat a tiny body once the cursor
  // is counted — Lane B DELTA_SMALL_RESPONSE_BYTES).
  const fullBaseline = Math.min(fullJson, fullToon);
  let winner: SnapshotEval['winner'];
  if (delta.mode === 'full' || smallResponse) {
    winner = fullToon <= fullJson ? 'full_toon' : 'full_json';
  } else if (notModified !== null) {
    winner = 'not_modified';
  } else if (deltaTok !== null && deltaTok < fullBaseline) {
    winner = 'delta';
  } else {
    winner = fullToon <= fullJson ? 'full_toon' : 'full_json';
  }

  const best = notModified ?? deltaTok;
  const savedVsFullPct =
    best !== null && fullBaseline > 0 ? Math.round((1 - best / fullBaseline) * 1000) / 10 : null;

  return {
    mode: delta.mode,
    ...(delta.mode === 'full' ? { reason: delta.reason } : {}),
    tokens: { fullJson, fullToon, notModified, delta: deltaTok },
    winner,
    savedVsFullPct,
    correct,
  };
}
