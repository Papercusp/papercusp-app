/**
 * Workspace WORK-SCOPE policy — "agents work only the allowed harnesses"
 * (plan workspace-work-scope-policy-2026-09-04; owner directive 2026-09-04:
 * only papercusp-related work runs, nothing for other pots).
 *
 * WHERE IT LIVES: as the `workScope` key of the operator_pot_control_policy row
 * (JSONB, no migration — reuse-first over a new table). Read SYNC through the
 * pot-control-policy cache so hot paths (claims, spawns, promotions) never await
 * a DB read just to ask "is this harness allowed?".
 *
 * WHERE IT IS ENFORCED: at the CHOKEPOINTS that START or HAND OUT work —
 * agent launches, scheduler pulls / claims, admission promotion, fixer
 * dispatch, grading sweeps. NEVER at filing: an item filed under another pot is
 * still recorded (and, when it is really papercusp work, RE-HOMED — see the
 * classifier below), it just cannot be worked while out of scope.
 *
 * FAIL-OPEN BY DESIGN: no policy / mode:'off' / an unreadable row ⇒ every
 * subject is allowed and every gate is byte-identical to before. A missing
 * policy must never freeze the fleet.
 */
import { placementOverride, readPotControlPolicy, refreshPotControlPolicy, writePotControlPolicy } from './pot-control-policy';
import type { RefusalContract } from './capability-envelope/identity-refusal-contract';

export interface WorkScopeException {
  /** harness slug or glob (`foo/*`) the exception admits */
  harness?: string;
  /** exact plan slug */
  plan?: string;
  /** exact goal id */
  goal?: string;
  /** exact work-item id */
  workItem?: string;
  reason: string;
  setBy?: string;
}

export type WorkScopeVerdictKind = 'denied' | 'held' | 'rehomed';

export interface WorkScopeDecision {
  at: string;
  /** the chokepoint that decided, e.g. `scheduler:get_next`, `capability:launch-agent`, `git-sync:content-fixer` */
  site: string;
  verdict: WorkScopeVerdictKind;
  harness: string | null;
  /** the plan / work-item / goal / install the decision was about */
  subject?: string;
  actor?: string;
  note?: string;
}

export interface WorkScopeLedger {
  entries: WorkScopeDecision[];
  counts: Record<WorkScopeVerdictKind, number>;
}

export interface WorkScopePolicy {
  mode: 'enforce' | 'off';
  /** harness slugs or globs (`papercusp/*` admits every sub-harness of papercusp) */
  allowHarnesses: string[];
  exceptions?: WorkScopeException[];
  setBy?: string;
  reason?: string;
  updatedAt?: string;
  /** bounded ring of the most recent decisions + running counts (loudness, not history) */
  ledger?: WorkScopeLedger;
}

/** Ring size of `ledger.entries` — the last N decisions, never the full history. */
export const WORK_SCOPE_LEDGER_CAP = 100;

const EMPTY_COUNTS: Record<WorkScopeVerdictKind, number> = { denied: 0, held: 0, rehomed: 0 };

/**
 * Glob match for harness patterns. `*` matches everything; `foo/*` matches `foo`
 * AND every `foo/...` sub-harness (the ~37 `papercusp/libs/*` submodules are
 * registered as sub-harnesses and must stay in scope with their root); a trailing
 * `*` is a plain prefix; anything else is an exact slug.
 */
export function matchHarnessPattern(pattern: string, slug: string): boolean {
  const p = (pattern ?? '').trim();
  const s = (slug ?? '').trim();
  if (!p || !s) return false;
  if (p === '*') return true;
  if (p.endsWith('/*')) {
    const root = p.slice(0, -2);
    return s === root || s.startsWith(`${root}/`);
  }
  if (p.endsWith('*')) return s.startsWith(p.slice(0, -1));
  return p === s;
}

function coercePolicy(raw: unknown): WorkScopePolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<WorkScopePolicy>;
  if (p.mode !== 'enforce' && p.mode !== 'off') return null;
  if (!Array.isArray(p.allowHarnesses)) return null;
  return p as WorkScopePolicy;
}

