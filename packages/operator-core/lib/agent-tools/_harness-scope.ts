/**
 * Explicit harness-scope resolution for harness-scoped tools.
 *
 * Background (su-prompt-audit-fixes / the all-sentinel design): harness-scoped
 * readers (`docs:*`, `plans:*`) used to SILENTLY fall back to Papercusp's own
 * docs/plans when no harness was in context — so a caller who simply forgot to
 * scope got the wrong data with no signal. We make "operate without a specific
 * harness" an EXPLICIT choice instead: a caller passes the `all` sentinel (or a
 * concrete slug) deliberately; omitting it at operator scope is an error.
 *
 * The crux is the `'*'` auto-default: `http-projection` sets
 * `ctx.harnessSlug = '*'` for every superuser/operator-scope call. That makes
 * "no harness picked" indistinguishable from "all" at the ctx level — so we
 * treat a bare ctx `'*'` (or unset) as **no explicit choice** (`'none'`), and
 * require the caller to pass `all`/`'*'` as an explicit ARG to opt into
 * operator/cross-harness scope. A session launched scoped to a real harness
 * (concrete `ctx.harnessSlug`) resolves to that harness with no arg needed.
 *
 * Pure + returning (no throw) so each tool maps the result onto its own error
 * shape — `docs:*` return `{ error: { code: 'harness_required' } }`; the plans
 * resolvers wrap this and throw `HarnessRequiredError` for the dispatcher.
 */

import { z } from 'zod';
import { HarnessRequiredError } from '@papercusp/agent-mcp';
import type { Sql } from 'postgres';

/** Canonical "all harnesses / operator scope" sentinel. `'*'` can't collide
 *  with a real slug; `'all'` is an accepted friendly alias. */
export const HARNESS_ALL = '*';

/**
 * Reusable `harness` arg for harness-scoped tools — keeps the
 * description identical everywhere it's spread into an args schema
 * (`args: z.object({ harness: harnessArg, … })`).
 *
 * OPTIONAL at the schema level: harness-scoped sessions can omit it
 * (it's in ctx); operator-scoped calls must pass a concrete slug. The `all`
 * sentinel is available only to an unscoped (--all-workspaces) session.
 * The runtime check (harnessScopedCtx) enforces this and throws a proper
 * error message when a harness cannot be resolved.
 */
export const harnessArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Harness slug to operate on. In a workspace-scoped operator/superuser session, ' +
      "pass the concrete in-scope harness slug (for example, 'papercusp' for " +
      "Papercusp's own plans). 'all' is only valid in an unscoped (--all-workspaces) " +
      'session. A harness-scoped session supplies this automatically. Recovering an ' +
      'EXACT plan slug without knowing its owner? On plans:get / plans:items you may ' +
      'omit `harness` entirely — but only an UNSCOPED session auto-resolves the owning ' +
      'harness from the slug; a session already scoped to a concrete harness (the common ' +
      'case) stays scoped to it, and a miss there reports which OTHER harness actually ' +
      'owns the slug instead of silently reading across harnesses — pass that harness ' +
      'explicitly to read it.',
  );

/** True when a value is the explicit all/operator-scope sentinel. */
export function isAllHarnessSentinel(v: string | null | undefined): boolean {
  const s = v?.trim().toLowerCase();
  return s === '*' || s === 'all';
}

/**
 * EI-18894866320087268: a distinct, workspace-clamp-SAFE way for a doc-reading tool
 * (docs:search / docs:outline / docs:get) to reach the Papercusp engineering /
 * agent-insights corpus. `harness:'all'`/`'*'` is intentionally blocked for a
 * workspace-scoped superuser session by the transport-level scoped-superuser-
 * workspace clamp (`_mcp-handler.ts`'s `harness_forbidden`, P-006/P-007/P-008) — a
 * real security boundary against cross-workspace TENANT data. But the engineering
 * corpus is Papercusp's own static reference documentation, identical for every
 * workspace, not tenant data — so a workspace-scoped session should still be able
 * to read it. That clamp inspects only the literal strings `'all'`/`'*'`, so this
 * distinct literal reaches the tool's handler untouched even under a scoped
 * session. Docs tools treat a match exactly like `HarnessScope`'s `'all'` kind for
 * adapter-resolution purposes (see resolveAdapter's `!harnessSlug || harnessSlug
 * === '*'` branch) — never as a concrete harness slug to look up (which would 404
 * with `harness_not_registered`). It is NOT a general cross-harness/cross-workspace
 * escape: `resolveAdapter`'s own `isSuperuser` gate (and every OTHER clamp in
 * `_mcp-handler.ts`) still applies unchanged.
 */
