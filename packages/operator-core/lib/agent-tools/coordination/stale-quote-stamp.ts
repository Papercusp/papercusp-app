/**
 * stale-quote-stamp.ts — stamp stale-value QUOTING at the coord:send chokepoint
 * (state-plane-adoption-2026-08-02 P-011).
 *
 * WHY THIS EXISTS. The state plane's standing rule is "about to QUOTE a value
 * into a message? RE-READ it, don't copy it" — and D-084 R3's own measurement
 * (state:read called FOUR times in seven days, fleet-wide) says that rule is
 * almost never followed. This module makes the violation VISIBLE at the one
 * moment it can be measured: a message that cites a registered cell while the
 * sender's invocation log holds no fresh read of that cell's door.
 *
 * ⚠ WHAT COUNTS AS "CITING A CELL" — the honest subset, stated up front.
 * Detection matches a cell's IDENTITY in section text: its registered id
 * (`gate.greenCheckpoint.verdict`) or a DOTTED payload path the registry itself
 * declares for it (`changeSignal.path`, `doorProjections[].path` — e.g.
 * `gate.consecutiveReds`, `positions.deployed`). It deliberately does NOT match:
 *   • bare field tokens (`deployedSha`, `claimState`) — they collide with
 *     ordinary tool-payload prose (a work-item's claimState is not the gate
 *     cell's), and a false "this has a registered cell" is a false accusation,
 *     the one thing every stamp in this seam is built to never make;
 *   • raw VALUES (a quoted sha) — attributing a bare sha to a cell truthfully
 *     requires resolving the cell at send (git commands on the hot path) or a
 *     result-payload ledger this system does not keep. Widening to values is a
 *     future item once either exists; a narrow true detector beats a broad
 *     guessing one (the same scoping `coupling-divergence-stamp.ts` shipped
 *     with: `owns`/`other` are simply not comparable, and saying so is the
 *     contract, not a gap).
 *
 * "THIS TURN" IS THE BASED-ON WINDOW, on purpose. The invocation log has no
 * turn boundary for interactive sessions (D-030's spawn_id near-miss), and
 * `basedOn` already approximates "this unit of work" as BASED_ON_WINDOW_MS.
 * Reusing the SAME constant keeps the two provenance features from drifting
 * into near-synonym windows (D-041) — a message's basedOn trace and its
 * stale-quote verdicts describe the same window of the sender's reading.
 *
 * ⚠ FAIL-SOFT, TOTAL, NEVER LOAD-BEARING ON THE SEND — and UNKNOWN NEVER
 * ACCUSES. Same contract as `resolvePremiseStamps` / the coupling diff: any
 * failure degrades to an empty stamp list. Sharper here: a FAILED read of the
 * invocation ledger returns NO stamps rather than stamping every detection
 * `quoted-without-fresh-read` — absence of evidence of a read is only evidence
 * of stale quoting when the ledger actually answered.
 *
 * ⚠ D-090: A STAMP IS DATA ABOUT THE FLEET'S HABITS, NEVER A FAULT. Do not
 * wire this to a warning, a nag, a refusal, or a per-sender score. Read it in
 * AGGREGATE (the D-030-style adoption re-measure queries the stamps). All
 * detections ride with their verdicts — the denominator is the point: "3
 * quoted-without-fresh-read" cannot be read without "out of how many cites".
 *
 * ⚠ EVERY IO DEPENDENCY IS IMPORTED DYNAMICALLY, inside the resolver — the
 * same load-graph contract as the two sibling stamp modules, for the same
 * measured reason (EI-19281789650149592: one static import made a 95-test
 * suite uncollectable through a partial mock).
 */
import { BASED_ON_WINDOW_MS } from './based-on';

/** One cell citation in one section, scored against the sender's read window. */
export interface StaleQuoteStamp {
  /** Index of the section that carried the citation. */
  section: number;
  /** The registered cell the citation names. */
  cell: string;
  /** The exact token that matched — the sender's own words, never invented. */
  token: string;
  verdict: 'fresh-read' | 'quoted-without-fresh-read';
}

export const STALE_QUOTE_FIELD = 'staleValueQuotes';

/** Bound on the stamp list — sections × cells is quadratic in principle. */
export const STALE_QUOTE_STAMPS_MAX = 16;

/** Max invocation rows examined; mirrors based-on.ts's bound and reason. */
export const STALE_QUOTE_SCAN_ROWS = 200;

