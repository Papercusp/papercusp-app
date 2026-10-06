/**
 * acceptance-runtime-wait-guard.ts — check whether a proposed main wait is
 * necessary for the caller's acceptance bars and remaining plan work.
 *
 * The psu-pty implementer armed `events:await release:deployed` to finish acceptance on
 * bars whose code runs in bg-host — code a :3070 deploy never carries. The wait was
 * pure latency. This guard notices the SHAPE of that wait (a release-deploy event key,
 * or a loop goal that names main / :3070 / a deploy) and, when the plan the caller holds
 * has live/deployed bars measured on a runtime OTHER than the release operator, attaches
 * an advisory naming those runtimes.
 *
 * The acceptance-plane check below remains advisory: a caller may genuinely need
 * the release operator for one bar. The plan-frontier check runs BEFORE registration
 * and refuses a plan-wide park when staging work is available or a downstream
 * dependency has not been reviewed. It never rewrites the plan graph itself.
 */
import { resolveBarEvidenceRuntime, type BarEvidenceRuntime } from './acceptance-bar-evidence-runtime';
import type { EvidenceRuntimeId } from './serving-runtimes';
import { currentBuildRoutesForRuntime, isRuntimeVintageEvidenceRuntimeId } from './serving-runtimes';
import { withBoundedTimeout } from './bounded-timeout';
import {
  hasNarrowDeployedMainException,
  isLiveGateOperationText,
  narrowExceptionDiagnosis,
} from './agent-tools/plans/staging-first-activation-guard';

/** Event keys whose only meaning is "the release operator received new code". */
export function isDeployWaitEvent(key: string | null | undefined): boolean {
  if (!key) return false;
  return /^(release:deployed|release:deploy-|deploy:await|release:green(?::|$)|green-checkpoint:(?:red|inconclusive|held)(?::|$))/.test(key.trim());
}

export interface MainWaitPlanItem {
  id: string;
  text: string;
  effectiveStatus: string;
  blockedBy: readonly string[];
  /** The coverage and issue-block floors used by plans:items actionable=true. */
  linkedBlocked: boolean;
  liveHeld: boolean;
  heldByCaller: boolean;
}

export interface MainWaitPlanSnapshot {
  slug: string;
  items: readonly MainWaitPlanItem[];
  /** plans:items actionable=true withholds every item while this plan gate is active. */
  specTriadGated?: boolean;
}

export interface MainWaitPlanReview {
  plan: string;
  allowWait: boolean;
  code: 'plan_main_wait_review_required';
  readyItems: string[];
  downstreamItems: Array<{ item: string; path: string[] }>;
  waitRoots: string[];
  reasonAccepted: boolean;
  message: string;
}

const isOpen = (item: MainWaitPlanItem): boolean =>
  item.effectiveStatus !== 'done' && item.effectiveStatus !== 'dropped';

/**
 * A main wait may be right for one item without stopping the plan. Show work that
 * can start now and the full downstream chain to review before parking. A path is
 * a candidate for semantic review, never proof that its dependency is false.
 */
