/**
 * state-plane-stamp.ts — THE DOOR EMITS THE PLANE
 * (state-plane-adoption-2026-08-02 P-010, the last Phase 2 item.)
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * P-001 through P-009 were PROMOTION: route the cells in CLAUDE.md, point the incumbent
 * door's guidance at them, nudge at call time, widen the cells where the residue was
 * real. Promotion asymptotes — measured at ACT/QUOTE 15/888 = 1.7% (D-030). Every one of
 * those tiers requires the agent to KNOW to switch tools at the moment it is least likely
 * to think about tooling: the moment it already has the number it wanted.
 *
 * So stop asking it to switch. `dev:pipeline_position` is the door agents already use
 * (626 calls/7d), and the cells and the door read ONE resolver (`gitPipelinePosition`).
 * This module stamps each volatile value in the door's own answer with the cell that
 * re-answers it, so the agent about to quote something is already holding the plane
 * reference. Adoption stops being a behaviour we promote and becomes the only path the
 * data travels.
 *
 * ── THE MAP IS DECLARED DATA, NOT A LIST MAINTAINED HERE ────────────────────
 *
 * The item's text assumed this module would have to name the door's volatile values.
 * It does not, and must not. Every cell already declares
 * `changeSignal: { kind:'poll', tool:'<the canonical door>', path:'<a path>' }` plus any
 * `doorProjections: [{ tool, path }]` — together those declarations ARE the door→cell
 * map, written by the cell's own author and already validated at registration. The
 * canonical changeSignal remains the one resolver state:read/state:subscribe dispatch;
 * doorProjections only let other existing payloads carry the same re-read handle. So the
 * stamp is DERIVED: filter those registry declarations by tool, then probe each path
 * against the payload in hand.
 *
 * A hand-written table here would be a SECOND derivation of a fact the registry already
 * owns (D-038 axis 5: one derivation, many lenses) and would drift the first time a cell
 * is renamed, re-pathed, or added — silently, because a stale table still returns stamps.
 * Nothing about this module is specific to `dev:pipeline_position`; a second door adopts
 * it by passing its own name (`coord:goal` already declares a cell against itself).
 *
 * ── THE TWO EDGES THAT DECIDE CORRECTNESS ───────────────────────────────────
 *
 * 1. MISSING ≠ NULL, so existence is OWN-KEY, never `valueAtPath`.
 *
 *    `valueAtPath` returns `undefined` for a key that is absent AND for one that is
 *    present-and-null. Keying the stamp on it would drop the handle exactly when the
 *    value is null — i.e. when the door could not determine the deployed sha, the gate
 *    verdict, the candidate. That is precisely the reading a caller must NOT transcribe,
 *    so the feature would vanish in the case that motivates it. `cell-read.ts` (503-515)
 *    already draws this line; production had no own-key walker of its own, only a copy
 *    inside the cell falsifier-reality suite (deleted at P-004). `pathExists` below is
 *    it, and `cell-assessment-reality.test.ts` IMPORTS it instead of re-copying it.
 *
 * 2. A CALLER-RELATIVE CELL NEEDS THE CALLER'S SUBJECT, OR IT ANSWERS A DIFFERENT
 *    QUESTION.
 *
 *    Two of the six pipeline cells declare `callerRelativity:{kind:'parameter',param:'path'}`.
 *    `state:read { cell:'gate.greenCheckpoint.candidate' }` with no `as` does not re-read
 *    the value the caller is holding — it answers about a different subject, or refuses.
 *    A handle that looks authoritative and resolves elsewhere is WORSE than no handle,
 *    because the whole promise of the stamp is "this re-reads the thing in your hand".
 *    So the subject is threaded from the caller's own args, and the param NAME is read
 *    off the spec (never hardcoded — `coord:goal`'s cell keys on `ownerId`).
 *
 *    When the cell is caller-relative and the caller supplied no subject, this FAILS SAFE
 *    the way `headlineSource` does (WI-36259): it emits `unreadable { needs }` and NO
 *    `reread`, so there is no incomplete handle to copy. Same reasoning as `canReadCell`
 *    failing closed — an enrichment may under-serve, never mislead.
 *
 * ── DELIBERATE OMISSIONS ────────────────────────────────────────────────────
 *
 * • NO VALUE COPY. The stamp names the path, not the value at it. The value is already in
 *   the payload; restating it would put a second copy in front of a reader whose specific
 *   failure mode is copying values around, and double the block's cost for nothing.
 * • NO `state:subscribe` HANDLE. The door already emits `awaitable`/`deploy:await` for the
 *   deploy leg and a subscribe pointer for the gate leg, gated so the two can never both
 *   fire; shipping a subscribe handle on all six stamps would recreate the "two
 *   contradictory instructions in one payload" failure that gating exists to prevent
 *   (pipeline_position.ts, WI-6595). Re-read is this module's job; waiting is not.
 * • NOTHING THROWS. A stamp is an enrichment on a read-only probe, so it must never fail
 *   the call it decorates — the rule `cell-read.ts` (456-477) states for the same reason,
 *   after P-007's totality fuzz found a payload walk escaping a no-throw contract. A
 *   payload may carry throwing getters or hostile proxies; every access here is guarded
 *   and a throw degrades to "no stamp for that path".
 */

