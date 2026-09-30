/**
 * register-scout-action.ts — Scout's PRODUCTION cycle runner provider
 * (cb4b9's buildScoutCycleDeps + runScoutCycle), supplying the three
 * irreducibly-injected deps a Scout cycle owns:
 *
 * The bespoke `system:scout-cycle` ROUTINE ACTION was retired at
 * deterministic-blueprints-migration-2026-06-13 P-130 in favor of the `scout`
 * BLUEPRINT — its seed fires `system:blueprint-run {blueprintId:'scout'}` →
 * the `blender:cycle` deterministic step → `runScoutCycleTick` (which calls
 * `productionScoutRunner` below). That remains the primary, workspace-singleton
 * Scout path.
 *
 * EI-18741240128927188: P-130 retired the *workspace-singleton* action, but the
 * PER-POT `system:scout-cycle` routine row provisioned INACTIVE at pot:create
 * (`lib/pot/provision-learning-loop.ts` P-020, one day after P-130) was never
 * migrated off it — its own docstring promises "bring-up human-gated" arming,
 * but nothing registered a `system:scout-cycle` handler, so arming that row
 * silently ticked "no handler registered … skipping" forever. Fixed by
 * self-registering HERE, reusing the exact same `productionScoutRunner` the
 * blueprint path already uses — so a per-pot arm and the workspace singleton
 * run byte-identical cycle logic, and the shared `runScoutCycleTick`
 * single-flight claim (keyed by scope) still dedupes them to one fire per
 * cadence window if both are ever live for the same scope at once.
 * Injected deps:
 *
 *   - llmCall — the real stateless LLM client (lib/llm-testing/llm-client; it satisfies
 *     ScoutLlmCall directly via the gym:judge pattern). Lazily imported so a boot
 *     that only REGISTERS the action never loads the llm-client graph (the gym's
 *     ab-run pattern); it loads on the first real cycle.
 *   - createPlanDraft — the system-side `plans:new` DRAFT creator (scout-plan-draft).
 *   - archive — the gym-QD ArchivePort. P-012 production wire: built per cycle from
 *     su-8075f's real archive via {@link buildScoutArchivePort} (snapshot→seed→flush),
 *     so the gym (testable) rail seeds Scout's distant ideas into the MAP-Elites
 *     archive. Falls back to a NO-OP if the archive is unavailable (e.g. PG/migration
 *     193 absent) — the broad + concrete rails are unaffected.
 *
 * `productionScoutRunner` is used TWO ways: imported directly by the scout
 * blueprint's deterministic step, and wired here as the `system:scout-cycle`
 * per-pot routine action's runner (registerScoutCycleAction, below).
 */

import { registerScoutCycleAction, type ScoutCycleRunner } from './scout-cycle-action';
import { admissionDenialFrom, isCapacityError, type CapacityFallbackEvent } from './capacity-errors';
import { readScoutPoolSnapshot, scoutRoutableProviders } from './capacity-probe';
import { runScoutCycle } from './cycle';
import { buildScoutCycleDeps } from './cycle-deps';
import { applyDedupBurnToConfig, readDedupBurnVerdict } from './dedup-burn-guard';
import { DEFAULT_SCOUT_CONFIG } from './config';
import { createScoutPlanDraft } from './scout-plan-draft';
import { buildScoutArchivePort, type ScoutArchivePort } from './scout-archive-port';
import { nicheKey, type ArchivePort } from './gym-bridge';
import { scoutCoordOwnerId } from './coord-identity';
import { runScoutRevisionCycle } from './revise';
import {
  notifyMugDraftRouted,
  notifyMugRevised,
  type MugNotifyMessage,
  type MugNotifyPorts,
} from './mug-notify';
import { LEARNING_MODEL_SPEC } from '../learning/model-policy';

/**
 * Placeholder gym-QD archive used when the real archive can't be built (PG down /
 * migration 193 absent). Reads empty + admits nothing, so the gym-seed rail is a
 * safe no-op (the broad/concrete rails are unaffected).
 */