/**
 * A token must be DOTTED and at least this long to be matchable at all. Every
 * registered cell id is dotted; a registry path that is a bare field name
 * (`deployedSha`, `goalRef`) is excluded by the dot rule — see the header.
 */
export const STALE_QUOTE_TOKEN_MIN_CHARS = 8;

/** A section as this module reads it — structural, so any section shape fits. */
interface SectionTextLike {
  text?: unknown;
}

/**
 * The slice of a CellSpec this module consumes — structural, test-injectable.
 * `changeSignal` is an all-optional bag on purpose: the registry's real type is
 * the union `{ kind:'poll'; tool; path } | { kind:'event'; key }`, and only the
 * poll arm carries tool/path — so every read below guards for absence, and an
 * event-signalled cell contributes just its `cell` token (no door, no path).
 * `kind`/`key` are listed so both union arms share properties with this weak
 * type (TS2559) — they are never read here.
 */
export interface CellSpecLike {
  cell: string;
  changeSignal?:
    | { kind?: string; tool?: string; path?: string; key?: string }
    | undefined;
  doorProjections?: readonly { tool: string; path: string }[] | undefined;
}

export interface CellTokenIndex {
  /** matchable token → the ONE cell it names (ambiguous tokens are dropped). */
  tokens: ReadonlyMap<string, string>;
  /** cell id → door tools whose successful call counts as a fresh read of it. */
  doorsByCell: ReadonlyMap<string, readonly string[]>;
  /** every door tool, for the ledger query's IN list (state:read is implicit). */
  doorTools: readonly string[];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function tokenEligible(t: string): boolean {
  return t.length >= STALE_QUOTE_TOKEN_MIN_CHARS && t.includes('.');
}

/**
 * PURE. Derive the token index from the registry's own declarations — never a
 * hand-maintained list (the derived-truth ladder's first rung): a cell added,
 * renamed or re-pathed shows up here on its own.
 *
 * A token claimed by TWO different cells is dropped entirely: stamping either
 * cell off an ambiguous match would be a guess wearing a verdict.
 */
export function buildCellTokenIndex(specs: readonly CellSpecLike[]): CellTokenIndex {
  const tokens = new Map<string, string>();
  const ambiguous = new Set<string>();
  const doorsByCell = new Map<string, string[]>();
  const doorTools = new Set<string>();

  const claim = (token: string, cell: string): void => {
    if (!tokenEligible(token) || ambiguous.has(token)) return;
    const existing = tokens.get(token);
    if (existing && existing !== cell) {
      tokens.delete(token);
      ambiguous.add(token);
      return;
    }
    tokens.set(token, cell);
  };

  for (const spec of specs) {
    const cell = str(spec.cell);
    if (!cell) continue;
    claim(cell, cell);
    const doors: string[] = [];
    if (spec.changeSignal) {
      // Poll arm only — an event-signalled cell has neither path nor tool.
      const csPath = str(spec.changeSignal.path);
      if (csPath) claim(csPath, cell);
      const tool = str(spec.changeSignal.tool);
      if (tool) doors.push(tool);
    }
    for (const dp of spec.doorProjections ?? []) {
      claim(dp.path, cell);
      const tool = str(dp.tool);
      if (tool) doors.push(tool);
    }
    doorsByCell.set(cell, [...new Set(doors)]);
    for (const d of doors) doorTools.add(d);
  }
  return { tokens, doorsByCell, doorTools: [...doorTools] };
}

/**
 * PURE. The detections in a message, in section order, de-duplicated per
 * (section, cell) — a section that names one cell three ways is one citation.
 * This is also the COST GATE: nothing after it runs when it returns [].
 */
export function detectQuotedCells(
  sections: readonly SectionTextLike[],
  index: CellTokenIndex,
): Array<{ section: number; cell: string; token: string }> {
  const out: Array<{ section: number; cell: string; token: string }> = [];
  if (index.tokens.size === 0) return out;
  sections.forEach((s, i) => {
    const text = str(s?.text);
    if (!text) return;
    const seen = new Set<string>();
    for (const [token, cell] of index.tokens) {
      if (out.length >= STALE_QUOTE_STAMPS_MAX) return;
      if (seen.has(cell)) continue;
      if (!text.includes(token)) continue;
      seen.add(cell);
      out.push({ section: i, cell, token });
    }
  });
  return out;
}

/** One ledger row as the pure scorer sees it. */
export interface SenderReadRow {
  tool: string;
  args: unknown;
}

/**
 * PURE. Score detections against the sender's read window. A `state:read` of
 * the exact cell, or ANY successful call of a door that projects it, counts as
 * fresh — generous on purpose: the stamp must under-accuse, never over-accuse.
 */
export function scoreStaleQuotes(
  detected: readonly { section: number; cell: string; token: string }[],
  reads: readonly SenderReadRow[],
  index: CellTokenIndex,
): StaleQuoteStamp[] {
  const freshCells = new Set<string>();
  for (const row of reads) {
    if (row.tool === 'state:read') {
      const args =
        row.args && typeof row.args === 'object' ? (row.args as Record<string, unknown>) : {};
      const cell = str(args.cell);
      if (cell) freshCells.add(cell);
      continue;
    }
    for (const [cell, doors] of index.doorsByCell) {
      if (doors.includes(row.tool)) freshCells.add(cell);
    }
  }
  return detected.map((d) => ({
    ...d,
    verdict: freshCells.has(d.cell) ? 'fresh-read' : 'quoted-without-fresh-read',
  }));
}

/**
 * The one IO leg, injectable so the wrapper tests without a database.
 * Returns `null` — NOT `[]` — when the ledger could not be read: the caller
 * must treat that as "no verdict possible", never as "no reads happened".
 */
export type SenderReadsReader = (
  selfOwnerId: string,
  opts: { workspaceId: string; toolNames: readonly string[]; windowMs: number },
) => Promise<SenderReadRow[] | null>;

export const readSenderReads: SenderReadsReader = async (selfOwnerId, opts) => {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const since = new Date(Date.now() - opts.windowMs);
    const rows = await sql<{ tool_name: string; args_json: unknown }[]>`
      SELECT tool_name, args_json
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${opts.workspaceId}
         AND coord_owner_id = ${selfOwnerId}
         AND invoked_at >= ${since}
         AND status = 'ok'
         AND tool_name = ANY(${[...opts.toolNames]})
       ORDER BY invoked_at DESC
       LIMIT ${STALE_QUOTE_SCAN_ROWS}`;
    return rows.map((r) => ({ tool: r.tool_name, args: r.args_json }));
  } catch {
    return null;
  }
};

