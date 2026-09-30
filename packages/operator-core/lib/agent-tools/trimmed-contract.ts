/**
 * trimmed-contract.ts — EI-20803112372029993.
 *
 * A tool may declare a `shape.trimmed` projection that REBUILDS each row from a
 * hardcoded allowlist. `trimmed` is the tier agents get BY DEFAULT. Nothing
 * checked that allowlist against the tool's own `guidance.returns` prose, so the
 * two drifted silently — and the failure is invisible in the worst way: the tool
 * returns `ok:true` with a well-formed row that is simply missing the field,
 * which reads as "this row has no such data" rather than "the shaper removed it".
 *
 * `routines:list` shipped this defect THREE times on the same allowlist:
 *   1. EI-19336000265007219 — `paused` dropped; a deliberate hold read as a stall.
 *   2. EI-20503768406496801 — `health` + `lastFiredAt` dropped, one field over.
 *   3. (this item) — `triggerKind` + `targetRole`, still dropped, while `returns`
 *      named all eleven row fields.
 *
 * Each fix added the missing field back and left a comment warning the next
 * author. Prose in a comment is not a mechanism; this file is the mechanism.
 *
 * ── WHY THE FIELD LIST IS DERIVED, NOT DECLARED ──────────────────────────────
 * The obvious fix is a second list on the tool (`trimmedContract: [...]`) that
 * the shaper is checked against. That is a THIRD hand-typed list beside the
 * `returns` prose and the allowlist, and it rots the same way the first two did.
 * Instead the contract's FIELDS come from the tool's own `returns` promise — the
 * sentence the agent actually reads — so the promise and the check are one
 * artifact. A tool opts in by naming only its row key, which is stable.
 *
 * ── WHY OPT-IN RATHER THAN A BLANKET RAIL ────────────────────────────────────
 * Measured population (2026-08-18): 21 tools declare `shape.trimmed`; 5 also
 * carry `returns`. A blanket "every trimmed shaper must preserve everything
 * promised" rail would be WRONG for at least `coord:orient`, whose trimmed tier
 * deliberately and correctly omits whole optional legs and says so in-band
 * (`optionalLegsOmitted`). Dropping data is that tool's job. The defect class is
 * specifically the ROW-REBUILD allowlist, so that is what this checks.
 */

import type { PayloadShapers } from '@papercusp/tooldef';

/**
 * Parse the documented `returns` convention: `Each row: { a, b, c }`.
 *
 * Returns null when the prose is not in that form — the caller must treat that
 * as "no derived contract", never as "the contract is empty" (an empty contract
 * passes vacuously, which is the failure mode this whole file exists to stop).
 */
export function parseReturnsRowFields(returns: unknown): string[] | null {
  if (typeof returns !== 'string') return null;
  const m = returns.match(/Each row:\s*\{([^}]*)\}/);
  if (!m) return null;
  const fields = m[1]
    .split(',')
    .map((f) => f.trim())
    .filter((f) => /^[A-Za-z_$][\w$]*$/.test(f));
  return fields.length > 0 ? fields : null;
}

/**
 * ── THE THREE CONTRACT AXES, AND WHY EACH EXISTS ─────────────────────────────
 *
 * `rows`/`fields` — the original axis. Guards the fields of ONE row array.
 *
 * `alsoRows` — ADDITIONAL row sets, each with its own required fields, judged
 * exactly like `rows`/`fields` per axis. Two jobs, and the first is what makes
 * the second reachable:
 *   1. SATISFY THE ENTRY GUARD. This check synthesises the envelope it feeds
 *      the shaper, and from `rows` alone it can only build one array. A shaper
 *      that bails unless SEVERAL arrays are present — `locks:list` is
 *      `if (!Array.isArray(d.resources) || !Array.isArray(d.holders)) return data`
 *      — therefore returned its input untouched, and the contract passed while
 *      asserting nothing. Naming the co-required sets gets the shaper to
 *      actually run. (The vacuity sentinel now catches this class outright, so
 *      it fails loudly instead of passing quietly.)
 *   2. GUARD A SECOND PROJECTOR. One tool often has two independent allowlists
 *      — `locks:list` rebuilds resource rows and holder rows separately, and
 *      each has ALREADY silently dropped a field once (`coordination_domain`
 *      from holders, EI-21733256625452096; `holders`/`held` from resources,
 *      EI-22073686775053989). A single `rows` axis can only ever guard one of
 *      them, so the other keeps the failure mode the pin exists to kill.
 *
 * `preserve` — TOP-LEVEL envelope keys that must survive trimming (WI-2145870).
 * `rows`/`fields` guard the row FIELDS; this guards the blocks beside the rows.
 * Guarding only rows misses this class's worst instance: `fleet:assignments`
 * emits a `scope` block ({agent, plan, fleet, harness, selfScoped, filtered})
 * and a hand-written reconstruction dropped it, so `summary` survived verbatim
 * while the caveat SCOPING it did not (EI-18763132241176410) — a self-scoped
 * `agents:1, claims:0` became indistinguishable from a measured-empty fleet.
 * Row fields are usually the VALUES; the newcomer at top level is usually the
 * QUALIFIER (scope, provenance, boundedness), and losing a qualifier while
 * keeping the values produces a confident WRONG reading rather than a visibly
 * missing one.
 *
 * ── WHY THE TYPE IS IMPORTED, NOT RESTATED ───────────────────────────────────
 * `contract` below is `PayloadShapers['contract']` — the SAME type a tool
 * declares against — deliberately, not a structural copy of it. A copy lets the
 * checker READ a field no tool may legally DECLARE, and that has now shipped
 * twice: `preserve` (EI-22616300370496224) and then `alsoRows`, each added here
 * and not to the tool-definition type. Both surfaced only as `TS2769: No
 * overload matches this call` at the first tool that tried to use them —
 * nowhere near the widening that caused it — and the tempting local fix (cast
 * the tool, or drop the field) silently weakens the guard instead. Extending
 * `PayloadShapers` is the durable fix; importing it is what makes forgetting to
 * impossible.
 */
export interface TrimmedContractSubject {
  /** Tool name, for the failure message. */
  name: string;
  /** The tool's `shape` block. */
  shape?: {
    trimmed?: (data: unknown, sctx: { args: unknown; tier: 'trimmed' | 'standard' }) => unknown;
    contract?: PayloadShapers['contract'];
  };
  /** The tool's `guidance.returns` prose. */
  returns?: unknown;
}

