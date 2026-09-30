import * as Dialog from '@radix-ui/react-dialog';
import { PlanDocumentView } from './PlanDocumentView';
import './ProjectHistoryView.css';
import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';

export interface BuildHistoryWorkItem {
  id: string;
  kind: string;
  title: string;
  state: string;
  completedAt: string | null;
  completionAuthority: string | null;
  completionSummary: string | null;
  completionEvidence: Record<string, unknown> | null;
  commits: BuildHistoryCommit[];
}

export interface BuildHistoryCommit {
  sha: string;
  url: string | null;
  subject: string | null;
  committedAt: string | null;
  files: string[];
  remoteStatus: 'confirmed' | 'local-only' | 'unknown';
  attribution: 'authoritative' | 'body-reference' | 'inferred';
}

export interface BuildHistoryRepository {
  provider: 'github' | 'git';
  url: string;
  webUrl: string | null;
  defaultBranch?: string | null;
}

export interface BuildHistoryProject {
  id: string;
  name: string;
  repository: BuildHistoryRepository | null;
}

export interface BuildHistoryPlan {
  slug: string;
  title: string;
  status: string;
  updatedAt: string | null;
  contentHash: string;
  markdown: string;
  frontmatter: Record<string, unknown>;
  items: BuildHistoryPlanItem[];
  decisions: BuildHistoryDecision[];
  completedItems: BuildHistoryWorkItem[];
  project: BuildHistoryProject;
  snapshot: BuildHistorySnapshotSource;
  validationSummary?: BuildHistoryValidationSummary;
}

export type BuildHistoryValidationStatus = 'todo' | 'validating' | 'passed' | 'failed';

export interface BuildHistoryValidationAssertion {
  id: string;
  planItemId: string;
  verify: string;
  evidenceLocator: string;
  status: BuildHistoryValidationStatus;
  requiresTest: boolean;
  source: 'canonical-plan-inline';
  sourceLineNumber: number;
}

export interface BuildHistoryValidationSummary {
  total: number;
  passed: number;
  failed: number;
  validating: number;
  todo: number;
  requiringTest: number;
}

export interface BuildHistoryPlanItem {
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
  validationAssertions?: BuildHistoryValidationAssertion[];
}

export interface BuildHistoryDecision {
  id: string;
  title: string;
  body: string;
  date: string | null;
  itemRefs: string[];
  lineNumber: number;
}

export interface BuildHistorySnapshotSource {
  kind: 'papercusp-plan-export';
  workspace: string;
  harness: string;
  planPrefix: string | null;
  generatedAt: string;
  planCount: number;
  generator: string;
}

export type BuildHistoryDateFilter = '7d' | '30d' | 'all';

export interface BuildHistoryFilters {
  search: string;
  status: string;
  date: BuildHistoryDateFilter;
  kind: string;
}

export interface BuildHistoryTarget {
  plan: string;
  item: string | null;
}

interface EvidenceSummary {
  changed: string[];
  verification: string[];
  files: string[];
}

interface BuildHistorySummary {
  latestVerified: { item: BuildHistoryWorkItem; plan: BuildHistoryPlan } | null;
  completedThisWeek: number;
  completedTotal: number;
  activePlans: number;
  deliveredPlans: number;
  totalPlans: number;
  lastUpdatedAt: string | null;
}

const PLAN_PAGE_SIZE = 12;
const ITEM_PAGE_SIZE = 12;
/** Commits shown on the plan card before the "Show N more commits" expansion. */
const PLAN_COMMIT_PREVIEW = 6;
const HISTORY_DOCUMENT_STATE = '__papercuspProjectHistoryDocument';
const HISTORY_WORK_ITEM_STATE = '__papercuspProjectHistoryWorkItem';
const TERMINAL_PLAN_STATES = new Set(['archived', 'cancelled', 'canceled', 'complete', 'completed', 'done', 'shipped', 'superseded']);
const buildDateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatBuildDate(value: string | null): string {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : buildDateFormatter.format(date);
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function humanizeEvidenceKey(key: string): string {
  const label = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .trim()
    .toLocaleLowerCase();
  return label ? `${label[0].toUpperCase()}${label.slice(1)}` : 'Evidence';
}

function evidenceValue(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value) && value.every((entry) => (
    typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean'
  ))) {
    return value.map(String).join(' · ');
  }
  return null;
}

function evidenceLines(evidence: Record<string, unknown> | null): Array<{ key: string; line: string }> {
  if (!evidence) return [];
  return Object.entries(evidence).flatMap(([key, value]) => {
    const readable = evidenceValue(value);
    return readable ? [{ key, line: `${humanizeEvidenceKey(key)}: ${readable}` }] : [];
  });
}

export function summarizeBuildItemEvidence(item: BuildHistoryWorkItem): EvidenceSummary {
  const lines = evidenceLines(item.completionEvidence);
  const files = lines
    .filter(({ key }) => /(artifact|file|output|path)/i.test(key))
    .map(({ line }) => line)
    .slice(0, 3);
  const verification = lines
    .filter(({ key }) => /(build|check|lint|proof|result|test|typecheck|valid|verif)/i.test(key))
    .map(({ line }) => line)
    .slice(0, 3);
  const categorized = new Set([...files, ...verification]);
  const changed = [
    item.completionSummary,
    ...lines.filter(({ line }) => !categorized.has(line)).map(({ line }) => line),
  ].filter((line): line is string => Boolean(line)).slice(0, 3);
  return { changed, verification, files };
}

/**
 * The COMPLETE evidence set for one work item. `summarizeBuildItemEvidence` slices
 * each block to three lines so a card stays scannable; the full-record dialog is
 * the place that must not truncate, or "read the full work item" is a lie.
 */