export function isEngineeringDocsSentinel(v: string | null | undefined): boolean {
  return (v?.trim().toLowerCase() ?? '') === 'engineering';
}

/**
 * Drop a CALLER-SUPPLIED operator-scope harness sentinel from a context object, leaving a
 * concrete harness untouched.
 *
 * EI-20186804943808838: where `'*'` is treated as SATISFYING a concrete harness binding
 * (recipe authority does this — an operator-scope session is inside every harness's lane),
 * the sentinel becomes an authority-widening value, so it must only ever be asserted by the
 * SESSION ctx, never by caller-supplied args. Server-derived values normally win by being
 * spread last, but that leaves a gap wherever the server value can be absent — this closes it
 * at the source instead of relying on spread order.
 */
export function stripCallerOperatorScope<T extends { harness?: string | null }>(
  context: T | undefined | null,
): Partial<T> {
  if (!context) return {};
  if (!isAllHarnessSentinel(context.harness)) return context;
  const { harness: _operatorScopeSentinel, ...rest } = context;
  return rest as Partial<T>;
}

export type HarnessScope = { kind: 'harness'; slug: string } | { kind: 'all' } | { kind: 'none' };

/** The ordered, durable bindings that may supply one concrete harness. */
export type InheritedHarnessSource = 'explicit' | 'claim' | 'plan' | 'fleet' | 'brief' | 'session';

export interface HarnessScopeCandidate {
  source: InheritedHarnessSource;
  harnessSlug: string;
  refs: string[];
}

export interface HarnessBindingRead {
  harnesses?: readonly (string | null | undefined)[];
  refs?: readonly string[];
  /** A binding exists but is no longer trustworthy (expired/missing/moved). */
  stale?: boolean;
  detail?: string;
}

export interface HarnessScopeInheritanceInput {
  explicitHarness?: string | null;
  ownerId?: string | null;
  workspaceId?: string | null;
  /** Exact plan identities already bound by the caller. Presence supplies this when omitted. */
  planSlugs?: readonly string[];
  sessionHarness?: string | null;
  /**
   * Recovery-only escape for the coord:orient bootstrap: a missing plan binding
   * may be skipped so a current fleet/brief binding can restore the session.
   * Ordinary resolution remains fail-closed on stale durable bindings.
   */
  allowStalePlanFallback?: boolean;
  /**
   * An explicit MCP workspace scope is an isolation boundary. A stale ambient
   * claim/plan/fleet/brief from another workspace must not reject that request;
   * continue to any binding that is valid for the explicit workspace instead.
   */
  allowStaleAmbientFallback?: boolean;
}

export interface HarnessScopeInheritanceReaders {
  claim(input: HarnessScopeInheritanceInput): Promise<HarnessBindingRead>;
  plan(input: HarnessScopeInheritanceInput): Promise<HarnessBindingRead>;
  fleet(input: HarnessScopeInheritanceInput): Promise<HarnessBindingRead>;
  brief(input: HarnessScopeInheritanceInput): Promise<HarnessBindingRead>;
}

/**
 * Decide whether an MCP call may recover from a stale plan binding.
 *
 * `coord:orient` is the compound recovery surface and may re-declare intent
 * after it reaches the current fleet/brief binding. The direct
 * `coord:declare-intent` escape is narrower: it is allowed only when the
 * caller is explicitly clearing the plan binding, not when it is trying to
 * claim a plan lane through a stale scope.
 */