export interface TrimmedContractViolation {
  tool: string;
  /** Fields the `returns` promise names that the trimmed shaper did not emit. */
  dropped: string[];
  /** Every field the contract required, for the message. */
  required: string[];
  /**
   * Top-level `contract.preserve` keys the trimmed shaper did not emit. Reported
   * separately from `dropped` because the remedy differs: a row-field drop is
   * usually an incomplete row allowlist, a top-level drop is usually a
   * hand-written envelope reconstruction that forgot a block.
   */
  droppedTopLevel?: string[];
  detail: string;
}

/**
 * A sentinel value per field. Distinct non-null strings, so a shaper that maps
 * a field through `?? null` still yields something we can see, and a shaper that
 * drops the key entirely is distinguishable from one that nulls it.
 *
 * Nulling a promised field is NOT treated as a drop: several shapers legitimately
 * null a field they cannot cheaply compute, and the key's presence is what tells
 * a reader "this row has no such data" rather than "the shaper removed it".
 */
/**
 * A key the check injects into every synthetic row, and which NO contract may
 * name in `fields`. It is what makes VACUITY OBSERVABLE (WI-2145871 wake-7).
 *
 * A shaper that REBUILDS each row from a key list cannot emit this key — so its
 * absence proves the shaper actually ran and that a `fields` pin has teeth. A
 * shaper that instead SPREADS the row, returns a shallow copy, or early-returns
 * its input WILL emit it, and in that case every pinned field "survives" without
 * the shaper asserting anything. That green is indistinguishable from a real one,
 * which is what makes it worse than no pin at all: the next reader counts the
 * tool as guarded and stops looking.
 *
 * Measured, not reasoned. Two instances were found by hand before this existed:
 *  - `coord:roster`'s `hasCallerLens(data) ? data : shape(...)` PASSTHROUGH branch
 *    (safe only because it keys off `projection`, which this check never sets);
 *  - `locks:list`, whose entry guard demands BOTH `resources` and `holders` be
 *    arrays while this check supplies only `contract.rows` — so the shaper
 *    early-returned its input and all six pinned holder fields passed vacuously.
 * Both were caught by a scratch probe a future author had no reason to re-run.
 * This makes the check itself the probe.
 */
const VACUITY_SENTINEL = '__contract_vacuity_sentinel__';

function syntheticRow(fields: readonly string[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const f of fields) row[f] = `__contract__${f}`;
  row[VACUITY_SENTINEL] = 1;
  return row;
}

/**
 * Check ONE tool. Returns null when the tool does not opt in, or when it opts in
 * but no field list can be resolved (that is reported separately by
 * `unresolvableContracts` — a tool that opts in and yields no fields must be
 * loud, not silently skipped).
 */
