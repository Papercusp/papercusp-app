/**
 * Design phase — lifecycle helpers.
 *
 * Step 1 of the design-phase plan
 * (apps/operator-docs/src/content/docs/design/design-phase-plan.mdx). Provides:
 *
 *   - computeNeedsDesign(): the heuristic for whether a new feature
 *     should enter the design phase, derived from proposal / scope text
 *     (NOT actual code diffs — at creation time there are none).
 *   - assertDesignGate(): throws if a feature is being promoted to
 *     "implementing" without an `accepted` or `ignored` design status.
 *
 * Database storage is in harness_shared.harness_features_consolidated
 * (columns: needs_design, design_status, design_spec_id,
 * discarded_design_work) + harness_shared.harness_design_artifacts.
 * See migration 048-design-phase.sql.
 */

export type DesignStatus = 'pending' | 'accepted' | 'ignored';

export interface DesignPhaseFields {
  needsDesign: boolean;
  designStatus: DesignStatus | null;
  designSpecId: string | null;
  discardedDesignWork: boolean;
}

/**
 * Heuristic input — read from the proposal at feature creation. We do NOT
 * inspect code (none exists yet); we read what the human/agent wrote.
 */
export interface NeedsDesignInput {
  title: string;
  summary?: string | null;
  /** acceptance criteria, scope notes, plan text — concatenated free-form */
  scopeText?: string | null;
  /** declared file globs the feature plans to touch (if known) */
  declaredGlobs?: readonly string[];
  /**
   * Per-ecosystem-adapter UI globs union, evaluated against `declaredGlobs`.
   * Defaults below cover React/Next operator surfaces; adapters declare
   * their own and the orchestrator unions them at call time.
   */
  uiGlobs?: readonly string[];
  /** Force-on / force-off override. Skips heuristic. */
  flagged?: 'force-on' | 'force-off' | null;
}

const DEFAULT_UI_GLOBS = [
  '**/*.tsx',
  '**/*.jsx',
  '**/*.css',
  '**/*.scss',
  'app/**/page.tsx',
  'app/**/layout.tsx',
];

const UI_KEYWORD_RE =
  /\b(ui|ux|design|layout|page|screen|view|component|panel|modal|drawer|button|form|chart|color|theme|font|icon|navigation|menu|toolbar|sidebar|header|footer|landing|onboarding)\b/i;

const COPY_KEYWORD_RE =
  /\b(label|copy|wording|message|placeholder|tooltip|empty[\s-]?state|error[\s-]?message|prompt[\s-]?text|microcopy|i18n|translation)\b/i;

const ROUTE_KEYWORD_RE =
  /\b(route|page|url|slug|navigation|navlink|tab|breadcrumb|deep[\s-]?link)\b/i;

const ICONOGRAPHY_KEYWORD_RE =
  /\b(icon|iconography|illustration|graphic|svg|image|avatar|logo|emoji)\b/i;

function anyMatch(re: RegExp, ...texts: ReadonlyArray<string | null | undefined>): boolean {
  for (const t of texts) {
    if (t && re.test(t)) return true;
  }
  return false;
}

function globsIntersect(declared: readonly string[], ui: readonly string[]): boolean {
  if (declared.length === 0 || ui.length === 0) return false;
  const uiSet = new Set(ui);
  // Cheap exact-match check first.
  for (const d of declared) if (uiSet.has(d)) return true;
  // Then suffix/extension match — declared globs that hint at UI files.
  const uiExts = ui
    .map((g) => /\.([a-z]+)$/.exec(g)?.[1])
    .filter((e): e is string => Boolean(e));
  if (uiExts.length === 0) return false;
  return declared.some((d) => uiExts.some((e) => d.endsWith(`.${e}`) || d.endsWith(`*.${e}`)));
}

/**
 * Computes whether a feature should enter the design phase, based on
 * proposal/scope text. Cheap, deterministic; no IO.
 *
 * Returns `false` for backend, infra, refactor, bugfix work.
 */
export function computeNeedsDesign(input: NeedsDesignInput): boolean {
  if (input.flagged === 'force-on') return true;
  if (input.flagged === 'force-off') return false;

  const haystack = [input.title, input.summary, input.scopeText];
  const uiGlobs = input.uiGlobs ?? DEFAULT_UI_GLOBS;

  return (
    anyMatch(UI_KEYWORD_RE, ...haystack) ||
    anyMatch(COPY_KEYWORD_RE, ...haystack) ||
    anyMatch(ROUTE_KEYWORD_RE, ...haystack) ||
    anyMatch(ICONOGRAPHY_KEYWORD_RE, ...haystack) ||
    globsIntersect(input.declaredGlobs ?? [], uiGlobs)
  );
}

/**
 * Lifecycle gate — call before promoting a feature to the implementing
 * phase. Throws if the design phase isn't terminal.
 *
 * `accepted` means a designer produced + crit-approved a spec.
 * `ignored` means the phase was explicitly skipped (heuristic was false,
 * or human override). Either is a green light.
 */
export class DesignGateError extends Error {
  readonly featureId: string;
  readonly designStatus: DesignStatus | null;

  constructor(featureId: string, designStatus: DesignStatus | null) {
    super(
      `feature ${featureId} cannot enter implementing phase: ` +
        `designStatus=${designStatus ?? 'null'} (must be accepted or ignored)`,
    );
    this.name = 'DesignGateError';
    this.featureId = featureId;
    this.designStatus = designStatus;
  }
}

export function assertDesignGate(
  featureId: string,
  fields: Pick<DesignPhaseFields, 'needsDesign' | 'designStatus'>,
): void {
  // Features that don't need design pass automatically.
  if (!fields.needsDesign) return;
  if (fields.designStatus === 'accepted' || fields.designStatus === 'ignored') return;
  throw new DesignGateError(featureId, fields.designStatus);
}

/**
 * Convenience for new-feature creation: compute initial design phase
 * fields from a proposal. Caller writes the result alongside the feature
 * row.
 */
export function initialDesignPhaseFields(input: NeedsDesignInput): DesignPhaseFields {
  return {
    needsDesign: computeNeedsDesign(input),
    designStatus: null,
    designSpecId: null,
    discardedDesignWork: false,
  };
}
