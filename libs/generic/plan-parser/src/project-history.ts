import { hashPlanContent } from './content-hash';
import { resolveEffectiveStatus } from './effective-status';
import { parsePlan, type PlanDecision, type PlanFrontmatter } from './parser';

export const PROJECT_HISTORY_SCHEMA_VERSION = 2 as const;

export type ProjectHistoryValidationStatus = 'todo' | 'validating' | 'passed' | 'failed';

export interface ProjectHistoryValidationAssertion {
  id: string;
  planItemId: string;
  verify: string;
  evidenceLocator: string;
  status: ProjectHistoryValidationStatus;
  requiresTest: boolean;
  source: 'canonical-plan-inline';
  sourceLineNumber: number;
}

export interface ProjectHistoryValidationSummary {
  total: number;
  passed: number;
  failed: number;
  validating: number;
  todo: number;
  requiringTest: number;
}

export type ProjectHistoryCommitAttribution =
  | 'authoritative'
  | 'body-reference'
  | 'inferred';

export type ProjectHistoryCommitRemoteStatus =
  | 'confirmed'
  | 'local-only'
  | 'unknown';

export interface ProjectHistoryRepository {
  provider: 'github' | 'git';
  /** Clone/fetch URL. It may be private and is therefore metadata, not a browser link. */
  url: string;
  /** Browser-safe repository root, for example https://github.com/Papercusp/sidestage. */
  webUrl: string | null;
  defaultBranch?: string | null;
}

export interface ProjectHistoryProject {
  id: string;
  name: string;
  repository: ProjectHistoryRepository | null;
}

export interface ProjectHistoryCommit {
  sha: string;
  url: string | null;
  subject: string | null;
  committedAt: string | null;
  files: string[];
  remoteStatus: ProjectHistoryCommitRemoteStatus;
  attribution: ProjectHistoryCommitAttribution;
}

export interface ProjectHistoryWorkItem {
  id: string;
  kind: string;
  title: string;
  state: string;
  completedAt: string | null;
  completionAuthority: string | null;
  completionSummary: string | null;
  completionEvidence: Record<string, unknown> | null;
  commits: ProjectHistoryCommit[];
}

export interface ProjectHistoryPlanItem {
  id: string;
  text: string;
  storedStatus: string;
  effectiveStatus: string;
  importance: string | null;
  riskTier: string | null;
  authority: string | null;
  blockedBy: string[];
  phase: string | null;
  lineNumber: number;
  validationAssertions: ProjectHistoryValidationAssertion[];
}

export interface ProjectHistoryDecision {
  id: string;
  title: string;
  body: string;
  date: string | null;
  itemRefs: string[];
  lineNumber: number;
}

export interface ProjectHistoryPlan {
  slug: string;
  title: string;
  status: string;
  updatedAt: string | null;
  contentHash: string;
  markdown: string;
  frontmatter: Record<string, unknown>;
  items: ProjectHistoryPlanItem[];
  decisions: ProjectHistoryDecision[];
  completedItems: ProjectHistoryWorkItem[];
  validationSummary: ProjectHistoryValidationSummary;
}

export interface ProjectHistorySource {
  kind: 'papercusp-plan-export';
  workspace: string;
  harness: string;
  planPrefix: string | null;
  generatedAt: string;
  planCount: number;
  generator: string;
}

/**
 * Versioned, disposable read model. The Papercusp ledgers and Git remain the
 * sources of truth; consumers may regenerate this document at any time.
 */
export interface ProjectHistoryDocument {
  schemaVersion: typeof PROJECT_HISTORY_SCHEMA_VERSION;
  project: ProjectHistoryProject;
  source: ProjectHistorySource;
  plans: ProjectHistoryPlan[];
}

export interface ProjectHistoryCommitLink {
  workItemId: string;
  attribution: ProjectHistoryCommitAttribution;
}