export const noopArchive: ScoutArchivePort = {
  listElites: () => [],
  seed: (entry) => ({ admitted: false, nicheKey: nicheKey(entry.descriptor.coords) }),
  flush: async () => {},
};

/** Builds the per-cycle ArchivePort for a harness (overridable for tests / alternate stores). */
export type ScoutArchiveBuilder = (scope: { workspaceId: string; harnessSlug: string }) => Promise<ArchivePort>;

const defaultArchiveBuilder: ScoutArchiveBuilder = (scope) => buildScoutArchivePort(scope);
const DEFAULT_ARCHIVE_RESOLVE_TIMEOUT_MS = 10_000;
const DEFAULT_SCOUT_CODEX_FALLBACK_MODEL = LEARNING_MODEL_SPEC;
const SCOUT_PROVIDER_CAPACITY_CACHE_MS = 1_000;

let activeArchiveBuilder: ScoutArchiveBuilder = defaultArchiveBuilder;
let scoutProviderCapacityCache:
  | { expiresAt: number; value: ScoutProviderCapacity }
  | undefined;
let scoutProviderCapacityRequest: Promise<ScoutProviderCapacity> | undefined;

export interface ScoutProviderCapacity {
  /** Whether the Claude/Anthropic pool can serve at least one request right now. */
  claudeAvailable: boolean;
  /** Whether the Codex provider has a configured, serving account to use as fallback. */
  codexAvailable: boolean;
}

/** The Codex model used only when the Claude pool is genuinely unavailable. */
export const SCOUT_CODEX_FALLBACK_MODEL = DEFAULT_SCOUT_CODEX_FALLBACK_MODEL;

/**
 * Read the gateway's provider-specific capacity without changing any routing state.
 *
 * `/stats.healthyAccounts` is the Claude pool's serviceable-account denominator. Codex's
 * ChatGPT-subscription bridge is reported by `/admin/config.providers.codex.cliAccountCount`;
 * bearer-backed Codex deployments are covered by `configured`. If either probe is unavailable,
 * fail closed to the historical Claude route rather than sending Scout into an unknown provider.
 *
 * ROUTING booleans only — the audit path (scheduler record-time discrimination, WI-5391
 * Part B) reads the raw {@link readScoutPoolSnapshot} instead, whose probe-failure is a
 * tristate `undefined`, never this function's fail-open "available".
 */
export async function readScoutProviderCapacity(fetchImpl: typeof fetch = fetch): Promise<ScoutProviderCapacity> {
  const snapshot = await readScoutPoolSnapshot(fetchImpl);
  if (!snapshot) return { claudeAvailable: true, codexAvailable: false };
  // The booleans themselves live in capacity-probe.ts so the P-016 cycle-top precheck
  // derives them from the SAME rule; this function keeps only its own fail-open policy
  // for a MISSING snapshot, which is deliberately NOT shared (the precheck's unknown is
  // a tristate that must not gate, not a fail-open "claude is fine").
  return scoutRoutableProviders(snapshot);
}

/** Cache the paired gateway probes so Scout's parallel ideators do not fan out diagnostics calls. */
export function cachedScoutProviderCapacity(): Promise<ScoutProviderCapacity> {
  const now = Date.now();
  if (scoutProviderCapacityCache && scoutProviderCapacityCache.expiresAt > now) {
    return Promise.resolve(scoutProviderCapacityCache.value);
  }
  if (!scoutProviderCapacityRequest) {
    scoutProviderCapacityRequest = readScoutProviderCapacity().then((value) => {
      scoutProviderCapacityCache = { expiresAt: Date.now() + SCOUT_PROVIDER_CAPACITY_CACHE_MS, value };
      return value;
    }).finally(() => {
      scoutProviderCapacityRequest = undefined;
    });
  }
  return scoutProviderCapacityRequest;
}

/** Test seam; also useful after an operator-side gateway hot-reload. */
export function resetScoutProviderCapacityCache(): void {
  scoutProviderCapacityCache = undefined;
  scoutProviderCapacityRequest = undefined;
}

