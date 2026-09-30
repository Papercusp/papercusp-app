/**
 * dependency-fixture.ts — one scenario factory for the dependency subsystem.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-002).
 *
 * WHY. The subsystem's months-long escape survived ~85 test files because every
 * fixture hardcoded workspace 'default' and a single family. The bug lived on the
 * axes the fixtures held CONSTANT, so no amount of additional coverage along the
 * other axes could find it. This factory makes those axes PARAMETERS — so the
 * tenant matrix (P-006) and family matrix (P-007) are sweeps over one helper
 * rather than 85 rewritten files.
 *
 * SHAPE. A pure core plus a thin adapter:
 *   defineScenario()      pure  — build a spec, no IO
 *   projectItemRows()     pure  — spec -> work_items rows
 *   projectEdgeRows()     pure  — spec -> work_item_deps rows (defects applied here)
 *   seedScenario(sql, …)  IO    — INSERTs the projected rows (integration tier only)
 * The pure half is unit-tier safe: it touches no PG and spawns nothing, per the
 * repo's testing rules. Only `seedScenario` needs a live connection, and it takes
 * `sql` as an argument rather than importing one, so importing this module from a
 * unit test can never open a socket.
 *
 * ⚠ THE TAUTOLOGY TRAP — READ BEFORE WRITING ASSERTIONS.
 * `canonicalRef()` encodes INV-01 (feature endpoints are harness-qualified, issue
 * endpoints are bare). If a test uses this factory to GENERATE a row and then
 * asserts the row's ref equals `canonicalRef(...)`, it has proved only that a pure
 * function agrees with itself — it would stay green if the entire production
 * subsystem were deleted. That is precisely the class of test that let the original
 * bug through.
 *
 * Assert BEHAVIOUR instead: seed the scenario, drive the real claim door, and check
 * that the blocked item is WITHHELD (INV-04). The factory's job is to put the system
 * into a known state, never to be the thing under test. The one legitimate exception
 * is `dependency-fixture.test.ts`, which tests the factory itself.
 */

/** Which family a work-item belongs to. Determines its endpoint ref FORM (INV-01). */
export type Family = 'feature' | 'issue';

/**
 * A deliberate corruption to inject into an edge.
 *
 * These exist so a detector or guard can be proven to FIRE (INV-12). A detector
 * asserted only against clean data returns 0 whether or not it works, which is
 * indistinguishable from working — so seeded defects are not an edge case here,
 * they are the point.
 */
export type EdgeDefect =
  /** Correct edge: both endpoints in their own family's canonical form. */
  | 'none'
  /** Declared *_kind disagrees with the target row's real family (INV-02). */
  | 'kind-mismatch'
  /** Harness-qualified with the WRONG slug — the pot-rename class (INV-03). */
  | 'wrong-qualifier'
  /** Blocker id resolves to no row at all — the stale class (INV-13). */
  | 'dangling';

export interface FixtureItem {
  readonly id: string;
  readonly family: Family;
  /** Lifecycle state. A non-terminal blocker is what actually withholds. */
  readonly status: string;
  readonly createdTs?: number;
  readonly takenBy?: string | null;
}

export interface FixtureEdgeSpec {
  /** Item id that is BLOCKED (the dependant). */
  readonly blocked: string;
  /** Item id that BLOCKS it. */
  readonly blocker: string;
  /** Defaults to 'none'. */
  readonly defect?: EdgeDefect;
}

export interface DependencyScenarioSpec {
  /** The workspace the ITEM rows live in. Varies per tenant. */
  readonly workspace: string;
  readonly harness: string;
  /**
   * The workspace the EDGE rows live in — a DIFFERENT AXIS from `workspace`, and the
   * single most dangerous thing to get wrong in this file.
   *
   * `work_item_deps` is keyed in the COORDINATION workspace (DEFAULT_COORD_WORKSPACE,
   * i.e. 'default'); every edge row is written there by design, whatever workspace the
   * items themselves live in. Migration 719 says so explicitly and warns against
   * "fixing" the edge lookup to match the item workspace: "Scoping the edge lookup to
   * p_workspace would match zero rows and disable blocking entirely."
   *
   * This field exists because THIS FIXTURE GOT IT WRONG. It originally wrote edges into
   * `spec.workspace`, so for any non-'default' tenant — which is the DEFAULT this
   * factory hands out — every seeded edge was invisible to the oracle and gated nothing.
   * That is precisely the D-017 inert-edge class the factory was built to detect,
   * reproduced by the tool meant to detect it, and the pure projection tests could not
   * see it because they only compare the factory against itself.
   */
  readonly coordWorkspace: string;
  readonly items: readonly FixtureItem[];
  readonly edges: readonly FixtureEdgeSpec[];
}