/** The live policy (sync, cache-backed). null ⇒ no policy stored. */
export function workScopePolicy(): WorkScopePolicy | null {
  return coercePolicy((placementOverride() as { workScope?: unknown }).workScope);
}

export function isWorkScopeEnforced(policy: WorkScopePolicy | null = workScopePolicy()): policy is WorkScopePolicy {
  return !!policy && policy.mode === 'enforce' && policy.allowHarnesses.some((h) => typeof h === 'string' && h.trim());
}

/**
 * Cheap boolean for list filters. A null / `*` harness is UNSCOPED (the concrete
 * harness is gated wherever it resolves), so it reads as in scope here.
 */
export function isHarnessInScope(slug: string | null | undefined, policy: WorkScopePolicy | null = workScopePolicy()): boolean {
  if (!isWorkScopeEnforced(policy)) return true;
  const s = slug?.trim();
  if (!s || s === '*') return true;
  return policy.allowHarnesses.some((p) => matchHarnessPattern(p, s));
}

export interface WorkScopeSubject {
  harness: string | null | undefined;
  plan?: string | null;
  goal?: string | null;
  workItem?: string | null;
  actor?: string | null;
}

export type WorkScopeAllowed = {
  allowed: true;
  reason: 'no-policy' | 'mode-off' | 'unscoped' | 'in-scope' | 'exception';
  exception?: WorkScopeException;
};
export type WorkScopeDenied = {
  allowed: false;
  code: 'scope_denied';
  harness: string;
  allowHarnesses: string[];
  message: string;
  setBy?: string;
  reason?: string;
  /** WI-10005197: what would LIFT the denial (the policy edit / exception / re-home that makes it allowed). */
  refusal?: RefusalContract;
};
export type WorkScopeVerdict = WorkScopeAllowed | WorkScopeDenied;

/** Pure decision — no I/O, no ledger. */
export function evaluateWorkScope(subject: WorkScopeSubject, policy: WorkScopePolicy | null = workScopePolicy()): WorkScopeVerdict {
  if (!policy) return { allowed: true, reason: 'no-policy' };
  if (!isWorkScopeEnforced(policy)) return { allowed: true, reason: 'mode-off' };
  const h = subject.harness?.trim();
  if (!h || h === '*') return { allowed: true, reason: 'unscoped' };
  if (policy.allowHarnesses.some((p) => matchHarnessPattern(p, h))) return { allowed: true, reason: 'in-scope' };
  const exception = (policy.exceptions ?? []).find(
    (e) =>
      (!!e.harness && matchHarnessPattern(e.harness, h)) ||
      (!!e.plan && !!subject.plan && e.plan === subject.plan) ||
      (!!e.goal && !!subject.goal && e.goal === subject.goal) ||
      (!!e.workItem && !!subject.workItem && e.workItem === subject.workItem),
  );
  if (exception) return { allowed: true, reason: 'exception', exception };
  const allow = policy.allowHarnesses.join(', ');
  const provenance = `${policy.setBy ? `; set by ${policy.setBy}` : ''}${policy.reason ? `: ${policy.reason}` : ''}`;
  return {
    allowed: false,
    code: 'scope_denied',
    harness: h,
    allowHarnesses: [...policy.allowHarnesses],
    setBy: policy.setBy,
    reason: policy.reason,
    refusal: {
      observed: { harness: h, allowHarnesses: allow || null, policySetBy: policy.setBy ?? null },
      liftsWhen:
        `harness '${h}' matches the workspace work-scope policy allow-list, or carries a work-scope exception. ` +
        `Widen the policy or add an exception with workspace:work_scope { op:'set' }, or re-home the item to an ` +
        `allowed harness if it is really that harness's work. Out-of-scope work is parked, never deleted`,
      whoCanMakeItTrue: ['owner', 'self'],
    },
    message:
      `scope_denied: harness '${h}' is outside the workspace work-scope policy (allowed: ${allow}${provenance}). ` +
      `Out-of-scope work is parked, never deleted — widen the policy or add an exception with workspace:work_scope { op:'set' }, ` +
      `or re-home the item to an allowed harness if it is really that harness's work.`,
  };
}