export function reviewMainWaitPlan(
  snapshot: MainWaitPlanSnapshot,
  explanation: string | null | undefined,
): MainWaitPlanReview | null {
  const open = snapshot.items.filter(isOpen);
  if (open.length === 0) return null;
  const text = explanation?.trim() ?? '';
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  const heldRoots = open.filter((item) => item.heldByCaller).map((item) => item.id);
  const namedRoots = (text.match(/\bP-\d{3,}\b/g) ?? []).filter((id) => byId.has(id));
  const inferredRoots = open.filter((item) => goalNamesDeployWait(item.text)).map((item) => item.id);
  const waitRoots = [...new Set(heldRoots.length ? heldRoots : inferredRoots.length ? inferredRoots : namedRoots)];
  const readyItems = open
    .filter((item) => !snapshot.specTriadGated && !waitRoots.includes(item.id) && item.effectiveStatus === 'todo' && !item.linkedBlocked && (!item.liveHeld || item.heldByCaller))
    .map((item) => item.id);

  // A release fixer may legitimately wait for the verdict it is operating.
  if (waitRoots.length > 0 && waitRoots.every((id) => isLiveGateOperationText(byId.get(id)!.text))) return null;

  const downstreamItems: MainWaitPlanReview['downstreamItems'] = [];
  const seen = new Set(waitRoots);
  const queue = waitRoots.map((id) => [id]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const parent = path[path.length - 1]!;
    for (const item of open) {
      if (!item.blockedBy.includes(parent) || seen.has(item.id)) continue;
      seen.add(item.id);
      const childPath = [...path, item.id];
      if (!item.liveHeld && item.effectiveStatus === 'blocked') {
        downstreamItems.push({ item: item.id, path: childPath });
      }
      queue.push(childPath);
    }
  }

  const reasonAccepted = hasNarrowDeployedMainException(text);
  const descendantsReviewed = downstreamItems.every(({ item }) => text.includes(item));
  const allowWait = !snapshot.specTriadGated && readyItems.length === 0 && reasonAccepted && descendantsReviewed;
  const parts = [
    `Plan ${snapshot.slug} still has ${open.length} open item(s).`,
    readyItems.length
      ? `Staging-ready work: ${readyItems.join(', ')}. Continue or hand off this work before parking the plan.`
      : 'No unheld staging-ready item was found.',
    snapshot.specTriadGated
      ? 'The plan spec triad currently gates its work; resolve that plan authoring gap before parking on main.'
      : '',
    downstreamItems.length
      ? `Review these blocked-by paths before waiting: ${downstreamItems.map(({ path }) => path.join(' -> ')).join('; ')}. If later items need only the staging result, revise their edges with plans:set-item-blocked-by; do not reorder them automatically.`
      : 'No downstream blocked-by path was found from the waiting item.',
    reasonAccepted
      ? ''
      : narrowExceptionDiagnosis(text, 'the wait note or goal'),
    descendantsReviewed
      ? ''
      : `Name each reviewed downstream item (${downstreamItems.map(({ item }) => item).join(', ')}) in that explanation and state why it truly needs the deployed result.`,
  ].filter(Boolean);
  return {
    plan: snapshot.slug,
    allowWait,
    code: 'plan_main_wait_review_required',
    readyItems,
    downstreamItems,
    waitRoots,
    reasonAccepted,
    message: parts.join(' '),
  };
}

/**
 * A loop goal that is waiting on the release plane. Deliberately narrow — "main" alone is
 * an ordinary English word — so it only matches the release-plane phrasings agents write.
 */
export function goalNamesDeployWait(goal: string | null | undefined): boolean {
  if (!goal) return false;
  return (
    /\bgreen[- ]main\b/i.test(goal) ||
    /\bgreen[- ]checkpoint\b/i.test(goal) ||
    /:3070\b/.test(goal) ||
    /\brelease:green\b/i.test(goal) ||
    /\brelease:deployed\b/i.test(goal) ||
    /\b(wait(ing)?|until|once|after|blocked)\b[^.\n]{0,40}\b(main|deploy(ed|s)?|deployment)\b/i.test(goal) ||
    /\b(reach(es|ed)?|land(s|ed)? (on|in)|promot(e|es|ed) to|on) main\b/i.test(goal)
  );
}

export interface HeldLiveBar {
  planSlug: string;
  barKey: string;
  evidencePlane: 'deployed' | 'live';
  resolution: BarEvidenceRuntime;
}