export function allowStalePlanRecoveryForMcpCall(
  toolName: string,
  args: Readonly<Record<string, unknown>> = {},
): boolean {
  // These are scope-repair doors. They must remain callable when the caller's
  // durable fleet/plan binding is stale, or the stale-scope gate removes the
  // very tools needed to clear the bad membership. coord:orient is the compound
  // recovery bootstrap; fleet:leave drops the stale fleet label.
  if (toolName === 'coord:orient' || toolName === 'fleet:leave' || toolName === 'fleet:step-down') return true;
  if (toolName !== 'coord:declare-intent') return false;

  const plan = args.current_plan_slug;
  const planIsClear = plan === undefined || plan === null || (typeof plan === 'string' && plan.trim() === '');
  const items = args.items;
  const itemsAreClear = items === undefined || (Array.isArray(items) && items.length === 0);
  return planIsClear && itemsAreClear;
}

type ActiveClaimBinding = {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  expired: boolean;
};

/** Injectable claim adapter, exported so hot callers can use an already-loaded store seam. */
export async function readClaimHarnessBinding(
  input: HarnessScopeInheritanceInput,
  readClaim: (workspaceId: string, ownerId: string) => Promise<ActiveClaimBinding | null>,
): Promise<HarnessBindingRead> {
  const workspaceId = concreteWorkspace(input);
  const ownerId = input.ownerId?.trim();
  if (!workspaceId || !ownerId) return {};
  const claim = await readClaim(workspaceId, ownerId);
  if (!claim) return {};
  const harnesses = [claim.harnessSlug];
  if (claim.expired || claim.workspaceId !== workspaceId) {
    return {
      harnesses,
      refs: [claim.workItemId],
      stale: true,
      detail: `active claim ${claim.workItemId} is expired or belongs to workspace ${claim.workspaceId}`,
    };
  }
  return { harnesses, refs: [claim.workItemId] };
}

type PresencePlanBinding = {
  currentPlanSlug?: string | null;
  workspaceId?: string | null;
  stale?: boolean;
};

export async function readPlanHarnessBinding(
  input: HarnessScopeInheritanceInput,
  readPresence: (ownerId: string) => Promise<PresencePlanBinding | null>,
  readPlanHarnesses: (workspaceId: string, slugs: readonly string[]) => Promise<Map<string, string[]>>,
): Promise<HarnessBindingRead> {
  const workspaceId = concreteWorkspace(input);
  if (!workspaceId) return {};
  let planSlugs = [...new Set((input.planSlugs ?? []).map((slug) => slug.trim()).filter(Boolean))];
  if (planSlugs.length === 0) {
    const ownerId = input.ownerId?.trim();
    if (!ownerId) return {};
    const presence = await readPresence(ownerId);
    const planSlug = presence?.currentPlanSlug?.trim();
    if (!planSlug) return {};
    if (presence?.stale || (presence?.workspaceId && presence.workspaceId !== workspaceId)) {
      return {
        refs: [planSlug],
        stale: true,
        detail: `bound plan ${planSlug} comes from stale or cross-workspace presence`,
      };
    }
    planSlugs = [planSlug];
  }
  const bySlug = await readPlanHarnesses(workspaceId, planSlugs);
  const missing = planSlugs.filter((slug) => (bySlug.get(slug) ?? []).length === 0);
  const harnesses = planSlugs.flatMap((slug) => bySlug.get(slug) ?? []);
  if (missing.length > 0) {
    return {
      harnesses,
      refs: planSlugs,
      stale: true,
      detail: `bound plan(s) no longer resolve in workspace ${workspaceId}: ${missing.join(', ')}`,
    };
  }
  return { harnesses, refs: planSlugs };
}

type ClaimSpecHarnessBinding = {
  source: 'cup' | 'fleet' | 'default';
  harnessSlug?: string | null;
  fleetSlug?: string;
};