/** The refusal envelope every gated tool returns for a denial (one shape, greppable). */
export function workScopeRefusal(
  v: WorkScopeDenied,
  extra?: Record<string, unknown>,
): { ok: false; error: string; harness: string | null; message: string; [k: string]: unknown } {
  return {
    ok: false as const,
    error: v.code,
    harness: v.harness,
    allowHarnesses: v.allowHarnesses,
    message: v.message,
    ...(v.setBy ? { setBy: v.setBy } : {}),
    ...(v.reason ? { reason: v.reason } : {}),
    ...(v.refusal ? { refusal: v.refusal } : {}),
    ...extra,
  };
}

/**
 * Append one decision to the bounded ledger on the policy row (best-effort: a
 * ledger write failure is logged and never blocks the gate that produced it).
 */
export async function recordWorkScopeDecision(d: Omit<WorkScopeDecision, 'at'> & { at?: string }): Promise<void> {
  const line = `[work-scope] ${d.verdict} @${d.site}: harness=${d.harness ?? '?'}${d.subject ? ` subject=${d.subject}` : ''}${d.actor ? ` actor=${d.actor}` : ''}${d.note ? ` — ${d.note}` : ''}`;
  console.warn(line);
  try {
    const current = (await readPotControlPolicy()) as { workScope?: unknown };
    const ws = coercePolicy(current.workScope);
    if (!ws) return;
    const entry: WorkScopeDecision = { at: d.at ?? new Date().toISOString(), site: d.site, verdict: d.verdict, harness: d.harness, subject: d.subject, actor: d.actor, note: d.note };
    const entries = [...(ws.ledger?.entries ?? []), entry].slice(-WORK_SCOPE_LEDGER_CAP);
    const counts = { ...EMPTY_COUNTS, ...(ws.ledger?.counts ?? {}) };
    counts[d.verdict] = (counts[d.verdict] ?? 0) + 1;
    await writePotControlPolicy({ workScope: { ...ws, ledger: { entries, counts } } });
  } catch (e) {
    console.warn(`[work-scope] ledger write failed (decision still applied): ${(e as Error)?.message ?? e}`);
  }
  await broadcastWorkScopeDecision(d).catch((e) => {
    console.warn(`[work-scope] broadcast failed (decision still applied): ${(e as Error)?.message ?? e}`);
  });
}

/** P-011 loudness: one owner-inbox line + one recurrence observation per (site, harness), throttled. */
const WORK_SCOPE_BROADCAST_THROTTLE_MS = 10 * 60_000;
const lastBroadcastAt = new Map<string, number>();
const WORK_SCOPE_SYSTEM_IDENTITY = {
  ownerId: 'system:work-scope-policy',
  ownerLabel: 'system · work-scope-policy',
  source: 'principal',
  workspaceId: null,
  userId: null,
} as const;

async function broadcastWorkScopeDecision(d: Omit<WorkScopeDecision, 'at'> & { at?: string }): Promise<void> {
  if (process.env.VITEST) return;
  const key = `${d.site}|${d.harness ?? '?'}|${d.verdict}`;
  const now = Date.now();
  const last = lastBroadcastAt.get(key) ?? 0;
  if (now - last < WORK_SCOPE_BROADCAST_THROTTLE_MS) return;
  lastBroadcastAt.set(key, now);
  const headline =
    `🛂 work-scope ${d.verdict} @${d.site}: harness '${d.harness ?? '?'}'` +
    `${d.subject ? ` (${d.subject})` : ''}${d.actor ? ` by ${d.actor}` : ''}`;
  const [{ sendMessage }, { captureImprovement }] = await Promise.all([
    import('./agent-tools/coordination/messages'),
    import('./harness/improvements/capture-core'),
  ]);
  await sendMessage(WORK_SCOPE_SYSTEM_IDENTITY as unknown as Parameters<typeof sendMessage>[0], {
    to: ['human'],
    summary: headline,
    body:
      `${headline}. ${d.note ?? ''} Out-of-scope work is parked, never deleted. ` +
      `Inspect: workspace:work_scope { op:'get' } (ledger + counts); widen: workspace:work_scope { op:'set' }.`,
  } as Parameters<typeof sendMessage>[1]);
  await captureImprovement({
    title: `work-scope ${d.verdict}: harness ${d.harness ?? '?'} refused at ${d.site}`,
    kind: 'change',
    lane: 'observation',
    conditionKey: `scope:${d.verdict}:${d.harness ?? 'unknown'}`,
    body: `${headline}. ${d.note ?? ''}`.trim(),
    foundDuring: 'workspace-work-scope-policy-2026-09-04',
  } as Parameters<typeof captureImprovement>[0]);
}