/** Non-null iff some held live/deployed bar is measured somewhere other than :3070. */
export function buildAcceptancePlaneAdvisory(bars: ReadonlyArray<HeldLiveBar>): string | null {
  const elsewhere = bars.filter(
    (b) => b.resolution.source === 'declared' && b.resolution.runtime !== null && b.resolution.runtime !== 'release-operator',
  );
  const inferredElsewhere = bars.filter(
    (b) => b.resolution.source === 'inferred' && b.resolution.runtime !== null && b.resolution.runtime !== 'release-operator',
  );
  if (elsewhere.length === 0 && inferredElsewhere.length === 0) return null;
  const byRuntime = new Map<EvidenceRuntimeId, string[]>();
  for (const bar of elsewhere) {
    const runtime = bar.resolution.runtime!;
    const list = byRuntime.get(runtime) ?? [];
    list.push(`${bar.planSlug}#${bar.barKey}`);
    byRuntime.set(runtime, list);
  }
  const where = [...byRuntime.entries()].map(([runtime, keys]) => `${runtime}: ${keys.join(', ')}`).join('; ');
  const routes = [...byRuntime.keys()].flatMap((runtime) =>
    currentBuildRoutesForRuntime(runtime).map((route) =>
      `${route.id}: ${route.readiness === 'gap' ? 'GAP — prepare isolated runtime first' : route.route} ` +
      `[${route.isolation}; prerequisites: ${route.prerequisites.join(', ')}]`,
    ),
  );
  const releaseBars = bars.filter((b) => b.resolution.runtime === 'release-operator').map((b) => `${b.planSlug}#${b.barKey}`);
  const unknownBars = [
    ...inferredElsewhere.map((b) => `${b.planSlug}#${b.barKey}: runtime unknown (source-path inference only)`),
  ];
  const vintageRuntimes = [...byRuntime.keys()].filter(isRuntimeVintageEvidenceRuntimeId);
  return (
    `ACCEPTANCE-PLANE ADVISORY: this wait is on the release operator (:3070 / green main), but the live/deployed ` +
    (elsewhere.length
      ? `acceptance bars you hold with declared runtimes are measured elsewhere — ${where}. Measure those on their declared runtime ` +
        `(dev:pipeline_position { path } → servingRuntimes names each runtime's build and whether it runs your change); `
      : '') +
    (unknownBars.length
      ? `${unknownBars.join('; ')}; read the BAR method and confirm its required runtime before measuring. `
      : '') +
    (routes.length ? `Current-build test route(s): ${routes.join('; ')}. ` : '') +
    (vintageRuntimes.length
      ? `External runtime(s): ${vintageRuntimes.join(', ')} — read deploys:vintage for the exact workspace/unit/host and build; if absent or unmeasured, keep acceptance unknown. An operator test route cannot substitute for it. `
      : '') +
    `a :3070 deploy does not change code they execute. ` +
    (releaseBars.length
      ? `Only ${releaseBars.join(', ')} genuinely need the release operator. `
      : unknownBars.length ? '' : 'None of your held bars needs the release operator. ') +
    'Registered anyway — this is advice, not a refusal.'
  );
}

export interface WaitGuardDeps {
  /** The plan slugs the caller is working (presence currentPlanSlug + held plan work). */
  heldPlanSlugs: (ownerId: string) => Promise<string[]>;
  /** The live acceptance criteria of a plan (null when it has none). */
  acceptanceCriteria: (planSlug: string) => Promise<ReadonlyArray<{
    barKey?: string;
    key: string;
    evidencePlane?: 'tree' | 'deployed' | 'live';
    evidenceRuntime?: EvidenceRuntimeId;
    model?: string;
    method?: string;
    driftMarkers?: string;
    replication?: string;
  }> | null>;
  /** The same plan item, issue-block, and live-holder floors used by plans:items. */
  planSnapshot?: (ownerId: string) => Promise<MainWaitPlanSnapshot | null>;
}

async function realPlanWaitSnapshot(ownerId: string): Promise<MainWaitPlanSnapshot | null> {
  const { getPresence } = await import('./agent-tools/coordination/presence');
  const presence = await getPresence(ownerId);
  const slug = presence?.currentPlanSlug;
  if (!slug || !presence?.workspaceId) return null;
  const { getPlanRow, planItemsForRow, resolvePlanHarnessSlug } = await import('./agent-tools/plans/source');
  const harnessSlug = await resolvePlanHarnessSlug(presence.workspaceId, slug);
  if (!harnessSlug) return null;
  const row = await getPlanRow(slug, { workspaceId: presence.workspaceId, harnessSlug });
  if (!row || row.status === 'shipped' || row.status === 'superseded') return null;
  const { specTriadGate, specTriadEpoch } = await import('./agent-tools/plans/spec-triad-policy');
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const { resolveEffectiveStatusForItems } = await import('@papercusp/plan-parser');
  const { getBlockingIssuesForPlan, applyPlanItemBlocks, planItemRef } = await import('./issue-blocks-merge');
  const { getAllPlanItemCoverage, isLiveHeldCoverage } = await import('./plan-item-coverage');
  const planItems = planItemsForRow(row);
  const [flagEnabled, blockingInfo, coverage] = await Promise.all([
    getFlag(FLAGS.SPEC_TRIAD_REQUIRED, 'system:plans-items').catch(() => false),
    getBlockingIssuesForPlan(slug),
    getAllPlanItemCoverage({ planItemRefs: planItems.map((item) => planItemRef(slug, item.id)) }),
  ]);
  const specTriadGated = specTriadGate(
    { planSlug: slug, content: row.content, created: row.created, itemCount: planItems.length },
    { flagEnabled, epoch: specTriadEpoch() },
  ).gated;
  const resolved = resolveEffectiveStatusForItems(planItems).items;
  const items = applyPlanItemBlocks(resolved, (id) => blockingInfo.blockedItems.get(id)).items;
  return {
    slug,
    specTriadGated,
    items: items.map((item) => {
      const held = coverage.get(planItemRef(slug, item.id));
      return {
        id: item.id,
        text: item.text,
        effectiveStatus: item.effectiveStatus,
        blockedBy: item.blockedBy,
        linkedBlocked: held?.links.some((link) => link.blocked === true) ?? false,
        liveHeld: isLiveHeldCoverage(held?.level),
        heldByCaller: held?.workers.includes(ownerId) ?? false,
      };
    }),
  };
}