export interface ItemRow {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  /**
   * A REAL kind value ('feature' | 'bug' | ...), NOT the family name — the engine derives
   * family from this value via `item_kind IN ('bug','change','task')`. See ITEM_KIND_FOR.
   */
  item_kind: string;
  status: string;
  taken_by: string | null;
  created_ts: number;
  updated_ts: number;
}

export interface EdgeRow {
  workspace_id: string;
  blocked_kind: Family;
  blocked_ref: string;
  blocker_kind: Family;
  blocker_ref: string;
  dep_type: string;
}

/**
 * INV-01, as a function: the ref form an endpoint of `family` must take.
 *
 * feature -> '<harness>#<id>' · issue -> '<id>' (bare, unqualified).
 *
 * See the tautology warning in the file header before asserting against this.
 */
export function canonicalRef(family: Family, harness: string, id: string): string {
  return family === 'feature' ? `${harness}#${id}` : id;
}

/** The other family — used to synthesise a kind-mismatch. */
function otherFamily(f: Family): Family {
  return f === 'feature' ? 'issue' : 'feature';
}

const DEFAULT_WORKSPACE = 'papercusp-workspace';
const DEFAULT_HARNESS = 'papercusp';
/**
 * The coordination workspace `work_item_deps` is keyed in. NOT a tenant knob: every edge
 * row lives here by design regardless of which workspace the items live in (migration
 * 719). Overridable only so a test can prove that an edge written under the WRONG coord
 * workspace is inert — which is what this factory itself was doing.
 */
const DEFAULT_COORD_WORKSPACE = 'default';

/**
 * Build a scenario spec.
 *
 * `workspace` and `harness` default to NON-'default' values on purpose: 'default'
 * is the tenant every historical fixture silently assumed, and defaulting back to
 * it would quietly re-create the blind spot this factory exists to remove. A test
 * that genuinely needs 'default' must ask for it by name.
 */
export function defineScenario(opts: {
  workspace?: string;
  harness?: string;
  coordWorkspace?: string;
  items: readonly FixtureItem[];
  edges: readonly FixtureEdgeSpec[];
}): DependencyScenarioSpec {
  const spec: DependencyScenarioSpec = {
    workspace: opts.workspace ?? DEFAULT_WORKSPACE,
    harness: opts.harness ?? DEFAULT_HARNESS,
    coordWorkspace: opts.coordWorkspace ?? DEFAULT_COORD_WORKSPACE,
    items: opts.items,
    edges: opts.edges,
  };
  // Fail loudly at construction. A typo'd id would otherwise surface as a
  // 'dangling' edge and read like a genuine finding — a fixture bug wearing the
  // costume of the exact defect under test.
  const known = new Set(spec.items.map((i) => i.id));
  for (const e of spec.edges) {
    if (!known.has(e.blocked)) {
      throw new Error(`dependency-fixture: edge.blocked '${e.blocked}' is not a declared item`);
    }
    if (e.defect !== 'dangling' && !known.has(e.blocker)) {
      throw new Error(
        `dependency-fixture: edge.blocker '${e.blocker}' is not a declared item ` +
          `(use defect:'dangling' if you meant an unresolvable blocker)`,
      );
    }
  }
  return spec;
}

/** Look an item up, or throw — internal, callers have already been validated. */
function itemOf(spec: DependencyScenarioSpec, id: string): FixtureItem {
  const it = spec.items.find((i) => i.id === id);
  if (!it) throw new Error(`dependency-fixture: unknown item '${id}'`);
  return it;
}

/**
 * A REAL `item_kind` value for each family — not the family NAME.
 *
 * The database classifies family by the VALUE of item_kind: the SQL everywhere reads
 * `item_kind IN ('bug','change','task')` for the issue family and treats everything else
 * as feature family. So writing the literal string 'issue' produces a row the engine
 * classifies as a FEATURE — and it then looks that blocker up by harness-qualified ref
 * while this factory wrote it bare, so the edge resolves to nothing.
 *
 * This factory did exactly that until P-006 drove it against real SQL. Like the
 * coordWorkspace bug, the pure projection tests could not see it: 'issue' is a perfectly
 * consistent value to compare against itself. Only the live oracle disagreed.
 */
const ITEM_KIND_FOR: Readonly<Record<Family, string>> = { feature: 'feature', issue: 'bug' };