let primed: Promise<void> | null = null;

/**
 * Prime the sync policy cache ONCE per process. `placementOverride()` starts EMPTY at
 * boot and is filled by a 60s managed refresh, so the first gate evaluations after a
 * restart read "no-policy" and fail OPEN — measured 2026-09-05: the first
 * `work_items:rehome` classify after a :3170 restart answered `in-scope` for a
 * `calendar` item while the stored policy was enforce/['papercusp'], and a fresh-process
 * probe of gateWorkScope('sidestage') answered `no-policy` for the same row. One awaited
 * read closes that window; a read error keeps the fail-open contract
 * (refreshPotControlPolicy never throws — it keeps the last value). Skipped under VITEST,
 * where ./pot-control-policy is mocked and the sync cache IS the fixture.
 */
export function primeWorkScopePolicy(): Promise<void> {
  if (process.env.VITEST) return Promise.resolve();
  if (!primed) primed = refreshPotControlPolicy().catch(() => undefined);
  return primed;
}

/**
 * One-call gate for a chokepoint: evaluate, and on a denial record it. Returns
 * the verdict so the caller shapes its own refusal (tool result vs. skip vs. throw).
 * With no explicit `policy` the cache is primed first (see primeWorkScopePolicy) so the
 * first call after a boot judges the STORED policy, not the empty cache.
 */
export async function gateWorkScope(site: string, subject: WorkScopeSubject, policy?: WorkScopePolicy | null): Promise<WorkScopeVerdict> {
  if (policy === undefined) {
    await primeWorkScopePolicy();
    policy = workScopePolicy();
  }
  const v = evaluateWorkScope(subject, policy);
  if (!v.allowed) {
    await recordWorkScopeDecision({
      site,
      verdict: 'denied',
      harness: v.harness,
      subject: subject.plan ?? subject.workItem ?? subject.goal ?? undefined,
      actor: subject.actor ?? undefined,
    });
  }
  return v;
}

interface WorkScopeSqlExceptionTerms {
  exactHarnesses: string[];
  harnessLikePrefixes: string[];
  plans: string[];
  goals: string[];
  workItems: string[];
}

interface WorkScopeSqlTerms {
  exact: string[];
  likePrefixes: string[];
  exceptions?: WorkScopeSqlExceptionTerms;
}

/**
 * The allow-list and explicit exceptions as SQL-ready terms. `null` means the
 * policy is unenforced or admits every harness, so callers emit no predicate.
 * The admission promoter uses these terms for both its admitted set and the
 * complementary held census; keep every exception axis aligned with
 * evaluateWorkScope.
 */