import { canReadCell, type CellReader, type CellSpec } from './cell-registry';

/**
 * Own-key existence probe. Distinguishes the three outcomes `valueAtPath` collapses into
 * `undefined`: the path resolves (to anything, INCLUDING null/undefined); the path is
 * missing; or the walk could not continue because a segment is not an object.
 *
 * `missingAt` names the first segment that failed, which is what makes a drifted
 * registration diagnosable instead of merely absent. Callers that need to preserve
 * nullable-cell semantics may opt into `nullTerminatedAt`, which distinguishes a
 * path below an explicit null parent from a genuinely missing key without changing
 * the default result shape.
 *
 * TOTAL — never throws. A getter that throws or a proxy that rejects reports as missing
 * at that segment, which is the safe direction: no stamp rather than a wrong one.
 */
export interface PathExistsOptions {
  /** Report the explicit null parent that stopped an otherwise-present path walk. */
  reportNullTermination?: boolean;
}

export interface PathExistsResult {
  exists: boolean;
  value: unknown;
  missingAt?: string;
  /** The present parent path whose explicit null value stopped this walk. */
  nullTerminatedAt?: string;
}

export function pathExists(
  obj: unknown,
  path: string,
  options: PathExistsOptions = {},
): PathExistsResult {
  let cur: unknown = obj;
  const segs = path.split('.');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (cur === null || cur === undefined || (typeof cur !== 'object' && typeof cur !== 'function')) {
      return {
        exists: false,
        value: undefined,
        missingAt: segs.slice(0, i + 1).join('.'),
        ...(options.reportNullTermination && cur === null && i > 0
          ? { nullTerminatedAt: segs.slice(0, i).join('.') }
          : {}),
      };
    }
    let has = false;
    try {
      has = Object.prototype.hasOwnProperty.call(cur, seg);
    } catch {
      has = false;
    }
    if (!has) {
      return { exists: false, value: undefined, missingAt: segs.slice(0, i + 1).join('.') };
    }
    try {
      cur = (cur as Record<string, unknown>)[seg];
    } catch {
      // A throwing getter: the key EXISTS but its value is unreachable. Report missing —
      // a stamp we cannot substantiate is worse than one we omit.
      return { exists: false, value: undefined, missingAt: segs.slice(0, i + 1).join('.') };
    }
  }
  return { exists: true, value: cur };
}

/** One volatile value in a door's payload, and how to re-read it from the plane. */
export interface PlaneStamp {
  /** Where the value sits in THIS payload — the caller reads it there, not from here. */
  path: string;
  /** The cell that re-answers this exact value. */
  cell: string;
  /** The re-read call. Absent only when it cannot be completed — see `unreadable`. */
  reread?: { tool: 'state:read'; args: { cell: string; as?: string } };
  /**
   * Why no handle was emitted. Present iff `reread` is absent, so a consumer branches on
   * one field rather than inferring from an omission.
   */
  unreadable?: { needs: string; why: string };
}

export interface StatePlaneStampInput {
  /** The door's own result payload. */
  payload: unknown;
  /** The door's tool name — matched against each cell's `changeSignal.tool`. */
  tool: string;
  /**
   * The caller's own arguments, keyed by parameter name. A caller-relative cell's subject
   * is looked up here under the param name the SPEC declares.
   */
  args?: Record<string, unknown>;
  /**
   * Candidate cells. Pass the AUDIENCE-FILTERED list (`listCells(reader)`) — or pass the
   * full list plus `reader` and this module filters. Advertising a cell the reader may not
   * read would leak its existence, which is the enumeration oracle P-019 forbids.
   */
  cells: readonly CellSpec[];
  /** Optional second line of defence for the audience check. */
  reader?: CellReader;
}

/** The block a door attaches to its result. */
export interface StatePlaneBlock {
  note: string;
  cells: PlaneStamp[];
}

const NOTE =
  'Each value below is a raw MEASUREMENT with a CELL that re-answers it from the same resolver ' +
  'and, when declared, returns an explicit ASSESSMENT (meaning + safe action + evidence). These ' +
  'drift mid-turn: re-read with the handle at the moment you ACT on one or quote it into a plan, ' +
  'message or work-item — never transcribe this measurement or infer its meaning yourself.';