/** Rows for `harness_shared.work_items`. Pure. */
export function projectItemRows(spec: DependencyScenarioSpec): ItemRow[] {
  return spec.items.map((i, idx) => ({
    workspace_id: spec.workspace,
    harness_slug: spec.harness,
    feature_id: i.id,
    item_kind: ITEM_KIND_FOR[i.family],
    status: i.status,
    taken_by: i.takenBy ?? null,
    created_ts: i.createdTs ?? (idx + 1) * 100,
    updated_ts: i.createdTs ?? (idx + 1) * 100,
  }));
}

/**
 * Rows for `harness_shared.work_item_deps`. Pure. Defects are applied HERE, which
 * keeps every corruption in one readable place instead of scattered through tests.
 *
 * The blocked side is always written correctly: these defects model writer bugs on
 * the BLOCKER lookup, which is where every real incident occurred.
 */
export function projectEdgeRows(spec: DependencyScenarioSpec): EdgeRow[] {
  return spec.edges.map((e) => {
    const blocked = itemOf(spec, e.blocked);
    const defect = e.defect ?? 'none';

    const base = {
      // The COORD workspace, NEVER spec.workspace — see DependencyScenarioSpec.coordWorkspace.
      // Writing spec.workspace here makes every edge inert for any non-'default' tenant.
      workspace_id: spec.coordWorkspace,
      blocked_kind: blocked.family,
      blocked_ref: canonicalRef(blocked.family, spec.harness, blocked.id),
      dep_type: 'blocks',
    };

    if (defect === 'dangling') {
      // No such row anywhere. Bare form so it is a pure resolution failure rather
      // than also a form error — one defect per edge keeps causes attributable.
      return { ...base, blocker_kind: 'issue' as Family, blocker_ref: e.blocker };
    }

    const blocker = itemOf(spec, e.blocker);

    if (defect === 'kind-mismatch') {
      // Declared kind is the WRONG family; ref is written in that wrong family's
      // form. This is exactly what syncFeatureBlockEdges produced for issue-family
      // blockers: form-valid, self-consistent, and joins nothing.
      const wrong = otherFamily(blocker.family);
      return { ...base, blocker_kind: wrong, blocker_ref: canonicalRef(wrong, spec.harness, blocker.id) };
    }

    if (defect === 'wrong-qualifier') {
      // Correct kind, but qualified with a stale harness slug — the pot-rename
      // class. Only meaningful for a feature endpoint, since issue refs are bare;
      // for an issue blocker we qualify it (which is itself wrong) so the defect
      // is still expressed rather than silently degrading to a correct row.
      return { ...base, blocker_kind: blocker.family, blocker_ref: `${spec.harness}-renamed#${blocker.id}` };
    }

    return { ...base, blocker_kind: blocker.family, blocker_ref: canonicalRef(blocker.family, spec.harness, blocker.id) };
  });
}

/** Ids of edges this spec expects a detector to flag, by defect class. */
export function expectedDefectiveEdges(spec: DependencyScenarioSpec): {
  kindMismatch: FixtureEdgeSpec[];
  wrongQualifier: FixtureEdgeSpec[];
  dangling: FixtureEdgeSpec[];
  total: number;
} {
  const pick = (d: EdgeDefect) => spec.edges.filter((e) => (e.defect ?? 'none') === d);
  const kindMismatch = pick('kind-mismatch');
  const wrongQualifier = pick('wrong-qualifier');
  const dangling = pick('dangling');
  return {
    kindMismatch,
    wrongQualifier,
    dangling,
    total: kindMismatch.length + wrongQualifier.length + dangling.length,
  };
}

/**
 * Terminal states, PER FAMILY, mirroring `work_item_is_blocked` (migration 719).
 *
 * ⚠ THESE TWO SETS ARE NOT THE SAME SET, and that asymmetry is the system's, not a typo.
 * The shipped oracle applies a different list to each family's blocker leg:
 *
 *   feature blocker → status NOT IN ('passed','deprecated','done','dropped')
 *   issue   blocker → status NOT IN ('resolved','closed','done','dropped')
 *
 * Each family's list is its own lifecycle vocabulary: a feature is `passed`/`deprecated`,
 * an issue is `resolved`/`closed`, and only `done`/`dropped` are shared. So `closed` is
 * terminal for an issue blocker and NOT terminal for a feature one.
 *
 * WHY THIS IS SPELLED OUT RATHER THAN LEFT AS ONE UNION. This function previously
 * defaulted to the family-blind UNION of both lists, which disagrees with the shipped
 * oracle for four of the six states — it called `closed`/`resolved` terminal for a
 * feature blocker and `passed`/`deprecated` terminal for an issue one. P-010's random
 * graphs caught it on their first run (feature blocker at `closed`: the oracle withheld
 * the dependent, this model said it was free).
 *
 * It survived P-002, P-006 and P-007 because every consumer drove `standardScenario`,
 * whose only terminal status is `done` — the one value both lists agree on. The fixture
 * built to stop bugs hiding on an axis the tests hold constant was itself hiding one on
 * exactly that axis. Do not re-collapse these into a single list.
 */
