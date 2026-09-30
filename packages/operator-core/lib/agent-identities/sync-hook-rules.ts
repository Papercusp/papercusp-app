/**
 * Worn synchronous hook rules (portable-identity-packages-2026-09-26 P-011; D-023).
 *
 * A `delivery:'sync'` rule package runs inline at one client hook sink. This
 * module is the operator side the hook endpoints call:
 *
 *   1. WHAT IS WORN. The wearer's APPLIED identity artifact (the launch receipt
 *      the control anchor's applied revision selects) pins `packageKind:'rule'`
 *      inputs; the sync ones are worn. Each is attributed to the blueprint layer
 *      whose pin lists it as a dependency, so a refusal names an identity.
 *   2. GUARDS (pre-tool) fail CLOSED on evaluation. A worn guard whose `tools`
 *      matches the pending call refuses when `deny` holds or `allowOnly` fails;
 *      a throw, an input over the bound, or a worn pin that no longer parses
 *      refuses too, naming the identity and rule. A guard never approves and
 *      never rewrites: the only verdicts are `deny` and `none`. No provider I/O
 *      is reachable from here — the predicate is `evaluateDataCondition`.
 *   3. CONTEXT (turn-start, post-tool, stop, compaction) fails OPEN, visibly. A
 *      worn context rule becomes one request in the sink's ONE
 *      `evaluateSinkInvocation`, produced by the same read-only provider path the
 *      turn-start package sink uses, and the per-(session, turn) ceiling spans
 *      every sink of the turn because every sink reads and charges the same
 *      durable hook turn (D-024), whichever cluster worker serves it.
 *
 * Reading the artifact is NOT evaluation: when it is unreadable no rule can be
 * named, and closing there would deny every call fleet-wide on a DB hiccup, so
 * the guard channel reports `unavailable` and the client's own permission flow
 * proceeds.
 */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';