export async function readFleetHarnessBinding(
  input: HarnessScopeInheritanceInput,
  readRecord: (args: { cupId: string; workspaceId: string }) => Promise<ClaimSpecHarnessBinding>,
): Promise<HarnessBindingRead> {
  const workspaceId = concreteWorkspace(input);
  const ownerId = input.ownerId?.trim();
  if (!workspaceId || !ownerId) return {};
  const record = await readRecord({ cupId: ownerId, workspaceId });
  // `default` is the sentinel for "no cup spec and no fleet spec — use the default
  // ordering". That is the ordinary state of a freshly created fleet, NOT a binding
  // that went stale: every other `stale: true` here marks a binding that EXISTED and
  // lost validity (an expired/cross-workspace claim, stale presence, a plan that no
  // longer resolves, a fleet spec missing its harness). Flagging `default` stale
  // hard-refused every MCP call from a member of any fleet not yet given a claim
  // spec — while the same record WITHOUT a fleetSlug returned {} and passed, so the
  // refusal keyed on merely carrying a fleet label rather than on any staleness.
  // An unbound fleet contributes no harness; resolution continues to the next source.
  // (WI-10000280. Taking LEADERSHIP still requires a concrete harness — enforced
  // separately by takeFleetLeadership's own fleet_harness_binding_required check.)
  if (record.source === 'default') return {};
  const harnessSlug = concreteHarness(record.harnessSlug);
  if (!harnessSlug) {
    return record.source === 'fleet'
      ? {
          refs: record.fleetSlug ? [record.fleetSlug] : [],
          stale: true,
          detail: 'fleet claim spec has no concrete harness binding',
        }
      : {};
  }
  return { harnesses: [harnessSlug], refs: record.fleetSlug ? [record.fleetSlug] : [] };
}

type SessionBriefHarnessBinding = {
  workspaceId?: string | null;
  harnessSlug?: string | null;
};

export async function readBriefHarnessBinding(
  input: HarnessScopeInheritanceInput,
  readBrief: (ownerId: string) => Promise<SessionBriefHarnessBinding | null>,
): Promise<HarnessBindingRead> {
  const ownerId = input.ownerId?.trim();
  if (!ownerId) return {};
  const brief = await readBrief(ownerId);
  const harnessSlug = concreteHarness(brief?.harnessSlug);
  if (!brief || !harnessSlug) return {};
  const workspaceId = concreteWorkspace(input);
  if (workspaceId && brief.workspaceId?.trim() && brief.workspaceId.trim() !== workspaceId) {
    return {
      harnesses: [harnessSlug],
      refs: [ownerId],
      stale: true,
      detail: `session brief belongs to workspace ${brief.workspaceId}, not ${workspaceId}`,
    };
  }
  return { harnesses: [harnessSlug], refs: [ownerId] };
}

export type InheritedHarnessScope =
  | {
      kind: 'harness';
      slug: string;
      source: InheritedHarnessSource;
      candidates: HarnessScopeCandidate[];
      conflictingBindings: HarnessScopeCandidate[];
    }
  | {
      kind: 'all';
      source: 'explicit';
      candidates: HarnessScopeCandidate[];
      conflictingBindings: HarnessScopeCandidate[];
    }
  | {
      kind: 'none';
      reason: 'missing' | 'ambiguous' | 'stale' | 'reader_error';
      source?: InheritedHarnessSource;
      candidates: HarnessScopeCandidate[];
      conflictingBindings: HarnessScopeCandidate[];
      detail?: string;
    };

function concreteHarness(value: string | null | undefined): string | null {
  const slug = value?.trim();
  return slug && !isAllHarnessSentinel(slug) ? slug : null;
}

function concreteWorkspace(input: HarnessScopeInheritanceInput): string | null {
  return concreteHarness(input.workspaceId);
}

/**
 * Give an inherited-scope reader the same bounded acquisition + connection-setup
 * retry as an ordinary workspace-scoped handler. These readers run BEFORE the
 * dispatcher can enter its normal handler transaction, so a bare org-pool read
 * here would bypass the only connect-phase deadline and can wedge scope
 * resolution indefinitely (EI-22575830430557187).
 *
 * Keep the workspace check outside `withWorkspace`: an incomplete bootstrap
 * input should remain an empty binding, not turn into a second "workspace is
 * empty" error. Each source reader supplies one callback, so related reads
 * (presence + plan ownership) share one bounded transaction rather than opening
 * nested transactions.
 */
async function withInheritedWorkspace<T>(
  input: HarnessScopeInheritanceInput,
  read: (tx: Sql) => Promise<T>,
): Promise<T | undefined> {
  const workspaceId = concreteWorkspace(input);
  if (!workspaceId) return undefined;
  const { withWorkspace } = await import('@papercusp/db-org');
  return withWorkspace(workspaceId, read);
}

/**
 * Production readers are loaded lazily so this foundational module does not import the
 * coordination, scheduler, plan, and carry stores back into every synchronous caller.
 * Tests inject small readers and exercise the decision independently of Postgres.
 */