export function checkTrimmedContract(tool: TrimmedContractSubject): TrimmedContractViolation | null {
  const contract = tool.shape?.contract;
  const trimmed = tool.shape?.trimmed;
  if (!contract || typeof trimmed !== 'function') return null;

  const resolved = contract.fields ? [...contract.fields] : parseReturnsRowFields(tool.returns);
  const required = resolved ?? [];
  // WI-2145870: the top-level axis. A tool may guard either axis or both, so the
  // opt-in test is the UNION — a preserve-only contract is a legitimate subject.
  const alsoRows = Object.entries(contract.alsoRows ?? {}).filter(
    ([k, f]) => k !== contract.rows && f.length > 0,
  );
  const preserve = (contract.preserve ?? []).filter(
    (k) => k !== contract.rows && !alsoRows.some(([ak]) => ak === k),
  );
  if (required.length === 0 && preserve.length === 0 && alsoRows.length === 0) return null;

  const input: Record<string, unknown> = { [contract.rows]: [syntheticRow(required)] };
  // Same synthetic-sentinel method as the rows, one level out. A distinct prefix
  // so a top-level sentinel can never be confused with a row one while debugging.
  for (const key of preserve) input[key] = `__contract_top__${key}`;
  // After `preserve`, so a key named on both axes gets the ARRAY a row set needs
  // rather than a string that would re-trip the very entry guard this satisfies.
  for (const [key, fields] of alsoRows) input[key] = [syntheticRow(fields)];

  let out: unknown;
  try {
    out = trimmed(input, { args: {}, tier: 'trimmed' });
  } catch (err) {
    return {
      tool: tool.name,
      dropped: [],
      required,
      detail: `its trimmed shaper THREW on a synthetic ${contract.rows} row: ${String(err)}`,
    };
  }

  // VACUITY, axis-independent (WI-2145871 wake-7). A shaper that hands back the
  // very object it was given has asserted NOTHING, yet every pinned field and
  // every preserve key "survives" and the contract passes. This is the one
  // failure mode that cannot be caught by looking at what survived, because a
  // vacuous pass and a real one are byte-identical downstream — so catch it by
  // identity, before reading the result at all.
  if (out === input) {
    return {
      tool: tool.name,
      dropped: [],
      required,
      detail:
        `its trimmed shaper returned THE INPUT OBJECT ITSELF, so this contract asserts nothing — ` +
        `every pinned field "survived" only because the shaper never ran. The usual cause is an ` +
        `entry guard that needs more of the envelope than this check supplies: it builds ` +
        `{ ${contract.rows}: [1 row] } plus string sentinels, so a shaper requiring a SECOND array ` +
        `(e.g. \`if (!Array.isArray(d.a) || !Array.isArray(d.b)) return data\`) bails out untouched. ` +
        `Declare the co-required row sets via \`contract.alsoRows\` so the guard is satisfied, or — if ` +
        `the shaper genuinely has no axis a pin could hold — drop the contract and record it as ` +
        `\`reasoned\` in SHAPER_CONTRACT_EXEMPT instead of banking a green that means nothing.`,
    };
  }

  const envelope = (out as Record<string, unknown> | null) ?? {};
  // Presence, not value equality — mirroring the row axis, where a shaper that
  // nulls a field it cannot cheaply compute has still told the reader the key
  // exists. Only a REMOVED key is a drop.
  const droppedTopLevel = preserve.filter((k) => !(k in envelope));

  // A preserve-only contract must not be judged on rows it never promised. Guard
  // the rows axis behind its own opt-in, or a preserve-only tool would fail on
  // the synthetic empty row below and report a defect it does not have.
  if (required.length > 0) {
    const rows = envelope[contract.rows];
    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        tool: tool.name,
        dropped: [],
        required,
        ...(droppedTopLevel.length > 0 ? { droppedTopLevel } : {}),
        detail:
          `its trimmed shaper returned no \`${contract.rows}\` rows for a 1-row input — ` +
          `either \`contract.rows\` names the wrong key, or the shaper dropped the row set entirely.`,
      };
    }

    const emitted = new Set(Object.keys((rows[0] ?? {}) as Record<string, unknown>));
    // VACUITY on the row axis (WI-2145871 wake-7). The sentinel is on no
    // contract's field list, so a key-list rebuild CANNOT emit it. Seeing it back
    // means the row reached us by spread or copy — every pinned field survived
    // for free, and the pin is decoration.
    if (emitted.has(VACUITY_SENTINEL)) {
      return {
        tool: tool.name,
        dropped: [],
        required,
        ...(droppedTopLevel.length > 0 ? { droppedTopLevel } : {}),
        detail:
          `its trimmed shaper emitted a \`${contract.rows}\` row containing a key this check invented ` +
          `and no contract names, which is only possible if the row was SPREAD or copied rather than ` +
          `rebuilt from a key list. So \`fields\` is trivially satisfied here: it would stay green even ` +
          `if the tool stopped emitting every field it promises. Pin the axis that actually rebuilds ` +
          `(often the nested row projector), or record the tool as \`reasoned\` — a row-spreading shaper ` +
          `has no row axis a contract can hold, and a green that asserts nothing is worse than no pin, ` +
          `because the next reader counts it as guarded.`,
      };
    }
    const dropped = required.filter((f) => !emitted.has(f));
    if (dropped.length > 0) {
      return {
        tool: tool.name,
        dropped,
        required,
        ...(droppedTopLevel.length > 0 ? { droppedTopLevel } : {}),
        detail:
          `\`returns\` promises { ${required.join(', ')} } on each row, but the trimmed shaper — ` +
          `the tier agents get BY DEFAULT — emitted a row without ${dropped.map((d) => `\`${d}\``).join(', ')}. ` +
          `An allowlist that rebuilds the row drops anything not on it, and the result still reads ok:true, ` +
          `so the field looks absent from the data rather than removed by the shaper.` +
          (droppedTopLevel.length > 0
            ? ` It ALSO dropped the top-level ${droppedTopLevel.map((d) => `\`${d}\``).join(', ')}.`
            : ''),
      };
    }
  }

  // Each ADDITIONAL row set, judged on the same two questions as the primary axis:
  // did the shaper rebuild it (sentinel gone), and did every promised field survive
  // that rebuild? A tool with two independent allowlists needs both asked — see
  // `alsoRows`, where each of `locks:list`'s two projectors has already dropped a
  // field once, in a separate incident.
  for (const [key, fields] of alsoRows) {
    const extra = envelope[key];
    const axisRequired = [...fields];
    if (!Array.isArray(extra) || extra.length === 0) {
      return {
        tool: tool.name,
        dropped: [],
        required: axisRequired,
        ...(droppedTopLevel.length > 0 ? { droppedTopLevel } : {}),
        detail:
          `its trimmed shaper returned no \`${key}\` rows for a 1-row input, so the ` +
          `\`alsoRows.${key}\` axis asserts nothing — either that key is wrong, or the shaper ` +
          `dropped the whole row set.`,
      };
    }
    const emitted = new Set(Object.keys((extra[0] ?? {}) as Record<string, unknown>));
    if (emitted.has(VACUITY_SENTINEL)) {
      return {
        tool: tool.name,
        dropped: [],
        required: axisRequired,
        ...(droppedTopLevel.length > 0 ? { droppedTopLevel } : {}),
        detail:
          `its trimmed shaper emitted a \`${key}\` row still carrying this check's invented ` +
          `sentinel, so that row was spread or copied rather than rebuilt and the ` +
          `\`alsoRows.${key}\` pin is trivially satisfied. Pin the projector that rebuilds, or ` +
          `drop this axis rather than bank a green that asserts nothing.`,
      };
    }
    const missing = axisRequired.filter((f) => !emitted.has(f));
    if (missing.length > 0) {
      return {
        tool: tool.name,
        dropped: missing,
        required: axisRequired,
        ...(droppedTopLevel.length > 0 ? { droppedTopLevel } : {}),
        detail:
          `\`alsoRows.${key}\` promises { ${axisRequired.join(', ')} } on each row, but the trimmed ` +
          `shaper — the tier agents get BY DEFAULT — emitted a \`${key}\` row without ` +
          `${missing.map((d) => `\`${d}\``).join(', ')}. A second allowlist in the same shaper drops ` +
          `anything not on it just as silently as the first, and the result still reads ok:true.`,
      };
    }
  }

  if (droppedTopLevel.length === 0) return null;

  return {
    tool: tool.name,
    dropped: [],
    required,
    droppedTopLevel,
    detail:
      `its trimmed shaper dropped the top-level ${droppedTopLevel.map((d) => `\`${d}\``).join(', ')} ` +
      `promised by \`contract.preserve\`. The rows survived, so the result reads ok:true and complete — ` +
      `but a top-level block is typically the QUALIFIER on those rows (scope, provenance, boundedness), ` +
      `and losing it while keeping the values yields a confident WRONG reading rather than a visibly ` +
      `missing one: a self-scoped \`agents:1, claims:0\` becomes indistinguishable from a measured-empty ` +
      `fleet. A hand-written envelope reconstruction drops anything it does not name.`,
  };
}

/**
 * Tools that OPT IN (`shape.contract`) but from which NO axis can be resolved.
 * Reported loudly: such a tool would otherwise pass vacuously, which is
 * indistinguishable from a real pass.
 *
 * "Vacuous" must be judged on the SAME union `checkTrimmedContract` opts in on,
 * or this reports a tool it fully checks. WI-2145870 added the top-level
 * `preserve` axis as an INDEPENDENT one, so a preserve-only contract resolves no
 * row fields BY DESIGN and is still completely checked — the row axis is guarded
 * behind its own `required.length > 0`. Judging resolvability on the row axis
 * alone called that vacuous and, since the live-registry assertion requires this
 * list to be empty, made a preserve-only opt-in unlandable: exactly the repair
 * shape this class's confirmed instance needs (`fleet:assignments` dropped a
 * top-level `scope` block, EI-18763132241176410).
 */