function fullBuildItemEvidence(item: BuildHistoryWorkItem): EvidenceSummary {
  const lines = evidenceLines(item.completionEvidence);
  const files = lines
    .filter(({ key }) => /(artifact|file|output|path)/i.test(key))
    .map(({ line }) => line);
  const verification = lines
    .filter(({ key }) => /(build|check|lint|proof|result|test|typecheck|valid|verif)/i.test(key))
    .map(({ line }) => line);
  const categorized = new Set([...files, ...verification]);
  const changed = [
    item.completionSummary,
    ...lines.filter(({ line }) => !categorized.has(line)).map(({ line }) => line),
  ].filter((line): line is string => Boolean(line));
  return { changed, verification, files };
}

function planActivityTimestamp(plan: BuildHistoryPlan): number {
  return Math.max(
    timestamp(plan.updatedAt) ?? Number.NEGATIVE_INFINITY,
    ...plan.completedItems.map((item) => timestamp(item.completedAt) ?? Number.NEGATIVE_INFINITY),
  );
}

function sortedItems(plan: BuildHistoryPlan): BuildHistoryWorkItem[] {
  return [...plan.completedItems].sort((left, right) => (
    (timestamp(right.completedAt) ?? 0) - (timestamp(left.completedAt) ?? 0)
  ));
}

function searchablePlanText(plan: BuildHistoryPlan): string {
  return [
    plan.slug,
    plan.title,
    plan.status,
    ...plan.completedItems.flatMap((item) => [
      item.id,
      item.kind,
      item.title,
      item.state,
      item.completionAuthority ?? '',
      item.completionSummary ?? '',
      ...evidenceLines(item.completionEvidence).map(({ line }) => line),
      ...item.commits.flatMap((commit) => [
        commit.sha,
        commit.subject ?? '',
        commit.attribution,
        commit.remoteStatus,
        ...commit.files,
      ]),
    ]),
  ].join(' ').toLocaleLowerCase();
}

export function filterBuildHistory(
  plans: readonly BuildHistoryPlan[],
  filters: BuildHistoryFilters,
  now = new Date(),
): BuildHistoryPlan[] {
  const query = filters.search.trim().toLocaleLowerCase();
  const cutoff = filters.date === 'all'
    ? Number.NEGATIVE_INFINITY
    : now.getTime() - Number.parseInt(filters.date, 10) * 24 * 60 * 60 * 1_000;

  return plans
    .filter((plan) => !query || searchablePlanText(plan).includes(query))
    .filter((plan) => filters.status === 'all' || plan.status.toLocaleLowerCase() === filters.status)
    .filter((plan) => filters.kind === 'all' || plan.completedItems.some(
      (item) => item.kind.toLocaleLowerCase() === filters.kind,
    ))
    .filter((plan) => planActivityTimestamp(plan) >= cutoff)
    .sort((left, right) => planActivityTimestamp(right) - planActivityTimestamp(left));
}

export function summarizeBuildHistory(
  plans: readonly BuildHistoryPlan[],
  now = new Date(),
): BuildHistorySummary {
  const allItems = plans.flatMap((plan) => plan.completedItems.map((item) => ({ item, plan })));
  const verifiedItems = allItems
    .filter(({ item }) => Boolean(
      item.completionAuthority
      || (item.completionEvidence && Object.keys(item.completionEvidence).length > 0),
    ))
    .sort((left, right) => (
      (timestamp(right.item.completedAt) ?? 0) - (timestamp(left.item.completedAt) ?? 0)
    ));
  const startOfWeek = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayFromMonday = (startOfWeek.getUTCDay() + 6) % 7;
  startOfWeek.setUTCDate(startOfWeek.getUTCDate() - dayFromMonday);

  const lastUpdatedAt = plans
    .flatMap((plan) => [plan.updatedAt, ...plan.completedItems.map((item) => item.completedAt)])
    .filter((value): value is string => timestamp(value) !== null)
    .sort((left, right) => (timestamp(right) ?? 0) - (timestamp(left) ?? 0))[0] ?? null;

  // A build HISTORY page must headline what was delivered. `activePlans` counts
  // only NON-terminal plans, so on its own it excludes every shipped plan —
  // i.e. it shrinks as the project succeeds, and read as "how much have we
  // built?" it understates the archive badly (28 shown against 51 real plans,
  // owner-reported twice). Keep it, but report it beside the totals rather than
  // as the headline. WI-39777.
  const activePlans = plans.filter(
    (plan) => !TERMINAL_PLAN_STATES.has(plan.status.toLocaleLowerCase()),
  ).length;

  return {
    latestVerified: verifiedItems[0] ?? null,
    completedThisWeek: allItems.filter(({ item }) => (
      (timestamp(item.completedAt) ?? Number.NEGATIVE_INFINITY) >= startOfWeek.getTime()
    )).length,
    completedTotal: allItems.length,
    activePlans,
    deliveredPlans: plans.length - activePlans,
    totalPlans: plans.length,
    lastUpdatedAt,
  };
}

function historyElementId(kind: 'plan' | 'item', value: string): string {
  return `history-${kind}-${value.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function historyHref(plan: string, item: string | null = null, currentUrl = '/'): string {
  const url = new URL(currentUrl, 'https://project.local');
  url.searchParams.set('tab', 'history');
  url.searchParams.set('plan', plan);
  if (item) url.searchParams.set('item', item);
  else url.searchParams.delete('item');
  url.hash = historyElementId(item ? 'item' : 'plan', item ?? plan);
  return `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
}

export function historyDocumentHref(plan: string, currentUrl = '/'): string {
  const url = new URL(currentUrl, 'https://project.local');
  url.searchParams.set('tab', 'history');
  url.searchParams.set('plan', plan);
  url.searchParams.delete('item');
  // Only one record viewer may be addressed at a time: leaving `work-item` behind
  // would reopen BOTH dialogs on the next load of this link.
  url.searchParams.delete('work-item');
  url.searchParams.set('document', plan);
  url.hash = historyElementId('plan', plan);
  return `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
}

export function historyDocumentCloseHref(currentUrl = '/'): string {
  const url = new URL(currentUrl, 'https://project.local');
  url.searchParams.delete('document');
  return `${url.pathname}${url.search ? url.search : ''}${url.hash}`;
}

/**
 * Durable link to ONE work item's full record. The plan half of a build entry has
 * had `historyDocumentHref` since the History tab shipped; this is the work-item
 * half the owner asked for (WI-38718, 2026-08-14) — a build entry must reach the
 * record that commissioned it without hunting through two disclosures.
 */
export function historyWorkItemHref(plan: string, item: string, currentUrl = '/'): string {
  const url = new URL(currentUrl, 'https://project.local');
  url.searchParams.set('tab', 'history');
  url.searchParams.set('plan', plan);
  url.searchParams.set('item', item);
  url.searchParams.delete('document');
  url.searchParams.set('work-item', item);
  url.hash = historyElementId('item', item);
  return `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
}