export const defaultHarnessScopeInheritanceReaders: HarnessScopeInheritanceReaders = {
  async claim(input) {
    const { getActiveClaimForOwner } = await import('../work-item-claims');
    return (
      (await withInheritedWorkspace(input, (tx) =>
        readClaimHarnessBinding(input, (workspaceId, ownerId) =>
          getActiveClaimForOwner(workspaceId, ownerId, tx),
        ),
      )) ?? {}
    );
  },

  async plan(input) {
    const [{ getPresence }, { planHarnessesForSlugs }] = await Promise.all([
      import('./coordination/presence'),
      import('./plans/source'),
    ]);
    return (
      (await withInheritedWorkspace(input, (tx) =>
        readPlanHarnessBinding(
          input,
          (ownerId) => getPresence(ownerId, tx),
          (workspaceId, slugs) => planHarnessesForSlugs(workspaceId, slugs, tx),
        ),
      )) ?? {}
    );
  },

  async fleet(input) {
    const { getClaimSpecRecord } = await import('../scheduler/claim-spec-store');
    return (
      (await withInheritedWorkspace(input, (tx) =>
        readFleetHarnessBinding(input, (args) => getClaimSpecRecord(args, tx)),
      )) ?? {}
    );
  },

  async brief(input) {
    const { getSessionBrief } = await import('../session-brief');
    return (
      (await withInheritedWorkspace(input, (tx) =>
        readBriefHarnessBinding(input, (ownerId) => getSessionBrief({ ownerId }, tx)),
      )) ?? {}
    );
  },
};

/**
 * Resolve one concrete harness through the canonical precedence chain:
 * explicit argument → live work-item claim → bound plan → fleet claim spec →
 * durable session brief → session context.
 *
 * A binding reader is fail-closed: stale data, a thrown read, or more than one
 * concrete candidate returns a typed non-resolution instead of falling through
 * to a lower-precedence guess. The response always carries the candidates and
 * conflicting bindings that made the decision.
 */