export function unresolvableContracts(tools: readonly TrimmedContractSubject[]): string[] {
  return tools
    .filter((t) => t.shape?.contract && typeof t.shape.trimmed === 'function')
    .filter((t) => {
      const c = t.shape!.contract!;
      const fields = c.fields ? [...c.fields] : parseReturnsRowFields(t.returns);
      // Same exclusion as checkTrimmedContract: `rows` names the row CONTAINER,
      // so preserving it is not a top-level guarantee and cannot make a contract
      // resolvable on its own.
      const preserve = (c.preserve ?? []).filter((k) => k !== c.rows);
      if (preserve.length > 0) return false;
      return !fields || fields.length === 0;
    })
    .map((t) => t.name);
}

export function trimmedContractViolations(
  tools: readonly TrimmedContractSubject[],
): TrimmedContractViolation[] {
  const out: TrimmedContractViolation[] = [];
  for (const t of tools) {
    const v = checkTrimmedContract(t);
    if (v) out.push(v);
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * COVERAGE — EI-21353488282456582.
 *
 * The contract above is opt-in, deliberately: a blanket "every trimmed shaper
 * must preserve everything promised" rail would be wrong for `coord:orient`,
 * whose trimmed tier correctly omits whole optional legs and says so in-band.
 * That reasoning still holds and is not what this section changes.
 *
 * What it changes is that opt-in with nothing forcing the choice is opt-in
 * nobody takes. Measured 2026-09-05, 18 days after this file landed (commit
 * 0e42cc6295, 2026-08-18): exactly ONE of the 22 tools declaring a payload
 * shaper had opted in — `routines:list`,
 * the tool whose three repeated defects motivated building the mechanism. The
 * guard covered its own motivating instance and nothing else, which is
 * indistinguishable from a guard that works until a second instance appears.
 *
 * The coverage assertion that should have caught that read
 * `expect(optedIn.length).toBeGreaterThanOrEqual(1)`. The instinct was right —
 * its comment says "if this drops to zero the suite above is green because it
 * checked nothing" — but the floor was set at the then-current population of
 * one, and nothing ratchets it, so a single adopter satisfies it forever.
 *
 * So this does not widen the contract. It forces a DECISION: a tool declaring
 * a payload shaper either opts in (`shape.contract`), or is listed in
 * SHAPER_CONTRACT_EXEMPT with a reason. Adding a shaper without classifying it
 * fails the build. That is the same inversion that works elsewhere in this repo
 * — a live-population scan where every member must be a deliberate
 * covered/exempt decision, rather than an allowlist that only grows.
 *
 * The check is BIDIRECTIONAL on purpose. An exemption naming a tool that no
 * longer declares a shaper is reported too: a one-way list rots into a set of
 * claims about code that has moved, which is the failure this file's header
 * already names for hand-typed lists.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Why an entry is not opted in. The two cases are governed DIFFERENTLY and must
 * not be conflated — mirroring `DarkCase` in libs/flags, where a reasoned
 * kill-switch and an unfinished-work parking slot share one list but only the
 * parking subset is rationed by a watermark.
 *
 * - `reasoned` — a deliberate decision that this shaper should not carry a row
 *   contract. Not rationed; it is an answer, not debt.
 * - `unclassified-baseline` — DEBT. Nobody has audited this shaper yet. It
 *   predates the coverage gate and is recorded only so the gate can fail on
 *   anything NEW. Rationed by SHAPER_BASELINE_HIGH_WATERMARK and shrink-only.
 *
 * Recording debt as though it were a decision is the failure this split exists
 * to prevent: it would make the gate read fully-covered while 21 shapers had
 * never been looked at.
 */
export type ShaperExemptionCase = 'reasoned' | 'unclassified-baseline';

export interface ShaperExemption {
  case: ShaperExemptionCase;
  reason: string;
}

/**
 * Tools that declare a payload shaper and are not opted in to the row contract.
 *
 * Every entry needs a REASON, not a placeholder — the reason is what a later
 * reader uses to decide whether it still holds. Seed and re-seed this from a
 * measuring run over the live registry (the coverage test names every offender
 * on failure), never from a grep: a filename glob is wrong in both directions
 * here — `policy-shape.ts` is not a payload shaper at all, while
 * `work_items/search.ts`, `scheduler/running.ts` and `fleet_registry/status.ts`
 * each declare one with no `*-shape.ts` file to glob.
 */
export const SHAPER_CONTRACT_EXEMPT: Readonly<Record<string, ShaperExemption>> = {
  'coord:orient': {
    case: 'reasoned',
    reason:
      'Its trimmed tier deliberately omits whole optional legs and says so in-band via ' +
      '`optionalLegsOmitted`. Dropping data is this tool\'s job, so a preserve-everything ' +
      'contract would be actively wrong for it (see this file\'s header).',
  },

  // ── BASELINE (debt, shrink-only) ─────────────────────────────────────────
  // Measured 2026-09-05 from the live registry by the coverage test below.
  // These predate the gate and have NOT been audited. Removing one — by opting
  // it in, or by promoting it to `reasoned` after actually looking — is the
  // intended direction of travel. See SHAPER_BASELINE_HIGH_WATERMARK.
  // RETIRED 2026-09-16 (WI-2145871): `agent_tools:list` now opts in with
  // `contract: { rows: 'tools', fields: [the 4 unconditional `base` keys] }`.
  // `project()` rebuilds each row FROM LITERALS, so the pin is load-bearing: a
  // field added to the handler's tools[] mapping and not to that literal is
  // dropped silently at `trimmed`, the DEFAULT read. `fields` is the
  // INTERSECTION of both tiers' unconditional keys — the standard-tier extras
  // (reason/composition/when) sit behind a tier branch. No top-level `preserve`:
  // the envelope is `{ ...d, tools }`, a SPREAD, so a preserve pin would be
  // TRIVIALLY SATISFIED. Falsifiability measured, not assumed
  // (.papercusp/scratch/wi2145871-final-two-teeth.mts, 12/12).
  // RETIRED 2026-09-16 (WI-2145871): `coord:presence` opts in on the ROW axis
  // with `contract: { rows: 'active', fields: [...11 every-tier fields],
  // preserve: ['agents'] }`. Its `project()` rebuilds each row from a key list,
  // so `fields` is the axis with teeth; the top-level axis is weak there
  // (`baseData = { ...d }` passes any other key through untouched).
  // RETIRED 2026-09-16 (WI-2145871): `coord:roster` delegates to the SAME
  // shapeCoordPresence and now carries the same row pin. Its shape block has a
  // passthrough branch (`hasCallerLens(data) ? data : shape(...)`), so the pin was
  // only safe to copy after checking that this check's synthetic input does not
  // trip it — `hasCallerLens` is `!!data.projection`, a key we never set, so the
  // real shaper runs. A passthrough branch keyed off `rows`/`preserve` instead
  // WOULD make a contract vacuous while still passing.
  // RETIRED 2026-09-16 (WI-2145871): `fleet:assignments` — the class's CONFIRMED
  // instance — now opts in with `contract: { rows: 'agents', preserve: ['ok',
  // 'summary'] }`. EI-18763132241176410's re-add of the dropped top-level
  // `scope` block was bespoke, so the pin is what stops the next key from going
  // the same way.
  // RETIRED 2026-09-16 (WI-2145871): `fleet:leader-brief` now opts in with
  // `contract: { rows: 'members', preserve: ['ok', 'leaderBriefProjection'] }`.
  // The mutative accumulator noted here is real and is what makes the pin safe
  // (a key can only appear by explicit addition, so the row-vacuity sentinel
  // cannot leak). The reason it stayed baseline debt longest is separate and
  // worth keeping: its shaper has a SECOND emission path this check cannot
  // reach — past LEADER_BRIEF_SHAPER_BUDGET_CHARS it abandons `buildProjection`
  // for a hand-built emergency object with a different key set. The synthetic
  // envelope is far under that ceiling, so a pin verified here alone can be
  // green while production drops the key. Its `preserve` is therefore the
  // intersection of both paths' UNCONDITIONAL keys; see the comment on the tool.
  // RETIRED 2026-09-16 (WI-2145871): `fleet:status` now opts in with
  // `contract: { rows: 'members', fields: [the 9 unconditional `base` keys] }` —
  // the first entry in this audit whose row axis was PINNABLE rather than
  // vacuous, and the pin is load-bearing: `projectMember` rebuilds each row FROM
  // LITERALS, so a field added to the handler's members[] mapping and not to that
  // literal is dropped silently at both non-full tiers, `trimmed` being the
  // DEFAULT read. WI-7286 lost `lifecycleBackoff` exactly that way.
  //
  // ⚠ The LEADER_BRIEF_SHAPER_BUDGET_CHARS second-emission-path caveat in the
  // comment ABOVE belongs to `fleet:leader-brief`, NOT to this tool — they are
  // adjacent here and the two were conflated once during this audit. `fleet:status`
  // has ONE emission path. Verify at the emission site, never from the neighbouring
  // comment.
  //
  // `fields` is the INTERSECTION of every return path's UNCONDITIONAL keys. No
  // top-level `preserve`: the envelope is `{ ...d, … }`, a SPREAD, so a preserve
  // pin would be TRIVIALLY SATISFIED — green while asserting nothing.
  // Falsifiability measured, not assumed (.papercusp/scratch/fleet-status-contract-teeth.mts,
  // 4/4): an absent key is caught, a CONDITIONAL key (`lastToolCallAt`) is caught,
  // and the same contract over an identity passthrough is refused as vacuous —
  // which is what makes the clean verdict attributable to key survival.
  // RETIRED 2026-09-16 (WI-2145871): `harness_docs:list` now opts in on BOTH
  // axes — `contract: { rows: 'entries', fields: [the 4 trimmed-tier keys],
  // preserve: [ok, activePath, filesCount, content, activeEntry] }`. It is the
  // first entry in this audit whose TOP-LEVEL axis was also pinnable: unlike the
  // `{ ...d }` spreads elsewhere in this file, its envelope is a hand-written
  // literal, so a dropped qualifier goes silently and `preserve` has teeth.
  //
  // ⚠ SECOND EMISSION PATH this check cannot reach: with `docId` supplied the
  // shaper returns a different envelope (entries suppressed for `entriesCount` +
  // `entries_suppressed`). This check invokes shapers with `args: {}`, so
  // `docIdRequested` is always false here and only the main path is exercised —
  // same class as fleet:leader-brief's budget path. `preserve` is therefore the
  // INTERSECTION of BOTH paths' UNCONDITIONAL keys; `entries` is deliberately
  // excluded (main-path only, and already the `rows` axis).
  // Falsifiability measured (.papercusp/scratch/wi2145871-final-two-teeth.mts,
  // 12/12): a dropped top-level `activePath` is CAUGHT, and the probe's
  // CALIBRATION arm against a spreading shaper DID surface the sentinel, so the
  // clean verdict is attributable to key survival rather than a dead probe.
  // AUDITED 2026-09-16 (WI-2145871): `logs:read` is `reasoned`, not debt — the
  // first shaper here MEASURED to have no axis a contract could hold.
  // `shapeLogsRead` returns `{ ...d, entries: kept }` (top-level SPREAD), and its
  // rows come from `clipEntry`, which returns the row untouched or `{ ...r,
  // message, clipped }` (row-level SPREAD). Both axes pass any key through, so a
  // `fields` or `preserve` pin would be TRIVIALLY SATISFIED — green while
  // asserting nothing about what the tool emits. That is WORSE than no pin: the
  // next reader counts it as guarded and stops looking.
  // Measured, not read — .papercusp/scratch/logs-read-contract-teeth.mts feeds the
  // real shaper a sentinel on each axis. Both survived, the shaper provably ran
  // (no early return via the empty-`entries` guard), and the CALIBRATION arm (the
  // same assertion against presence's key-list rebuild) DID drop its sentinel — so
  // "survived" is a finding, not what a broken probe also prints.
  // What can actually regress here is the entries BUDGET and the `payloadBounded`
  // marker: behavioural, not key-presence, and covered by this shaper's own tests.
  'logs:read': {
    case: 'reasoned',
    reason:
      'No axis a row contract could hold: the envelope spreads (`{ ...d, entries }`) ' +
      'and clipEntry spreads each row, so any pin is vacuous. Established with a ' +
      'calibrated teeth probe rather than inferred from reading. Its real failure ' +
      'mode is the entries budget, which is behavioural and separately tested.',
  },
  // RETIRED 2026-09-16 (WI-2145871): `plans:attention` opts in with
  // `contract: { rows: 'groups', preserve: ['tierCounts','itemsTotal','top','hint'] }`.
  // WI-2145871 audit. Unlike its `plans:list` / `plans:items` siblings — which
  // rebuild each row from an object literal and so can hold a real `fields` pin
  // — every emission site in get-shape.ts is a SPREAD of its input: the envelope
  // (`{ ...d, payloadTier, results }`), the result row (`const out = { ...r }`),
  // and the items / decisions / section maps (`{ ...rest }`, `{ ...rec }`,
  // `{ ...section }`). A pinned key therefore survives because it was spread,
  // not because the shaper re-emitted it, so the pin can never fail.
  // PROVED, not inferred — that same "it structurally must survive" reasoning
  // was wrong for fleet:leader-brief, whose second path was hand-built. See
  // `.papercusp/scratch/plans-get-contract-teeth.mts`: a sentinel key the shaper
  // never emits survived on BOTH the row axis and the envelope, while the
  // CALIBRATION control (`linkedFeatures` — deleted by the trimmed tier, kept by
  // standard) was correctly observed ABSENT. Without that control, "everything
  // survived" is what a probe that cannot see an absent key prints anyway.
  'plans:get': {
    case: 'reasoned',
    reason:
      'No axis a row contract could hold: the envelope spreads ' +
      '(`{ ...d, payloadTier, results }`) and shapeResult spreads each result row ' +
      '(`{ ...r }`), as do its items/decisions/section maps, so any pin is vacuous. ' +
      'Established with a calibrated teeth probe rather than inferred from reading. ' +
      'Its real failure modes are the prose/section/decision BUDGETS and the ' +
      'narrowed-read carve-outs, which are behavioural and separately tested.',
  },
  // RETIRED 2026-09-16 (WI-2145871): `plans:items` opts in with
  // `contract: { rows: 'items', fields: [the 13 `base` keys] }` — the ROW axis,
  // the one shapePlansItems rebuilds from an object literal. No `preserve`, for
  // the same reason as `plans:list` below. Its SECOND emission path (the over-cap
  // `(truncated)` sentinel row, unreachable by this check's 1-row input) is
  // proven key-complete by `.papercusp/scratch/plans-items-contract-teeth.mts`
  // rather than inferred — see the note on the tool.
  // RETIRED 2026-09-16 (WI-2145871): `plans:list` opts in with
  // `contract: { rows: 'plans', fields: [the 12 `base` keys] }` — the ROW axis,
  // the one shapePlansList rebuilds from an object literal. Deliberately no
  // `preserve`: it returns `{ ...data, plans: rows }`, so every top-level key
  // survives unconditionally and a pin there would be green forever while
  // guarding nothing.
  // RETIRED 2026-09-16 (WI-2145871): `scheduler:running` opts in with
  // `contract: { rows: 'runs', preserve: ['ok','summary'] }`.
  //
  // AUDITED 2026-09-16 (WI-2145871): `testing:coverage` and `testing:runs` are
  // `reasoned`, not debt — and they are the only two entries here that were
  // OPTED IN and then DEMOTED. Both were caught by this file's own vacuity
  // sentinel on its first run against the live catalog: each emitted a row key
  // the check invents and no contract names, which only a SPREAD can do. Their
  // pins had been green since the day they were written and had never asserted
  // anything.
  //
  // The calibration is the same run, not a separate probe: 32 sibling tools pass
  // the identical sentinel check, and the detector distinguishes `out === input`
  // (the shaper early-returned) from sentinel-survived (the shaper RAN and
  // spread). Both landed in the second bucket, so "the shaper ran" is measured.
  //
  // `testing:coverage` is the instructive one, and the reason this comment is
  // long: its 13-field row allowlist was CORRECT about `readCoverage`, the
  // handler, which really does rebuild each row from an explicit key list. But a
  // contract is checked against the SHAPER, and `shapeTestingCoverage` only drops
  // whole rows to bound size. So the list could be verified line-by-line against
  // the source and still guard nothing — the general trap this lane keeps
  // meeting, in its sharpest form: A FIELD LIST CAN DESCRIBE THE HANDLER WHILE
  // THE CHECK EXERCISES ONLY THE SHAPER.
  'testing:coverage': {
    case: 'reasoned',
    reason:
      'No axis a row contract could hold: `shapeTestingCoverage` bounds size by ' +
      'dropping whole rows and passes each surviving row through untouched, so a ' +
      'row pin is vacuous. Its former 13-field allowlist described the HANDLER ' +
      '(`readCoverage`), which is not what a contract checks. Measured by this ' +
      "file's vacuity sentinel against the live catalog, with 32 passing siblings " +
      'as the control. Its real failure mode is the row budget and the ' +
      '`payloadBounded` marker — behavioural, and separately tested.',
  },
  'testing:runs': {
    case: 'reasoned',
    reason:
      'No axis a row contract could hold: `projectTestingRun` spreads each row ' +
      '(`{ ...r, … }`) and the envelope spreads too (`{ ...d, runs: kept }`), so ' +
      'both `fields` and `preserve` are trivially satisfied. Measured by this ' +
      "file's vacuity sentinel against the live catalog, with 32 passing siblings " +
      'as the control. Its real failure mode is the row budget and outputTail ' +
      'clipping — behavioural, and separately tested.',
  },
  // RETIRED 2026-09-16 (WI-2145871): `work_items:burn_down` opts in on the ROW
  // axis with `contract: { rows: 'inFlight', fields: [...12 unconditional
  // projectRow keys], preserve: ['counts','presentation','parked','unclaimed'] }`.
  // All three buckets share projectRow, so one bucket guards all three.
  // AUDITED 2026-09-16 (WI-2145871): `work_items:claim` and `work_items:complete`
  // are `reasoned`, and they are the first pair here retired by ONE audit — they
  // genuinely share `shapeWorkItemWriteEcho` (verified at the IMPORT SITES,
  // claim.ts:37 and complete.ts:185, not inferred from the shared `work_items:`
  // prefix — that inference was FALSE for the plans cluster, which has three
  // separate shape modules).
  //
  // This one is worth reading before writing another pin, because the shaper DOES
  // contain a real allowlist and it still cannot be guarded here. `compactWorkItemRef`
  // rebuilds from an object literal of exactly 6 keys — the one place a new WorkItem
  // field would be silently dropped — but it sits at `results[i].workItem`, one level
  // BELOW the row, and `contract.fields` only inspects `rows[0]`'s own keys. So the
  // guardable thing and the expressible thing are not the same thing.
  //
  // PROVED, not inferred — `.papercusp/scratch/write-echo-contract-teeth.mts` (exit 0).
  // Both calibration controls discriminate, which is what makes the vacuity verdict
  // mean anything: CONTROL A — a sentinel nested inside `workItem` comes back ABSENT
  // (so the probe can see a dropped key at all); CONTROL B — `completion` /
  // `outputPayload` are absent at trimmed and PRESENT at standard, the same
  // both-directions control `plans:get` used. Without them, "every sentinel survived"
  // is what a probe that cannot observe absence prints against ANY shaper.
  'work_items:claim': {
    case: 'reasoned',
    reason:
      'No axis a contract could hold: the envelope spreads (`{ ...d, results }`) and ' +
      'each row spreads (`{ ...row }`), so both `preserve` and `fields` are trivially ' +
      'satisfied. Its one real allowlist (`compactWorkItemRef`, 6 literal keys) is ' +
      'NESTED at `results[i].workItem`, which `contract.fields` cannot address. ' +
      'Established with a calibrated teeth probe rather than inferred from reading. ' +
      'Its real failure mode is the write-echo diet itself (the compact ref and the ' +
      'dropped authored echoes) — behavioural, and separately tested.',
  },
  'work_items:complete': {
    case: 'reasoned',
    reason:
      'Same shaper as `work_items:claim` (`shapeWorkItemWriteEcho`, shared by import, ' +
      'not by name) and therefore the same verdict: envelope and rows both spread, so ' +
      'every contract-expressible axis is vacuous, and the only real rebuild is nested ' +
      'one level below the row where a `fields` pin cannot reach. Covered by the same ' +
      'calibrated probe.',
  },
  'work_items:list': {
    case: 'reasoned',
    reason:
      'Guardable but NOT EXPRESSIBLE — a different case from the spreading shapers ' +
      'above, and the distinction is the point. `project()` rebuilds every row from an ' +
      'object literal with 10 unconditional keys, so the drop-point is real and a ' +
      '`fields` pin would be meaningful. The checker cannot reach it: ' +
      '`shapeWorkItemsList` returns a BARE ARRAY and guards its entry with ' +
      '`if (!Array.isArray(data)) return data`, while checkTrimmedContract can only ever ' +
      'synthesize an OBJECT envelope `{ [contract.rows]: [syntheticRow] }`. The shaper ' +
      'therefore passthroughs that object untouched and a pin fails LOUDLY on the ' +
      'identity detector ("returned THE INPUT OBJECT ITSELF") rather than passing ' +
      'vacuously — so this is not a pin that would rot, it is a pin that cannot be ' +
      'written at all until the check can synthesize a root-array input. Measured with ' +
      'a calibrated teeth probe (.papercusp/scratch/work-items-list-contract-teeth.mts), ' +
      'not inferred: its controls confirm the literal rebuild (an invented key and a ' +
      'real non-emitted field both come back ABSENT at both tiers) and its calibration ' +
      'arm confirms an equivalent ENVELOPE shaper passes clean, so the refusal is about ' +
      'the payload shape and not the harness. Follow-up for the missing capability ' +
      '(a root-array axis, e.g. a reserved `rows: \'$root\'`): EI-23405908569258988.',
  },
  'work_items:search': {
    case: 'reasoned',
    reason:
      'Audited: no key-survival axis exists to pin, because this shaper never drops a key. ' +
      'Unlike work_items:list (a bare array the check cannot reach at all), shapeWorkItemsSearch ' +
      'IS a genuine envelope shaper and the check DOES reach it: it rejects arrays at search.ts:71 ' +
      'and requires `envelope.items` at :73, both satisfied by the synthetic `{ items: [row] }`. ' +
      'But the row projection (:82) is `{ ...match, title: clipped, summary: clipped }` and the ' +
      'envelope return (:94) is `{ ...envelope, items, ...conditional }` — both SPREADS, which ' +
      'overwrite and conditionally ADD keys but remove none. Its transformation axis is text ' +
      'CLIPPING (SEARCH_TIER_CAPS title/summary) and row CAPPING (.slice), orthogonal to the ' +
      "`fields` axis, which asserts key survival. So a pin would be decorative: green forever " +
      'while naming nothing. Measured with a calibrated teeth probe ' +
      '(.papercusp/scratch/work-items-search-contract-teeth.mts), not inferred — the check ' +
      "REFUSES the candidate pin itself on its own vacuity sentinel ('a key this check invented' " +
      'survived the spread), an invented key and an arbitrary extra field both survive at BOTH ' +
      'tiers, its negative control (rows past the cap absent) confirms the shaper really ran, and ' +
      'its calibration arm confirms an equivalent literal-rebuild envelope shaper passes clean.',
  },
};

/**
 * Ceiling on the `unclassified-baseline` subset — SHRINK-ONLY.
 *
 * Seeded at the measured population on 2026-09-05. It rations DEBT only;
 * `reasoned` exemptions are not counted, so recording a genuine decision never
 * has to fight this budget. Lower it as shapers get audited; raising it means
 * a new shaper shipped unclassified, which is what the gate exists to stop.
 *
 * 20 → 19 (a peer, before WI-2145871 was picked up).
 * 19 → 16 on 2026-09-16 (WI-2145871): `fleet:assignments`, `plans:attention`
 * and `scheduler:running` audited and opted in. All three REBUILD their
 * envelope — a hand-written key list or a fully literal object — so a
 * top-level key survives only by being named, which is the axis a
 * `contract.preserve` pin actually holds. The remaining 16 are not
 * interchangeable with these: most SPREAD their source envelope
 * (`{ ...d, rows }`), where no top-level key can be dropped and a preserve pin
 * would assert a key the tool has not been shown to emit. Those need the ROW
 * axis instead, and none of them carries `returns` prose in the
 * `Each row: { … }` form that derives it — so retiring them means writing that
 * promise (or a minimal `fields: [<identity>]` pin, as `work_items:get` does),
 * not another preserve list.
 * 16 → 15 on 2026-09-16 (WI-2145871): `coord:presence`, on the ROW axis rather
 * than the top-level one — see its entry above. It is the first retirement here
 * to pin `fields`, and the template for the rest: a shaper that REBUILDS its
 * rows is guarded by naming them, whichever way its envelope is assembled.
 * 15 → 14 on 2026-09-16 (WI-2145871): `work_items:burn_down`, a mutative `out`
 * accumulator — the shape where a key can ONLY appear by explicit addition, so
 * naming the rows is the whole guard.
 * 14 → 13 on 2026-09-16 (WI-2145871): `coord:roster`, reusing `coord:presence`'s
 * pinned set verbatim because it delegates to the same shaper. Note what made
 * that safe: its shape block has a PASSTHROUGH branch, and a contract is vacuous
 * if this check's synthetic input trips one. It does not here — the branch keys
 * off `data.projection`, which the check never sets — but a passthrough keyed off
 * the `rows`/`preserve` keys instead would pass while asserting nothing. Check
 * the branch condition, not just that the suite goes green.
 * 13 → 12 on 2026-09-16 (WI-2145871): `logs:read` — the first retirement here that
 * is an ANSWER rather than a pin. Promoted to `reasoned` because a calibrated probe
 * showed it has NO axis a contract could hold: both its envelope and its rows
 * spread. Note the two outcomes are NOT interchangeable even though they shrink
 * this number by the same 1 — recording a vacuous pin would have left the shaper
 * genuinely unguarded while LABELLING it guarded, which costs the next reader more
 * than the debt entry did. Prefer `reasoned` whenever the probe shows both axes
 * pass keys through.
 * (The per-step lines above stop at 13 → 12; the retirements between 12 and 7 are
 * recorded as inline `RETIRED 2026-09-16` comments at each entry instead. Both
 * conventions are in use here — read the entries, not just this changelog.)
 * 7 → 5 on 2026-09-16 (WI-2145871): `work_items:claim` and `work_items:complete`,
 * the first pair retired by ONE audit — they genuinely share `shapeWorkItemWriteEcho`
 * (verified at the import sites, not assumed from the shared prefix). Both `reasoned`:
 * envelope and rows spread, so every expressible axis is vacuous. The instructive part
 * is that this shaper DOES have a real allowlist — `compactWorkItemRef`'s 6 literal
 * keys — and it still cannot be pinned, because it is nested one level below the row
 * and `contract.fields` only reaches `rows[0]`. A shaper can be genuinely guardable
 * and still have no axis THIS contract can express; recording that is the honest
 * outcome, and a pin written anyway would have been green forever.
 *
 * 5 → 4 on 2026-09-16 (WI-2145871): `work_items:list`, a THIRD distinct reason for
 * `reasoned` and the first that is not about spreading at all. Its row projector is a
 * textbook literal rebuild — 10 unconditional keys — so unlike the shapers above there
 * genuinely IS something to guard. It cannot be reached: the payload is a BARE ARRAY,
 * and this check only ever synthesizes an object envelope, so the shaper's
 * `!Array.isArray(data)` entry guard hands the input straight back and a pin fails
 * LOUDLY on the identity detector instead of rotting quietly. Measured with a
 * calibrated probe whose ARM C confirms an equivalent envelope shaper passes clean, so
 * the refusal is the payload shape and not the harness. The missing capability — a
 * root-array axis — is EI-23405908569258988; until it exists this is unpinnable, not
 * unaudited.
 */
// WI-2145871 CLOSED 2026-09-16: the baseline debt class is fully retired — every
// tool that predated the gate has now been AUDITED, either opted in on a real
// axis or recorded as `reasoned` after measurement. Zero is the floor and this
// list stays SHRINK-ONLY, so a new `unclassified-baseline` entry can no longer be
// added without a deliberate, visible watermark raise. New tools must classify
// themselves at authoring time rather than inheriting an unaudited grace period.
export const SHAPER_BASELINE_HIGH_WATERMARK = 0;

export interface ShaperClassification {
  /** Declares a shaper but is neither opted in nor exempt — an undecided tool. */
  unclassified: string[];
  /** Exempt but no longer declares a shaper — the exemption has gone stale. */
  staleExemptions: string[];
  /** Entries recorded as unaudited debt, rationed by the watermark. */
  baseline: string[];
}

/**
 * Classify every tool that declares a payload shaper.
 *
 * `unclassified` is the build-failing set: a shaper nobody decided about. An
 * empty result means every declared shaper is a deliberate choice, NOT that
 * every shaper preserves every field — that stronger property is what
 * `trimmedContractViolations` checks, and only for the opted-in subset.
 */
export function classifyDeclaredShapers(
  tools: readonly TrimmedContractSubject[],
  exempt: Readonly<Record<string, ShaperExemption>> = SHAPER_CONTRACT_EXEMPT,
): ShaperClassification {
  const declaresShaper = (t: TrimmedContractSubject): boolean =>
    typeof t.shape?.trimmed === 'function';

  const unclassified = tools
    .filter(declaresShaper)
    .filter((t) => !t.shape?.contract)
    .filter((t) => !Object.prototype.hasOwnProperty.call(exempt, t.name))
    .map((t) => t.name)
    .sort();

  const declaring = new Set(tools.filter(declaresShaper).map((t) => t.name));
  const staleExemptions = Object.keys(exempt)
    .filter((name) => !declaring.has(name))
    .sort();

  // Counted from the LIVE population, not from the literal's length: an entry
  // for a tool that no longer declares a shaper is stale, and counting it here
  // would let the watermark be satisfied by debt that has already evaporated.
  const baseline = Object.entries(exempt)
    .filter(([name, e]) => e.case === 'unclassified-baseline' && declaring.has(name))
    .map(([name]) => name)
    .sort();

  return { unclassified, staleExemptions, baseline };
}
