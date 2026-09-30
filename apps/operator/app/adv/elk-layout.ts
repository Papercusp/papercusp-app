/**
 * elk-layout — the ONE elkjs seam shared by every graph pane in the operator.
 *
 * Extracted from DepGraphPanel (dependency-health-pane-2026-08-02 D-005, owner: "lets use
 * elkjs") when the Workflows topology pane (external-triggers-gmail-slack-2026-08-22 P-024,
 * D-016) became elkjs's second consumer.
 *
 * ── WHY THIS IS SHARED RATHER THAN COPIED ───────────────────────────────────────────────
 * Not tidiness — the CACHE. elkjs is a GWT-transpiled ~1MB bundle shipping inside a desktop
 * app, and D-005 requires it never enter the initial chunk. A per-pane `elkPromise` would
 * mean a second module record holding a second ELK instance, so opening both panes in one
 * session would pay the ~1MB instantiation twice with nothing reporting that it happened.
 * One module-scoped promise here is what makes "imported once per session at most" true
 * across panes rather than only within one.
 *
 * The lazy `import()` is the load-bearing part: it must stay INSIDE the function so the
 * bundler keeps elkjs out of the initial chunk. Hoisting it to a static import at the top of
 * this file would silently undo D-005.
 */

/** The slice of the ELK instance our panes actually use. */
export interface ElkLayoutEngine {
  layout: (graph: unknown) => Promise<unknown>;
}

/** Cached elk instance — the module is ~1MB, so it is imported once per session at most. */
let elkPromise: Promise<ElkLayoutEngine> | null = null;

export async function getElk(): Promise<ElkLayoutEngine> {
  if (!elkPromise) {
    elkPromise = import('elkjs/lib/elk.bundled.js').then((m) => {
      const Ctor = (m.default ?? m) as new () => ElkLayoutEngine;
      return new Ctor();
    });
  }
  return elkPromise;
}

/**
 * ELK options for a left-to-right LAYERED DAG (dependency-health-pane-2026-08-02 D-001).
 *
 * `layered` is the Sugiyama family the decision names. NETWORK_SIMPLEX layering plus
 * BRANDES_KOEPF node placement is ELK's standard high-quality combination, and crossing
 * minimisation is what we adopted ELK for over dagre in the first place (D-005).
 */
export const ELK_LAYERED_LR_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.spacing.nodeNode': '24',
  'elk.layered.spacing.nodeNodeBetweenLayers': '72',
  'elk.spacing.edgeNode': '16',
};

/** The shape ELK hands back for a laid-out graph, narrowed to what callers read. */
export interface ElkLaidOut {
  children?: Array<{ id: string; x?: number; y?: number }>;
  edges?: Array<{
    id: string;
    sections?: Array<{
      startPoint: { x: number; y: number };
      endPoint: { x: number; y: number };
      bendPoints?: Array<{ x: number; y: number }>;
    }>;
  }>;
  width?: number;
  height?: number;
}