/**
 * Derive the stamps for one door result. Pure and total.
 *
 * Returns `null` — not an empty block — when nothing could be stamped, so a door can omit
 * the key entirely rather than attach an empty shell that reads like "this payload has no
 * volatile values" when it may simply have no registered cells yet.
 */
export function stampStatePlane(input: StatePlaneStampInput): StatePlaneBlock | null {
  let stamps: PlaneStamp[];
  try {
    stamps = collect(input);
  } catch {
    // Belt and braces: `collect` is written not to throw, but this function is called on a
    // hot read-only path and an enrichment must never fail the operation it decorates.
    return null;
  }
  if (stamps.length === 0) return null;
  return { note: NOTE, cells: stamps };
}

function collect(input: StatePlaneStampInput): PlaneStamp[] {
  const { payload, tool, args, cells, reader } = input;
  const out: PlaneStamp[] = [];
  const seen = new Set<string>();

  for (const spec of cells ?? []) {
    if (!spec) continue;
    // Only poll-backed cells can emit state:read handles. An event-signalled cell has no
    // resolver to re-read, even if a similarly named field happens to be present here.
    if (spec.changeSignal?.kind !== 'poll') continue;

    // P-019: never advertise a cell the reader may not read. `canReadCell` fails closed.
    if (reader && !canReadCell(spec, reader)) continue;

    const projections = [spec.changeSignal, ...(spec.doorProjections ?? [])];
    for (const projection of projections) {
      if (projection.tool !== tool) continue;
      const path = projection.path;
      if (typeof path !== 'string' || path.length === 0) continue;

      // OWN-KEY existence — a present-and-null value still stamps. See the header.
      if (!pathExists(payload, path).exists) continue;

      // Two cells declaring the same path would emit two competing handles for one value.
      // Keep the first (registration order) and skip the rest — deterministic, and a
      // duplicate is a registry defect to fix there, not something to render twice.
      if (seen.has(path)) continue;
      seen.add(path);

      out.push(stampFor(spec, path, args));
    }
  }

  // Deterministic output: registration order is an implementation detail of the registry,
  // and a payload whose block reorders between two reads invites a spurious diff.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * The handle half of a stamp: either a complete re-read call, or the reason one could
 * not be built. Split out from `stampFor` so the OTHER handle-emitting surface — the
 * coord:orient interest fold (P-011 of state-plane-interest-and-hardening-2026-08-21) —
 * shares this exact decision instead of growing a second, drifting copy of it.
 *
 * The two callers select their cells completely differently (this module by payload
 * path, the interest fold by the reader's live contexts), but "what does a usable
 * re-read call look like, and when is it honest to emit one" must not be answered
 * twice. `path` stays with the caller because only a door-payload stamp has one.
 */
export type CellHandle =
  | { reread: { tool: 'state:read'; args: { cell: string; as?: string } }; unreadable?: undefined }
  | { unreadable: { needs: string; why: string }; reread?: undefined };

/**
 * Build the re-read handle for one cell, given the SUBJECT the caller resolved for it.
 *
 * Emits `unreadable { needs }` and NO `reread` when a caller-relative cell has no
 * subject — never a bare unqualified handle. That asymmetry is the point: an
 * unqualified re-read of a caller-relative cell SUCCEEDS and answers confidently
 * about a different subject, which is strictly worse than refusing, because nothing
 * in the reply marks it as the wrong question.
 */
export function cellRereadHandle(spec: CellSpec, subject?: unknown): CellHandle {
  const rel = spec.callerRelativity;
  if (rel?.kind !== 'parameter') {
    // Global (or any non-parameter relativity): the handle is complete as-is.
    return { reread: { tool: 'state:read', args: { cell: spec.cell } } };
  }

  const param = rel.param;
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    return {
      unreadable: {
        needs: param,
        why:
          `this cell is caller-relative on "${param}" and this call supplied none, so a re-read could not be ` +
          `addressed to the same subject — call state:read { cell: '${spec.cell}', as: '<the ${param}>' } yourself ` +
          `rather than re-reading it unqualified, which answers about a different subject.`,
      },
    };
  }

  return { reread: { tool: 'state:read', args: { cell: spec.cell, as: subject } } };
}

function stampFor(spec: CellSpec, path: string, args: Record<string, unknown> | undefined): PlaneStamp {
  const rel = spec.callerRelativity;
  const subject = rel?.kind === 'parameter' ? args?.[rel.param] : undefined;
  return { path, cell: spec.cell, ...cellRereadHandle(spec, subject) };
}