/**
 * Score every cell citation in the message against the sender's read window.
 *
 * Returns `[]` — never throws, never partially fails a send — when nothing is
 * detected, the sender/workspace is unresolvable, the registry is empty, or
 * the ledger read fails (unknown never accuses).
 */
export async function resolveStaleQuoteStamps(
  opts: {
    selfOwnerId: string;
    sections: readonly SectionTextLike[];
    workspaceId?: string | null;
  },
  readReads: SenderReadsReader = readSenderReads,
): Promise<StaleQuoteStamp[]> {
  try {
    const self = (opts.selfOwnerId ?? '').trim();
    const workspaceId = (opts.workspaceId ?? '').trim();
    if (!self || !workspaceId) return [];
    if (!opts.sections.some((s) => str(s?.text))) return [];

    // Registry access is in-memory but imported dynamically per the header's
    // load-graph contract. An empty registry (a process that never wired the
    // state tools) gets the built-ins registered — idempotent by construction.
    const [registry, registrations] = await Promise.all([
      import('../../cell-registry'),
      import('../../cell-registrations'),
    ]);
    if (registry.listCellsUnchecked().length === 0) {
      try {
        registrations.registerBuiltinCells();
      } catch {
        /* a registration race is fine — whatever is registered is what we index */
      }
    }
    // listCellsUnchecked, deliberately (P-019 reviewed): the index carries cell
    // IDENTITIES only, and a stamp names a cell the SENDER already wrote into
    // their own message — no value and no hidden cell name is ever served.
    const index = buildCellTokenIndex(registry.listCellsUnchecked());
    const detected = detectQuotedCells(opts.sections, index);
    if (detected.length === 0) return [];

    const reads = await readReads(self, {
      workspaceId,
      toolNames: ['state:read', ...index.doorTools],
      windowMs: BASED_ON_WINDOW_MS,
    });
    if (reads === null) return []; // ledger unreadable — no verdict, no accusation
    return scoreStaleQuotes(detected, reads, index);
  } catch {
    return [];
  }
}

/**
 * The stamps worth an aggregate reader's attention. Exported for the reader —
 * per D-090 it must never be baked into the send-side stamping (the
 * denominator rides on purpose).
 */
export function staleQuotes(stamps: readonly StaleQuoteStamp[]): StaleQuoteStamp[] {
  return stamps.filter((s) => s.verdict === 'quoted-without-fresh-read');
}