export const FEATURE_TERMINAL_STATES: readonly string[] = ['passed', 'deprecated', 'done', 'dropped'];
export const ISSUE_TERMINAL_STATES: readonly string[] = ['resolved', 'closed', 'done', 'dropped'];

/**
 * Ids that SHOULD be withheld: any item with at least one edge whose blocker is
 * non-terminal AND whose edge is not defective.
 *
 * Terminality is decided by the BLOCKER'S OWN FAMILY (see the two sets above), because
 * that is how the oracle decides it. Pass `terminalStates` to override both families at
 * once — used to pin a specific vocabulary in a test rather than to paper over the split.
 *
 * A defective edge is deliberately excluded — it gates nothing, which is the whole
 * finding. So this doubles as the expectation for a negative control: an item whose
 * only edges are defective appears here as CLAIMABLE, and a test asserting that is
 * asserting the bug's cost, not the fix's success.
 */
export function expectedBlockedIds(
  spec: DependencyScenarioSpec,
  terminalStates?: readonly string[],
): string[] {
  const terminalFor = (family: Family): ReadonlySet<string> =>
    new Set(terminalStates ?? (family === 'feature' ? FEATURE_TERMINAL_STATES : ISSUE_TERMINAL_STATES));
  const blocked = new Set<string>();
  for (const e of spec.edges) {
    if ((e.defect ?? 'none') !== 'none') continue;
    const blocker = spec.items.find((i) => i.id === e.blocker);
    if (!blocker || terminalFor(blocker.family).has(blocker.status)) continue;
    blocked.add(e.blocked);
  }
  return [...blocked].sort();
}

/** Minimal shape of a postgres.js-style tagged-template client. */
export type SqlLike = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

/**
 * INSERT the scenario. INTEGRATION TIER ONLY — takes `sql` as an argument so that
 * merely importing this module from a unit test cannot open a connection.
 */
export async function seedScenario(sql: SqlLike, spec: DependencyScenarioSpec): Promise<void> {
  for (const r of projectItemRows(spec)) {
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, taken_by, created_ts, updated_ts)
      VALUES (${r.workspace_id}, ${r.harness_slug}, ${r.feature_id}, ${r.item_kind},
              ${r.status}, ${r.taken_by}, ${r.created_ts}, ${r.updated_ts})
      ON CONFLICT DO NOTHING`;
  }
  for (const r of projectEdgeRows(spec)) {
    await sql`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      VALUES (${r.workspace_id}, ${r.blocked_kind}, ${r.blocked_ref},
              ${r.blocker_kind}, ${r.blocker_ref}, ${r.dep_type})
      ON CONFLICT DO NOTHING`;
  }
}

/**
 * The canonical small scenario, used as the default subject across the matrices.
 *
 * Deliberately mixed-family with one of each defect, so a sweep over (workspace,
 * harness) exercises every class without each test restating the graph.
 */
export function standardScenario(
  opts: { workspace?: string; harness?: string; coordWorkspace?: string } = {},
): DependencyScenarioSpec {
  return defineScenario({
    ...opts,
    items: [
      { id: 'F-blocked', family: 'feature', status: 'open' },
      { id: 'EI-blocked', family: 'issue', status: 'open' },
      { id: 'F-open-blocker', family: 'feature', status: 'wip' },
      { id: 'EI-open-blocker', family: 'issue', status: 'open' },
      { id: 'F-done-blocker', family: 'feature', status: 'done' },
    ],
    edges: [
      { blocked: 'F-blocked', blocker: 'EI-open-blocker' }, // mixed family, correct
      { blocked: 'EI-blocked', blocker: 'F-open-blocker' }, // mixed the other way
      { blocked: 'F-blocked', blocker: 'F-done-blocker' }, // terminal ⇒ does not withhold
      { blocked: 'EI-blocked', blocker: 'EI-open-blocker', defect: 'kind-mismatch' },
      { blocked: 'F-blocked', blocker: 'F-open-blocker', defect: 'wrong-qualifier' },
      { blocked: 'EI-blocked', blocker: 'WI-does-not-exist', defect: 'dangling' },
    ],
  });
}