export interface ProjectHistoryCommitInput {
  sha: string;
  subject?: string | null;
  committedAt?: string | null;
  files?: readonly string[];
  remoteStatus?: ProjectHistoryCommitRemoteStatus;
  links: readonly ProjectHistoryCommitLink[];
  /**
   * Repository this commit came from, when it is NOT the project's primary repo.
   * A product can span several repos (SideStage's iOS/Android work lives in
   * `sidestage-mobile`, not `sidestage`), and a commit's browser URL must resolve
   * against the repo that actually contains it — otherwise the link 404s, which is
   * worse than no link. Omit for the primary repo.
   */
  repository?: ProjectHistoryRepository | null;
}

export interface ProjectHistoryWorkItemInput
  extends Omit<ProjectHistoryWorkItem, 'commits'> {
  /** Restrict an explicit item to these plans. Omit to attach it wherever its id is referenced. */
  planSlugs?: readonly string[];
}

export interface ProjectHistoryPlanInput {
  markdown: string;
  filePath?: string;
  updatedAt?: string | null;
  completedItems?: readonly ProjectHistoryWorkItemInput[];
}

export interface AssembleProjectHistoryInput {
  project: ProjectHistoryProject;
  source: Omit<ProjectHistorySource, 'planCount'>;
  plans: readonly ProjectHistoryPlanInput[];
  commits?: readonly ProjectHistoryCommitInput[];
}

/**
 * I/O boundary for Project History generation. Implementations may read the
 * Papercusp ledgers, a fixture directory, or another compatible store; the
 * assembler itself remains pure and product-neutral.
 */
export interface ProjectHistoryProvider {
  loadPlans(): Promise<readonly ProjectHistoryPlanInput[]>;
  loadWorkItems?(ids: readonly string[]): Promise<readonly ProjectHistoryWorkItemInput[]>;
  loadCommits?(ids: readonly string[]): Promise<readonly ProjectHistoryCommitInput[]>;
}

export interface GenerateProjectHistoryInput {
  project: ProjectHistoryProject;
  source: Omit<ProjectHistorySource, 'planCount'>;
  provider: ProjectHistoryProvider;
}

const COMPLETION_MARKER_RE = /\u2190\s+((?:WI|EI|F)-\d+)\s+completed\b/g;
const NOTE_SUFFIX_RE = /\s+\u2014\s+note:.*$/;
const PLAN_ITEM_LINE_RE = /^\s*-\s+\*\*(P-\d{3,})\*\*/;
const VALIDATION_LINE_RE = /^\s*-\s+\*\*\[(VAL-[^\]]+)\]\*\*\s*$/;
const VALIDATION_FIELD_RE = /^\s*-\s+\*\*(Verify|Evidence|Status|RequiresTest):\*\*\s*(.*)$/i;

/** Parse canonical inline VAL blocks without coupling the portable package to Postgres. */
export function validationAssertionsFromPlan(markdown: string): ProjectHistoryValidationAssertion[] {
  const lines = markdown.split(/\r?\n/);
  const assertions: ProjectHistoryValidationAssertion[] = [];
  let planItemId: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const item = line.match(PLAN_ITEM_LINE_RE)?.[1];
    if (item) {
      planItemId = item;
      continue;
    }
    const validationId = line.match(VALIDATION_LINE_RE)?.[1];
    if (!validationId || !planItemId) continue;

    const fields = new Map<string, string>();
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? '';
      if (PLAN_ITEM_LINE_RE.test(candidate) || VALIDATION_LINE_RE.test(candidate) || /^\s*#{1,6}\s/.test(candidate)) break;
      const match = candidate.match(VALIDATION_FIELD_RE);
      if (match?.[1]) fields.set(match[1].toLocaleLowerCase(), (match[2] ?? '').trim());
    }
    const verify = fields.get('verify') ?? '';
    const evidenceLocator = fields.get('evidence') ?? '';
    const rawStatus = fields.get('status')?.replaceAll('`', '').trim().toLocaleLowerCase();
    const status: ProjectHistoryValidationStatus = rawStatus === 'validating' || rawStatus === 'passed' || rawStatus === 'failed'
      ? rawStatus
      : 'todo';
    assertions.push({
      id: validationId,
      planItemId,
      verify,
      evidenceLocator,
      status,
      requiresTest: fields.get('requirestest')?.replaceAll('`', '').trim().toLocaleLowerCase() !== 'false',
      source: 'canonical-plan-inline',
      sourceLineNumber: index + 1,
    });
  }
  return assertions;
}