/** Run before registering a release wait; absent plan state never invents a refusal. */
export async function mainWaitPlanReviewForWait(
  input: { ownerId: string | null | undefined; event?: string | null; goal?: string | null; note?: string | null },
  deps: WaitGuardDeps = REAL_WAIT_GUARD_DEPS,
): Promise<MainWaitPlanReview | null> {
  const ownerId = input.ownerId;
  if (!ownerId || (!isDeployWaitEvent(input.event) && !goalNamesDeployWait(input.goal))) return null;
  try {
    if (!deps.planSnapshot) return null;
    const probe = await withBoundedTimeout(() => deps.planSnapshot!(ownerId), {
      fallback: null,
      timeoutMs: 8_000,
      label: 'main-wait-plan-review',
    });
    const snapshot = probe.value;
    return snapshot ? reviewMainWaitPlan(snapshot, input.note ?? input.goal) : null;
  } catch {
    return null;
  }
}

export async function loadHeldLiveBars(ownerId: string, deps: WaitGuardDeps): Promise<HeldLiveBar[]> {
  const slugs = [...new Set(await deps.heldPlanSlugs(ownerId))].slice(0, 5);
  const out: HeldLiveBar[] = [];
  for (const planSlug of slugs) {
    const criteria = await deps.acceptanceCriteria(planSlug).catch(() => null);
    for (const c of criteria ?? []) {
      if (c.evidencePlane !== 'live' && c.evidencePlane !== 'deployed') continue;
      out.push({
        planSlug,
        barKey: c.barKey ?? c.key,
        evidencePlane: c.evidencePlane,
        resolution: resolveBarEvidenceRuntime(c),
      });
    }
  }
  return out;
}

async function realHeldPlanSlugs(ownerId: string): Promise<string[]> {
  const { getPresence } = await import('./agent-tools/coordination/presence');
  const presence = await getPresence(ownerId).catch(() => null);
  return presence?.currentPlanSlug ? [presence.currentPlanSlug] : [];
}

async function realAcceptanceCriteria(planSlug: string) {
  const { getAcceptanceRubricForPlan } = await import('./rubrics');
  const rubric = await getAcceptanceRubricForPlan(planSlug).catch(() => null);
  return rubric?.criteria ?? null;
}

export const REAL_WAIT_GUARD_DEPS: WaitGuardDeps = {
  heldPlanSlugs: realHeldPlanSlugs,
  acceptanceCriteria: realAcceptanceCriteria,
  planSnapshot: realPlanWaitSnapshot,
};

/**
 * The one call both wait surfaces make. Cheap when the wait is not deploy-shaped (no I/O),
 * and it never throws — a failed read degrades to "no advisory", never to a refused wait.
 */
export async function acceptancePlaneAdvisoryForWait(
  input: { ownerId: string | null | undefined; event?: string | null; goal?: string | null },
  deps: WaitGuardDeps = REAL_WAIT_GUARD_DEPS,
): Promise<string | null> {
  if (!input.ownerId) return null;
  if (!isDeployWaitEvent(input.event) && !goalNamesDeployWait(input.goal)) return null;
  try {
    return buildAcceptancePlaneAdvisory(await loadHeldLiveBars(input.ownerId, deps));
  } catch {
    return null;
  }
}