/**
 * Pure Scout provider selection. A requested Codex model is authoritative and
 * is never rewritten back to Claude. A legacy Claude override may still run
 * while that pool is healthy; when it is unavailable, the fallback is the same
 * canonical Sol xhigh policy as every other Scout phase.
 */
export function resolveScoutModel(
  requestedModel: string | undefined,
  capacity: ScoutProviderCapacity,
  backendForModel: (model: string | undefined) => string,
  claudeModel: string,
): string | undefined {
  if (backendForModel(requestedModel) === 'codex') return requestedModel;
  if (!capacity.claudeAvailable && capacity.codexAvailable) return SCOUT_CODEX_FALLBACK_MODEL;
  return requestedModel ?? claudeModel;
}

/**
 * WI-5391 item 3 — cross-provider fallback-as-discriminator. `resolveScoutModel` only
 * reroutes when the pool was ALREADY empty at cycle start; a call whose pool walls
 * MID-cycle dies with an attested capacity denial and the cycle rides it into a timeout.
 * Wraps a call so such a denial gets ONE retry on the Codex bridge, recorded loudly in
 * `events`: `succeeded:true` after a Claude denial is evidence the cycle had somewhere to
 * go when the pool said no. Cross-PROVIDER recovery only — never read it as within-Claude-
 * pool failover evidence (that is the poolSnapshot/contradiction path + WI-4475).
 *
 * Only an ATTESTED capacity denial may divert (the same evidence bar the classifier
 * holds); anything else — including an evidence-free capacity-shaped message — rethrows.
 * When the fallback ALSO fails, the ORIGINAL denial is rethrown: it carries the
 * attestation the classifier needs, and the `{succeeded:false}` event records the miss.
 */
export function withCodexCapacityFallback<O extends { model?: string }, R>(
  call: (o: O) => Promise<R>,
  opts: {
    /** Cycle-start capacity probe (codex availability is config, not load). */
    capacity: ScoutProviderCapacity;
    backendForModel: (model: string | undefined) => string;
    /** Mutated in place — the runner surfaces it on the cycle result / thrown error. */
    events: CapacityFallbackEvent[];
    fallbackModel?: string;
  },
): (o: O) => Promise<R> {
  const fallbackModel = opts.fallbackModel ?? SCOUT_CODEX_FALLBACK_MODEL;
  return async (o: O): Promise<R> => {
    try {
      return await call(o);
    } catch (err) {
      if (!isCapacityError(err) || !opts.capacity.codexAvailable || opts.backendForModel(o.model) === 'codex') {
        throw err;
      }
      const denial = admissionDenialFrom(err);
      const event: CapacityFallbackEvent = {
        from: o.model ?? '(unresolved)',
        to: fallbackModel,
        succeeded: false,
        ...(denial?.via ? { via: denial.via } : {}),
        ...(denial?.reason ? { reason: denial.reason } : {}),
      };
      opts.events.push(event);
      try {
        const res = await call({ ...o, model: fallbackModel });
        event.succeeded = true;
        return res;
      } catch {
        throw err;
      }
    }
  };
}

/** Swap the archive builder (a test, or an alternate gym-QD store). */
export function setScoutArchiveBuilder(builder: ScoutArchiveBuilder): void {
  activeArchiveBuilder = builder;
}

/** Build the cycle's archive, degrading to the no-op if the real one is unavailable. */
export async function resolveArchive(scope: { workspaceId: string; harnessSlug: string }): Promise<ArchivePort> {
  try {
    return await withArchiveResolveTimeout(activeArchiveBuilder(scope), scoutArchiveResolveTimeoutMs());
  } catch (err) {
     
    console.warn('[register-scout-action] archive unavailable — gym rail no-ops this cycle:', err instanceof Error ? err.message : err);
    return noopArchive;
  }
}