export function historyWorkItemCloseHref(currentUrl = '/'): string {
  const url = new URL(currentUrl, 'https://project.local');
  url.searchParams.delete('work-item');
  return `${url.pathname}${url.search ? url.search : ''}${url.hash}`;
}

function readHistoryDocument(): string | null {
  if (typeof window === 'undefined') return null;
  return new URL(window.location.href).searchParams.get('document')?.trim() || null;
}

function readHistoryWorkItem(): string | null {
  if (typeof window === 'undefined') return null;
  return new URL(window.location.href).searchParams.get('work-item')?.trim() || null;
}

function isPlainPrimaryClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

function CopyLinkButton({ href, label = 'Copy link' }: { href: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    if (typeof window === 'undefined' || !navigator.clipboard) {
      setState('failed');
      return;
    }
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.href).href);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <button className="button ghost small" type="button" onClick={copy}>
      {state === 'copied' ? 'Link copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}

function EvidenceBlock({ title, lines, empty }: { title: string; lines: readonly string[]; empty: string }) {
  return (
    <section className="build-evidence-block">
      <h4>{title}</h4>
      {lines.length > 0 ? lines.map((line) => <p key={line}>{line}</p>) : <p className="build-evidence-empty">{empty}</p>}
    </section>
  );
}

function LazyRawEvidence({ item }: { item: BuildHistoryWorkItem }) {
  const [open, setOpen] = useState(false);
  if (!item.completionEvidence) return null;

  return (
    <details className="build-raw-evidence" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>View full evidence</summary>
      {open ? <pre>{JSON.stringify(item.completionEvidence, null, 2)}</pre> : null}
    </details>
  );
}

function commitAttributionLabel(attribution: BuildHistoryCommit['attribution']): string {
  if (attribution === 'authoritative') return 'Ledger attribution';
  if (attribution === 'body-reference') return 'Referenced in commit';
  return 'Inferred historical match';
}

function commitRemoteLabel(status: BuildHistoryCommit['remoteStatus']): string {
  if (status === 'confirmed') return 'Remote confirmed';
  if (status === 'local-only') return 'Local only';
  return 'Remote unknown';
}

function CommitRow({ commit }: { commit: BuildHistoryCommit }) {
  const shortSha = commit.sha.slice(0, 7);
  const title = commit.subject ?? `Commit ${shortSha}`;
  const confirmedUrl = commit.remoteStatus === 'confirmed' ? commit.url : null;

  return (
    <li>
      <div className="build-commit-title">
        {confirmedUrl ? (
          <a href={confirmedUrl} target="_blank" rel="noreferrer">
            <span>{title}</span>
            <small>View commit ↗</small>
          </a>
        ) : <strong>{title}</strong>}
        <code title={commit.sha}>{shortSha}</code>
      </div>
      <div className="build-commit-meta">
        <span>{commitAttributionLabel(commit.attribution)}</span>
        <span className={`is-${commit.remoteStatus}`}>{commitRemoteLabel(commit.remoteStatus)}</span>
        <span>{commit.files.length} {commit.files.length === 1 ? 'file' : 'files'}</span>
      </div>
    </li>
  );
}

function BuildItemCommits({ item }: { item: BuildHistoryWorkItem }) {
  if (item.commits.length === 0) return null;

  return (
    <section className="build-item-commits" aria-label={`Commits for ${item.id}`}>
      <header>
        <h4>Commits</h4>
        <span>{item.commits.length}</span>
      </header>
      <ul>
        {item.commits.map((commit) => <CommitRow commit={commit} key={commit.sha} />)}
      </ul>
    </section>
  );
}

/**
 * Every commit across a plan's completed items, deduped by sha and newest first.
 * The same sha can be linked from several items; keep the strongest attribution.
 */
export function planCommits(plan: BuildHistoryPlan): BuildHistoryCommit[] {
  const bySha = new Map<string, BuildHistoryCommit>();
  for (const item of plan.completedItems) {
    for (const commit of item.commits) {
      const existing = bySha.get(commit.sha);
      if (!existing || (existing.attribution !== 'authoritative' && commit.attribution === 'authoritative')) {
        bySha.set(commit.sha, commit);
      }
    }
  }
  return [...bySha.values()].sort((left, right) => {
    const byTime = (right.committedAt ?? '').localeCompare(left.committedAt ?? '');
    return byTime || left.sha.localeCompare(right.sha);
  });
}

/**
 * Plan-level commit list. The per-ITEM list below is two disclosures deep (plan card ->
 * "View N work items" -> item), which is why the GitHub links read as missing entirely
 * (WI-39898). This surfaces the same links one click from the plan card.
 */
function BuildPlanCommits({ plan }: { plan: BuildHistoryPlan }) {
  const commits = useMemo(() => planCommits(plan), [plan]);
  const [expanded, setExpanded] = useState(false);
  if (commits.length === 0) return null;

  const visible = expanded ? commits : commits.slice(0, PLAN_COMMIT_PREVIEW);
  const hidden = commits.length - visible.length;

  return (
    <section className="build-item-commits build-plan-commits" aria-label={`Commits for ${plan.slug}`}>
      <header>
        <h4>Commits</h4>
        <span>{commits.length}</span>
      </header>
      <ul>
        {visible.map((commit) => <CommitRow commit={commit} key={commit.sha} />)}
      </ul>
      {hidden > 0 ? (
        <button className="button ghost small build-show-more" type="button" onClick={() => setExpanded(true)}>
          Show {hidden} more {hidden === 1 ? 'commit' : 'commits'}
        </button>
      ) : null}
    </section>
  );
}

function BuildValidationContract({ plan }: { plan: BuildHistoryPlan }) {
  const assertions = plan.items.flatMap((item) => item.validationAssertions ?? []);
  if (assertions.length === 0) return null;
  const summary = plan.validationSummary ?? {
    total: assertions.length,
    passed: assertions.filter((assertion) => assertion.status === 'passed').length,
    failed: assertions.filter((assertion) => assertion.status === 'failed').length,
    validating: assertions.filter((assertion) => assertion.status === 'validating').length,
    todo: assertions.filter((assertion) => assertion.status === 'todo').length,
    requiringTest: assertions.filter((assertion) => assertion.requiresTest).length,
  };
  const tone = summary.failed > 0 ? 'is-failed' : summary.passed === summary.total ? 'is-passed' : 'is-pending';

  return (
    <section className={`build-validation-contract ${tone}`} aria-label={`Validation contract for ${plan.title}`}>
      <header>
        <div>
          <span>Validation contract</span>
          <strong>{summary.passed}/{summary.total} assertions passed</strong>
        </div>
        <small>
          {summary.failed > 0 ? `${summary.failed} failed · ` : ''}
          {summary.validating > 0 ? `${summary.validating} validating · ` : ''}
          {summary.todo > 0 ? `${summary.todo} pending · ` : ''}
          {summary.requiringTest} require tests
        </small>
      </header>
      <ul>
        {plan.items.flatMap((item) => (item.validationAssertions ?? []).map((assertion) => (
          <li key={assertion.id} className={`is-${assertion.status}`}>
            <div className="build-validation-heading">
              <code>{assertion.id}</code>
              <span>{assertion.status}</span>
              <small>{item.id}{assertion.requiresTest ? ' · automated test required' : ' · inspection allowed'}</small>
            </div>
            <p>{assertion.verify}</p>
            <dl>
              <dt>Evidence</dt>
              <dd>{assertion.evidenceLocator || 'No evidence locator recorded.'}</dd>
              <dt>Provenance</dt>
              <dd>Canonical plan · line {assertion.sourceLineNumber}</dd>
            </dl>
          </li>
        )))}
      </ul>
    </section>
  );
}

const BuildItem = memo(function BuildItem({
  item,
  plan,
  onOpenDocument,
  onOpenWorkItem,
}: {
  item: BuildHistoryWorkItem;
  plan: BuildHistoryPlan;
  onOpenDocument: (plan: BuildHistoryPlan, trigger: HTMLAnchorElement) => void;
  // Required: the work-item opener is now wired top-down (BuildHistoryList →
  // BuildPlanCard → BuildPlanDetails → here) by WI-38718. It was briefly optional
  // as a compile-unblock by su-e8071 2026-09-05 16:03Z, while that handler did not
  // yet exist; the body invokes it unconditionally, so optional is not safe once a
  // handler exists. Keep it required — that is what makes the call site checked.
  onOpenWorkItem: (plan: BuildHistoryPlan, item: BuildHistoryWorkItem, trigger: HTMLAnchorElement) => void;
}) {
  const planSlug = plan.slug;
  const summary = summarizeBuildItemEvidence(item);
  const currentUrl = typeof window === 'undefined' ? '/' : window.location.href;
  const href = historyHref(planSlug, item.id, currentUrl);
  // History rows predate the work-item/plan association, so a missing ref is the
  // NORMAL case, not an error case: render no control at all rather than a link
  // whose href resolves to nothing (WI-38718 acceptance).
  const itemRef = item.id?.trim() ?? '';
  const planRef = planSlug?.trim() ?? '';
  const workItemHref = itemRef ? historyWorkItemHref(planRef || itemRef, itemRef, currentUrl) : null;
  const planHref = planRef ? historyDocumentHref(planRef, currentUrl) : null;

  return (
    <li className="build-item" id={historyElementId('item', item.id)}>
      <article>
        <header className="build-item-heading">
          <div>
            <span className="build-item-kind">{item.kind}</span>
            <h3>{item.title}</h3>
          </div>
          <time dateTime={item.completedAt ?? undefined} title={formatBuildDate(item.completedAt)}>
            {formatBuildDate(item.completedAt)}
          </time>
        </header>
        <div className="build-item-meta">
          <code>{item.id}</code>
          <span className="build-item-state">{item.state}</span>
          {item.completionAuthority ? <span>{item.completionAuthority}</span> : null}
          <a href={href}>Permalink</a>
        </div>
        {workItemHref || planHref ? (
          <div className="build-item-actions">
            {workItemHref ? (
              <a
                className="button small"
                href={workItemHref}
                aria-label={`Read the full work item ${itemRef}`}
                onClick={(event) => {
                  if (!isPlainPrimaryClick(event)) return;
                  event.preventDefault();
                  onOpenWorkItem(plan, item, event.currentTarget);
                }}
              >
                Read full work item
              </a>
            ) : null}
            {planHref ? (
              <a
                className="button ghost small"
                href={planHref}
                aria-label={`Read the full plan for ${itemRef || planRef}`}
                onClick={(event) => {
                  if (!isPlainPrimaryClick(event)) return;
                  event.preventDefault();
                  onOpenDocument(plan, event.currentTarget);
                }}
              >
                Read full plan
              </a>
            ) : null}
          </div>
        ) : null}
        <div className="build-item-evidence-grid">
          <EvidenceBlock title="What changed" lines={summary.changed} empty="No completion summary was attached." />
          <EvidenceBlock title="Verification" lines={summary.verification} empty="No structured verification result was attached." />
          <EvidenceBlock title="Files" lines={summary.files} empty="No changed-file list was attached." />
        </div>
        <BuildItemCommits item={item} />
        <LazyRawEvidence item={item} />
      </article>
    </li>
  );
});

function BuildPlanDetails({
  plan,
  targetItem,
  onOpenDocument,
  onOpenWorkItem,
}: {
  plan: BuildHistoryPlan;
  targetItem: string | null;
  onOpenDocument: (plan: BuildHistoryPlan, trigger: HTMLAnchorElement) => void;
  onOpenWorkItem: (plan: BuildHistoryPlan, item: BuildHistoryWorkItem, trigger: HTMLAnchorElement) => void;
}) {
  const items = useMemo(() => sortedItems(plan), [plan]);
  const [showItems, setShowItems] = useState(Boolean(targetItem));
  const [itemLimit, setItemLimit] = useState(ITEM_PAGE_SIZE);
  const latest = items[0] ?? null;
  const summaries = items.map(summarizeBuildItemEvidence);
  const changed = latest?.completionSummary
    ? [latest.completionSummary]
    : [`${items.length} completed ${items.length === 1 ? 'work item is' : 'work items are'} recorded for this plan.`];
  const verification = summaries.flatMap((summary) => summary.verification).filter((line, index, all) => all.indexOf(line) === index).slice(0, 3);
  const files = summaries.flatMap((summary) => summary.files).filter((line, index, all) => all.indexOf(line) === index).slice(0, 3);
  const firstItems = items.slice(0, itemLimit);
  const targetedItem = targetItem ? items.find((item) => item.id === targetItem) : null;
  const visibleItems = targetedItem && !firstItems.includes(targetedItem)
    ? [...firstItems, targetedItem]
    : firstItems;
  const planHref = historyDocumentHref(plan.slug, typeof window === 'undefined' ? '/' : window.location.href);

  return (
    <div className="build-plan-body">
      <div className="build-plan-evidence-grid">
        <EvidenceBlock title="What changed" lines={changed} empty="No completed work is recorded." />
        <EvidenceBlock
          title="Verification"
          lines={verification}
          empty={latest?.completionAuthority ? `Completion authority: ${latest.completionAuthority}` : 'No structured verification result was attached.'}
        />
        <EvidenceBlock title="Files" lines={files} empty="No changed-file list was attached." />
      </div>
      <div className="build-plan-actions">
        <a
          className="button small"
          href={planHref}
          onClick={(event) => {
            if (!isPlainPrimaryClick(event)) return;
            event.preventDefault();
            onOpenDocument(plan, event.currentTarget);
          }}
        >
          Read full plan
        </a>
        {latest ? (
          <a
            className="button small"
            href={historyWorkItemHref(plan.slug, latest.id, typeof window === 'undefined' ? '/' : window.location.href)}
            aria-label={`Read the full work item ${latest.id}`}
            onClick={(event) => {
              if (!isPlainPrimaryClick(event)) return;
              event.preventDefault();
              onOpenWorkItem(plan, latest, event.currentTarget);
            }}
          >
            Read full work item
          </a>
        ) : null}
        <CopyLinkButton href={planHref} label="Copy plan link" />
        {plan.project.repository?.webUrl ? (
          <a
            className="button ghost small"
            href={plan.project.repository.webUrl}
            target="_blank"
            rel="noreferrer"
          >
            View repository ↗
          </a>
        ) : null}
      </div>
      <BuildValidationContract plan={plan} />
      <BuildPlanCommits plan={plan} />
      <details className="build-work-items-disclosure" open={showItems} onToggle={(event) => setShowItems(event.currentTarget.open)}>
        <summary>{showItems ? 'Hide' : 'View'} {items.length} {items.length === 1 ? 'work item' : 'work items'}</summary>
        {showItems ? (
          <>
            {items.length > 0 ? (
              <ol className="build-item-list">
                {visibleItems.map((item) => (
                  <BuildItem
                    item={item}
                    plan={plan}
                    onOpenDocument={onOpenDocument}
                    onOpenWorkItem={onOpenWorkItem}
                    key={item.id}
                  />
                ))}
              </ol>
            ) : <p className="build-plan-empty">This plan has no completed work items yet.</p>}
            {itemLimit < items.length ? (
              <button className="button ghost small build-show-more" type="button" onClick={() => setItemLimit((limit) => limit + ITEM_PAGE_SIZE)}>
                Show {Math.min(ITEM_PAGE_SIZE, items.length - itemLimit)} more work items
              </button>
            ) : null}
          </>
        ) : null}
      </details>
    </div>
  );
}

function BuildPlanCard({
  plan,
  open,
  targetItem,
  onToggle,
  onOpenDocument,
  onOpenWorkItem,
}: {
  plan: BuildHistoryPlan;
  open: boolean;
  targetItem: string | null;
  onToggle: (open: boolean) => void;
  onOpenDocument: (plan: BuildHistoryPlan, trigger: HTMLAnchorElement) => void;
  onOpenWorkItem: (plan: BuildHistoryPlan, item: BuildHistoryWorkItem, trigger: HTMLAnchorElement) => void;
}) {
  const latest = sortedItems(plan)[0] ?? null;
  const commitCount = plan.completedItems.reduce((count, item) => count + item.commits.length, 0);
  const outcome = latest?.completionSummary
    ?? `${plan.completedItems.length} completed ${plan.completedItems.length === 1 ? 'work item' : 'work items'} recorded.`;

  return (
    <details
      className="build-plan-card"
      id={historyElementId('plan', plan.slug)}
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary className="build-plan-heading">
        <div className="build-plan-title">
          <div className="build-plan-meta-row">
            <span className="build-plan-status">{plan.status}</span>
            <span>{plan.completedItems.length} completed {plan.completedItems.length === 1 ? 'item' : 'items'}</span>
            {commitCount > 0 ? <span>{commitCount} {commitCount === 1 ? 'commit' : 'commits'}</span> : null}
            <time dateTime={plan.updatedAt ?? undefined} title={formatBuildDate(plan.updatedAt)}>
              Updated {formatBuildDate(plan.updatedAt)}
            </time>
          </div>
          <h2>{plan.title}</h2>
          <p>{outcome}</p>
          <code>{plan.slug}</code>
        </div>
        <span className="build-plan-disclosure" aria-hidden="true">{open ? '−' : '+'}</span>
      </summary>
      {open ? (
        <BuildPlanDetails
          plan={plan}
          targetItem={targetItem}
          onOpenDocument={onOpenDocument}
          onOpenWorkItem={onOpenWorkItem}
        />
      ) : null}
    </details>
  );
}

function BuildPlanDialog({
  documentSlug,
  plan,
  documentAssetBaseUrl,
  returnFocusRef,
  onClose,
}: {
  documentSlug: string | null;
  plan: BuildHistoryPlan | null;
  documentAssetBaseUrl: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={Boolean(documentSlug)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="build-plan-dialog-overlay" />
        <Dialog.Content
          className="build-plan-dialog"
          onCloseAutoFocus={(event) => {
            const trigger = returnFocusRef.current;
            if (!trigger?.isConnected) return;
            event.preventDefault();
            trigger.focus();
          }}
        >
          <header className="build-plan-dialog-header">
            <div>
              <span className="build-plan-dialog-eyebrow">Read-only plan record</span>
              <Dialog.Title>{plan?.title ?? 'Plan unavailable'}</Dialog.Title>
              <Dialog.Description>
                {plan
                  ? 'The complete committed plan, including its outline, item states, decisions, and references.'
                  : `No committed History snapshot contains ${documentSlug ?? 'this plan'}.`}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="build-plan-dialog-close" type="button" aria-label="Close plan">
                <span aria-hidden="true">×</span>
              </button>
            </Dialog.Close>
          </header>

          {plan ? (
            <>
              <dl className="build-plan-dialog-provenance" aria-label="Plan snapshot provenance">
                <div>
                  <dt>Snapshot</dt>
                  <dd>
                    <time dateTime={plan.snapshot.generatedAt}>{formatBuildDate(plan.snapshot.generatedAt)}</time>
                  </dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{plan.snapshot.workspace} / {plan.snapshot.harness}</dd>
                </div>
                <div>
                  <dt>Content hash</dt>
                  <dd><code title={plan.contentHash}>{plan.contentHash.slice(0, 12)}</code></dd>
                </div>
                <div>
                  <dt>Repository</dt>
                  <dd>
                    {plan.project.repository?.webUrl ? (
                      <a href={plan.project.repository.webUrl} target="_blank" rel="noreferrer">
                        {plan.project.repository.provider}
                      </a>
                    ) : plan.project.name}
                  </dd>
                </div>
                <div>
                  <dt>Generator</dt>
                  <dd>{plan.snapshot.generator}</dd>
                </div>
              </dl>
              <PlanDocumentView
                className="build-plan-dialog-document"
                value={plan.markdown}
                slug={plan.slug}
                frontmatter={plan.frontmatter}
                items={plan.items}
                decisions={plan.decisions}
                outline="left"
                assetBaseUrl={documentAssetBaseUrl}
                theme="light"
              />
            </>
          ) : (
            <div className="build-plan-dialog-missing" role="alert">
              <strong>This plan is not in the committed History snapshot.</strong>
              <p>Close the viewer and choose a plan from the current History list.</p>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The work-item half of the owner's request (WI-38718): the plan record has had
 * `BuildPlanDialog` since History shipped, and this is its counterpart — the full,
 * UNTRUNCATED record of one completed work item, addressable by `?work-item=`.
 */
function BuildWorkItemDialog({
  workItemId,
  match,
  returnFocusRef,
  onClose,
}: {
  workItemId: string | null;
  match: { item: BuildHistoryWorkItem; plan: BuildHistoryPlan } | null;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const evidence = match ? fullBuildItemEvidence(match.item) : null;
  return (
    <Dialog.Root open={Boolean(workItemId)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="build-plan-dialog-overlay" />
        <Dialog.Content
          className="build-plan-dialog build-work-item-dialog"
          onCloseAutoFocus={(event) => {
            const trigger = returnFocusRef.current;
            if (!trigger?.isConnected) return;
            event.preventDefault();
            trigger.focus();
          }}
        >
          <header className="build-plan-dialog-header">
            <div>
              <span className="build-plan-dialog-eyebrow">Read-only work-item record</span>
              <Dialog.Title>{match?.item.title ?? 'Work item unavailable'}</Dialog.Title>
              <Dialog.Description>
                {match
                  ? 'The complete committed work-item record, including its full completion evidence and commits.'
                  : `No committed History snapshot contains ${workItemId ?? 'this work item'}.`}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="build-plan-dialog-close" type="button" aria-label="Close work item">
                <span aria-hidden="true">×</span>
              </button>
            </Dialog.Close>
          </header>

          {match && evidence ? (
            /* One scrollable body: the plan dialog's 3-row grid ends in the document
               pane, but a work-item record has no single tall child to give the
               remaining row, so it scrolls as a whole instead. */
            <div className="build-work-item-dialog-body">
              <dl className="build-plan-dialog-provenance" aria-label="Work item provenance">
                <div>
                  <dt>Work item</dt>
                  <dd><code>{match.item.id}</code></dd>
                </div>
                <div>
                  <dt>Kind</dt>
                  <dd>{match.item.kind}</dd>
                </div>
                <div>
                  <dt>State</dt>
                  <dd>{match.item.state}</dd>
                </div>
                <div>
                  <dt>Completed</dt>
                  <dd>
                    <time dateTime={match.item.completedAt ?? undefined}>
                      {formatBuildDate(match.item.completedAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Authority</dt>
                  <dd>{match.item.completionAuthority ?? 'Not recorded'}</dd>
                </div>
                <div>
                  <dt>Plan</dt>
                  <dd>
                    {/* The reverse link: a work item must reach its plan without hunting. */}
                    <a href={historyDocumentHref(match.plan.slug, typeof window === 'undefined' ? '/' : window.location.href)}>
                      {match.plan.title}
                    </a>
                  </dd>
                </div>
              </dl>
              <div className="build-item-evidence-grid build-work-item-dialog-evidence">
                <EvidenceBlock title="What changed" lines={evidence.changed} empty="No completion summary was attached." />
                <EvidenceBlock title="Verification" lines={evidence.verification} empty="No structured verification result was attached." />
                <EvidenceBlock title="Files" lines={evidence.files} empty="No changed-file list was attached." />
              </div>
              <BuildItemCommits item={match.item} />
            </div>
          ) : (
            <div className="build-plan-dialog-missing" role="alert">
              <strong>This work item is not in the committed History snapshot.</strong>
              <p>Close the viewer and choose a work item from the current History list.</p>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function BuildHistoryMetrics({ plans, now }: { plans: readonly BuildHistoryPlan[]; now: Date }) {
  const summary = summarizeBuildHistory(plans, now);
  return (
    <>
      <section className="build-metric-grid" aria-label="Release summary">
        <div className="build-metric">
          <span>Latest verified</span>
          <strong>{summary.latestVerified?.item.title ?? 'None recorded'}</strong>
          <small>{summary.latestVerified ? `${summary.latestVerified.plan.title} · ${formatBuildDate(summary.latestVerified.item.completedAt)}` : 'Waiting for evidence-backed completion'}</small>
        </div>
        <div className="build-metric">
          <span>Completed work items</span>
          <strong>{summary.completedTotal}</strong>
          <small>{summary.completedThisWeek} completed this week</small>
        </div>
        <div className="build-metric">
          <span>Plans</span>
          <strong>{summary.totalPlans}</strong>
          <small>{summary.deliveredPlans} delivered · {summary.activePlans} in flight</small>
        </div>
        <div className="build-metric">
          <span>Last ledger update</span>
          <strong>{formatBuildDate(summary.lastUpdatedAt)}</strong>
          <small>Newest plan or completion timestamp</small>
        </div>
      </section>
      <div className={`build-verification-banner${summary.latestVerified ? '' : ' is-pending'}`}>
        <span className="build-verification-mark" aria-hidden="true">{summary.latestVerified ? '✓' : '◇'}</span>
        <div>
          <strong>{summary.latestVerified ? 'Verified delivery evidence is attached' : 'No verified delivery is recorded yet'}</strong>
          <p>{summary.latestVerified ? `${summary.latestVerified.item.id} is the newest completed item with evidence or completion authority.` : 'Completed work will appear here when its ledger entry includes evidence or completion authority.'}</p>
        </div>
        <span className="build-verification-status">{summary.latestVerified ? 'Ledger verified' : 'Pending'}</span>
      </div>
    </>
  );
}

export function BuildHistoryList({
  plans,
  documentAssetBaseUrl = '/vditor',
  initialTarget = null,
  initialDocument = null,
  initialWorkItem = null,
  now = new Date(),
}: {
  plans: readonly BuildHistoryPlan[];
  /** Consumer-hosted Vditor distribution; relative paths support static subdirectories. */
  documentAssetBaseUrl?: string;
  initialTarget?: BuildHistoryTarget | null;
  initialDocument?: string | null;
  initialWorkItem?: string | null;
  now?: Date;
}) {
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [status, setStatus] = useState('all');
  // The archive opens UNFILTERED by date: this page is the project's build
  // history, so a rolling window silently hid most of it (62 plans rendered as
  // 28). Narrowing stays available in the Date select; it is just not the
  // default. Keep this in sync with resetFilters below.
  const [date, setDate] = useState<BuildHistoryDateFilter>('all');
  const [kind, setKind] = useState('all');
  const [planLimit, setPlanLimit] = useState(PLAN_PAGE_SIZE);
  const [documentSlug, setDocumentSlug] = useState(initialDocument);
  const documentTriggerRef = useRef<HTMLElement | null>(null);
  const [workItemId, setWorkItemId] = useState(initialWorkItem);
  const workItemTriggerRef = useRef<HTMLElement | null>(null);
  const [openPlans, setOpenPlans] = useState<Set<string>>(() => (
    initialTarget ? new Set([initialTarget.plan]) : new Set()
  ));

  const statuses = useMemo(() => [...new Set(plans.map((plan) => plan.status.toLocaleLowerCase()))].sort(), [plans]);
  const kinds = useMemo(() => [...new Set(plans.flatMap((plan) => plan.completedItems.map((item) => item.kind.toLocaleLowerCase())))].sort(), [plans]);
  const matchedPlans = useMemo(() => filterBuildHistory(plans, {
    search: deferredSearch,
    status,
    date,
    kind,
  }, now), [plans, deferredSearch, status, date, kind, now]);
  const matchedSlugs = new Set(matchedPlans.map((plan) => plan.slug));
  const retainedOpenPlans = plans.filter((plan) => openPlans.has(plan.slug) && !matchedSlugs.has(plan.slug));
  const pagedPlans = matchedPlans.slice(0, planLimit);
  const preservedOpenPlans = plans.filter((plan) => openPlans.has(plan.slug) && !pagedPlans.includes(plan));
  const displayedPlans = [...pagedPlans, ...preservedOpenPlans];
  const documentPlan = plans.find((plan) => plan.slug === documentSlug) ?? null;
  // Resolve `?work-item=` against the WHOLE snapshot, not just the visible page:
  // a permalink must open its record even when filters exclude the owning plan.
  const workItemMatch = useMemo(() => {
    if (!workItemId) return null;
    for (const plan of plans) {
      const item = plan.completedItems.find((candidate) => candidate.id === workItemId);
      if (item) return { item, plan };
    }
    return null;
  }, [plans, workItemId]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPopState = () => {
      setDocumentSlug(readHistoryDocument());
      setWorkItemId(readHistoryWorkItem());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!initialTarget || typeof document === 'undefined') return;
    const targetId = historyElementId(initialTarget.item ? 'item' : 'plan', initialTarget.item ?? initialTarget.plan);
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (typeof target?.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start' });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialTarget, plans.length]);

  const resetFilters = () => {
    setSearch('');
    setStatus('all');
    setDate('all');
    setKind('all');
    setPlanLimit(PLAN_PAGE_SIZE);
  };

  const openDocument = (plan: BuildHistoryPlan, trigger: HTMLAnchorElement) => {
    documentTriggerRef.current = trigger;
    if (typeof window !== 'undefined') {
      const currentState = window.history.state;
      const state = currentState && typeof currentState === 'object' ? currentState : {};
      window.history.pushState(
        { ...state, [HISTORY_DOCUMENT_STATE]: plan.slug },
        '',
        historyDocumentHref(plan.slug, window.location.href),
      );
    }
    // historyDocumentHref drops `work-item`, so the URL already says one viewer;
    // keep the rendered state in step or both dialogs stack.
    setWorkItemId(null);
    setDocumentSlug(plan.slug);
  };

  const closeDocument = () => {
    if (typeof window === 'undefined') {
      setDocumentSlug(null);
      return;
    }
    const currentState = window.history.state;
    if (
      currentState
      && typeof currentState === 'object'
      && currentState[HISTORY_DOCUMENT_STATE] === documentSlug
    ) {
      window.history.back();
      return;
    }
    const state = currentState && typeof currentState === 'object'
      ? { ...currentState }
      : {};
    delete state[HISTORY_DOCUMENT_STATE];
    window.history.replaceState(state, '', historyDocumentCloseHref(window.location.href));
    setDocumentSlug(null);
  };

  const openWorkItem = (
    plan: BuildHistoryPlan,
    item: BuildHistoryWorkItem,
    trigger: HTMLAnchorElement,
  ) => {
    workItemTriggerRef.current = trigger;
    if (typeof window !== 'undefined') {
      const currentState = window.history.state;
      const state = currentState && typeof currentState === 'object' ? currentState : {};
      window.history.pushState(
        { ...state, [HISTORY_WORK_ITEM_STATE]: item.id },
        '',
        historyWorkItemHref(plan.slug, item.id, window.location.href),
      );
    }
    setDocumentSlug(null);
    setWorkItemId(item.id);
  };

  const closeWorkItem = () => {
    if (typeof window === 'undefined') {
      setWorkItemId(null);
      return;
    }
    const currentState = window.history.state;
    // If WE pushed this entry, go back so the Back button stays honest; otherwise
    // the record was deep-linked and there is no entry of ours to pop.
    if (
      currentState
      && typeof currentState === 'object'
      && currentState[HISTORY_WORK_ITEM_STATE] === workItemId
    ) {
      window.history.back();
      return;
    }
    const state = currentState && typeof currentState === 'object'
      ? { ...currentState }
      : {};
    delete state[HISTORY_WORK_ITEM_STATE];
    window.history.replaceState(state, '', historyWorkItemCloseHref(window.location.href));
    setWorkItemId(null);
  };

  if (plans.length === 0 && !documentSlug && !workItemId) {
    return (
      <div className="build-history-empty">
        <span aria-hidden="true">◇</span>
        <h2>No completed builds yet</h2>
        <p>Completed project work will appear here with its verification and validation evidence.</p>
      </div>
    );
  }

  return (
    <>
      <BuildPlanDialog
        documentSlug={documentSlug}
        documentAssetBaseUrl={documentAssetBaseUrl}
        plan={documentPlan}
        returnFocusRef={documentTriggerRef}
        onClose={closeDocument}
      />
      <BuildWorkItemDialog
        workItemId={workItemId}
        match={workItemMatch}
        returnFocusRef={workItemTriggerRef}
        onClose={closeWorkItem}
      />
      <BuildHistoryMetrics plans={plans} now={now} />
      <section className="build-history-toolbar" aria-label="Release filters">
        <label className="build-history-search">
          <span className="skip-link">Search build history</span>
          <input
            className="text-input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search plan, work item, outcome, or file"
            aria-label="Search build history"
          />
        </label>
        <label>
          <span>Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option>
            {statuses.map((option) => <option value={option} key={option}>{option}</option>)}
          </select>
        </label>
        <label>
          <span>Date</span>
          <select value={date} onChange={(event) => setDate(event.target.value as BuildHistoryDateFilter)}>
            <option value="all">All time</option>
            <option value="30d">Last 30 days</option>
            <option value="7d">Last 7 days</option>
          </select>
        </label>
        <label>
          <span>Work type</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="all">All work types</option>
            {kinds.map((option) => <option value={option} key={option}>{option}</option>)}
          </select>
        </label>
      </section>

      <div className="build-history-results-heading">
        <div>
          <h2>Recently updated</h2>
          <p aria-live="polite">
            {matchedPlans.length} {matchedPlans.length === 1 ? 'plan matches' : 'plans match'}
            {retainedOpenPlans.length > 0 ? ` · ${retainedOpenPlans.length} open outside the filters` : ''}
          </p>
        </div>
        <button className="button ghost small" type="button" onClick={resetFilters}>Reset filters</button>
      </div>

      {displayedPlans.length > 0 ? (
        <div className="build-plan-list" aria-label="Build plans">
          {displayedPlans.map((plan) => (
            <BuildPlanCard
              plan={plan}
              open={openPlans.has(plan.slug)}
              targetItem={initialTarget?.plan === plan.slug ? initialTarget.item : null}
              onToggle={(open) => setOpenPlans((current) => {
                const next = new Set(current);
                if (open) next.add(plan.slug);
                else next.delete(plan.slug);
                return next;
              })}
              onOpenDocument={openDocument}
              onOpenWorkItem={openWorkItem}
              key={plan.slug}
            />
          ))}
          {planLimit < matchedPlans.length ? (
            <button className="button ghost build-show-more" type="button" onClick={() => setPlanLimit((limit) => limit + PLAN_PAGE_SIZE)}>
              Show {Math.min(PLAN_PAGE_SIZE, matchedPlans.length - planLimit)} more plans
            </button>
          ) : null}
        </div>
      ) : (
        <div className="build-history-empty">
          <span aria-hidden="true">⌕</span>
          <h2>No plans match these filters</h2>
          <p>Reset the filters or search for a different plan, work item, outcome, or file.</p>
        </div>
      )}
    </>
  );
}

export const ProjectHistoryView = BuildHistoryList;
export type ProjectHistoryPlan = BuildHistoryPlan;
export type ProjectHistoryWorkItem = BuildHistoryWorkItem;
export type ProjectHistoryTarget = BuildHistoryTarget;
