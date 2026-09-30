/**
 * Rationale projection — domain types (docs-and-memory-as-projections-2026-06-05 D-003).
 *
 * The "why" of the system is authored structurally already — as plan decisions,
 * work-items, and insights. Rather than re-summarising it (token cost) or
 * full-searching it (token cost), we PROJECT it: a topic-keyed inverted index
 * `topic → {decisions, work_items, insights}`, maintained incrementally by the
 * event engine. These types are the domain side of the generic
 * `@papercusp/projection-index` seam:
 *   - `RationaleSource` — a fully-loaded source record fed to the pure projector.
 *   - `RationaleEntry`  — the compact, agent-facing payload it shreds into.
 */

/** What produced a projected entry — drives query-time `kinds` filtering. */
export type RationaleKind = 'decision' | 'work_item' | 'insight';

/**
 * The compact projected payload stored under a topic — agent-facing and
 * token-lean (no full bodies; a `ref` to drill in). This is what `rationale:feed`
 * returns.
 */
export interface RationaleEntry {
  kind: RationaleKind;
  /**
   * A stable, human-readable reference to drill in:
   *   decision  → `D-NNN @ <plan-slug>`
   *   work_item → the work-item id (`WI-NNN` / `F-NNN`)
   *   insight   → `<insight-slug>`
   */
  ref: string;
  /** The entry's own title. */
  title: string;
  /** A one-line summary / excerpt (first sentence or a bounded slice). */
  summary: string;
  /** Where it lives: plan slug | work-item id | insight slug — for the drill-in tool. */
  home: string;
  /** Lifecycle state, when meaningful (work-item state; plan status). */
  state?: string;
  /** ISO date if known (decision date, work-item createdAt). */
  date?: string;
}

/** A parsed plan decision, the minimum the projector needs. */
export interface PlanDecisionLite {
  id: string;
  title: string;
  body: string;
  date?: string | null;
}

/**
 * A source record fed to the projector — already loaded from its store by the
 * gather layer. The projector is PURE: no I/O, deterministic. One source →
 * the contributions it currently produces; the index diffs against its prior ones.
 */
export type RationaleSource =
  | {
      kind: 'plan';
      /** Plan slug — the home of the decisions. */
      slug: string;
      /** Plan title (for context in the entry). */
      planTitle?: string;
      planStatus?: string | null;
      /** Topics this plan is tagged to (coord_links rel='tagged'). The index keys. */
      topics: string[];
      /** The plan's parsed decisions. */
      decisions: PlanDecisionLite[];
    }
  | {
      kind: 'work_item';
      id: string;
      title: string;
      summary: string;
      state: string;
      /** Topics this work-item is tagged to. The index keys. */
      topics: string[];
      createdAt?: string;
    }
  | {
      kind: 'insight';
      /** Insight file slug (under agent-insights/). */
      slug: string;
      title: string;
      description: string;
      /** Frontmatter tags — treated directly as index keys (topic slugs). */
      tags: string[];
    };

/** The stable `sourceId` the projection-index keys a source by. */
export function sourceIdOf(record: RationaleSource): string {
  switch (record.kind) {
    case 'plan':
      return `plan:${record.slug}`;
    case 'work_item':
      return `wi:${record.id}`;
    case 'insight':
      return `insight:${record.slug}`;
  }
}