export async function resolveInheritedHarnessScope(
  input: HarnessScopeInheritanceInput,
  readers: HarnessScopeInheritanceReaders = defaultHarnessScopeInheritanceReaders,
): Promise<InheritedHarnessScope> {
  const explicit = input.explicitHarness?.trim();
  if (explicit) {
    if (isAllHarnessSentinel(explicit)) {
      return { kind: 'all', source: 'explicit', candidates: [], conflictingBindings: [] };
    }
    const candidate = { source: 'explicit' as const, harnessSlug: explicit, refs: [] };
    return {
      kind: 'harness',
      slug: explicit,
      source: 'explicit',
      candidates: [candidate],
      conflictingBindings: [],
    };
  }

  const candidates: HarnessScopeCandidate[] = [];
  for (const source of ['claim', 'plan', 'fleet', 'brief'] as const) {
    let read: HarnessBindingRead;
    try {
      read = await readers[source](input);
    } catch (error) {
      return {
        kind: 'none',
        reason: 'reader_error',
        source,
        candidates,
        conflictingBindings: [],
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const refs = [...new Set((read.refs ?? []).map((ref) => ref.trim()).filter(Boolean))];
    const sourceCandidates = [
      ...new Set((read.harnesses ?? []).map(concreteHarness).filter((v): v is string => Boolean(v))),
    ].map((harnessSlug) => ({ source, harnessSlug, refs }));
    candidates.push(...sourceCandidates);
    if (read.stale) {
      // An explicit workspace selected on the transport outranks ambient
      // session bindings. Keep those bindings in the diagnostic candidate list,
      // but do not let a binding from the caller's previous workspace block the
      // explicitly selected workspace.
      if (input.allowStaleAmbientFallback) continue;
      // coord:orient / fleet:leave / explicit self-clear are recovery surfaces
      // for a session whose launch-bound plan OR fleet was retired/moved. Let
      // those callers continue to a current lower-precedence binding; ordinary
      // resolvers still fail closed here.
      if ((source === 'plan' || source === 'fleet') && input.allowStalePlanFallback) continue;
      return {
        kind: 'none',
        reason: 'stale',
        source,
        candidates,
        conflictingBindings: sourceCandidates,
        ...(read.detail ? { detail: read.detail } : {}),
      };
    }
    if (sourceCandidates.length > 1) {
      return {
        kind: 'none',
        reason: 'ambiguous',
        source,
        candidates,
        conflictingBindings: sourceCandidates,
        detail: `${source} binding resolves to multiple harnesses: ${sourceCandidates.map((c) => c.harnessSlug).join(', ')}`,
      };
    }
    if (sourceCandidates.length === 1) {
      const winner = sourceCandidates[0]!;
      return {
        kind: 'harness',
        slug: winner.harnessSlug,
        source,
        candidates,
        conflictingBindings: [],
      };
    }
  }

  const sessionHarness = concreteHarness(input.sessionHarness);
  if (sessionHarness) {
    const candidate = { source: 'session' as const, harnessSlug: sessionHarness, refs: [] };
    candidates.push(candidate);
    return {
      kind: 'harness',
      slug: sessionHarness,
      source: 'session',
      candidates,
      conflictingBindings: [],
    };
  }
  return { kind: 'none', reason: 'missing', candidates, conflictingBindings: [] };
}

/**
 * Resolve harness scope from an explicit per-call `harness` arg + the session
 * ctx. Precedence:
 *   1. explicit arg `all`/`'*'`            → `{ kind: 'all' }`   (deliberate operator/cross scope)
 *   2. explicit arg concrete slug          → `{ kind: 'harness', slug }`
 *   3. no arg, concrete `ctx.harnessSlug`  → `{ kind: 'harness', slug }`   (scoped session)
 *   4. no arg, ctx `'*'`/`'all'`/unset     → `{ kind: 'none' }`   (caller must opt in)
 */
export function resolveHarnessScope(
  argHarness: string | null | undefined,
  ctx: { harnessSlug?: string | null } | null | undefined,
): HarnessScope {
  const arg = argHarness?.trim();
  if (arg) {
    return isAllHarnessSentinel(arg) ? { kind: 'all' } : { kind: 'harness', slug: arg };
  }
  const c = ctx?.harnessSlug?.trim();
  if (c && !isAllHarnessSentinel(c)) return { kind: 'harness', slug: c };
  return { kind: 'none' };
}

/** Shared detail string for the `harness_required` error every gated tool returns. */
export const HARNESS_REQUIRED_DETAIL =
  'No harness specified. `harness` is a per-call arg — pass it on THIS call ' +
  "(you don't need a differently-scoped session): normally the concrete slug for that " +
  "harness (for example, `harness: 'papercusp'` for Papercusp's own plans). " +
  "`harness: 'all'` is valid only in an unscoped (`--all-workspaces`) session; a " +
  'workspace-scoped session rejects it as `harness_forbidden`. (A harness-scoped ' +
  'session supplies its concrete slug automatically.) Recovering an EXACT plan slug ' +
  'you already know? plans:get / plans:items resolve the owning harness automatically ' +
  'when you OMIT `harness` and pass the slug.';

export function harnessRequiredDetail(
  ctx?: { workspaceId?: string | null } | { harnessSlug?: string | null } | null,
): string {
  // Callers that resolve a scope carry `harnessSlug`, while plans resolvers also
  // carry `workspaceId`; accept both context shapes without making the generic
  // harness-scoped caller pretend every context has a workspace field.
  const workspaceId = ctx && 'workspaceId' in ctx ? ctx.workspaceId?.trim() : undefined;
  if (isAllHarnessSentinel(workspaceId)) {
    return (
      'No harness specified. This is an unscoped (`--all-workspaces`) session, so pass ' +
      "either a concrete harness slug or `harness: 'all'` on THIS call."
    );
  }
  if (workspaceId) {
    return (
      `No harness specified. This session is scoped to workspace "${workspaceId}". ` +
      "Pass the concrete in-scope harness slug on THIS call (for example, `harness: 'papercusp'` " +
      "for Papercusp's own plans). Do not retry with `harness: 'all'`: that is the unscoped " +
      'escape and this session will reject it as `harness_forbidden`.'
    );
  }
  return HARNESS_REQUIRED_DETAIL;
}

/**
 * Bulk harness-scope resolution (bulk-endpoint-standardization-2026-06-21): the
 * harness_docs:* writers are bulk (single | items[]), each item with an OPTIONAL
 * per-item `harness` override over the batch `harness` default. Resolve every
 * item's effective scope here, and decide the ONE top-level gate: if NOT A SINGLE
 * item can resolve to a concrete harness (batch default is non-harness AND no item
 * overrides), the whole batch can't run → `gate:true` so the handler returns the
 * top-level `{ ok:false, error:'harness_required' }` (isError) — the same shape
 * the pre-bulk single tools returned, so the harness-scope-gate test holds. When
 * at least one item resolves, the batch runs and an item whose own scope is
 * non-harness becomes that item's `{ ok:false, error:'harness_required' }`.
 */
export function resolveBulkHarnessScopes<T extends { harness?: string }>(
  items: readonly T[],
  batchHarness: string | undefined,
  ctx: { harnessSlug?: string | null } | null | undefined,
): { gate: boolean; scopes: HarnessScope[] } {
  const scopes = items.map((it) => resolveHarnessScope(it.harness ?? batchHarness, ctx));
  const gate = scopes.length === 0 || scopes.every((s) => s.kind !== 'harness');
  return { gate, scopes };
}

/**
 * For tools that resolve their harness through a **ctx-taking** helper (the
 * `plans:*` resolvers `ctxToPlanSourceOpts` / `resolveCtxHarnessSlug`): apply
 * the per-call `harness` arg by returning a ctx whose `harnessSlug` is the
 * resolved scope, and **throw `HarnessRequiredError`** (→ dispatcher
 * `harness_required`) when none is resolvable.
 *
 * `'all'` maps to the `'*'` wildcard — which those resolvers already treat as
 * "operator scope" (Papercusp's own plans). A concrete slug passes through.
 * So the existing resolvers stay UNCHANGED; the gate lives here, in the
 * handler, exactly as the `docs:*` tools gate before `resolveAdapter`.
 */
export function harnessScopedCtx<T extends { harnessSlug?: string | null }>(
  argHarness: string | null | undefined,
  ctx: T,
): T & { harnessSlug: string } {
  const scope = resolveHarnessScope(argHarness, ctx);
  if (scope.kind === 'none') throw new HarnessRequiredError(harnessRequiredDetail(ctx));
  return { ...ctx, harnessSlug: scope.kind === 'all' ? HARNESS_ALL : scope.slug };
}

/**
 * Resolve a single CONCRETE harness slug for a tool that operates on exactly ONE
 * harness — routed through the fail-loud {@link resolveHarnessScope}. Returns the
 * slug, or `null` when no single harness is resolvable: a bare/unset ctx, the
 * operator/superuser `'*'` auto-default, OR an explicit `all`/`'*'` arg (a
 * cross-harness scope is meaningless for a single-harness op).
 *
 * This is the durable fix for the `args.x ?? ctx.harnessSlug ?? ''` band-aid
 * family (workspace-data-isolation-leaks-2026-06-17 P-004): a `?? ''` guarded by
 * `if (!slug)` — or a `truthy:` requires-precondition — rejects the empty string
 * but NOT the `'*'` wildcard, so under operator scope those tools silently
 * read/wrote a nonexistent `'*'` bucket (empty results / no-op success) instead
 * of failing. Callers turn a `null` into {@link harnessRequiredResult}.
 */
export function resolveConcreteHarnessSlug(
  argHarness: string | null | undefined,
  ctx: { harnessSlug?: string | null } | null | undefined,
): string | null {
  const scope = resolveHarnessScope(argHarness, ctx);
  return scope.kind === 'harness' ? scope.slug : null;
}

/**
 * The standard MCP `harness_required` error result a harness-scoped tool returns
 * when no concrete harness can be resolved (mirrors `docs:get`). Fail LOUD — the
 * caller gets a clear, actionable error instead of an empty/wrong-scope success.
 */
export function harnessRequiredResult(
  toolName?: string,
  ctx?: { workspaceId?: string | null },
): {
  isError: true;
  content: { type: 'text'; text: string }[];
} {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: 'harness_required',
          ...(toolName ? { tool: toolName } : {}),
          detail: harnessRequiredDetail(ctx),
        }),
      },
    ],
  };
}