function validationSummary(assertions: readonly ProjectHistoryValidationAssertion[]): ProjectHistoryValidationSummary {
  return {
    total: assertions.length,
    passed: assertions.filter((assertion) => assertion.status === 'passed').length,
    failed: assertions.filter((assertion) => assertion.status === 'failed').length,
    validating: assertions.filter((assertion) => assertion.status === 'validating').length,
    todo: assertions.filter((assertion) => assertion.status === 'todo').length,
    requiringTest: assertions.filter((assertion) => assertion.requiresTest).length,
  };
}

function frontmatterRecord(frontmatter: PlanFrontmatter): Record<string, unknown> {
  const { raw: _raw, ...known } = frontmatter;
  return { ...frontmatter.raw, ...known };
}

function historyDecision(decision: PlanDecision): ProjectHistoryDecision {
  return {
    id: decision.id,
    title: decision.title,
    body: decision.body,
    date: decision.date,
    itemRefs: [...decision.itemRefs],
    lineNumber: decision.lineNumber,
  };
}

/**
 * Work-item completion markers are a compatibility provider, not the long-term
 * authority. Explicit provider records replace them by id when available.
 */
export function completedWorkItemsFromPlan(
  planSlug: string,
  updatedAt: string | null,
  contentHash: string,
  items: readonly { id: string; text: string }[],
): ProjectHistoryWorkItem[] {
  const completed = new Map<string, ProjectHistoryWorkItem>();
  for (const item of items) {
    for (const match of item.text.matchAll(COMPLETION_MARKER_RE)) {
      const id = match[1];
      if (!id) continue;
      completed.set(id, {
        id,
        kind: 'work-item',
        title: item.text.replace(NOTE_SUFFIX_RE, '').trim(),
        state: 'done',
        completedAt: updatedAt,
        completionAuthority: 'plan-ledger',
        completionSummary: `Recorded complete by ${item.id} in the canonical plan ledger.`,
        completionEvidence: {
          source: 'canonical-plan-completion-marker',
          plan: planSlug,
          planItem: item.id,
          contentHash,
        },
        commits: [],
      });
    }
  }
  return [...completed.values()];
}

export function projectHistoryCommitUrl(
  repository: ProjectHistoryRepository | null,
  sha: string,
): string | null {
  if (repository?.provider !== 'github' || !repository.webUrl) return null;
  return `${repository.webUrl.replace(/\/$/, '')}/commit/${encodeURIComponent(sha)}`;
}

function commitsByWorkItem(
  repository: ProjectHistoryRepository | null,
  commits: readonly ProjectHistoryCommitInput[],
): Map<string, ProjectHistoryCommit[]> {
  const byWorkItem = new Map<string, ProjectHistoryCommit[]>();
  for (const commit of commits) {
    for (const link of commit.links) {
      const output: ProjectHistoryCommit = {
        sha: commit.sha,
        // A commit carried in from a secondary repo resolves against ITS OWN repo,
        // never the project's primary one — see ProjectHistoryCommitInput.repository.
        url: projectHistoryCommitUrl(commit.repository ?? repository, commit.sha),
        subject: commit.subject ?? null,
        committedAt: commit.committedAt ?? null,
        files: [...new Set(commit.files ?? [])].sort(),
        remoteStatus: commit.remoteStatus ?? 'unknown',
        attribution: link.attribution,
      };
      const current = byWorkItem.get(link.workItemId) ?? [];
      const previous = current.findIndex((entry) => entry.sha === output.sha);
      if (previous === -1) current.push(output);
      else if (
        current[previous]?.attribution !== 'authoritative'
        && output.attribution === 'authoritative'
      ) current[previous] = output;
      byWorkItem.set(link.workItemId, current);
    }
  }
  for (const values of byWorkItem.values()) {
    values.sort((left, right) => {
      const byTime = (right.committedAt ?? '').localeCompare(left.committedAt ?? '');
      return byTime || left.sha.localeCompare(right.sha);
    });
  }
  return byWorkItem;
}