import type { HookContextSink, ResolvedAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { evaluateDataCondition, type DataCondition } from '@papercusp/rules';
import { parseRulePackage, RULE_PACKAGE_SCHEMA_VERSION, type SyncRuleDeclaration } from '../cupboard/rule-store';
import {
  DEFAULT_SINK_HOST_LIMITS,
  evaluateSinkInvocation,
  isSinkResultCurrent,
  type SinkContributionRequest,
  type SinkHostLimits,
  type SinkInvocationResult,
} from './sink-evaluator';
import {
  defaultTurnStartPackageSinkDeps,
  type PackageSinkWearer,
  type ProduceContextInput,
} from './turn-start-package-sink';

/** The adapter ships `tool_input` unclamped up to this bound and flags anything beyond. */
export const SYNC_HOOK_GUARD_INPUT_MAX_BYTES = 64 * 1024;

export interface WornSyncRule {
  /** The blueprint layer that pins this rule (the pin's own ref when none does). */
  readonly identityId: string;
  readonly pinRef: string;
  readonly rule: SyncRuleDeclaration;
}

/** A worn rule pin that no longer parses as a rule package. */
export interface UnreadableWornRule {
  readonly identityId: string;
  readonly pinRef: string;
  readonly error: string;
}

export interface WornSyncRules {
  readonly rules: readonly WornSyncRule[];
  readonly unreadable: readonly UnreadableWornRule[];
}

type PackageInput = Extract<ResolvedAgentSpecification['inputs'][number], { kind: 'package' }>;

/** PURE: the sync rules an applied artifact pins, attributed to their layers. */
export function wornSyncRules(artifact: Pick<ResolvedAgentSpecification, 'inputs'>): WornSyncRules {
  const packages = artifact.inputs.filter((entry): entry is PackageInput => entry.kind === 'package');
  const owner = (ref: string) => packages.find((entry) => entry.packageKind !== 'rule' &&
    (entry.dependencies ?? []).some((dependency) => dependency.packageKind === 'rule' && dependency.ref === ref))?.ref;
  const rules: WornSyncRule[] = [];
  const unreadable: UnreadableWornRule[] = [];
  for (const pin of packages) {
    if (pin.packageKind !== 'rule') continue;
    const identityId = owner(pin.ref) ?? pin.ref;
    const value = pin.value && typeof pin.value === 'object' && !Array.isArray(pin.value)
      ? pin.value as Record<string, unknown> : null;
    // The pin carries what readRuleDir returned: the manifest minus schemaVersion, plus its ref.
    const { ref: _ref, ...fields } = value ?? {};
    const parsed = value ? parseRulePackage({ schemaVersion: RULE_PACKAGE_SCHEMA_VERSION, ...fields }) : null;
    if (!parsed || !parsed.ok) {
      unreadable.push({ identityId, pinRef: pin.ref, error: parsed ? parsed.error : 'rule pin carries no value' });
      continue;
    }
    if (parsed.rule.delivery === 'sync') rules.push({ identityId, pinRef: pin.ref, rule: parsed.rule });
  }
  return { rules, unreadable };
}

/** A `tools` filter entry is a name or a prefix ending in `*`; no filter matches every tool. */
export function ruleMatchesTool(tools: readonly string[] | undefined, tool: string): boolean {
  if (!tools) return true;
  return tools.some((pattern) => pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern);
}

export interface PendingToolCall {
  readonly tool: string;
  readonly input: unknown;
  readonly client: string;
  /** The adapter cut `input` at {@link SYNC_HOOK_GUARD_INPUT_MAX_BYTES}. */
  readonly inputTruncated?: boolean;
}

export type GuardVerdict =
  | { readonly decision: 'deny'; readonly identityId: string; readonly ruleId: string; readonly reason: string }
  | { readonly decision: 'none' };

/**
 * PURE, fail-closed: the first refusal among the worn guards for one pending
 * call. Evaluation order is deterministic (identity, then rule id).
 */
export function evaluatePreToolGuards(worn: WornSyncRules, call: PendingToolCall): GuardVerdict {
  // A pin that no longer parses cannot prove it is not a guard for this call.
  const broken = [...worn.unreadable].sort((a, b) => key(a).localeCompare(key(b)))[0];
  if (broken) {
    return { decision: 'deny', identityId: broken.identityId, ruleId: broken.pinRef,
      reason: `worn rule ${broken.pinRef} no longer parses: ${broken.error}`.slice(0, 500) };
  }
  const guards = worn.rules
    .filter((entry) => entry.rule.sink === 'pre-tool' && entry.rule.guard && ruleMatchesTool(entry.rule.tools, call.tool))
    .sort((a, b) => key(a).localeCompare(key(b)));
  const event = { tool: call.tool, input: call.input, client: call.client };
  for (const { identityId, rule } of guards) {
    const guard = rule.guard!;
    const deny = (reason: string): GuardVerdict => ({ decision: 'deny', identityId, ruleId: rule.id, reason });
    if (call.inputTruncated) return deny(`tool input exceeds ${SYNC_HOOK_GUARD_INPUT_MAX_BYTES} bytes; guard ${rule.id} cannot see all of it`);
    try {
      if (guard.deny !== undefined && evaluateDataCondition(guard.deny as DataCondition, event)) {
        return deny(guard.reason ?? `refused by ${rule.id}`);
      }
      if (guard.allowOnly !== undefined && !evaluateDataCondition(guard.allowOnly as DataCondition, event)) {
        return deny(guard.reason ?? `outside what ${rule.id} allows`);
      }
    } catch (error) {
      return deny(`guard ${rule.id} failed to evaluate: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
    }
  }
  return { decision: 'none' };
}

function key(entry: { identityId: string; pinRef: string }): string {
  return `${entry.identityId}\u0000${entry.pinRef}`;
}

/* ------------------------------------------------------------------ */
/* One turn per session, shared by every hook sink on every worker.     */
/* ------------------------------------------------------------------ */

/** A session's current hook turn and what its sinks have spent in it. */
export interface HookTurn {
  readonly turnId: string;
  readonly tokensSpent: number;
  /** Wall-clock the turn's sink invocations have taken, summed (not time since the turn began). */
  readonly msSpent: number;
}

/** What one sink invocation charges to its turn. */
export interface HookTurnSpend {
  readonly tokens: number;
  readonly ms: number;
}

/**
 * Durable per-session hook turn (D-024). Each sink is a separate request that
 * any cluster worker may serve, so the turn id and its spend live in PG.
 */
export interface HookTurnStore {
  /** Start a turn (turn start, or a compaction that opens a fresh context). */
  begin(ownerId: string, workspaceId: string): Promise<HookTurn>;
  /** The session's current turn; a sink before any turn start opens one. */
  current(ownerId: string, workspaceId: string): Promise<HookTurn>;
  /** Whether the session has taken a hook turn before (D-024 §3). */
  exists(ownerId: string, workspaceId: string): Promise<boolean>;
  /** Add what a sink spent to the turn, only while it is still the current one. */
  charge(ownerId: string, workspaceId: string, turnId: string, spend: HookTurnSpend): Promise<void>;
}

/** Production store: harness_shared.identity_hook_turns (migrations 1251 + 1253). */
export function pgHookTurnStore(): HookTurnStore {
  type Row = { turn_id: string; tokens_spent: number; ms_spent: number };
  const toTurn = (row: Row): HookTurn =>
    ({ turnId: row.turn_id, tokensSpent: Number(row.tokens_spent), msSpent: Number(row.ms_spent) });
  const begin = async (ownerId: string, workspaceId: string): Promise<HookTurn> => {
    const rows = await getOrgPg().sql<Row[]>`
      INSERT INTO harness_shared.identity_hook_turns (workspace_id, owner_id, turn_id)
      VALUES (${workspaceId}, ${ownerId}, ${randomUUID()})
      ON CONFLICT (workspace_id, owner_id) DO UPDATE
        SET turn_id = EXCLUDED.turn_id, tokens_spent = 0, ms_spent = 0, started_at = now(), updated_at = now()
      RETURNING turn_id, tokens_spent, ms_spent`;
    return toTurn(rows[0]!);
  };
  return {
    begin,
    current: async (ownerId, workspaceId) => {
      const rows = await getOrgPg().sql<Row[]>`
        SELECT turn_id, tokens_spent, ms_spent FROM harness_shared.identity_hook_turns
         WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}`;
      return rows[0] ? toTurn(rows[0]) : begin(ownerId, workspaceId);
    },
    exists: async (ownerId, workspaceId) => {
      const rows = await getOrgPg().sql<{ one: number }[]>`
        SELECT 1 AS one FROM harness_shared.identity_hook_turns
         WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}`;
      return rows.length > 0;
    },
    charge: async (ownerId, workspaceId, turnId, spend) => {
      const tokens = spend.tokens > 0 ? Math.ceil(spend.tokens) : 0;
      const ms = spend.ms > 0 ? Math.ceil(spend.ms) : 0;
      if (!tokens && !ms) return;
      await getOrgPg().sql`
        UPDATE harness_shared.identity_hook_turns
           SET tokens_spent = tokens_spent + ${tokens}, ms_spent = ms_spent + ${ms}, updated_at = now()
         WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId} AND turn_id = ${turnId}`;
    },
  };
}

/** Process-local store for unit tests; production always uses {@link pgHookTurnStore}. */
export function memoryHookTurnStore(): HookTurnStore {
  const turns = new Map<string, HookTurn>();
  const key = (ownerId: string, workspaceId: string) => `${workspaceId}\u0000${ownerId}`;
  const begin = async (ownerId: string, workspaceId: string) => {
    const turn: HookTurn = { turnId: randomUUID(), tokensSpent: 0, msSpent: 0 };
    turns.set(key(ownerId, workspaceId), turn);
    return turn;
  };
  return {
    begin,
    current: async (ownerId, workspaceId) => turns.get(key(ownerId, workspaceId)) ?? begin(ownerId, workspaceId),
    exists: async (ownerId, workspaceId) => turns.has(key(ownerId, workspaceId)),
    charge: async (ownerId, workspaceId, turnId, spend) => {
      const turn = turns.get(key(ownerId, workspaceId));
      if (turn?.turnId !== turnId) return;
      turns.set(key(ownerId, workspaceId), {
        ...turn,
        tokensSpent: turn.tokensSpent + (spend.tokens > 0 ? Math.ceil(spend.tokens) : 0),
        msSpent: turn.msSpent + (spend.ms > 0 ? Math.ceil(spend.ms) : 0),
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Context sinks.                                                       */
/* ------------------------------------------------------------------ */

/** The worn context rules due at one sink occurrence. */
export function dueSyncContextRules(
  worn: WornSyncRules, sink: HookContextSink, tools: readonly string[] = [],
): WornSyncRule[] {
  return worn.rules.filter((entry) => entry.rule.context && entry.rule.sink === sink &&
    (sink !== 'post-tool' || tools.some((tool) => ruleMatchesTool(entry.rule.tools, tool))));
}

export interface SyncHookRuleDeps {
  readonly readWearer: (ownerId: string, workspaceId: string) => Promise<PackageSinkWearer | null>;
  /** The wearer's worn rules at its applied revision; null when nothing is applied. */
  readonly readWornRules: (ownerId: string, workspaceId: string) => Promise<WornSyncRules | null>;
  readonly produceContext: (input: ProduceContextInput) => Promise<string>;
  readonly turns: HookTurnStore;
  readonly limits?: SinkHostLimits;
}

/** Sink requests for due context rules, produced by the read-only provider path. */
export function syncContextRequests(input: {
  due: readonly WornSyncRule[];
  workspaceId: string;
  ownerId: string;
  potSlug: string | null;
  produceContext: SyncHookRuleDeps['produceContext'];
}): SinkContributionRequest[] {
  return input.due.map(({ identityId, rule }) => {
    const context = rule.context!;
    const injection = { tokenBudget: context.tokenBudget, priority: context.priority, overBudget: context.overBudget };
    return {
      identityId,
      contributionId: rule.id,
      injection,
      produce: async (call) => {
        if (!input.potSlug) throw new Error('the wearer has no pot scope to resolve a provider in');
        return input.produceContext({
          workspaceId: input.workspaceId, potSlug: input.potSlug, ownerId: input.ownerId, identityId,
          contribution: { id: rule.id, ref: context.ref, verb: context.verb, injection },
          signal: call.signal,
        });
      },
    };
  });
}

export interface HookContextSinkResult {
  /** Delivered text plus visible omission markers, fenced to the re-read attachment. */
  readonly text: string;
  readonly result: SinkInvocationResult | null;
  readonly error?: string;
}

/** Evaluate the worn context rules due at one hook sink occurrence. Never throws. */
export async function evaluateHookContextSink(input: {
  ownerId: string;
  workspaceId: string;
  sink: Exclude<HookContextSink, 'turn-start'>;
  /** post-tool: the batch's tool names, matched against each rule's `tools`. */
  tools?: readonly string[];
  signal?: AbortSignal;
  deps?: Partial<SyncHookRuleDeps>;
}): Promise<HookContextSinkResult> {
  const deps = { ...defaultSyncHookRuleDeps(), ...(input.deps ?? {}) };
  let wearer: PackageSinkWearer | null;
  let requests: SinkContributionRequest[];
  try {
    wearer = await deps.readWearer(input.ownerId, input.workspaceId);
    const worn = wearer ? await deps.readWornRules(input.ownerId, input.workspaceId) : null;
    if (!wearer || !worn) return { text: '', result: null };
    requests = syncContextRequests({
      due: dueSyncContextRules(worn, input.sink, input.tools), workspaceId: input.workspaceId,
      ownerId: input.ownerId, potSlug: wearer.potSlug, produceContext: deps.produceContext,
    });
  } catch (error) {
    return { text: '', result: null, error: error instanceof Error ? error.message : String(error) };
  }
  if (requests.length === 0) return { text: '', result: null };
  // A compaction opens a fresh context; every other sink joins the running turn.
  let turn: HookTurn;
  try {
    turn = input.sink === 'compaction'
      ? await deps.turns.begin(input.ownerId, input.workspaceId)
      : await deps.turns.current(input.ownerId, input.workspaceId);
  } catch (error) {
    // Without the shared turn this sink cannot prove it stays under the turn ceiling.
    return { text: '', result: null, error: `hook turn unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let observedRevision = wearer.attachmentRevision;
  const result = await evaluateSinkInvocation({
    invocation: {
      sessionId: input.ownerId, turnId: turn.turnId, invocationId: randomUUID(),
      sink: input.sink, attachmentRevision: wearer.attachmentRevision,
    },
    contributions: requests,
    limits: deps.limits ?? DEFAULT_SINK_HOST_LIMITS,
    currentAttachmentRevision: () => observedRevision,
    turnSpent: { tokensSpent: turn.tokensSpent, msSpent: turn.msSpent },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  await deps.turns.charge(input.ownerId, input.workspaceId, turn.turnId,
    { tokens: result.deliveredTokens, ms: result.elapsedMs }).catch(() => undefined);
  const turnId = turn.turnId;
  try {
    observedRevision = (await deps.readWearer(input.ownerId, input.workspaceId))?.attachmentRevision ?? '';
  } catch {
    observedRevision = '';
  }
  if (!isSinkResultCurrent(result, { sessionId: input.ownerId, turnId, attachmentRevision: observedRevision })) {
    return { text: '', result };
  }
  const text = [...result.deliveries.map((row) => row.text), ...result.omissions.map((row) => row.marker)]
    .filter(Boolean).join('\n\n');
  return { text, result };
}

/**
 * The turn-start half: worn context rules due at turn start, as requests that
 * join the package sink's ONE invocation (P-010), so rules and blueprint
 * contributions share one aggregate budget. Throws when the worn rules cannot
 * be read; the caller omits the rule half and keeps the blueprint half.
 */
export async function turnStartSyncRuleRequests(input: {
  ownerId: string;
  workspaceId: string;
  wearer: PackageSinkWearer;
  produceContext: SyncHookRuleDeps['produceContext'];
  readWornRules?: SyncHookRuleDeps['readWornRules'];
}): Promise<SinkContributionRequest[]> {
  const worn = await (input.readWornRules ?? readAppliedWornRules)(input.ownerId, input.workspaceId);
  if (!worn) return [];
  return syncContextRequests({
    due: dueSyncContextRules(worn, 'turn-start'), workspaceId: input.workspaceId,
    ownerId: input.ownerId, potSlug: input.wearer.potSlug, produceContext: input.produceContext,
  });
}

/**
 * The wearer's worn rules at its APPLIED revision. Null when nothing is
 * applied (the session wears no identity); throws when a revision is applied
 * but its artifact cannot be resolved from the gate-selected launch record.
 */
export async function readAppliedWornRules(ownerId: string, workspaceId: string): Promise<WornSyncRules | null> {
  const sql = getOrgPg().sql;
  const rows = await sql<{ applied: unknown }[]>`
    SELECT control_state->'activation'->'applied' AS applied
      FROM harness_shared.session_briefs
     WHERE owner_id = ${ownerId} AND workspace_id = ${workspaceId}
     LIMIT 1`;
  const applied = rows[0]?.applied as { specificationRevision?: unknown; stateRevision?: unknown } | null | undefined;
  if (typeof applied?.specificationRevision !== 'string' || typeof applied.stateRevision !== 'string') return null;
  const cacheKey = [workspaceId, ownerId, applied.specificationRevision, applied.stateRevision].join('\u0000');
  const cached = wornRulesCache.byRevision.get(cacheKey);
  if (cached && 'worn' in cached) return cached.worn;
  if (cached && cached.unreadableUntil > Date.now()) throw new Error('applied identity artifact unreadable');
  const [{ readGateSelectedLaunchSpec }, { appliedIdentityArtifact }] = await Promise.all([
    import('../agent-tools/coordination/control-anchor'),
    import('../capability-envelope/identity-grants-port'),
  ]);
  const artifact = appliedIdentityArtifact(await readGateSelectedLaunchSpec(sql, ownerId, workspaceId), {
    specificationRevision: applied.specificationRevision, stateRevision: applied.stateRevision,
  });
  if (!artifact) {
    rememberWornRules(cacheKey, { unreadableUntil: Date.now() + WORN_RULES_UNREADABLE_TTL_MS });
    throw new Error('applied identity artifact unreadable');
  }
  const worn = wornSyncRules(artifact);
  rememberWornRules(cacheKey, { worn });
  return worn;
}

/**
 * Worn rules by (workspace, owner, applied revision). The pre-tool guard reads
 * them on EVERY tool call, and both revisions are content hashes, so a resolved
 * entry can never go stale: a changed identity is a different key. Only the
 * cheap applied-revision read stays on the per-call path.
 *
 * An UNREADABLE revision is remembered briefly, not forever: the launch record
 * can gain the applied revision's receipt after the control state moves, and
 * until then every tool call would otherwise repeat the expensive read.
 */
const WORN_RULES_CACHE_MAX = 256;
const WORN_RULES_UNREADABLE_TTL_MS = 30_000;
type WornRulesCacheEntry = { readonly worn: WornSyncRules } | { readonly unreadableUntil: number };
const wornRulesCache = pinModuleState('@papercusp/operator-core.agent-identities.worn-sync-rules', () => ({
  byRevision: new Map<string, WornRulesCacheEntry>(),
}));

function rememberWornRules(cacheKey: string, entry: WornRulesCacheEntry): void {
  const cache = wornRulesCache.byRevision;
  cache.delete(cacheKey);
  if (cache.size >= WORN_RULES_CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, entry);
}

/** Production wiring: the control anchor, the gate-selected launch record and the read-only provider path. */
export function defaultSyncHookRuleDeps(): SyncHookRuleDeps {
  const packageSink = defaultTurnStartPackageSinkDeps();
  return {
    readWearer: packageSink.readWearer,
    produceContext: packageSink.produceContext,
    readWornRules: readAppliedWornRules,
    turns: pgHookTurnStore(),
  };
}