function scoutArchiveResolveTimeoutMs(): number {
  const raw = Number(process.env.PAPERCUSP_SCOUT_ARCHIVE_RESOLVE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ARCHIVE_RESOLVE_TIMEOUT_MS;
}

async function withArchiveResolveTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`archive resolve timed out after ${timeoutMs}ms`)), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The production Scout cycle runner the `system:scout-cycle` action invokes:
 * assembles cb4b9's cycle deps with the real llmCall + the system-side plan-draft
 * creator + the per-cycle archive, runs one budgeted cycle, then flushes any
 * buffered scout seeds to the archive (P-012).
 */
export const productionScoutRunner: ScoutCycleRunner = async ({ harnessSlug, workspaceId, budget, cycleId, scoutConfig, revisionRequests, signal, deadlineMs, onPhase, admitLlmCall, deferDispatch }) => {
  if (deferDispatch && revisionRequests?.length)
    throw new Error('Deferred-dispatch evaluation cannot mutate existing drafts through revision requests');
  onPhase?.('runner-bootstrap');
  // FB-16 PARITY (the gym's `gym-cycle-inprocess-llm-bypasses-gateway` insight, applied to
  // Scout): Scout's IN-PROCESS ideator/critic/recombine llmCalls are anthropic-direct and
  // never pass the spawn chokepoint that patches `ANTHROPIC_BASE_URL` onto bee subprocesses —
  // so (unlike bees) they egress STRAIGHT to api.anthropic.com on a SINGLE account. Under the
  // busy fleet that account is perpetually at its Anthropic limit → every ideator 429s → the
  // cycle returns `no-ideas` with $0 spent. That is why the @singleton Scout produced 0 ideas
  // across 49/49 ticks since the 2026-06-14 re-scope (root-caused 2026-06-18). When the
  // INFERENCE_GATEWAY flag is on, point the in-process SDK (PAPERCUSP_ANTHROPIC_URL) AND any
  // claude-CLI subprocess (ANTHROPIC_BASE_URL) at the localhost pacing gateway so Scout
  // load-balances across the bound pool accounts exactly like the gym (autoloop-cycle.ts) and
  // the fleet. Flag-OFF → unchanged direct egress; a pre-set override is respected.
  const { FLAGS } = await import('@papercusp/flags');
  const { getFlag } = await import('@papercusp/flags/server');
  onPhase?.('gateway-env');
  if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
    const { gatewayLlmEnv } = await import('../inference-gateway/spawn-env');
    for (const [k, v] of Object.entries(gatewayLlmEnv(true))) {
      if (!process.env[k]) process.env[k] = v;
    }
  }

  onPhase?.('llm-client-import');
  const { llmCall: rawLlmCall, backendForLlmCall } = await import('../llm-testing/llm-client');
  const { SCOUT_IDEATOR_MODEL } = await import('./ideators');
  const { DEFAULT_WORKSPACE_ID } = await import('../workspace-id-constant');
  const providerCapacity = await cachedScoutProviderCapacity();

  // Gateway admission-tier label (gateway-priority-tiers-2026-06-22): stamp every
  // in-process Scout LLM call (ideators/critics/recombine/revise) with the `scout`
  // role so the localhost pacing gateway routes it through TIER 1 — the protected,
  // reserved-floor lane the map already assigns to scout/queen/overwatch/interactive
  // (DEFAULT_GATEWAY_PRIORITY_MAP). Until this, the FB-16 fix pointed the in-process
  // SDK at the gateway (gatewayLlmEnv) but never identified the caller, so Scout's 8
  // ideators arrived UNTIERED → the lowest `default` band (tier 4), which the AIMD
  // shrink sheds FIRST under fleet load → all 8 bailed every fire ("rate-limit pause
  // exceeds maxWait"), 0 ideas for 12 days while bees (tier 3) crowded the pool.
  // su-5e6cc (2026-06-30): PIN Scout's in-process LLM onto the gateway's ANTHROPIC pool.
  // The runtime ideator model was resolving to a codex/gpt model → routed to OpenAI
  // (quota-EXHAUSTED) → "all 1 ideator failed, 0 ideas, $0 spent" → circuit-open/gated
  // for hours, DESPITE the claude-opus-4-8 default + INFERENCE_GATEWAY on (that flag only
  // redirects the anthropic-direct path, NOT codex). OpenAI has no quota; the Anthropic
  // pool (the gateway) does. Preserve that historical force while Claude has capacity, but
  // use the available Codex bridge when the gateway proves the Claude pool is empty (WI-4475).
  // (LLM_TEST_BACKEND is unset on bg-host, so backendForLlmCall is model-derived — pinning
  // the model is sufficient.)
  // WI-5391 item 3: one Codex retry on an attested mid-cycle capacity denial, recorded in
  // capacityFallbacks as discriminator evidence — see withCodexCapacityFallback above.
  const capacityFallbacks: CapacityFallbackEvent[] = [];
  const governedCall = (o: Parameters<typeof rawLlmCall>[0]) => {
    const resolved = { ...o, signal: combineAbortSignals(signal, o.signal), priority: 'scout', harnessSlug };
    const invoke = () => rawLlmCall(resolved);
    return admitLlmCall ? admitLlmCall(resolved, invoke) : invoke();
  };
  const callWithFallback = withCodexCapacityFallback(governedCall, {
    capacity: providerCapacity,
    backendForModel: backendForLlmCall,
    events: capacityFallbacks,
  });
  const llmCall: typeof rawLlmCall = (o) => {
    const model = resolveScoutModel(o.model, providerCapacity, backendForLlmCall, SCOUT_IDEATOR_MODEL) ?? SCOUT_IDEATOR_MODEL;
    return callWithFallback({ ...o, model });
  };

  // ── Mug↔Scout feedback loop (queen-scout-feedback-loop-2026-06-20 — historical slug) ──
  // Scout's coord identity (P-003) + the two Scout→Mug ping ports (mug-notify).
  // The coord/PG/ALS edge is lazily imported inside the closures so a boot that
  // only references the runner never loads it; best-effort everywhere (a notify
  // can never break ideation/revision).
  const scoutOwner = scoutCoordOwnerId(harnessSlug);
  const mugSend = async (msg: MugNotifyMessage): Promise<void> => {
    const { sendMessage } = await import('../agent-tools/coordination/messages');
    const { runWithWorkspace } = await import('../workspace-als');
    const identity = {
      ownerId: scoutOwner,
      ownerLabel: `scout · ${harnessSlug}`,
      source: 'principal' as const,
      workspaceId,
      userId: null,
    };
    await runWithWorkspace(workspaceId, () =>
      sendMessage(identity, {
        to: msg.to,
        summary: msg.summary,
        body: msg.body,
        plan_slug: msg.planSlug,
        harnessSlug,
      }),
    );
  };
  const mugNotifyPorts: MugNotifyPorts = {
    // resolveMugOwner takes workspaceId explicitly (no ALS needed); the routine's
    // ctx workspace is where the hive's adv_sessions / coord live (NOT the DEFAULT
    // plan workspace the drafts are pinned to).
    resolveMugOwner: async () => {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { resolveMugOwner } = await import('../pot/placement-watchdog');
      const { sql } = getOrgPg();
      return resolveMugOwner(sql, workspaceId, harnessSlug);
    },
    send: mugSend,
    // WI-37625: was a hardcoded `@role:mug` inside mug-notify. Resolve it through the
    // SHARED nudge-recipient ladder (reuse, never a second ladder) — this is the layer
    // that actually has `workspaceId`, which is why the module takes it as a port.
    //
    // The ladder picks WHO (D-038): a deliverable Mug keeps the legacy slot so the tier
    // still works when switched on for testing; otherwise a live su is addressed directly,
    // and with nobody live it escalates to the owner. `unresolved` returns NOTHING on
    // purpose — a presence hiccup is not evidence nobody is home, and these two pings
    // always carry a concrete owner id alongside, so the message still goes somewhere.
    resolveDurableCoAddress: async () => {
      try {
        const { resolveNudgeRecipient } = await import('./nudge-recipient');
        const { getOrgPg } = await import('@papercusp/db-org');
        const { resolveMugOwner } = await import('../pot/placement-watchdog');
        const { sql } = getOrgPg();
        const mugOwner = await resolveMugOwner(sql, workspaceId, harnessSlug).catch(() => null);
        const recipient = await resolveNudgeRecipient({ workspaceId, mugOwner });
        if (recipient.kind === 'mug') return ['@role:mug'];
        if (recipient.kind === 'su') return [recipient.ownerId];
        if (recipient.kind === 'escalate') return ['human'];
        return [];
      } catch {
        return [];
      }
    },
  };

  // A revision-request tick runs a TARGETED revision of the reviewer's draft(s)
  // — NOT a fresh ideation cycle (which would route NEW plans, starving the loop).
  // Same gateway-routed llmCall (FB-16 parity above applies). Pings the Mug back
  // per draft so it re-reviews (D-001 step 3). Returns a cycle-shaped result the
  // scheduler ledgers + acks (the scheduler only acks on a non-throwing return).
  if (revisionRequests && revisionRequests.length > 0) {
    onPhase?.('ideate');
    const result = await runScoutRevisionCycle(revisionRequests, {
      llmCall,
      planWorkspaceId: DEFAULT_WORKSPACE_ID,
      harnessSlug,
      ...(scoutConfig ? { model: scoutConfig.models.revision } : {}),
    });
    try {
      await notifyMugRevised(mugNotifyPorts, result.revisions);
    } catch {
      /* best-effort — a ping-back failure never fails the revision tick */
    }
    return { ...result, ...(capacityFallbacks.length > 0 ? { capacityFallbacks } : {}) };
  }

  onPhase?.('resolve-archive');
  const archive = await resolveArchive({ workspaceId, harnessSlug });
  // P-007 dedup-burn guard (WI-39479): assess the recent ran-tick streak BEFORE
  // building the cycle. Saturated ⇒ (1) widen the novelty band on the effective
  // config so borderline ideas survive instead of burning again, and (2) stamp
  // the digest so renderDigest steers the ideators off the saturated standing
  // corpus. Fail-open: readDedupBurnVerdict never throws — an unsaturated
  // verdict leaves everything byte-identical.
  const dedupBurn = await readDedupBurnVerdict({ workspaceId, installSlug: harnessSlug });
  const effectiveScoutConfig = dedupBurn.saturated
    ? applyDedupBurnToConfig(scoutConfig ?? DEFAULT_SCOUT_CONFIG, dedupBurn)
    : scoutConfig;
  if (dedupBurn.saturated) {
    console.warn(`[scout/dedup-burn-guard] ${dedupBurn.reason}`);
  }
  onPhase?.('build-cycle-deps');
  const deps = buildScoutCycleDeps({
    harnessSlug,
    workspaceId,
    llmCall,
    deferDispatch,
    // Draft plans are pinned to the DEFAULT workspace, NOT the routine's ctx
    // workspace: the whole plan surface (plans:* dispatch, Create tab, plan
    // projections) lives under 'default', so a draft written under the
    // routine's 'papercusp-workspace' is invisible to every plan UI/read
    // (live miss 2026-06-11 — 3 routed drafts stranded). The routed-idea
    // LEDGER row keeps the ctx workspace (learning.scout reads it there).
    // route→coord:send (D-003 #1): a NEWLY-routed draft pings the Mug so it
    // reviews it — this is what STARTS the feedback loop. Only on `created` (a
    // re-derived/idempotent existing slug is not re-announced). Best-effort: the
    // ping never fails the routing path.
    createPlanDraft: async (args) => {
      const res = await createScoutPlanDraft({ ...args, harnessSlug, workspaceId: DEFAULT_WORKSPACE_ID });
      if (res.created) {
        try {
          await notifyMugDraftRouted(mugNotifyPorts, { slug: res.slug, title: args.title, scoutOwner });
        } catch {
          /* best-effort — a notify never breaks routing */
        }
      }
      return res;
    },
    archive,
    onScoutDraftCreated: async ({ slug, title }) => {
      try {
        await notifyMugDraftRouted(mugNotifyPorts, { slug, title, scoutOwner });
      } catch {
        /* best-effort — a notify never breaks rubric authoring */
      }
    },
    limits: { maxCostUsd: budget.maxCostUsd, maxIdeators: budget.maxIdeators },
    cycleId,
    ...(onPhase ? { onPhase } : {}),
    // WI-4475: the scheduler's absolute kill-deadline. Bounds every in-cycle LLM call's governor
    // ADMISSION wait to the time actually left, so a call queued behind a shared rate-limit pause
    // can no longer be guillotined by an outer timer and misreported as transport death ($0 spent,
    // 0 ideas) — nor consume the entire cycle. Absent ⇒ unchanged behavior.
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    // P-009: per-blueprint Scout tuning (lenses/novelty/buckets/routing). Undefined ⇒
    // buildScoutCycleDeps falls back to DEFAULT_SCOUT_CONFIG (behavior-neutral).
    // P-007: on a saturated verdict this is the WIDENED config (see dedupBurn above).
    ...(effectiveScoutConfig ? { scoutConfig: effectiveScoutConfig } : {}),
    // P-007: the digest stamp — readCorpus copies it onto the digest so renderDigest
    // drops the standing patterns + leads with the saturation banner.
    ...(dedupBurn.saturated
      ? {
          dedupSaturation: {
            consecutiveSaturated: dedupBurn.consecutiveSaturated,
            wideningSteps: dedupBurn.wideningSteps,
          },
        }
      : {}),
  });
  try {
    onPhase?.('run-cycle');
    const result = await runScoutCycle(deps);
    // EI-13119: attach the ideate leg's per-slot outcomes so the scheduler persists
    // them on the 'ran' tick detail (a no-ideas streak becomes ledger-diagnosable).
    return {
      ...result,
      ...(deps.lastIdeation ? { ideators: deps.lastIdeation } : {}),
      ...(capacityFallbacks.length > 0 ? { capacityFallbacks } : {}),
      // P-007: ride the saturation verdict on the result so the scheduler persists
      // it in the ran-tick detail — the guard's activation is ledger-diagnosable.
      ...(dedupBurn.saturated ? { dedupBurn } : {}),
    };
  } catch (err) {
    // A throwing cycle can't return its fallback trail — ride it on the error so the
    // scheduler's error/gated tick detail still carries it (capacityFallbacksFrom).
    if (capacityFallbacks.length > 0 && err && typeof err === 'object') {
      (err as { capacityFallbacks?: CapacityFallbackEvent[] }).capacityFallbacks = capacityFallbacks;
    }
    throw err;
  } finally {
    // Persist scout seeds (P-012) even if the cycle threw mid-route.
    if (isFlushable(archive)) {
      try {
        await archive.flush();
      } catch (err) {
         
        console.warn('[register-scout-action] archive flush failed:', err instanceof Error ? err.message : err);
      }
    }
  }
};

function combineAbortSignals(parent?: AbortSignal, child?: AbortSignal): AbortSignal | undefined {
  if (!parent) return child;
  if (!child) return parent;
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any([parent, child]);
  if (parent.aborted) return parent;
  if (child.aborted) return child;
  const ctrl = new AbortController();
  const abort = () => {
    if (!ctrl.signal.aborted) ctrl.abort();
  };
  parent.addEventListener('abort', abort, { once: true });
  child.addEventListener('abort', abort, { once: true });
  return ctrl.signal;
}

function isFlushable(a: ArchivePort): a is ScoutArchivePort {
  return typeof (a as ScoutArchivePort).flush === 'function';
}

// EI-18741240128927188: register `system:scout-cycle` so the PER-POT routine row
// `provision-learning-loop.ts` seeds (INACTIVE, per-pot budget) actually fires when
// an owner arms it — reusing the SAME `productionScoutRunner` the `scout` blueprint's
// `blender:cycle` step already runs (byte-identical cycle logic; the workspace-
// singleton path via `system:blueprint-run` is unaffected and remains primary).
registerScoutCycleAction(productionScoutRunner);