function appliesToPlan(item: ProjectHistoryWorkItemInput, planSlug: string): boolean {
  return !item.planSlugs || item.planSlugs.length === 0 || item.planSlugs.includes(planSlug);
}

/**
 * What one plan contributes to the id union, plus the slug membership is decided by.
 *
 * The slug is carried OUT of here on purpose. Both consumers below need it, and it
 * costs a `parsePlan` over a plan body that can reach ~1MB, so re-deriving it per
 * work item turns a per-plan cost into a per-(plan x item) one — see the comment on
 * the filter in `generateProjectHistory`.
 */
interface PlanReferences {
  slug: string;
  ids: Set<string>;
}

function referencedWorkItems(planInput: ProjectHistoryPlanInput): PlanReferences {
  const parsed = parsePlan(planInput.markdown, { filePath: planInput.filePath });
  const resolved = resolveEffectiveStatus(parsed);
  const slug = parsed.frontmatter.slug ?? parsed.slug;
  const updatedAt = planInput.updatedAt ?? (
    typeof parsed.frontmatter.updated === 'string' ? parsed.frontmatter.updated : null
  );
  const contentHash = hashPlanContent(planInput.markdown);
  return {
    slug,
    ids: new Set([
      ...completedWorkItemsFromPlan(slug, updatedAt, contentHash, resolved.items).map((item) => item.id),
      ...(planInput.completedItems ?? []).map((item) => item.id),
    ]),
  };
}

/**
 * Load provider data and produce a validated Project History document.
 * Provider work items without an explicit planSlugs list are attached only to
 * plans that already reference their id, preserving the plan ledger as the
 * membership authority.
 */
export async function generateProjectHistory(
  input: GenerateProjectHistoryInput,
): Promise<ProjectHistoryDocument> {
  const plans = [...await input.provider.loadPlans()].map((plan) => ({
    plan,
    reference: referencedWorkItems(plan),
  }));
  const ids = [...new Set(plans.flatMap(({ reference }) => [...reference.ids]))].sort();
  const workItems = ids.length > 0 && input.provider.loadWorkItems
    ? [...await input.provider.loadWorkItems(ids)]
    : [];

  // A provider that resolves NOTHING for referenced ids is a broken read, not a
  // project without completed work — and the difference is invisible in the output,
  // because `completedWorkItemsFromPlan` happily produces a well-formed document
  // full of evidence-free plan-ledger stubs. That is exactly what shipped: 327 of
  // 327 items published with no verification, files or commits while the ledger
  // held 505 evidenced completions (WI-39831). Fail loudly instead of degrading.
  if (input.provider.loadWorkItems && ids.length > 0 && workItems.length === 0) {
    throw new Error(
      `Project History provider resolved 0 work items for ${ids.length} referenced id(s). `
      + 'Refusing to emit a document built entirely from plan-completion markers: a silent '
      + 'fallback to the plan-ledger compatibility stub is indistinguishable from real '
      + 'completion evidence once published. Fix the provider read, or omit loadWorkItems '
      + 'to declare the marker ledger as the intended authority.',
    );
  }
  const commits = ids.length > 0 && input.provider.loadCommits
    ? [...await input.provider.loadCommits(ids)]
    : [];

  return assembleProjectHistory({
    project: input.project,
    source: input.source,
    // `reference.slug` is the plan's slug, parsed ONCE above. It used to be
    // re-derived with a fresh `parsePlan` INSIDE this filter callback, which runs
    // once per (plan x work item) pair rather than once per plan: measured on a
    // 20-plan page of the papercusp archive, 20 parses (87ms) became 2,780 (~12.1s),
    // and it was the whole reason the History tab could not load a page.
    plans: plans.map(({ plan, reference }) => ({
      ...plan,
      completedItems: [
        ...(plan.completedItems ?? []),
        ...workItems.filter((item) => (
          item.planSlugs && item.planSlugs.length > 0
            ? item.planSlugs.includes(reference.slug)
            : reference.ids.has(item.id)
        )),
      ],
    })),
    commits,
  });
}