export function workScopeSqlTerms(policy: WorkScopePolicy | null = workScopePolicy()): WorkScopeSqlTerms | null {
  if (!isWorkScopeEnforced(policy)) return null;
  const exact: string[] = [];
  const likePrefixes: string[] = [];
  for (const raw of policy.allowHarnesses) {
    if (appendHarnessSqlTerm(raw, exact, likePrefixes)) return null;
  }

  const exceptionTerms: WorkScopeSqlExceptionTerms = {
    exactHarnesses: [],
    harnessLikePrefixes: [],
    plans: [],
    goals: [],
    workItems: [],
  };
  for (const exception of policy.exceptions ?? []) {
    if (appendHarnessSqlTerm(exception.harness, exceptionTerms.exactHarnesses, exceptionTerms.harnessLikePrefixes)) {
      return null;
    }
    if (exception.plan) exceptionTerms.plans.push(exception.plan);
    if (exception.goal) exceptionTerms.goals.push(exception.goal);
    if (exception.workItem) exceptionTerms.workItems.push(exception.workItem);
  }

  const hasExceptions = Object.values(exceptionTerms).some((terms) => terms.length > 0);
  return { exact, likePrefixes, ...(hasExceptions ? { exceptions: exceptionTerms } : {}) };
}

/** Returns true only when this pattern admits every harness. */
function appendHarnessSqlTerm(raw: string | undefined, exact: string[], likePrefixes: string[]): boolean {
  const p = (raw ?? '').trim();
  if (!p) return false;
  if (p === '*') return true;
  if (p.endsWith('/*')) {
    const root = p.slice(0, -2);
    exact.push(root);
    likePrefixes.push(`${escapeLike(root)}/%`);
  } else if (p.endsWith('*')) {
    likePrefixes.push(`${escapeLike(p.slice(0, -1))}%`);
  } else {
    exact.push(p);
  }
  return false;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Async read for the tool / status surfaces (never for hot paths — use workScopePolicy()). */
export async function readWorkScopePolicy(workspaceId?: string): Promise<WorkScopePolicy | null> {
  const current = (await readPotControlPolicy(workspaceId)) as { workScope?: unknown };
  return coercePolicy(current.workScope);
}

export async function setWorkScopePolicy(
  next: Omit<WorkScopePolicy, 'ledger' | 'updatedAt'>,
  opts: { keepLedger?: boolean } = {},
): Promise<WorkScopePolicy> {
  const prior = await readWorkScopePolicy();
  const stored: WorkScopePolicy = {
    mode: next.mode,
    allowHarnesses: next.allowHarnesses.map((h) => h.trim()).filter(Boolean),
    ...(next.exceptions?.length ? { exceptions: next.exceptions } : {}),
    ...(next.setBy ? { setBy: next.setBy } : {}),
    ...(next.reason ? { reason: next.reason } : {}),
    updatedAt: new Date().toISOString(),
    ...(opts.keepLedger !== false && prior?.ledger ? { ledger: prior.ledger } : {}),
  };
  await writePotControlPolicy({ workScope: stored });
  return stored;
}

export async function clearWorkScopePolicy(): Promise<void> {
  await writePotControlPolicy({ workScope: undefined });
}

/**
 * P-010 — session homing integrity. A session's presence pot is DERIVED from its
 * harness (potHomeSlugForHarness); an explicitly requested pot that disagrees with
 * that derivation is how four sessions ended up homed in `sb-devboard-hive` while
 * doing papercusp work (EI-22374455128414213). Pure: the caller supplies both.
 */
export function reconcilePresencePot(input: {
  requested: string | null | undefined;
  derived: string | null | undefined;
  harnessSlug: string | null | undefined;
}): { potSlug: string | null; corrected: boolean; note?: string } {
  const harness = input.harnessSlug?.trim();
  const derived = input.derived?.trim() || null;
  const requested = input.requested?.trim() || null;
  if (!harness || harness === '*' || !derived) return { potSlug: requested ?? derived, corrected: false };
  if (requested && requested !== derived) {
    return {
      potSlug: derived,
      corrected: true,
      note: `presence pot '${requested}' disagrees with the home pot '${derived}' derived from harness '${harness}' — corrected to the derived pot (EI-22374455128414213)`,
    };
  }
  return { potSlug: requested ?? derived, corrected: false };
}

/**
 * P-009 — the NON-NAIVE half. An out-of-scope work-item is not automatically
 * "other pot's work": papercusp platform defects are routinely filed under the pot
 * where they SURFACED (git-sync content-guard quarantines in calendar/email/
 * sidestage, tool bugs from a mis-homed session). Classify before parking:
 * platform-referencing items are re-homed to the platform harness, only genuinely
 * other-pot work is held. Pure and conservative — every signal is a positive
 * reference to the platform, so an ambiguous item stays `hold`.
 */
export interface RehomeClassifierInput {
  harness: string;
  title?: string | null;
  body?: string | null;
  paths?: string[] | null;
  /** the creating role (content-fixer / merge-resolver / release-fixer / git-sync are platform system roles) */
  createdByRole?: string | null;
  /** tool refs / `tool:` attributions on the item */
  toolRefs?: string[] | null;
}
export interface RehomeClassifierPolicy {
  /** the platform harness items get re-homed to (papercusp) */
  platformHarness: string;
  /** repo-relative path prefixes that only exist in the platform tree */
  platformPathPrefixes: string[];
  /** system roles that are the platform's own machinery even when they run in another pot's tree */
  platformSystemRoles: string[];
  /** vocabulary that names platform surfaces (tool verbs, subsystems) */
  platformTerms: string[];
  /**
   * Harness-slug prefixes that are the platform's own NON-POT homes. `operator:<workspaceId>` is
   * the legacy workspace-global issue slug (issues-engineer.ts now homes `operator` scope to the
   * platform Pot), so anything still landing there was mis-homed by a filer that skipped that
   * resolution — never another pot's work. WI-10004723: 14 learning-loop alarms filed under
   * `operator:papercusp-workspace` sat held by scope for 6 days because no text signal matched.
   */
  platformHarnessPrefixes: string[];
}

export const DEFAULT_REHOME_CLASSIFIER_POLICY: RehomeClassifierPolicy = {
  platformHarness: 'papercusp',
  platformPathPrefixes: [
    'packages/operator-core/',
    'packages/agent-mcp/',
    'apps/operator/',
    'libs/papercusp/',
    'libs/flags/',
    'orchestrator/',
    'papercusp-desktop/',
    'scripts/',
  ],
  platformSystemRoles: ['content-fixer', 'merge-resolver', 'release-fixer', 'git-sync', 'green-checkpoint', 'judge'],
  platformTerms: [
    'git-sync',
    'content-guard',
    'content guard',
    'identity-leak',
    'green-checkpoint',
    'release gate',
    'scheduler:get_next',
    'work_items:',
    'coord:',
    'plans:',
    'loop:',
    'fleet:',
    'tools:invoke',
    'capability:',
    'papercusp',
  ],
  platformHarnessPrefixes: ['operator:'],
};

/** True when `harness` is a platform non-pot home (`operator:<ws>`), i.e. a held row there is mis-homed. */
export function isPlatformNonPotHarness(
  harness: string | null | undefined,
  cls: RehomeClassifierPolicy = DEFAULT_REHOME_CLASSIFIER_POLICY,
): boolean {
  const slug = (harness ?? '').trim();
  return slug.length > 0 && cls.platformHarnessPrefixes.some((prefix) => slug.startsWith(prefix));
}

export type RehomeVerdict =
  | { action: 'keep'; reason: 'in-scope' }
  | { action: 'rehome'; to: string; signals: string[] }
  | { action: 'hold'; reason: 'no-platform-signal' };

export function classifyForRehome(
  item: RehomeClassifierInput,
  scope: WorkScopePolicy | null = workScopePolicy(),
  cls: RehomeClassifierPolicy = DEFAULT_REHOME_CLASSIFIER_POLICY,
): RehomeVerdict {
  if (isHarnessInScope(item.harness, scope)) return { action: 'keep', reason: 'in-scope' };
  const signals: string[] = [];
  if (isPlatformNonPotHarness(item.harness, cls)) signals.push(`harness:${item.harness.trim()}`);
  const role = item.createdByRole?.trim().toLowerCase();
  if (role && cls.platformSystemRoles.includes(role)) signals.push(`system-role:${role}`);
  for (const p of item.paths ?? []) {
    const path = (p ?? '').trim();
    if (!path) continue;
    const rel = path.startsWith(`${cls.platformHarness}/`) ? path.slice(cls.platformHarness.length + 1) : path;
    if (cls.platformPathPrefixes.some((pre) => rel.startsWith(pre))) signals.push(`path:${path}`);
  }
  for (const t of item.toolRefs ?? []) {
    const ref = (t ?? '').trim();
    if (ref) signals.push(`tool:${ref}`);
  }
  const text = `${item.title ?? ''}\n${item.body ?? ''}`.toLowerCase();
  for (const term of cls.platformTerms) {
    if (text.includes(term.toLowerCase())) signals.push(`term:${term}`);
  }
  if (signals.length === 0) return { action: 'hold', reason: 'no-platform-signal' };
  return { action: 'rehome', to: cls.platformHarness, signals };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Status lens — WI-2145092 (the D-003 residue: a `state:read` cell + /admin pane).
 *
 * ONE derivation, three doors: `workspace:work_scope_status` (the cell's read-only
 * resolver), the `workScope.policy` sync query (the /admin/work-scope pane) and the
 * `workspace:work_scope { op:'get' }` control tool all project THIS payload, so a
 * reader on any door sees exactly what the gates enforce.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The one code the `workspace.workScope` cell answers with. */
export type WorkScopeAssessment = 'enforce' | 'off' | 'absent';

/**
 * Pure assessor behind the cell, derived from the SAME predicate every dispatch gate
 * uses (isWorkScopeEnforced) — so `enforce` means "gates refuse out-of-scope work",
 * not "a row says enforce". An enforce row with an EMPTY allow-list confines nothing
 * (fail-open) and therefore reads `off`; no row at all reads `absent` (D-001:
 * byte-identical to before the policy shipped).
 */
export function assessWorkScope(policy: WorkScopePolicy | null): WorkScopeAssessment {
  if (isWorkScopeEnforced(policy)) return 'enforce';
  return policy ? 'off' : 'absent';
}

export interface WorkScopeStatusPayload {
  ok: true;
  /** headline of the `workspace.workScope` cell — the stored mode; null when no policy row exists */
  mode: WorkScopePolicy['mode'] | null;
  /** the gates' own verdict (isWorkScopeEnforced) — evidence for the assessment, independent of `mode` */
  enforced: boolean;
  allowHarnesses: string[];
  exceptions: number;
  setBy: string | null;
  reason: string | null;
  updatedAt: string | null;
  /** running counts plus the last `recent` decisions of the bounded ledger ring */
  ledger: { counts: Record<WorkScopeVerdictKind, number>; recent: WorkScopeDecision[] };
  assessments: { policy: WorkScopeAssessment };
}

export const WORK_SCOPE_STATUS_DEFAULT_RECENT = 10;

/** Build the status payload from a (possibly absent) policy. Pure: no I/O, no cache. */
export function buildWorkScopeStatusPayload(
  policy: WorkScopePolicy | null,
  opts: { recent?: number } = {},
): WorkScopeStatusPayload {
  const recent = Math.max(0, Math.min(WORK_SCOPE_LEDGER_CAP, opts.recent ?? WORK_SCOPE_STATUS_DEFAULT_RECENT));
  const entries = policy?.ledger?.entries ?? [];
  return {
    ok: true,
    mode: policy?.mode ?? null,
    enforced: isWorkScopeEnforced(policy),
    allowHarnesses: policy?.allowHarnesses ?? [],
    exceptions: policy?.exceptions?.length ?? 0,
    setBy: policy?.setBy ?? null,
    reason: policy?.reason ?? null,
    updatedAt: policy?.updatedAt ?? null,
    ledger: {
      counts: { ...EMPTY_COUNTS, ...(policy?.ledger?.counts ?? {}) },
      recent: recent > 0 ? entries.slice(-recent) : [],
    },
    assessments: { policy: assessWorkScope(policy) },
  };
}