/** Assemble one deterministic Project History v2 document from provider inputs. */
export function assembleProjectHistory(
  input: AssembleProjectHistoryInput,
): ProjectHistoryDocument {
  const commits = commitsByWorkItem(input.project.repository, input.commits ?? []);
  const plans = input.plans.map((planInput) => {
    const parsed = parsePlan(planInput.markdown, { filePath: planInput.filePath });
    const resolved = resolveEffectiveStatus(parsed);
    const slug = parsed.frontmatter.slug ?? parsed.slug;
    const updatedAt = planInput.updatedAt ?? (
      typeof parsed.frontmatter.updated === 'string' ? parsed.frontmatter.updated : null
    );
    const contentHash = hashPlanContent(planInput.markdown);
    const validationAssertions = validationAssertionsFromPlan(planInput.markdown);
    const inferred = completedWorkItemsFromPlan(slug, updatedAt, contentHash, resolved.items);
    const byId = new Map(inferred.map((item) => [item.id, item]));
    for (const explicit of planInput.completedItems ?? []) {
      if (!appliesToPlan(explicit, slug)) continue;
      const { planSlugs: _planSlugs, ...item } = explicit;
      byId.set(item.id, { ...item, commits: [] });
    }
    const completedItems = [...byId.values()].map((item) => ({
      ...item,
      commits: [...(commits.get(item.id) ?? [])],
    }));

    return {
      slug,
      title: parsed.frontmatter.title ?? slug,
      status: parsed.frontmatter.status ?? 'unknown',
      updatedAt,
      contentHash,
      markdown: planInput.markdown,
      frontmatter: frontmatterRecord(parsed.frontmatter),
      items: resolved.items.map((item) => ({
        id: item.id,
        text: item.text,
        storedStatus: item.storedStatus,
        effectiveStatus: item.effectiveStatus,
        importance: item.importance ?? null,
        riskTier: item.riskTier ?? null,
        authority: item.authority ?? null,
        blockedBy: [...item.blockedBy],
        phase: item.phase,
        lineNumber: item.lineNumber,
        validationAssertions: validationAssertions.filter((assertion) => assertion.planItemId === item.id),
      })),
      decisions: parsed.decisions.map(historyDecision),
      completedItems,
      validationSummary: validationSummary(validationAssertions),
    } satisfies ProjectHistoryPlan;
  });

  const document: ProjectHistoryDocument = {
    schemaVersion: PROJECT_HISTORY_SCHEMA_VERSION,
    project: {
      ...input.project,
      repository: input.project.repository ? { ...input.project.repository } : null,
    },
    source: { ...input.source, planCount: plans.length },
    plans,
  };
  return assertProjectHistoryDocument(document);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const VALIDATION_STATUSES = new Set<ProjectHistoryValidationStatus>(['todo', 'validating', 'passed', 'failed']);
const COMMIT_ATTRIBUTIONS = new Set<ProjectHistoryCommitAttribution>(['authoritative', 'body-reference', 'inferred']);
const COMMIT_REMOTE_STATUSES = new Set<ProjectHistoryCommitRemoteStatus>(['confirmed', 'local-only', 'unknown']);

function validValidationSummary(value: unknown, assertions: readonly ProjectHistoryValidationAssertion[]): boolean {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<ProjectHistoryValidationSummary>;
  const expected = validationSummary(assertions);
  return (
    summary.total === expected.total
    && summary.passed === expected.passed
    && summary.failed === expected.failed
    && summary.validating === expected.validating
    && summary.todo === expected.todo
    && summary.requiringTest === expected.requiringTest
  );
}

/** Runtime guard for generated or remotely loaded History documents. */
export function assertProjectHistoryDocument(value: unknown): ProjectHistoryDocument {
  if (!value || typeof value !== 'object') throw new TypeError('Project History document must be an object');
  const document = value as Partial<ProjectHistoryDocument>;
  if (document.schemaVersion !== PROJECT_HISTORY_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported Project History schemaVersion: ${String(document.schemaVersion)}`);
  }
  if (!document.project || !nonEmptyString(document.project.id) || !nonEmptyString(document.project.name)) {
    throw new TypeError('Project History project.id and project.name are required');
  }
  if (!document.source || !nonEmptyString(document.source.workspace) || !nonEmptyString(document.source.harness)) {
    throw new TypeError('Project History source.workspace and source.harness are required');
  }
  if (document.source.kind !== 'papercusp-plan-export' || !nonEmptyString(document.source.generator)) {
    throw new TypeError('Project History source.kind and source.generator are required');
  }
  if (typeof document.source.generatedAt !== 'string' || !validTimestamp(document.source.generatedAt)) {
    throw new TypeError('Project History source.generatedAt must be a valid timestamp');
  }
  if (!Array.isArray(document.plans)) throw new TypeError('Project History plans must be an array');
  if (document.source.planCount !== document.plans.length) {
    throw new TypeError('Project History source.planCount must equal plans.length');
  }
  const slugs = new Set<string>();
  for (const plan of document.plans) {
    if (!nonEmptyString(plan.slug) || slugs.has(plan.slug)) {
      throw new TypeError(`Project History plan slugs must be non-empty and unique: ${String(plan.slug)}`);
    }
    slugs.add(plan.slug);
    if (!validTimestamp(plan.updatedAt)) {
      throw new TypeError(`Project History ${plan.slug} updatedAt must be a valid timestamp`);
    }
    if (!Array.isArray(plan.completedItems)) throw new TypeError(`Project History ${plan.slug} completedItems must be an array`);
    if (!Array.isArray(plan.items) || !plan.validationSummary) {
      throw new TypeError(`Project History ${plan.slug} validation data is required`);
    }
    const assertionIds = new Set<string>();
    const assertions: ProjectHistoryValidationAssertion[] = [];
    for (const item of plan.items) {
      if (!Array.isArray(item.validationAssertions)) {
        throw new TypeError(`Project History ${plan.slug} ${item.id} validationAssertions must be an array`);
      }
      for (const assertion of item.validationAssertions) {
        if (
          !nonEmptyString(item.id)
          || !nonEmptyString(assertion.id)
          || assertionIds.has(assertion.id)
          || !assertion.id.startsWith('VAL-')
          || assertion.planItemId !== item.id
          || !nonEmptyString(assertion.verify)
          || !nonEmptyString(assertion.evidenceLocator)
          || !VALIDATION_STATUSES.has(assertion.status)
          || typeof assertion.requiresTest !== 'boolean'
          || assertion.source !== 'canonical-plan-inline'
          || !nonNegativeInteger(assertion.sourceLineNumber)
          || assertion.sourceLineNumber < 1
        ) {
          throw new TypeError(`Project History ${plan.slug} ${item.id} has an invalid validation assertion`);
        }
        assertionIds.add(assertion.id);
        assertions.push(assertion);
      }
    }
    if (!validValidationSummary(plan.validationSummary, assertions)) {
      throw new TypeError(`Project History ${plan.slug} validationSummary does not match validation assertions`);
    }
    for (const item of plan.completedItems) {
      if (!nonEmptyString(item.id) || !Array.isArray(item.commits)) {
        throw new TypeError(`Project History ${plan.slug} has an invalid completed item`);
      }
      if (!validTimestamp(item.completedAt)) {
        throw new TypeError(`Project History ${item.id} completedAt must be a valid timestamp`);
      }
      for (const commit of item.commits) {
        if (
          !/^[0-9a-f]{7,64}$/i.test(commit.sha)
          || !validTimestamp(commit.committedAt)
          || !Array.isArray(commit.files)
          || commit.files.some((file) => !nonEmptyString(file))
          || !COMMIT_REMOTE_STATUSES.has(commit.remoteStatus)
          || !COMMIT_ATTRIBUTIONS.has(commit.attribution)
          || (commit.url !== null && !nonEmptyString(commit.url))
        ) {
          throw new TypeError(`Project History ${item.id} has an invalid commit sha: ${commit.sha}`);
        }
      }
    }
  }
  return document as ProjectHistoryDocument;
}
