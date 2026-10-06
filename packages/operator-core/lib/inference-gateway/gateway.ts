/**
 * The hive inference gateway — a localhost transparent `/v1/*` reverse proxy that PACES the
 * fleet's requests through the existing rate governor and injects the bound account's OAuth, so
 * one Max subscription can serve many concurrent bees without each `claude -p` bursting blind
 * (hive-inference-gateway-2026-06-09 P-006 + P-007).
 *
 * Per request:
 *   1. parse `model` + estimate tokens from the body (token-aware admission, P-010);
 *   2. `governor.acquire(est)` — BLOCK until a slot frees (backpressure, D-004) rather than
 *      bursting; a wait longer than `maxQueueWaitMs` returns a synthetic 429 + `retry-after`
 *      (so a multi-hour capacity pause doesn't pin an HTTP socket open for hours);
 *   3. inject the bound account's credential per attempt — `Authorization: Bearer <token>` +
 *      `anthropic-beta: oauth-…` for a subscription account, `x-api-key` (no OAuth beta) for a
 *      Console API-key account (the bee sends UNAUTHENTICATED to 127.0.0.1) — and forward to api.anthropic.com,
 *      streaming SSE through untouched;
 *   4. feed every response's `anthropic-ratelimit-*` headers back into the governor
 *      (`recordResponse` → unified-utilization pace/pause, D-009) and `penalize()` on 429/529.
 *
 * The proxy is otherwise byte-transparent: it strips `content-encoding`/`content-length` on the
 * way back (undici already decoded the body) and forces `accept-encoding: identity` upstream.
 */
import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { processMonotonicClock } from '../process-monotonic-clock';
import { normalizeModelId } from '@papercusp/model-pricing';
import { resolveCodexModel } from '../model-context-budget.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActiveOperationAttestationContext, ActiveOperationModelPolicyRead } from '../blueprint/operation-worker-binding';
import type { DirectOperationModelAttestation } from '../blueprint/operation-service';
import { PassThrough, Readable } from 'node:stream';
import { describeAdmissionCeiling } from './admission-ceiling';
import { describeGatewayLiveAdmissionState } from './admission-state-model';
import {
  governorForBackend,
  snapshotGovernors,
  effectiveRpm,
  effectivePaceMs,
  effectiveRpmFactor,
  PriorityAdmissionQueue,
  QueueFullError,
  AimdConcurrencyController,
  priorityFromLabel,
  tierOf,
  shedTierCaps,
  classifyHttpError,
  parseUsageReset,
  type RateLimitGovernor,
  type AdmissionSnapshot,
  type AimdSnapshot,
  type TierAdmissionConfig,
  type PriorityTierMap,
} from '@papercusp/papercusp-shared/agent';
import {
  INITIAL_PROVIDER_ADMISSION_WINDOW,
  ProviderAdmissionLifecycle,
  type ProviderLaneId,
} from './provider-admission-lifecycle';
import { accountLoadKey, ACCOUNT_INFLIGHT_LOAD_WEIGHT, FIVE_HOURS_MS, type AccountBurnAction } from './account-failover';
import { selectAffectedOwners } from './affected-owners';
import { CLAUDE_CONTEXT_1M_BETA, withClientBetas, scrubSecrets } from './credential-store';
import {
  classifyClaudeCreditWallResponse,
  CREDIT_WALL_DEFAULT_PAUSE_MS,
  parseClaudeBillingState,
  type ClaudeBillingStateKind,
  type ClaudeCreditWall,
  type ClaudeCreditWallCause,
} from './anthropic-billing';
import { classifyCredential401Streak, DEFAULT_CREDENTIAL_401_DEAD_THRESHOLD } from './credential-health';
import { createCodexModelRefusalRegistry, type CodexModelRefusalEntry } from './codex-model-refusals';
import { dbHealthSnapshot, type DbHealthSnapshot } from './db-health';
import { evaluateSelfHeal, pickReclaimTarget, classifySlotReconcile } from './gateway-self-heal';
import { probeEgress } from './egress-probe';
import { recordGatewayStall } from './gateway-stall-store';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { listManaged } from '@papercusp/scheduled-registry';
import { EXTERNAL_SCHEDULES } from '../schedule-descriptors.mjs';
import {
  gatewayProviderStatuses,
  legacyExecutorForGatewayTransport,
  makeGatewayLaneRegistry,
  makeGatewayProviderAdapters,
  providerForGatewayRequest,
  REQUIRE_OUTPUT_TOKEN_LIMIT_HEADER,
  type GatewayLaneDescriptor,
  type GatewayLegacyExecutorId,
} from './provider-adapters';
import {
  executeGatewayRequestKernel,
  GatewayRequestKernelError,
  withPromiseDeadline,
  type GatewayKernelAttemptContext,
  type GatewayKernelContext,
} from './request-kernel';
import {
  createCodexBearerKernelAdapter,
  parseCodexRequestShape,
  type CodexBearerFetchResponse,
} from './codex-bearer-kernel-adapter';
import { createCodexOAuthKernelAdapter, type CodexOAuthFetchResponse } from './codex-oauth-kernel-adapter';
import { decideThrottleRecovery, shapeTerminalThrottle } from './throttle-recovery-ladder';
import {
  createCodexCliKernelAdapter,
  type CodexCliChunk,
  type CodexCliResponseMetadata,
  type CodexCliRouteValue,
} from './codex-cli-kernel-adapter';
import {
  createLocalKernelAdapter,
  type LocalChunk,
  type LocalFetchResponse,
  type LocalResponseMetadata,
  type LocalRouteValue,
} from './local-kernel-adapter';
import {
  createClaudeKernelAdapter,
  type ClaudeChunk,
  type ClaudeClassifyInput,
  type ClaudeFetchResponse,
  type ClaudePreparedAttempt,
  type ClaudeResponseClassification,
  type ClaudeResponseMetadata,
  type ClaudeRouteReason,
  type ClaudeRouteValue,
} from './claude-kernel-adapter';
import type { AccountPool, ActiveAccount } from './provider-contracts';
export type { AccountPool, ActiveAccount } from './provider-contracts';
import {
  GatewayRequestTelemetry,
  classifyGatewayTelemetryOutcome,
  type GatewayRequestSpan,
  type GatewayRequestTelemetrySnapshot,
  type GatewayTelemetryProtocol,
  type GatewayTelemetryProvider,
  type GatewayTelemetryTransport,
} from './request-stage-telemetry';
import {
  codexCliResponsesCompletionSse,
  codexCliResponsesBody,
  extractResponsesInputText,
  isCodexAuthFailure,
  isCodexRateLimitFailure,
  parseBridgeModel,
  runCodexCliCompletion,
  type CodexCliAccount,
  type CodexCliRunOpts,
  type CodexCliSyntheticResponse,
  type CodexCliRunResult,
} from './codex-cli-bridge';
import {
  aggregateCodexNonStreamResponse,
  buildCodexUpstreamHeaders,
  CODEX_CHATGPT_BACKEND_BASE,
  codexBackendUrl,
  CodexNonStreamAggregateError,
  makeCodexNonStreamUpstreamBody,
  normalizeCodexChatGptResponsesBody,
  codexReserveModelFor,
  createCodexProviderCompletionDecoder,
  parseCodexRateReset,
  refreshCodexToken,
  resolveCodexAccessToken,
  type CodexAuth,
  type CodexProviderCompletionEvidence,
} from './codex-oauth-proxy';
import type { AccountEgress, ClaudeAccount } from '../deployment/account-pool';
import { egressEntries } from '../deployment/account-pool';
import { egressCacheKey, egressIsHttpProxy, egressIsSocks5Proxy } from './egress-dispatcher';
import {
  CACHE_POLICY_VERSION,
  deferLargeToolsEnabled,
  deferMinToolBytesFromEnv,
  rewriteAnthropicCacheBody,
  rewriteOpenAiCacheBody,
  shardedCacheKey,
  type AnthropicCacheStats,
  type OpenAiCacheStats,
} from './cache-policy';
import {
  chooseSupportedEffort,
  createEffortClampCache,
  parseUnsupportedEffortError,
  readRequestEffort,
  rewriteRequestEffort,
} from './effort-clamp';
import type { LocalBackend, LocalBackendPool } from './local-backend-pool';
import {
  AdmitImmediatelyDriver,
  AdmissionPersistenceError,
  Governor,
  type AdmissionContext,
} from '../resource-governor/admission';
import { OrgTxnTimeoutError } from '../pg-bounded-txn';
import { DbCallDeadlineError } from '@papercusp/db-org';
import {
  admitGatewayRequest,
  gatewayAdmissionBypassKeyForRequest,
  gatewayAdmissionInputForLane,
  gatewayAdmissionKindForBypassKey,
  withGatewayAdmission,
  GATEWAY_ADMISSION_BYPASS_REGISTRY,
  type GatewayAdmissionBypassKey,
  type GatewayAdmissionKind,
  type GatewayAdmissionRequestInput,
  type GatewayAdmissionGovernor,
} from './admission-context';
import { PayloadSpoolPersistenceError, PayloadTooLargeError, type GatewayPayloadSpool } from './payload-spool';
import { assertKnownFlagKey, buildProcessFlagAttestation, GATEWAY_FLAG_ATTEST_PATH } from '../flag-attestation';
import { foreignLoopbackPeerForSocket } from '../auth/loopback-peer-trust';
import type { Socket as NetSocket } from 'node:net';

/** `RequestInit` plus undici's `dispatcher` extension (per-account egress routing). The standard
 *  lib `RequestInit` type omits it, but Node's global `fetch` honors it. */
type UndiciDispatcher = import('undici').Dispatcher;
type FetchInit = RequestInit & { dispatcher?: UndiciDispatcher };

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
// Pre-admission wait (NO admission slot held → cannot wedge): how long a request parks waiting for an
// account's rate to clear before failing with a retry-after. Bumped 2→4 min (2026-06-22) so the gateway
// ABSORBS more transient throttles for the caller (it succeeds after a longer wait instead of surfacing a
// 429) — safe because no slot is held and the fail-fast-shed still bails immediately when the soonest reset
// is BEYOND this window (a doomed request never waits the full budget). Kept comfortably under the bee CLI's
// ~10-min SDK request timeout. Env-tunable. (The POST-admission 60s slot-hold deadline is a SEPARATE,
// wedge-bounded budget and is NOT changed here.)
const DEFAULT_MAX_QUEUE_WAIT_MS = Number(process.env.PAPERCUSP_GATEWAY_MAX_QUEUE_WAIT_MS) || 4 * 60 * 1000;
// EXTENDED POST-ADMISSION ABSORPTION (env-tunable, 2026-06-22). When > 0, rather than FORWARD a retryable
// transient throttle 429 to the caller (after rotation + the in-retry wait-budget are exhausted) the gateway
// RELEASES its admission slot and re-acquires — the re-acquire's wait holds NO slot, so it CANNOT wedge — looping
// until an account serves or this POST-admission budget runs out. So the caller WAITS LONGER and succeeds instead
// of getting a $0 429. Only a TRANSIENT throttle is absorbed (`transient` gate excludes multi-hour usage caps).
// RAMPED ON at 60s (2026-06-22, owner-ratified): wedge-safe by construction + a held-then-succeeded call beats a
// shed 429 that fails a bee at $0. Sized so maxQueueWaitMs + this stays under the bee CLI's ~10-min SDK timeout.
// 0 = OFF (legacy: shed/forward at the deadline). Env-tunable; injectable per-gateway via deps.requestAbsorbMs.
const DEFAULT_REQUEST_ABSORB_MS = Number(process.env.PAPERCUSP_GATEWAY_REQUEST_ABSORB_MS) || 60_000;
// P-003 (gateway-priority-tiers, SAFE variant of the priority throttle-park): tier-differential absorb
// patience. A higher-priority tier HOLDS the caller longer through a transient throttle-park (so it wins the
// recovered account); a batch tier sheds SOONER (freeing the slot for the high tier) — the OUTCOME of "serve
// highest tier first" WITHOUT a governor-wait-queue restructure (which collides with the absorb's gov-layer
// re-acquire). Applied only when the tier layer is on (`tierMap` set) and the absorb is on; identity (factor 1)
// otherwise. Env PAPERCUSP_GATEWAY_ABSORB_TIER_SCALE=0 disables. Factors ≤1.5, so maxQueueWaitMs + the scaled
// absorb stays under the bee CLI's ~10-min SDK timeout for a sanely-sized requestAbsorbMs.
const ABSORB_TIER_SCALE_ON = process.env.PAPERCUSP_GATEWAY_ABSORB_TIER_SCALE !== '0';
function absorbTierFactor(tier: number | undefined): number {
  if (!ABSORB_TIER_SCALE_ON || tier === undefined) return 1;
  if (tier <= 1) return 1.5; // interactive / queen / scout / overwatch — hold longest
  if (tier === 2) return 1.25; // su
  if (tier === 3) return 1; // bee — the baseline
  return 0.6; // tier 4+ (unknown / batch) — sheds soonest, freeing the slot for the high tiers
}
// INTERACTIVE FAIL-FAST (no-pin-hang follow-up #2, 2026-06-23): a HUMAN-facing caller (priority label
// `interactive` / `operator`) prefers a fast, clear retry-after over the long autonomous stall-absorb hold —
// a bee benefits from held-then-succeed, a person at a prompt does not. Their absorb is CAPPED at this (a brief
// transient blip is still absorbed; a sustained storm sheds quickly), while autonomous tier-1 roles (queen /
// scout / overwatch) keep the full tier-scaled hold — so this OVERRIDES absorbTierFactor's 1.5 for the human
// labels only. Env-tunable; 0 disables the cap (revert to the pure tier factor). The proactive health pick
// (no-pin fix above) already keeps these requests OFF the absorb in the common case; this only bounds the
// worst (whole-pool-throttled-but-recovering) case for a human.
const INTERACTIVE_ABSORB_MS = Number(process.env.PAPERCUSP_GATEWAY_INTERACTIVE_ABSORB_MS) || 8_000;
/** Priority labels that mark a HUMAN-facing caller (vs an autonomous role) → they get the fail-fast absorb cap. */
const HUMAN_PRIORITY_LABELS = new Set(['interactive', 'operator']);
// STALL ABSORPTION (2026-06-23, su-3650b incident fix #2): extend the in-request absorb to the dominant failure
// — TRANSPORT STALLS (Anthropic holding the connection → egress circuit). The 429-absorb can't help (no 429);
// under an Anthropic-wide stall storm every account TTFB-stalls, the gateway exhausts rotation + sheds a
// retryable 503, and the caller errors. With this on, the egress-exhausted shed instead RELEASES the slot +
// re-acquires (gov.acquire waits for a circuit-OPEN account's transport-pause to lift via the half-open probe)
// + retries — so the caller WAITS through the storm and succeeds. Bounded by the same absorb budget (no slot
// held during the wait → cannot wedge). Gated by requestAbsorbMs>0 (the absorb being on); kill-switch:
// PAPERCUSP_GATEWAY_ABSORB_STALLS=0 reverts to the immediate retryable-503 shed.
const ABSORB_STALLS_ON = process.env.PAPERCUSP_GATEWAY_ABSORB_STALLS !== '0';
/** G1 (WI-649): when ≥half the account pool is out of rotation (a FLEET-WIDE bare-burst storm), SUPPRESS the
 *  cross-account rotate-retry on a bare 429 — rotating A→B→C finds no capacity and just multiplies upstream
 *  load (the observed 2.4× fan-out: 152 upstream-429s / 63 requests + 108 failovers), sustaining the storm.
 *  Suppressing it lets the request fall through to the bounded transient-wait / absorb / fail-fast-shed so it
 *  makes ≈1 upstream call instead of ~2.4. The few-accounts-maxed→rotate-to-healthy path is preserved (this
 *  fires ONLY when <half the pool has rotation budget). Kill-switch: PAPERCUSP_GATEWAY_SUPPRESS_BAREBURST_ROTATE=0. */
const SUPPRESS_BAREBURST_ROTATE_ON = process.env.PAPERCUSP_GATEWAY_SUPPRESS_BAREBURST_ROTATE !== '0';
/** WI-673: fleet-wide bare-burst can start as a rapid cross-account CLUSTER before ≥half the
 *  pool has been marked out of rotation. In that ramp phase the old G1 check still rotated the
 *  first few bare 429s (A→B→C...), creating the retry fan-out observed live at only ~3.5
 *  upstream calls/min/account. Treat a short-window cluster across multiple distinct accounts
 *  as the same shared edge throttle and suppress rotate-retry early. */
const BAREBURST_CLUSTER_WINDOW_MS = Number(process.env.PAPERCUSP_GATEWAY_BAREBURST_CLUSTER_WINDOW_MS) || 2_000;
const BAREBURST_CLUSTER_MIN_ACCOUNTS = Number(process.env.PAPERCUSP_GATEWAY_BAREBURST_CLUSTER_MIN_ACCOUNTS) || 2;
/** A header-less ("bare") upstream 429 carries no window/retry signal — but it comes with
 *  `x-should-retry: true`, i.e. a SHORT transient burst-throttle (capacity exists), NOT quota
 *  exhaustion (which sets retry-after / unified-window headers + x-should-retry:false). So pace the
 *  account for this short bounded backoff AND fail over — rotating off the momentarily-limited
 *  account instead of 429-looping it (the ownerhandle10 stuck-loop, 2026-06-17). Tuned to the observed
 *  transient-throttle duration: long enough to let it clear, short enough not to over-bench an
 *  account that's already recovered (which would thin the pool under broad concurrent contention). */
const BARE_429_FAILOVER_BACKOFF_MS = 15 * 1000;
/** CODEX-CLI DEAD-CREDENTIAL QUARANTINE (EI-21618978789879488). A codex home whose `auth.json`
 *  cannot authenticate is NOT out of quota: it advertises `available:true` with healthy headroom
 *  and — because credentials resolve from CODEX_HOME only AFTER selection — nothing feeds that
 *  failure back into selection. On 2026-08-27 a clobbered credential was therefore chosen ahead of
 *  four healthy codex homes on every request for hours, and the resulting blank failure was read
 *  fleet-wide as "the provider is out of usage". Quarantining through the pool's ORDINARY
 *  exhaustion path (not a parallel health map) makes a dead credential skippable with the same
 *  readmit semantics as a rate wall. Much longer than the 429 backoff — a credential does not
 *  heal on its own; it takes an owner `codex login` — but still bounded, so a repaired home is
 *  readmitted without a gateway restart (an account hot-reload readmits it immediately). */
const CODEX_CLI_AUTH_QUARANTINE_MS = Number(process.env.PAPERCUSP_GATEWAY_CODEX_AUTH_QUARANTINE_MS) || 15 * 60 * 1000;
/** CODEX-CLI SSE KEEPALIVE. The subscription bridge drives a nested `codex exec` to completion
 *  before it holds a single output byte, but `codex exec` asks for SSE and BOTH ends enforce an
 *  idle deadline — the gateway's own `downstreamIdleMs` (2 min) destroys the response first, which
 *  aborts the signal, which SIGKILLs the child. So adapting the buffered result to SSE *without*
 *  keeping the socket warm does not fix `stream:true`, it only converts a fail-fast 400 into a
 *  120s hang: measured ~10 `request aborted`/min for every gateway-routed Codex agent turn between
 *  17:51Z and 18:31Z on 2026-08-27, against ZERO in the preceding four hours. Comment frames are
 *  ignored by every SSE reader and reset both deadlines; well under downstreamIdleMs so one missed
 *  tick is survivable. */
const CODEX_CLI_SSE_KEEPALIVE_MS = Number(process.env.PAPERCUSP_GATEWAY_CODEX_SSE_KEEPALIVE_MS) || 15 * 1000;
/** BARE-429 PERSISTENCE CIRCUIT (auto-route-around fix, 2026-06-29). A bare/burst 429 is normally a SHORT
 *  transient (paced 15s above). But a per-IP Cloudflare EDGE throttle on an account's egress proxy returns
 *  the SAME bare 429 PERSISTENTLY — and since a 429 means "the proxy WORKED", the transport egress circuit
 *  (which counts only stalls/connect-errors) never trips. So the account was paced only 15s, rejoined
 *  rotation, and got re-throttled forever — the pool NEVER auto-routed around the bad IP (owner-reported
 *  "constant api errors on the pinned account even though it has usage + rate-limit headroom"; the throttle
 *  is on the IP, not the account quota). FIX: count CONSECUTIVE bare-429s per account; once the streak
 *  crosses the threshold, ESCALATE the pause (double per step, capped) so the existing pin-yield /
 *  soft-pin-failover / health-pick selectors route AROUND the throttled IP to healthy accounts — the 429
 *  analogue of the transport egress circuit. Reset on the next 2xx. Disable with THRESHOLD=0. */
const BARE429_CIRCUIT_THRESHOLD = Number(process.env.PAPERCUSP_GATEWAY_BARE429_CIRCUIT_THRESHOLD ?? 4);
const BARE429_CIRCUIT_MAX_MS = Number(process.env.PAPERCUSP_GATEWAY_BARE429_CIRCUIT_MAX_MS) || 120_000;
// SOFT-PIN failover is UNSERVICEABLE-ONLY (dedicated-pin redesign 2026-07-01, gateway-rayobyte-hardening
// P-004; supersedes the load-aware yield of 2026-06-29): a pin is a cache-affinity COMMITMENT, broken only
// when `accountLoadKey`-based `keyOf` scores the pin Infinity (governor/egress/rate-hint paused, 5h/7d
// window exhausted or rejected, every pooled egress IP cooled). Load alone — live in-flight, climbing
// utilization, some-but-not-all IPs cooled — NEVER diverts a pin: concurrency on a pinned account is the
// owner's explicit choice, and it queues + paces on the pin's governor. The load-aware yield diverted
// pinned owners off a 97%-cache-hit account at inflight=1 (su-98731/ownerhandle7, 2026-07-01) — the cold-cache
// cost of a diverted first turn dwarfs any queueing it saved. Real saturation still degrades gracefully:
// 429 → escalating pause → keyOf()=Infinity → yield, and per-request re-evaluation returns traffic to the
// pin as soon as the pause lifts.
/** When EVERY pool account is transiently throttled at once, the gateway waits out the soonest
 *  account's short penalty and retries rather than forwarding a retryable (x-should-retry:true) 429.
 *  This caps that wait so a request can never hang on a hard/long reset (a multi-hour usage cap is
 *  forwarded, not waited on). Sized to cover a bare-429 burst penalty + slack. */
const ALL_THROTTLED_RECOVERY_WAIT_CAP_MS = 20 * 1000;
/** Total time a single client request may spend WAITING out short transient throttles (budget #2,
 *  separate from the rotation-attempt budget) before forwarding. Bounds the wait so a fleet-wide
 *  transient burst is absorbed but a request can never hang. */
const TRANSIENT_TOTAL_WAIT_BUDGET_MS = 30 * 1000;
/** Hard wall-clock ceiling on how long ONE client request may keep RETRYING internally (rotating across
 *  accounts + waiting out transient throttles) before it stops, sheds a retryable 429, and FREES its
 *  admission slot. This is the load-bearing rung of the WEDGE-PREVENTION THRESHOLD LADDER:
 *
 *    INTERNAL_RETRY_DEADLINE_MS (60s)  <  self-heal freeze (DEFAULT_SELFHEAL_FREEZE_MS, 75s)  <  watchdog freeze (120s)
 *
 *  Without it a request under a SLOW-upstream pool-wide storm could hold its slot for (≤INTERNAL_RETRY_MAX_
 *  ATTEMPTS upstream fetches, each seconds long under load) + the 30s transient-wait budget — exceeding
 *  75-120s. At the AIMD FLOOR (a few slots) a handful of such squatters saturate every slot with NO natural
 *  completion → the self-heal drain-clock ages → the valve can't keep up → the watchdog FULL-restarts the
 *  gateway (~15-30s of fleet-wide connection-refused = the "api error" the fleet sees). Shedding at the
 *  deadline keeps every slot cycling fast enough that the frozen-while-saturated wedge signature never forms.
 *  TRADEOFF: a bounded retryable 429 (+retry-after) to a few no-CLI-retry callers (scout/gym) is strictly
 *  better than a wedge that connection-refuses the WHOLE fleet. MUST stay < DEFAULT_SELFHEAL_FREEZE_MS. */
const INTERNAL_RETRY_DEADLINE_MS = Number(process.env.PAPERCUSP_GATEWAY_INTERNAL_RETRY_DEADLINE_MS) || 60 * 1000;
/** Inspect a NON-200 upstream body up to this many bytes for a usage/session-limit signature (the
 *  Claude-Code subscription cap — "You've hit your session limit · resets 10:50am" — a WALL the bee
 *  classifies as usage_limit + WON'T retry). Such error bodies are tiny; this just bounds the read.
 *  Successful 200 streams are NEVER peeked, so the hot path keeps zero added latency. */
const USAGE_LIMIT_PEEK_BYTES = 64 * 1024;
/** When a usage/session-limit message carries no parseable reset, pause the capped account this long. */
const USAGE_LIMIT_DEFAULT_PAUSE_MS = 60 * 60 * 1000;
/** An account-level org/subscription DISQUALIFICATION (a 403 that is NOT a transient throttle): the
 *  account's Anthropic org disabled OAuth API access, or Claude Code for the subscription. The account
 *  is unusable until an admin re-enables it, so pause it OUT of rotation this long (re-probes after) +
 *  fail over — instead of forwarding the 403, which hard-fails the bee AND, when the account is
 *  active(), 403-blocks the WHOLE fleet (the avi-storewolf incident, 2026-06-18). */
const ORG_DISALLOW_PAUSE_MS = 6 * 60 * 60 * 1000;
/** Consecutive org-disallowed 403s from ONE account that trigger PERSISTENT deactivation (`onOrgDisallowed`).
 *  Default 1: org-disable is a DEFINITIVE Anthropic-side permission_error (not a transient throttle), AND the
 *  account is PAUSED out of rotation on the first hit — so a higher streak could never accumulate (it is never
 *  re-selected; the in-memory streak also resets on restart). Deactivate on the first hit. Tunable via deps. */
const DEFAULT_ORG_DISALLOWED_DEACTIVATE_THRESHOLD = 1;
/** Body signatures of an org/subscription disqualification (403). Covers both observed forms: the
 *  OAuth-org disallow ("OAuth authentication is currently not allowed for this organization") and the
 *  spawned-claude-code disallow ("Claude subscription disabled for Claude Code"). */
const ORG_DISALLOWED_RE =
  /not allowed for this organization|subscription disabled for claude code|disabled for claude code/i;
/** Bounded INTERNAL retry: how many upstream attempts the gateway makes on a SINGLE client request,
 *  walking past usage-capped / transiently-throttled accounts before giving up and forwarding the error.
 *  The gateway absorbs transient throttles itself so a bee's SMALL CLI retry budget never exhausts (the
 *  observed $0 fail: "Server is temporarily limiting requests · Rate limited" → bee exits rc=1 in ~10s),
 *  and routes around a usage cap (which the bee won't retry at all). */
const INTERNAL_RETRY_MAX_ATTEMPTS = 6;
/** Short backoff before retrying a TRANSIENT 429 on a freshly-rotated account (the throttle is
 *  account-specific, so a different account usually sidesteps it; the pause just avoids a hot loop). */
const TRANSIENT_429_BACKOFF_MS = 400;
/** Backoff before retrying a 529 (SERVER overload — not account budget, so we don't penalize/rotate the
 *  account; just wait briefly for the upstream to recover). */
const OVERLOAD_529_BACKOFF_MS = 1000;
/** Consecutive upstream TRANSPORT failures (a fetch stall/abort or connect error — NOT an HTTP status,
 *  which means the proxy WORKS) on ONE account before its egress circuit OPENS (B-GW-EGRESS, the
 *  2026-06-20 dead-proxy wedge). A transport failure never reaches Anthropic → never returns 429 → it
 *  fed NO account-health signal, so a DEAD egress proxy scored "healthiest", drew the MOST traffic, and
 *  overrode session pins (ownerhandle6/216.41.233.249, a half-dead squid CONNECT-hanging ~60s, wedged the
 *  whole gateway into a restart storm). A lone blip just briefly paces the account; a STREAK opens a
 *  longer circuit. Env-tunable. */
const EGRESS_FAIL_CIRCUIT_THRESHOLD = Number(process.env.PAPERCUSP_GATEWAY_EGRESS_FAIL_THRESHOLD) || 3;
/** How long an OPEN egress circuit pauses the account — fed into the SAME gov.pausedUntil lever the 429
 *  hard-cap uses, so the existing pin-yield + cross-account selector already route around it. Short
 *  enough that the natural half-open (pause expires → the next request re-probes the account → a success
 *  closes the circuit, a transport failure re-opens it) retests soon; long enough to route the fleet
 *  around a dead proxy. Env-tunable. */
// FALLBACK ceiling on the egress-circuit pause: the half-open probe now LIFTS the pause the instant the
// proxy recovers (out-duration = actual recovery, usually a few seconds), so this only bites when the probe
// is disabled or the proxy is genuinely dead. Shortened 60s→20s (2026-06-21) so a flaky proxy never strands
// a token-healthy account for a full minute even in the probe-off fallback path.
const EGRESS_CIRCUIT_OPEN_MS = Number(process.env.PAPERCUSP_GATEWAY_EGRESS_CIRCUIT_MS) || 20_000;
/** FLAPPING BACKOFF (2026-06-22): a chronically-flapping egress proxy (circuit reopens soon after a readmit)
 *  gets a progressively LONGER open — doubling per reopen up to this cap — so we stop readmitting-and-failing
 *  it every EGRESS_CIRCUIT_OPEN_MS, which routes real bee requests back onto a known-bad proxy → 503. Observed
 *  during a sustained Rayobyte outage: 134 circuit opens in 50 min thrashing the same proxies. */
const EGRESS_CIRCUIT_OPEN_MAX_MS = Number(process.env.PAPERCUSP_GATEWAY_EGRESS_CIRCUIT_MAX_MS) || 300_000;
/** A proxy stable (no reopen) for longer than this RESETS its flapping escalation — the next open is treated
 *  as fresh (base duration), so a one-off blip never inherits a chronic flapper's long backoff. */
const EGRESS_FLAP_RESET_MS = Number(process.env.PAPERCUSP_GATEWAY_EGRESS_FLAP_RESET_MS) || 300_000;
/** Consecutive SUCCESSFUL egress probes required before readmitting a circuit-paused account. A flapping proxy
 *  (passes a probe, then stalls the real request) rarely strings two spaced probes together → it stays out;
 *  a genuinely-recovered proxy readmits after just one extra probe interval. =1 restores the old behavior. */
const EGRESS_PROBE_READMIT_STREAK = Number(process.env.PAPERCUSP_GATEWAY_EGRESS_PROBE_READMIT_STREAK) || 2;
/** Delay before the half-open egress PROBE fires after a circuit opens (egress-probe.ts re-tests the
 *  account's proxy through the same dispatcher). On success it clears the failure streak so the account
 *  readmits CLEAN at pause-expiry; `=0` disables the active probe (the natural pause-expiry half-open
 *  still applies). Env-tunable. */
const EGRESS_PROBE_DELAY_MS =
  process.env.PAPERCUSP_GATEWAY_EGRESS_PROBE_MS !== undefined
    ? Number(process.env.PAPERCUSP_GATEWAY_EGRESS_PROBE_MS)
    : 4_000;
/** Per-probe network timeout for the half-open egress probe — bounded so it never lingers on a still-dead
 *  proxy, yet generous enough to CONFIRM a recovered-but-slow proxy. The per-account egress squids
 *  legitimately take 1.3–6.1s under box load; the old 8s cap false-aborted healthy proxies ("egress probe
 *  STILL DOWN (operation aborted)") → the recovered account stayed circuit-paused the full window → the
 *  pool read "all throttled / no-fresh-account" → bees hung on their first inference with 0 invocations
 *  (WI-389). Kept under EGRESS_CIRCUIT_OPEN_MS − EGRESS_PROBE_DELAY_MS so the probe still fits inside the
 *  open window. Env-tunable. */
const EGRESS_PROBE_HTTP_TIMEOUT_MS = Number(process.env.PAPERCUSP_GATEWAY_EGRESS_PROBE_HTTP_MS) || 12_000;
/*
 * RETIRED BY P-010 (capless-inference-gateway-2026-08-28):
 *   - `DEFAULT_CONCURRENCY = 24`            the baked Claude admission ceiling
 *   - `CODEX_ADMISSION_SLOTS_PER_ACCOUNT`   the Codex account-scaled slot ceiling
 *   - `accountScaledCodexConcurrency()`     Codex's separate seed arithmetic
 *   - `readCodexConcurrencyOverride()`      PAPERCUSP_GATEWAY_CODEX_CONCURRENCY
 *
 * Admission concurrency is no longer configured for either provider. Both lanes
 * are driven by ONE `ProviderAdmissionLifecycle` (provider-admission-lifecycle.ts)
 * whose window has a floor and intentionally no maximum, so a healthy lane grows
 * past whatever it started at instead of being pinned to a number someone typed.
 * A bootstrap value can still say where a COLD lane starts (D-002: initial state,
 * never a ceiling) — see `INITIAL_PROVIDER_ADMISSION_WINDOW`.
 */
/** AIMD admission-concurrency defaults (inference-gateway-robustness-audit-2026-06-20 P1 / B-GW-1). The
 *  gateway shrinks the admission queue's EFFECTIVE maxConcurrent under sustained upstream 429s (fewer
 *  concurrent upstream calls = lower per-IP RPM = the throttle eases — breaking the retry-storm
 *  amplification) and additively recovers toward the cap when calls succeed. Semantics mirror the fleet
 *  AIMD gate (governor-registry.ts). Floor ≥1; tunable via deps.aimd / env. The floor stays a few slots
 *  so the pool can still rotate + absorb a short transient (the scout/gym no-CLI-retry protection). */
const DEFAULT_AIMD_FLOOR = Number(process.env.PAPERCUSP_GATEWAY_AIMD_FLOOR) || 4;
/** Net throttle pressure (429s minus successes) that trips one multiplicative halving — high enough that
 *  a lone transient 429 never shrinks the pool, low enough that a real storm reaches the floor fast. */
const DEFAULT_AIMD_DECREASE_THRESHOLD = Number(process.env.PAPERCUSP_GATEWAY_AIMD_DECREASE_THRESHOLD) || 6;
/** Consecutive clean 2xx that earn one additive +1 step back toward the cap (gentle recovery). */
const DEFAULT_AIMD_INCREASE_EVERY = Number(process.env.PAPERCUSP_GATEWAY_AIMD_INCREASE_EVERY) || 8;
// Legacy serviceability recommendation knobs. P-007 keeps these values for
// diagnostics/routing evidence, but they are no longer applied to the productive
// admission window. `PAPERCUSP_GATEWAY_SERVICEABLE_CLAMP` remains accepted as
// compatibility telemetry and cannot re-enable a hard cap.
const SERVICEABLE_CLAMP_ON = process.env.PAPERCUSP_GATEWAY_SERVICEABLE_CLAMP !== '0';
/** How the serviceable-count clamp is honored. `auto` = apply the recommendation (the safe default, the
 *  thundering-herd guard). `off` = compute + REPORT it, but admit at the AIMD effective — the agent
 *  override. Flippable LIVE via `POST /admin/clamp-mode` (no restart), per the 2026-07-09 owner directive
 *  that a gateway clamp be a recommendation rather than a hard cap. */
export type ServiceableClampMode = 'auto' | 'off';
const PER_ACCOUNT_ADMISSION = Number(process.env.PAPERCUSP_GATEWAY_PER_ACCOUNT_ADMISSION) || 4;
const MIN_SERVICEABLE_ADMISSION = Number(process.env.PAPERCUSP_GATEWAY_MIN_ADMISSION) || 2;

/**
 * How many concurrent admission slots a pool of `accountCount` accounts can actually serve.
 *
 * ONE FORMULA, TWO CONSUMERS — do not re-derive it at a call site. It is (a) the
 * serviceable-clamp RECOMMENDATION published on `GET /stats` as `clamp.recommendation`, and
 * (b) the COLD-START SEED for the capless admission lifecycle (`launch.ts`).
 *
 * WHY (b) EXISTS — measured outage 2026-09-02, WI-2140943. The seed was the hard-coded
 * `INITIAL_PROVIDER_ADMISSION_WINDOW` (8) no matter how large the pool was, because
 * `sidecar-main.ts` deliberately passes no `concurrency` under P-010 ("admission concurrency is
 * learned, never configured"). Learned is right for the LIVE window and wrong for where a cold
 * lane STARTS: with 7 healthy Claude accounts (recommendation 28) the gateway restarted into a
 * window of 8, and since AIMD recovery is additive (+1 per N successes) at a rate proportional
 * to the window itself, climbing back cost hours of fleet-wide queueing. Seeding from real pool
 * size removes the artificial cold-start bottleneck without reinstating a cap.
 *
 * This is a SEED and a RECOMMENDATION — never a maximum. The AIMD still owns the live window and
 * may grow past this under clean traffic or contract below it under genuine upstream throttling.
 * P-007 retired the clamp as an admission AUTHORITY and that stays retired.
 */
export function serviceableAdmissionFor(accountCount: number): number {
  return Math.max(MIN_SERVICEABLE_ADMISSION, Math.floor(accountCount) * PER_ACCOUNT_ADMISSION);
}
const SERVICEABLE_CLAMP_TICK_MS = Number(process.env.PAPERCUSP_GATEWAY_SERVICEABLE_CLAMP_TICK_MS) || 2000;
const SERVICEABLE_CLAMP_MODEL = process.env.PAPERCUSP_GATEWAY_SERVICEABLE_CLAMP_MODEL || 'claude-opus-4';
/** Max requests allowed to WAIT for an admission slot before the gateway sheds load (429 + retry-after)
 *  instead of growing the backlog. Under a SUSTAINED pool-wide upstream throttle every in-flight request
 *  squats its slot for the full internal wait budget, so the queue would otherwise grow without bound
 *  until the gateway is wedged (the 2026-06-19/20 outages: queue hit 2k–3.6k deep, needing a manual
 *  restart). A bounded queue degrades to fast retryable 429s and self-recovers when the throttle clears.
 *  Env-tunable (PAPERCUSP_GATEWAY_MAX_QUEUED); generous by default so normal bursts still queue.
 *
 *  Retained deliberately by the capless migration, NOT missed by it: it bounds how many requests may
 *  WAIT in resident memory, never the admission window. The gateway resolves the bound as
 *  `deps.maxQueued ?? (payloadSpool ? 0 : DEFAULT_MAX_QUEUED)`, and 0 is PriorityAdmissionQueue's
 *  uncapped sentinel — so with the durable payload spool active this constant does not bind at all
 *  (capacity-inventory.ts P-006/P-014 row: live GET /stats 2026-08-30T00:17Z reported maxQueued=0
 *  and shed429=0 across 27,329 requests).
 *  @capacity-disposition: semantic — resident-memory safety backstop for requests with nowhere durable to spill; 0 (uncapped) whenever the payload spool is active, and it never bounds the admission window */
const DEFAULT_MAX_QUEUED = Number(process.env.PAPERCUSP_GATEWAY_MAX_QUEUED) || 256;
/** retry-after (seconds) on a load-shed 429 — short, since the backlog drains as in-flight requests
 *  settle; the caller should retry soon (and will likely land once the burst/throttle eases). */
const LOADSHED_RETRY_AFTER_SEC = 5;
/** Upstream stall guard (the 2026-06-19 deadlock fix). `doFetch`/the body stream had NO deadline, so a
 *  stalled upstream (socket accepted, no response — Anthropic during an overload) hung the proxy task
 *  forever; PriorityAdmissionQueue only frees a slot when the task settles, so each hang leaked a slot
 *  until the pool deadlocked at maxConcurrent (every request then queued + timed out, on every account).
 *  An AbortController turns the permanent hang into a normal reject → slot release → failover. Two
 *  activity-reset windows so a LEGITIMATELY long request is never clipped: a wait for response HEADERS
 *  and a per-chunk idle gap for the streamed BODY (reset on every byte — only a true stall trips it).
 *  The headers wait is split by mode (2026-06-20): a STREAMING request's first byte/headers arrive in
 *  seconds (the bee `claude` CLI streams, + Anthropic emits `message_start` BEFORE it generates), so it gets
 *  a SHORT TTFB deadline — a stalled Anthropic socket (a soft-throttle that HOLDS the request, or an
 *  Anthropic-side flap) then aborts quickly instead of squatting its admission slot for the full 5min.
 *  Cut 60→30s (2026-06-22): account-side stalls dominate under throttle, and a real first byte arrives in
 *  seconds, so 30s is still a 6×+ margin — but it frees the slot + the retry budget twice as fast to route
 *  around the stalling account (the dominant "pinned/low-activity account still errored" failure mode).
 *  A NON-streaming request's headers only arrive AFTER the full generation, so it keeps the generous
 *  deadline (a short one would falsely abort a long completion). All env-overridable. */
const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = Number(process.env.PAPERCUSP_GATEWAY_UPSTREAM_HEADERS_MS) || 5 * 60 * 1000;
const DEFAULT_UPSTREAM_STREAM_HEADERS_TIMEOUT_MS =
  Number(process.env.PAPERCUSP_GATEWAY_UPSTREAM_STREAM_HEADERS_MS) || 30 * 1000;
const DEFAULT_UPSTREAM_BODY_IDLE_TIMEOUT_MS = Number(process.env.PAPERCUSP_GATEWAY_UPSTREAM_BODY_IDLE_MS) || 90 * 1000;
/** Max wait for an OAuth token refresh before the attempt is FAILED instead of hung (the 2026-06-20
 *  token-hang wedge). `active.token()` does a network refresh (grant_type=refresh_token) with NO deadline
 *  of its own AND runs BEFORE the upstream stall-guard is armed — so when the OAuth endpoint stalls (it
 *  tends to during an upstream incident) every in-flight slot that needed a refresh blocked there forever,
 *  pinning all maxConcurrent slots until a manual restart (symptom: counters frozen, multi-minute log
 *  silence, queue climbing to the shed cap — distinct from the streaming-TTFB wedge above). Bounding it
 *  turns the hang into a fast reject → penalize the account + the finally releases the slot. Generous by
 *  default (a refresh is normally <2s). Env-overridable. */
const DEFAULT_TOKEN_TIMEOUT_MS = Number(process.env.PAPERCUSP_GATEWAY_TOKEN_MS) || 20 * 1000;
/** Downstream (gateway→client) idle timeout: if the bee's socket makes NO progress for this long while
 *  we stream a response to it, tear the socket down so a hung / half-open client (got headers, stopped
 *  reading, never sent RST) cannot pin the proxy task — and thus its admission slot — forever. The
 *  upstream stall-guard aborts UPSTREAM only; a completed-upstream + dead-client stream had no path to
 *  resolve (res never 'finish' — can't flush; never 'close' — half-open; upstream never 'error' — done),
 *  so the slot pinned with frozen counters + silent logs (the 2026-06-20 wedge #2). `res.setTimeout`
 *  fires on socket INACTIVITY, so it distinguishes a hung client (fires → destroy → 'close' → release)
 *  from a slow-but-draining one (write progress keeps resetting it). Env-tunable. */
const DEFAULT_DOWNSTREAM_IDLE_MS = Number(process.env.PAPERCUSP_GATEWAY_DOWNSTREAM_IDLE_MS) || 2 * 60 * 1000;
/** Hard per-request lifetime ceiling — a UNIVERSAL backstop. The activity timers (upstream headers/body,
 *  token refresh, downstream idle) each bound a SPECIFIC hang; this bounds the WHOLE request regardless of
 *  cause, so a future/unknown unbounded await can never silently pin an admission slot (the recurring
 *  2026-06-20 wedge class). Generous — longer than any legitimate single turn (a long non-streaming
 *  generation waits the 5-min headers deadline + body) — so it only fires on a genuine wedge, never on live
 *  traffic. On fire it aborts the in-flight upstream AND destroys the client socket → every await resolves
 *  → the finally releases the slot. Env-tunable. */
const DEFAULT_REQUEST_CEILING_MS = Number(process.env.PAPERCUSP_GATEWAY_REQUEST_CEILING_MS) || 20 * 60 * 1000;
/** ChatGPT's OAuth Responses endpoint speaks SSE even for a public `stream:false` request. The gateway
 * aggregates that boundedly into ordinary Responses JSON so high-volume non-stream callers do not spawn
 * one `codex exec` subprocess per retry. The env switch is the emergency compatibility fallback to the
 * old CLI bridge; the transport is enabled by default whenever the OAuth proxy itself is enabled. */
const DEFAULT_CODEX_OAUTH_NONSTREAM = process.env.PAPERCUSP_GATEWAY_CODEX_OAUTH_NONSTREAM !== '0';
const DEFAULT_CODEX_OAUTH_NONSTREAM_MAX_BYTES =
  Number(process.env.PAPERCUSP_GATEWAY_CODEX_OAUTH_NONSTREAM_MAX_BYTES) || 16 * 1024 * 1024;
const DEFAULT_CODEX_OAUTH_NONSTREAM_TIMEOUT_MS =
  Number(process.env.PAPERCUSP_GATEWAY_CODEX_OAUTH_NONSTREAM_TIMEOUT_MS) || undefined;
/** Account-scoped model discovery is metadata, but it still crosses the same OAuth + egress
 * boundary as inference. Keep it short, cache it, and never let a catalog outage block Codex
 * startup. The stale value remains a last-known-good fallback after TTL expiry. */
const DEFAULT_CODEX_MODELS_CATALOG_TTL_MS =
  Number(process.env.PAPERCUSP_GATEWAY_CODEX_MODELS_TTL_MS) || 5 * 60 * 1000;
const DEFAULT_CODEX_MODELS_CATALOG_TIMEOUT_MS =
  Number(process.env.PAPERCUSP_GATEWAY_CODEX_MODELS_TIMEOUT_MS) || 5_000;
const CODEX_MODELS_CATALOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The OAuth adapter receives live SSE while deliberately withholding downstream
 * bytes until `response.completed`. Its body-idle timer already rejects a truly
 * stalled upstream, and the request ceiling bounds the whole request. A shorter
 * fixed aggregation lifetime therefore kills healthy long-running generations
 * (WI-42278 reproduced this at the former five-minute default). Unless an
 * operator deliberately configures a tighter limit, use the request ceiling.
 */
export function resolveCodexOAuthNonStreamTimeoutMs(requestCeilingMs: number, configuredTimeoutMs?: number): number {
  return Math.max(1, Math.min(requestCeilingMs, Math.floor(configuredTimeoutMs ?? requestCeilingMs)));
}
/** A header-PINNED request waits at most this long on its pinned account before failing over to the
 *  pool's active() account (Fault #3): the spawn-side drain selector pins by the cross-process budget
 *  projection, which can't see the gateway's live pacing, so a pinned account may be actively paced —
 *  we must NOT 429-loop the bee into a $0 hang. Short, so failover is quick; cache-affinity yields. */
const PINNED_FAILOVER_WAIT_MS = 10_000;
/** Cap on the `retry-after` the gateway ever HANDS A BEE on a shed/admission-timeout 429. The internal
 *  governor pause may be tens of minutes (a 7d-exhausted rolling window — see ROLLING_WINDOW_REPROBE_MAX_MS),
 *  but that's a ROUTING horizon (keep the account parked), NOT how long the bee should sleep: telling a bee
 *  "retry after 1800s" strands it (owner-reported 2026-06-21). Forward a short retry-after so the bee re-asks
 *  soon — by then routing has walked to a healthy account, or the stall-waker resumes it. Env-tunable. */
const BEE_RETRY_AFTER_CAP_S =
  Number(process.env.PAPERCUSP_GATEWAY_CUP_RETRY_AFTER_CAP_S ?? process.env.PAPERCUSP_GATEWAY_BEE_RETRY_AFTER_CAP_S) ||
  60; // legacy env name — dual-accept until callers migrate
/** Grace before a shutdown FORCE-destroys still-streaming connections (2026-06-22 audit). server.close()
 *  alone waits for every long-lived SSE stream to end → it hung past systemd's TimeoutStopSec and got
 *  force-killed (orphaned process). Drop idle keep-alives immediately, let near-done requests finish within
 *  this window, then destroy the rest so the restart is prompt. Well under the unit's TimeoutStopSec=30s. */
const GRACEFUL_SHUTDOWN_MS = Number(process.env.PAPERCUSP_GATEWAY_SHUTDOWN_GRACE_MS) || 5_000;
/** Max round-robin hops the admission router takes looking for an account whose governor has headroom
 *  RIGHT NOW before falling back to waiting on the chosen one. Bounds the walk to roughly the pool size
 *  so an UNPINNED request egresses through an account with capacity instead of hanging the full
 *  maxQueueWaitMs on one paused-governor account while siblings sit admittable (the 2026-06-18
 *  "accounts unused / opus hangs" bug: ownerhandle2/ownerhandle7 returned opus 200 upstream while the gateway
 *  pinned all egress to one paused account). */
const POOL_WALK_MAX_ATTEMPTS = 16;
/** In-process self-heal release valve (EI-2086). The external WEDGE watchdog (watchdog.mjs) recovers a
 *  wedged gateway by FULL-RESTARTING the process — dropping every in-flight request + the listener
 *  (~15-30s fleet-wide connection-refused) — on the `frozen 120s while saturated` signature. The
 *  gateway's own per-request guards (5-min non-streaming headers, 20-min hard ceiling) reclaim a stuck
 *  slot far SLOWER than 120s, so the watchdog's restart always wins → the routine recovery became an
 *  hourly restart (5× on 2026-06-20). This sweeper PRE-EMPTS it: when saturated AND nothing has
 *  NATURALLY drained for SELFHEAL_FREEZE_MS (< 120s), it aborts the oldest stuck slot in-process, so the
 *  gateway drains its own wedge with the listener + healthy traffic still up. Default on; `=0` disables. */
const DEFAULT_SELFHEAL_ENABLED = process.env.PAPERCUSP_GATEWAY_SELFHEAL !== '0';
/** How long the gateway may be saturated with NO natural completion before the valve reclaims a slot.
 *  Deliberately below the watchdog's 120s freeze threshold so self-heal pre-empts the full restart. */
const DEFAULT_SELFHEAL_FREEZE_MS = Number(process.env.PAPERCUSP_GATEWAY_SELFHEAL_FREEZE_MS) || 75_000;
/** Sweeper tick interval — also the spacing between successive reclaims while a wedge persists, so a
 *  multi-slot wedge drains a slot every poll (several reclaims land before the watchdog's 120s). */
const DEFAULT_SELFHEAL_POLL_MS = Number(process.env.PAPERCUSP_GATEWAY_SELFHEAL_POLL_MS) || 10_000;
/** Per-attempt timeout for a local-backend (llama-server/vllm/ollama) proxy request. Local inference
 *  can be slow on a loaded box, but a request that never resolves must still fail over. */
const DEFAULT_LOCAL_BACKEND_TIMEOUT_MS =
  Number(process.env.PAPERCUSP_GATEWAY_LOCAL_BACKEND_TIMEOUT_MS) || 5 * 60 * 1000;
/** Header a bee/spawn sets to prioritise its requests (interactive/queen > batch). */
export const PRIORITY_HEADER = 'x-papercusp-priority';
/** MAINTENANCE lane (deterministic-context-carry P-002, ornith-overflow brief fixes 2–3): the
 *  priority label + endpoint path for compaction/summarizer calls. The label maps to tier 1
 *  (reserved floor, never AIMD-shed) so fleet worker traffic can never starve a compaction —
 *  the 2026-07-13 incident's summarizer 429'd against the agent's own saturated backend, then
 *  its hosted fallback 429'd under fleet load, and the session hit its context wall on camera. */
export const MAINTENANCE_PRIORITY_LABEL = 'maintenance';
/** POST path speaking omp's remote-compaction wire: `{systemPrompt?, prompt}` → `{summary}`
 *  (the shape omp's `compaction.remoteEndpoint` client sends/expects, verified in the bundle).
 *  psu-launcher.mjs hardcodes this path (it cannot import TS) — keep them in lockstep. */
export const MAINTENANCE_SUMMARIZE_PATH = '/maintenance/summarize';
/** GET path exposing a local backend's LIVE per-slot context window (deterministic-context-carry
 *  P-005): `?model=<id>` → `{ok, model, backendId, nCtx, totalSlots}` read from the backend's
 *  `/props` (`default_generation_settings.n_ctx` is PER-SLOT for llama-server: total -c divided
 *  by -np). The gateway is the only component that knows the model→backend mapping, and it only
 *  proxies /v1/* otherwise — so session launchers read the live limit HERE instead of trusting a
 *  hand-set registry number. psu-launcher.mjs hardcodes this path (it cannot import TS) — keep
 *  them in lockstep. */
export const MAINTENANCE_BACKEND_CONTEXT_PATH = '/maintenance/backend-context';
/** Deadline for the backend `/props` probe — a local /props read is milliseconds; anything
 *  slower means the backend is wedged and the caller should fall back to its configured limit. */
const BACKEND_CONTEXT_PROBE_TIMEOUT_MS = 5_000;
/** Model the maintenance summarizer runs on — CHEAP + hosted, never the caller's own backend.
 *  `claude-haiku-4-5` is the repo-canonical haiku id (haiku.ts, scout, memory extraction). */
const DEFAULT_MAINTENANCE_MODEL = process.env.PAPERCUSP_GATEWAY_MAINTENANCE_MODEL || 'claude-haiku-4-5';
/** Output cap for a maintenance summary. omp's own summarizer asked for 0.8×window — far more than
 *  a carry summary needs; 8K bounds cost while comfortably fitting the largest useful summary. */
const DEFAULT_MAINTENANCE_MAX_TOKENS = Number(process.env.PAPERCUSP_GATEWAY_MAINTENANCE_MAX_TOKENS) || 8192;
/** Hard ceiling on a caller-supplied maxTokens override (keeps the lane cheap by construction). */
const MAINTENANCE_MAX_TOKENS_CEILING = 16384;
/** Whole-call deadline for a maintenance summarize (loopback admission + upstream generation).
 *  Below omp's 180s remote-compaction client timeout so the caller gets a structured error, not
 *  a socket hang; generous enough to ride out a transient throttle-park via the absorb path. */
const DEFAULT_MAINTENANCE_TIMEOUT_MS = Number(process.env.PAPERCUSP_GATEWAY_MAINTENANCE_TIMEOUT_MS) || 150_000;
/** Header a spawn sets to pin its requests to one pool account for cache affinity
 *  (inference-gateway-multi-credential-routing P-003). Stripped before the upstream forward. */
export const ACCOUNT_HEADER = 'x-papercusp-account';
/** Header marking a pin as HARD (operator / PSU-utility pins, account-hard-pin-2026-06-29): value
 *  `hard` ⇒ route the request to its pinned account with NO failover whatsoever — it never yields to
 *  liveness/load/stall, never soft-pin-failover, and never rotates off the account in the retry loop.
 *  The operator EXPLICITLY chose this credential and accepts its latency/limits (an exhausted/stalled
 *  pin waits or 429s ON the pin rather than serving a different account). Absent / any other value ⇒
 *  today's SOFT pin (a cache-affinity preference that yields). Bees keep the soft pin unchanged; only
 *  bootstrap-su's resolveAccountPin sets this. Stripped before the upstream forward. */
export const ACCOUNT_PIN_HEADER = 'x-papercusp-account-pin';
/** Response header naming the pool account the gateway ACTUALLY routed a request to. Lets the
 *  caller (psu launcher / bootstrap-su / tests / operator) detect a silent fallback off a pinned
 *  account — e.g. the pin was ignored because the gateway's pool didn't contain it (the
 *  stale-`local`-pool fault), or it failed over off a paced/paused account. Not forwarded upstream
 *  (it's set on the response back to the client). */
export const ROUTED_ACCOUNT_HEADER = 'x-papercusp-routed-account';
/** Set when a SOFT-pinned request was served by a sibling because its pin was UNSERVICEABLE
 *  (gateway-rayobyte-hardening P-003): value `<pinnedId>-><servedId>`. Pair with
 *  ROUTED_ACCOUNT_HEADER — a pinned owner (or its statusline) can tell "my pin is capped/paused and I
 *  was failed over" apart from "my pin served me". Not forwarded upstream. */
export const PIN_YIELDED_HEADER = 'x-papercusp-pin-yielded';
/** WI-1073 last-resort opus→sonnet downgrade: set on the response back to the client when the gateway,
 *  facing a pool-wide HARD opus wall it could not route/wait around, rewrote the request model to
 *  sonnet so the call succeeds instead of hard-failing. Makes the silent-substitution VISIBLE to the
 *  caller + observable in the journal. Value: `opus->sonnet`. Not forwarded upstream. */
export const MODEL_DOWNGRADED_HEADER = 'x-papercusp-model-downgraded';
/** WI-10005833: set on the response back to the client when the gateway rewrote the request's
 *  `output_config.effort` because the model refuses that level (learned from an upstream 400 naming the
 *  supported levels). Makes the substitution visible to the caller. Value: `<from>-><to>`, e.g.
 *  `xhigh->max`. Not forwarded upstream. */
export const EFFORT_CLAMPED_HEADER = 'x-papercusp-effort-clamped';
/** Set on the response back to the client when the gateway's internal retry ladder for a 429/529
 *  (bounded transient-wait + absorb +, for opus, the last-resort downgrade) is fully EXHAUSTED and
 *  the terminal upstream status is being forwarded as the gateway's final answer. Value: the number
 *  of internal attempts made on this request. Pairs with a forced `x-should-retry: false` override
 *  on this same response — the raw upstream 429 often carries `x-should-retry: true` with no
 *  retry-after, and forwarding that unchanged invites a downstream SDK to honour it and retry a
 *  terminal, gateway-exhausted condition silently and indefinitely (EI-21921571654476580: 5 client
 *  retries over 2.5 minutes, no error ever surfaced — "Working..." forever). Not forwarded upstream. */
export const RETRIES_EXHAUSTED_HEADER = 'x-papercusp-retries-exhausted';
/** A terminal codex 429 names the POOL's recovery horizon — an ISO instant; `now` when a sibling can serve
 *  but THIS request could not use it (a hard pin, a spent absorb budget, a written head); `unknown` when
 *  no account has a known reset — so a caller can tell "the pool is walled for 3h" from "retry in a minute"
 *  without re-asking (plan codex-auto-route-all-walled-fail-fast-2026-09-05, P-003). */
export const POOL_RECOVERY_AT_HEADER = 'x-papercusp-pool-recovery-at';
/** Header a spawn sets carrying its coord ownerId (== spawnId), so the gateway can attribute a
 *  rate-limit shed back to THIS bee and a coordinator can wake it once the account recovers
 *  (gateway-rate-limit-stall-autowake P-001). Stripped before the upstream forward. */
export const OWNER_HEADER = 'x-papercusp-owner';
/** Reserved durable owner-route value: explicitly ignore a session's static account header and let
 * the gateway select/fail over per request. Distinct from clearing the owner route, which restores
 * the launch-time header. `auto` is already reserved by every launcher account-routing contract. */
export const OWNER_AUTO_ACCOUNT_ROUTE = 'auto';
/** AUTO-ROUTE SESSION AFFINITY (WI-2140943, 2026-09-02). Anthropic's prompt cache is scoped PER
 *  ACCOUNT, and an UNPINNED (`--account=auto`) request used to be routed by per-request round-robin —
 *  so a session's consecutive turns landed on different accounts and RE-CREATED its whole prefix cache
 *  (billed 1.25× input) instead of READING it (0.1×). Measured 2026-09-02 on a 7-account pool: ~88% of
 *  input spend was cache CREATE, per-account hit rates 0.45–0.65 where a warm session reads >0.9.
 *  Fix: an unpinned request whose caller is identifiable (x-papercusp-owner, else the Claude CLI's
 *  per-session metadata.user_id) is treated as SOFT-pinned to the account that last served that caller
 *  (within this TTL) — the existing soft-pin failover still yields the moment that account is
 *  UNSERVICEABLE, and a caller with no prior route still gets the least-loaded health pick.
 *  Kill-switch PAPERCUSP_GATEWAY_AUTO_AFFINITY=0 restores per-request round-robin. */
export const AUTO_AFFINITY_ENABLED = process.env.PAPERCUSP_GATEWAY_AUTO_AFFINITY !== '0';
export const AUTO_AFFINITY_TTL_MS = Number(process.env.PAPERCUSP_GATEWAY_AUTO_AFFINITY_TTL_MS) || 60 * 60 * 1000;
/** Affinity key for an unpinned request: the coord owner id when the caller sent one, else the Claude
 *  CLI's `metadata.user_id` — accepted ONLY when it visibly carries a per-SESSION component, so a
 *  per-user-only id can never collapse every headerless session onto one account. Pure; exported for tests. */
export function autoAffinityKey(ownerId: string | undefined, metaUserId: unknown): string | undefined {
  if (ownerId) return ownerId;
  if (
    typeof metaUserId === 'string' &&
    metaUserId.length > 0 &&
    metaUserId.length <= 512 &&
    /session/i.test(metaUserId)
  ) {
    return `meta:${metaUserId}`;
  }
  return undefined;
}

/** The Claude CLI's NATIVE session id, read from the request body's `metadata.user_id` — a JSON string
 *  `{"device_id":…,"account_uuid":…,"session_id":"<uuid>"}` (CC 2.1.x; a legacy `…_session_<uuid>`
 *  suffix form is also accepted). It is the transcript's own id, so a per-owner reading recorded under
 *  it can be BOUND to one native session by the compaction watchdog: a carry-respawn successor (same
 *  owner, new native id) never inherits its dead predecessor's usage or window (WI-2140943 lane 2). */
export function nativeSessionIdFromMetaUserId(metaUserId: unknown): string | null {
  if (typeof metaUserId !== 'string' || !metaUserId || metaUserId.length > 2048) return null;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (metaUserId.startsWith('{')) {
    try {
      const j = JSON.parse(metaUserId) as { session_id?: unknown };
      return typeof j.session_id === 'string' && UUID.test(j.session_id) ? j.session_id.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  const m = /_session_([0-9a-f-]{36})$/i.exec(metaUserId);
  return m && UUID.test(m[1]) ? m[1].toLowerCase() : null;
}

/** Does an `anthropic-beta` header value already carry the 1M-context beta? The Claude CLI resolves
 *  `model[1m]` client-side into exactly this header, so it — not the body marker — is what says
 *  whether the forwarded request is served at 1M. */
export function hasContext1mBeta(betaHeader: string | null | undefined): boolean {
  if (!betaHeader) return false;
  return betaHeader
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .some((s) => s === CLAUDE_CONTEXT_1M_BETA || s.startsWith('context-1m'));
}

/** Models the gateway will RESTORE the 1M-context beta onto: the `[1m]`-alias targets (the CLI's own
 *  `opus[1m]`/`sonnet[1m]`/`fable[1m]` resolve to exactly these ids) plus any dated id of those families
 *  the caller itself was already served at 1M. Deliberately NOT haiku and NOT the sonnet-4.x last-resort
 *  downgrade target — a beta the model rejects is a 400, no better than the overflow it would prevent. */
export function supportsContext1m(model: string, priorContext1mModel?: string | null): boolean {
  if (priorContext1mModel && model === priorContext1mModel) return true;
  return Object.values(ONE_MILLION_MODEL_ALIASES).includes(model) || isDefaultContext1mModel(model);
}

/** WI-10006049: API model ids of the Claude families papercusp serves at 1M BY DEFAULT —
 *  generation-5+ opus, sonnet and fable (the API-id side of agent-config-constants
 *  DEFAULT_1M_FAMILY_RE, which covers launch SPECS like `opus`/`sonnet-5`). Measured against the
 *  2.1.289 CLI: its 1M aliases are exactly opus/sonnet/fable/opusplan `[1m]`, and their API ids
 *  are dated point releases (`claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5-5`) that the
 *  ONE_MILLION_MODEL_ALIASES table (the bare `-5` ids) does not list. Deliberately NOT haiku and NOT
 *  the 4.x generations: a 1M beta the model rejects is a 400. */
export function isDefaultContext1mModel(model: string | null | undefined): boolean {
  return /^claude-(?:opus|sonnet|fable)-(?:[5-9]|[1-9]\d+)(?:[-.][0-9a-z.-]*)?$/i.test(String(model ?? '').trim());
}

/** WI-10006049 (owner Avi 2026-10-05 #1369/#1371: "if the default is 1m that sounds good" ·
 *  "make sure this works for all claude models too not just opus"): a papercusp-managed caller
 *  (it carries the owner header) asking for a 1M-capable family WITHOUT the 1M beta is served at
 *  1M anyway. This is what makes the default survive Claude Code's bare `/model` menu: on 2.1.289
 *  the menu saves the 200k `opus`/`sonnet`/`fable` pick and the CLI then sends no beta, which
 *  re-seeded sessions at a 158k limit below their own ~130-165k fixed prompt (a respawn storm).
 *  Below 200k input tokens the beta changes nothing about price or limits; above it, it is the
 *  difference between a served request and "Prompt is too long". Un-owned callers are untouched.
 *  Pure; the request handler applies it. */
export function shouldDefaultContext1m(args: {
  owner: string | null | undefined;
  url: string;
  model: string;
  context1m: boolean;
  clientHas1m: boolean;
}): boolean {
  if (!args.owner || args.context1m || args.clientHas1m) return false;
  if (!args.url.startsWith('/v1/messages')) return false;
  return isDefaultContext1mModel(args.model);
}

/** Below this many (bytes/4-estimated) input tokens a 200k window is not in danger, so a caller that
 *  dropped its `[1m]` marker on purpose (its own rate-limit fallback) is left alone. Above it the drop
 *  is lethal — measured 2026-09-02 (da701a71): the CLI fell from `claude-fable-5-1[1m]` to a bare
 *  `claude-opus-5` after one gateway 429 while holding 248,703 real tokens, and every later turn died
 *  ("does not support effort level 'xhigh'" on the sonnet downgrade, then "Prompt is too long"). The
 *  estimate under-reads real usage by ~28% on code-heavy bodies (720KB ⇒ 180k est vs 248,703 real), so
 *  the floor sits well under 200k. */
export const CONTEXT_1M_STICKY_MIN_EST_TOKENS =
  Number(process.env.PAPERCUSP_GATEWAY_CONTEXT_1M_STICKY_MIN_EST) || 120_000;

/** STICKY 1M WINDOW (WI-2140943 lane 2). A caller whose recent requests were served at 1M, now sending
 *  the same family WITHOUT the marker while carrying a body too large for 200k, gets the beta restored:
 *  the alternative is a certain "Prompt is too long" that kills the session outright, whereas a 1M
 *  request that the account cannot serve right now is a 429 the CLI retries. Pure; the caller applies. */
export function shouldRestoreContext1m(
  prior: { model: string; context1m: boolean; at: number } | undefined,
  model: string,
  estInTok: number,
  nowMs: number,
  opts: { ttlMs?: number; minEstTokens?: number } = {},
): boolean {
  if (!prior?.context1m) return false;
  if (nowMs - prior.at > (opts.ttlMs ?? AUTO_AFFINITY_TTL_MS)) return false;
  if (estInTok < (opts.minEstTokens ?? CONTEXT_1M_STICKY_MIN_EST_TOKENS)) return false;
  return supportsContext1m(model, prior.model);
}
const ANTHROPIC_VERSION = '2023-06-01';

/** The request's effective priority label: the explicit `x-papercusp-priority` header when present,
 *  otherwise INFERRED from the `x-papercusp-owner` id prefix (`su-…` → `su`, `s-…` → `bee`). Guards the
 *  tier-5 starvation trap (2026-07-01): the interactive PSU pin path spawned sessions with an owner header
 *  but NO priority header, so every pinned session fell to the `default` band (tier 5, cap 1) and the
 *  whole fleet's first turns serialized one-at-a-time. An owner-bearing session is by construction a
 *  coordinated fleet role, never anonymous batch — so infer its band instead of crawling. Requests with
 *  NEITHER header keep the default band. */
export function effectivePriorityLabel(headers: Record<string, unknown>): string | undefined {
  const explicit = (headers[PRIORITY_HEADER] as string | undefined)?.trim().toLowerCase();
  if (explicit) return explicit;
  const owner = (headers[OWNER_HEADER] as string | undefined)?.trim().toLowerCase();
  if (!owner) return undefined;
  if (owner.startsWith('su-')) return 'su';
  if (owner.startsWith('s-')) return 'cup';
  return undefined;
}

/** WI-1073: the fleet-canonical SONNET api id the gateway substitutes for a walled OPUS request as a
 *  last resort. `claude-sonnet-4-6` is the sonnet id used fleet-wide (omp-integration, gym, pr-host,
 *  scout, replay), so it is a known-valid dated id the gateway can forward verbatim (a bare alias like
 *  `claude-sonnet-4` 404s upstream). */
const LAST_RESORT_SONNET_MODEL = 'claude-sonnet-4-6';

type AcceptedClaudeModelPolicy = Extract<ActiveOperationModelPolicyRead, { status: 'bound' }>['policy'];
const MODEL_EFFORT_SUFFIX = /:(low|medium|high|xhigh|max|ultra)$/i;

/** The gateway must check the requested model before the first upstream send as
 * well as before a retry substitutes another model. Pricing normalization alone
 * drops provider and effort, so compare those separately. */
function acceptedClaudeModelAllows(policy: AcceptedClaudeModelPolicy, requested: string): boolean {
  const provider = (value: string) => value.includes('/')
    ? value.slice(0, value.indexOf('/')).toLowerCase() : 'anthropic';
  if (provider(requested) !== 'anthropic') return false;
  const requestedEffort = MODEL_EFFORT_SUFFIX.exec(requested)?.[1]?.toLowerCase();
  if (policy.effort && requestedEffort && policy.effort.toLowerCase() !== requestedEffort) return false;
  return policy.models.some((entry) => {
    const upstream = acceptedClaudeUpstreamModel(entry);
    if (!upstream || normalizeModelId(upstream.model) !== normalizeModelId(requested)) return false;
    const listedEffort = MODEL_EFFORT_SUFFIX.exec(entry)?.[1]?.toLowerCase();
    return (!listedEffort || !requestedEffort || listedEffort === requestedEffort) &&
      (!policy.effort || !listedEffort || listedEffort === policy.effort.toLowerCase());
  });
}

/** Compare Codex policy entries at the provider API model boundary. The
 * request's reasoning.effort is a separate field; a suffix on a policy entry
 * still constrains it. */
function acceptedCodexModelAllows(
  policy: AcceptedClaudeModelPolicy,
  model: string,
  effort: string | null,
): boolean {
  const provider = (value: string) => value.includes('/') ? value.slice(0, value.indexOf('/')).toLowerCase() : 'openai';
  if (!['openai', 'openai-codex'].includes(provider(model))) return false;
  const canonical = (value: string) => normalizeModelId(resolveCodexModel(value.replace(MODEL_EFFORT_SUFFIX, '')));
  return policy.models.some((entry) => {
    if (!['openai', 'openai-codex'].includes(provider(entry)) || canonical(entry) !== canonical(model)) return false;
    const listedEffort = MODEL_EFFORT_SUFFIX.exec(entry)?.[1]?.toLowerCase();
    return (!listedEffort || listedEffort === effort) && (!policy.effort || policy.effort.toLowerCase() === effort);
  });
}

function forwardedClaudeEffort(bodyBuf: Buffer): string | null {
  return readRequestEffort(bodyBuf);
}

/** Convert only an accepted Anthropic policy entry to an upstream API id.
 * A provider prefix and CLI effort are launch metadata; the 1M marker is a
 * separate window used by the capacity selector. */
function acceptedClaudeUpstreamModel(entry: string): GatewayModelResolution | null {
  const slash = entry.indexOf('/');
  if (slash >= 0 && entry.slice(0, slash).toLowerCase() !== 'anthropic') return null;
  const bare = (slash >= 0 ? entry.slice(slash + 1) : entry).replace(MODEL_EFFORT_SUFFIX, '');
  const resolved = resolveGatewayModel(bare);
  return /^claude-[a-z0-9-]+$/i.test(resolved.model) ? resolved : null;
}

/** WI-1073: rewrite the `model` field of a buffered `/v1/messages` request body to `newModel`, returning
 *  the re-serialized body — or `null` when the body isn't JSON with a string `model` (⇒ the caller leaves
 *  the request unchanged and forwards the original failure, byte-identical to today). Pure. */
export function rewriteRequestModel(bodyBuf: Buffer, newModel: string): Buffer | null {
  if (!bodyBuf.length) return null;
  try {
    const j = JSON.parse(bodyBuf.toString('utf8')) as { model?: unknown };
    if (typeof j.model !== 'string') return null;
    j.model = newModel;
    return Buffer.from(JSON.stringify(j), 'utf8');
  } catch {
    return null;
  }
}

/** Claude CLI's `[1m]` marker is a client-side window selector, not an Anthropic API model id. */
const ONE_MILLION_MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  fable: 'claude-fable-5',
};

export interface GatewayModelResolution {
  model: string;
  context1m: boolean;
}

/** Reasoning-effort ladder a fallback-lineup Codex model advertises (standard = low..xhigh, max adds max, ultra adds ultra). */
export type CodexFallbackReasoningTier = 'standard' | 'max' | 'ultra';

export interface CodexFallbackLineupEntry {
  slug: string;
  displayName: string;
  description: string;
  priority: number;
  /** Advertised context window; absent = 272,000. */
  contextWindow?: number;
  /** Advertised max window; absent = `contextWindow` (a real "no extended window" state). */
  maxContextWindow?: number;
  /** Absent = 'standard'. */
  reasoning?: CodexFallbackReasoningTier;
}

/**
 * The Codex model lineup the gateway advertises on `GET /v1/models` when no live
 * account catalog is available (`codexModelsResponse`). Data only: the response
 * builder maps each row through its `model()` shape. Windows mirror the upstream
 * registry (see that builder's note); keep them in sync alongside the lineup.
 *
 * Exported so `configured-models-priced.test.ts` derives its population from it
 * (WI-10004506): every model the gateway offers must have a usage price, or
 * llm-client's Codex path refuses it at call time (the WI-10004502 Scout outage).
 */
export const CODEX_GATEWAY_FALLBACK_LINEUP: readonly CodexFallbackLineupEntry[] = [
  {
    slug: 'gpt-6.1-sol',
    displayName: 'GPT-6.1-Sol',
    description: 'Latest Sol workhorse for coding and everyday tasks.',
    priority: 17,
    contextWindow: 272_000,
    maxContextWindow: 1_000_000,
    reasoning: 'max',
  },
  {
    slug: 'gpt-6-astra',
    displayName: 'GPT-6-Astra',
    description: 'Our most capable model for complex, demanding work.',
    priority: 16,
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    reasoning: 'ultra',
  },
  {
    slug: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'Reliable agentic workhorse for everyday tasks.',
    priority: 15,
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    reasoning: 'ultra',
  },
  {
    slug: 'gpt-6-sol',
    displayName: 'GPT-6-Sol',
    description: 'GPT-6 Sol Codex model.',
    priority: 15,
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    reasoning: 'ultra',
  },
  {
    slug: 'gpt-6-luna',
    displayName: 'GPT-6-Luna',
    description: 'GPT-6 Luna Codex model.',
    priority: 14,
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    reasoning: 'max',
  },
  {
    slug: 'gpt-5.6-terra',
    displayName: 'GPT-5.6-Terra',
    description: 'Balanced agentic coding model for everyday work.',
    priority: 14,
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    reasoning: 'ultra',
  },
  {
    slug: 'gpt-5.6-luna',
    displayName: 'GPT-5.6-Luna',
    description: 'Fast and affordable agentic coding model.',
    priority: 13,
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    reasoning: 'max',
  },
  {
    slug: 'gpt-5.5',
    displayName: 'GPT-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
    priority: 12,
  },
  {
    slug: 'gpt-5.4',
    displayName: 'GPT-5.4',
    description: 'Strong model for everyday coding.',
    priority: 11,
    contextWindow: 272_000,
    maxContextWindow: 1_000_000,
  },
  {
    slug: 'gpt-5.4-mini',
    displayName: 'GPT-5.4-Mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
    priority: 10,
  },
];

/** Resolve a CLI model marker to the real upstream model id and its beta requirement. */
export function resolveGatewayModel(model: string): GatewayModelResolution {
  if (!/\[1m\]/i.test(model)) return { model, context1m: false };
  // The marker is inserted before an optional CLI effort suffix (e.g. opus[1m]:high).
  const unmarked = model.replace(/\[1m\]/gi, '').replace(/:(?:low|medium|high|xhigh|max)$/i, '');
  return {
    model: ONE_MILLION_MODEL_ALIASES[unmarked.toLowerCase()] ?? unmarked,
    context1m: true,
  };
}

/** Normalize a buffered Anthropic request once, before admission and upstream forwarding. */
export function normalizeGatewayRequestBody(bodyBuf: Buffer): {
  body: Buffer;
  model: string | null;
  context1m: boolean;
} {
  if (!bodyBuf.length) return { body: bodyBuf, model: null, context1m: false };
  try {
    const body = JSON.parse(bodyBuf.toString('utf8')) as { model?: unknown } & Record<string, unknown>;
    if (typeof body.model !== 'string') return { body: bodyBuf, model: null, context1m: false };
    const resolved = resolveGatewayModel(body.model);
    if (resolved.model === body.model) return { body: bodyBuf, model: resolved.model, context1m: resolved.context1m };
    body.model = resolved.model;
    return { body: Buffer.from(JSON.stringify(body), 'utf8'), model: resolved.model, context1m: resolved.context1m };
  } catch {
    return { body: bodyBuf, model: null, context1m: false };
  }
}
/** Prompt-cache policy kill-switches (gateway-cache-plane-shared-prefix-ttl-2026-07-19 D-002).
 *  Read per-request so a flip takes effect on the next request, not the next restart. */
const cachePolicyOn = () => process.env.PAPERCUSP_CACHE_POLICY !== '0';
// OPT-IN: measured a no-op 2026-07-19 (identical read/write with and without) and it caused
// EI-16980. Enable only with P-004 + a measured read-delta.
const cacheToolsBreakpointOn = () => process.env.PAPERCUSP_CACHE_TOOLS_BREAKPOINT === '1';
/**
 * P-002 (agent-launch-context-cost-2026-09-18): mark oversized tool schemas `defer_loading` and
 * inject the BM25 tool-search tool so they stay reachable.
 *
 * ON BY DEFAULT since 2026-09-18 (D-016). It shipped OPT-IN "until a both-arms live A/B has run
 * (P-003)". That A/B ran and is recorded in D-002: three live psu arms, identical launch command,
 * varying only the cache-proxy — control 169,167, 8000 B threshold 163,508 (−3.3%), and the
 * MEASURED 1200 B threshold 115,273 (−31.9%), which is below this plan's ~120,000 target. The
 * mechanism is directly evidenced by a per-request proxy log line (`deferred 45 tool(s), 142012 B
 * + injected tool_search_tool_bm25`), not inferred from a token delta.
 *
 * WHY THE DEFAULT FLIPPED RATHER THAN WAITING LONGER: this repo's flag policy treats finished,
 * measured, reversible work left default-OFF as UNFINISHED. D-002 ended "P-002's code is landed
 * and inert" — and inert is exactly what it stayed while the +134k launch regression (the
 * ToolSearch deny turning native schema deferral off, commit 0091eb05) went on costing every
 * session. The same finding was re-derived four times across three epochs without the fix ever
 * reaching a live agent.
 *
 * SCOPED, per D-002 Ruling 4: what is proven is FUNCTIONAL reachability — a deferred tool is
 * still callable because `tools:invoke` dispatches server-side and needs no schema at all. The
 * native schema-MATERIALIZATION path through `tool_search_tool_bm25` remains UNPROVEN and is
 * explicitly accepted as unused here: papercusp agents discover via `tools:find` and call via
 * `tools:invoke`, both of which transit `applyResultDoor`'s ~1,500-token cap. That is precisely
 * the property native `ToolSearch` lacked (one call, +67,045 tokens, ~45x the cap) and why it is
 * denied at launch.
 *
 * KILL SWITCH: PAPERCUSP_GATEWAY_DEFER_LARGE_TOOLS=0 restores the pre-2026-09-18 passthrough.
 * This gateway is on the inference path of EVERY session, and the sibling knob above is opt-in
 * precisely because shipping a tools-array rewrite on a passing unit test alone produced
 * EI-16980. Those three rails — never pair `defer_loading` with `cache_control`, never defer
 * every tool, keep the search tool itself non-deferred — are enforced in cache-policy.ts and
 * mutation-proven (ledger row 18385266).
 */
/** P-009(d): delegates to cache-policy's single read site, shared with the cache-proxy forward
 *  point, so the two planes cannot disagree about the kill switch by construction. */
const cacheDeferLargeToolsOn = () => deferLargeToolsEnabled();
/** Serialized-byte threshold above which a tool is deferred. Default see DEFAULT_DEFER_MIN_TOOL_BYTES.
 *  Same single-read-site rule as above (P-009(d)). */
const cacheDeferMinToolBytes = () => deferMinToolBytesFromEnv();
/** P-004 stable/volatile system split — ON by default (measured +66k shared tokens/session);
 *  PAPERCUSP_CACHE_SPLIT_BOUNDARY=0 kills it. */
const cacheSplitBoundaryOn = () => process.env.PAPERCUSP_CACHE_SPLIT_BOUNDARY !== '0';
/** How many `prompt_cache_key` buckets the codex traffic is spread across. OpenAI degrades a
 *  single key past ~15 req/min; fewer buckets = more cross-session sharing. */
const codexCacheShards = () => {
  const n = Number(process.env.PAPERCUSP_CACHE_CODEX_SHARDS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
};

/** Hop-by-hop + body-framing headers never copied verbatim across the proxy. */
const STRIP_REQUEST = new Set([
  'host',
  'authorization',
  'x-api-key',
  'x-papercusp-account',
  'x-papercusp-account-pin',
  'x-papercusp-owner',
  REQUIRE_OUTPUT_TOKEN_LIMIT_HEADER,
  'content-length',
  'accept-encoding',
  'connection',
  'transfer-encoding',
  'keep-alive',
]);
const STRIP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

/** Trusted controller input for one actual, fully shaped Codex HTTP attempt.
 * Account labels and client metadata alone are not serving-scope authentication.
 * The controller must verify the bound credential/scope, source and native bounds,
 * then atomically reserve the complete remaining D017 budget before returning.
 * Body text is private validation input: never copy it into telemetry or receipts.
 */
export interface GatewayCarryTrialAttempt {
  readonly attemptId: string;
  readonly manifestSha256: string;
  readonly armId: string;
  readonly transport: 'oauth-http' | 'bearer-http' | 'anthropic-http';
  readonly accountId: string;
  readonly credentialHeader: 'authorization' | 'x-api-key';
  readonly credentialSha256: string;
  readonly target: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly clockId: string;
  readonly signal: AbortSignal;
}

export interface GatewayCarryTrialBinding {
  readonly manifestSha256: string;
  readonly armId: string;
  /** Explicit host-owned inference protocols. Omission retains the original
   * OpenAI-only binding; an Anthropic arm cannot use unobserved alternate routes. */
  readonly protocols?: readonly ('openai-responses' | 'anthropic-messages')[];
  /** SHA256 of a controller-issued high-entropy Bearer token for THIS arm.
   * This is a dedicated gateway binding, not a caller-selected owner/arm header. */
  readonly requestTokenSha256: string;
  readonly authorizeAttempt: (attempt: GatewayCarryTrialAttempt) => Promise<{
    readonly attemptId: string;
    readonly reservationRef: string;
    readonly clockId: string;
    readonly validUntilMonotonicMs: number;
  } | null>;
}

export type GatewayGoalBudgetDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly status: 403 | 503;
      readonly code: string;
      readonly message: string;
    };

class GoalInferenceAdmissionRefusal extends Error {
  constructor(
    readonly status: 403 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GoalInferenceAdmissionRefusal';
  }
}

function respondGoalInferenceAdmissionRefusal(
  error: unknown,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  writeJson: (
    response: http.ServerResponse,
    status: number,
    body: unknown,
    extra?: Record<string, string>,
  ) => void,
): boolean {
  if (!(error instanceof GoalInferenceAdmissionRefusal)) return false;
  req.resume();
  const retryable = error.status === 503;
  if (!res.headersSent) {
    writeJson(
      res,
      error.status,
      {
        type: 'error',
        error: {
          type: retryable ? 'overloaded_error' : 'permission_error',
          code: error.code,
          message: error.message,
        },
        gateway: true,
      },
      retryable
        ? { 'retry-after': String(LOADSHED_RETRY_AFTER_SEC), 'x-should-retry': 'true' }
        : { 'x-should-retry': 'false' },
    );
  } else if (!res.destroyed) {
    res.destroy();
  }
  return true;
}

export interface GatewayDeps {
  /** Dedicated bounded-trial gateway only. No production grant issuer is implied.
   * When bound, every request is authenticated and only Codex HTTP Responses
   * inference is allowed. Reservations are never implicitly refunded on failure.
   * The controller owns durable CAS, charge settlement and R4/R5 approval checks. */
  carryTrial?: GatewayCarryTrialBinding;
  /** Server-side accepted-operation policy read at a model substitution boundary.
   * A failed read is an explicit unavailable verdict, never permission to downgrade. */
  readAcceptedOperationModelPolicy?: (
    ownerId: string, backend?: 'claude' | 'codex',
  ) => Promise<ActiveOperationModelPolicyRead>;
  /** Persist provider-observed evidence before a bound worker sees a successful response. */
  recordAcceptedOperationModelAttestation?: (
    context: ActiveOperationAttestationContext,
    evidence: DirectOperationModelAttestation,
  ) => Promise<void>;
  /**
   * Canonical resource-governor seam for gateway request starts.  The default
   * uses the admit-immediately compatibility driver while the durable queue
   * migration is staged; the existing provider queues remain the execution
   * authority until those later items land.
   */
  admissionGovernor?: GatewayAdmissionGovernor;
  /** Optional parent lineage when the gateway is itself running under a governed request. */
  admissionParent?: AdmissionContext | null;
  /** Per-turn goal budget check; runs before body spool and durable admission. */
  checkGoalInferenceAdmission?: (ownerId: string) => Promise<GatewayGoalBudgetDecision>;
  /** Single-account fallback: a fresh bearer for the bound account (the resolver's `current`).
   *  Superseded by `pool` when present. */
  token?(): Promise<string>;
  /** Drop the cached token (called on an upstream 401). */
  invalidateToken?(): void;
  /** Single-account fallback: bound account id — scopes the governor bucket + pool attribution.
   *  Superseded by `pool` when present. */
  accountId?: string;
  /** Multi-account failover pool (EI-535). When present, supersedes accountId/token/invalidateToken:
   *  the gateway reads the active account per request + fails over on 5h exhaustion. */
  pool?: AccountPool;
  /** Codex/OpenAI-compatible account pool. When present, non-Anthropic `/v1/*` routes
   *  (for example `/v1/responses`) are forwarded through this pool with bearer injection. */
  codexPool?: AccountPool;
  /** ChatGPT-SUBSCRIPTION codex accounts (credentialRef `codex-cli:<CODEX_HOME>`) served by
   *  DRIVING the codex CLI instead of HTTP-with-a-bearer (codex-cli-bridge.ts). A getter so the
   *  launch layer's account hot-reload applies without a gateway restart. Selection: an explicit
   *  `x-papercusp-account` pin to one of these ids, or the FALLBACK when no bearer pool exists /
   *  the bearer pool has no available account. */
  codexCliAccounts?: () => CodexCliAccount[];
  /** Routing/health twin of `codexCliAccounts`. The entries carry the same account ids and egress
   *  bindings, but no credential material; the OAuth proxy resolves credentials from each account's
   *  CODEX_HOME only after selection. Keeping subscription accounts in a real AccountPool gives them
   *  the same round-robin, pin, exhaustion, readmit, and hot-reload semantics as bearer accounts. */
  codexCliPool?: AccountPool;
  /** Test seam: the codex-CLI completion runner (default runCodexCliCompletion). */
  codexCliRun?: (opts: CodexCliRunOpts) => Promise<CodexCliRunResult>;
  /** Read a configured CLI account's native models cache. The default reads
   *  `<CODEX_HOME>/models_cache.json`; injected in tests to keep fixtures local. */
  codexModelsCacheRead?: (home: string) => unknown;
  /** Fresh account-catalog cache lifetime. Zero disables freshness reuse while retaining
   *  in-flight coalescing + the last-known-good failure fallback (test seam). */
  codexModelsCatalogTtlMs?: number;
  /** Whole OAuth-refresh + account-catalog lookup deadline (test seam). */
  codexModelsCatalogTimeoutMs?: number;
  /** codex-gateway-oauth-proxy-2026-07-04 (WI-2198): when true, a codex-cli account serves a
   *  STREAMING /v1/responses by OAuth-reverse-proxying to the ChatGPT backend (codex-oauth-proxy.ts)
   *  instead of the one-shot exec bridge. Flag-resolved at the launch layer; default false. */
  codexOAuthProxy?: boolean;
  /** Non-streaming leg of the ChatGPT OAuth reverse-proxy. Defaults ON; set false (or
   * `PAPERCUSP_GATEWAY_CODEX_OAUTH_NONSTREAM=0`) to retain the one-shot CLI bridge fallback. */
  codexOAuthNonStream?: boolean;
  /** Maximum upstream bytes retained while aggregating a ChatGPT OAuth non-stream response. */
  codexOAuthNonStreamMaxBytes?: number;
  /** Maximum aggregation wall time; additionally capped by requestCeilingMs. */
  codexOAuthNonStreamTimeoutMs?: number;
  /** Upstream base URL. Default `https://api.anthropic.com`; a fake in tests. */
  upstreamBase?: string;
  /** OpenAI-compatible upstream base URL. Default `https://api.openai.com`. */
  openaiUpstreamBase?: string;
  /** `fetch` impl (injected in tests). Default global fetch. */
  fetchImpl?: typeof fetch;
  /** PROACTIVE egress probe cadence (ms) — gateway-rayobyte-hardening P-002. Every tick, each pool
   *  account with a PROXY egress that hasn't proven itself with real traffic recently is probed through
   *  its dispatcher; 2 consecutive probe failures open its egress circuit BEFORE live requests burn on
   *  it (the reactive circuit needs 2 live-request failures first). 0 disables. Default
   *  `PAPERCUSP_GATEWAY_PROACTIVE_PROBE_MS` or 45s. */
  proactiveEgressProbeMs?: number;
  /** Probe impl (injected in tests). Default `probeEgress` (egress-probe.ts). Used by BOTH the
   *  half-open recovery probe and the proactive prober. */
  probeEgressImpl?: typeof probeEgress;
  /** The governor for a model (default: the shared per-account `claude-code` governor).
   *
   *  ⚠ `accountId` is part of the contract, not decoration (EI-2648). The DEFAULT
   *  (`governorForBackend`) keys its governor by account, so a penalty on one account
   *  persists for that account and does NOT pause its siblings. An injected factory that
   *  ignores `accountId` collapses every account onto one governor — or, if it returns a
   *  fresh instance per call, discards penalties entirely, so an account is never actually
   *  paused and any "waits out a penalty" behaviour silently degrades to "retries and
   *  happens to succeed". This parameter was previously not passed at all, which made a
   *  faithful per-account test double IMPOSSIBLE to write and left the EXTENDED ABSORB
   *  wait-out path under-covered. Cache by `accountId` to mirror production. */
  governorFor?(model: string, accountId: string): RateLimitGovernor;
  /** Max admission wait before a synthetic 429+retry-after. Default 2 min. */
  maxQueueWaitMs?: number;
  /* RETIRED by P-010: there is no Codex-specific admission size. Both provider
   * lanes start from the shared `concurrency` seed and are sized thereafter by the
   * one capless ProviderAdmissionLifecycle, from the outcomes each lane observes. */
  /** POST-admission extended-absorption budget (ms). >0 = on a slot-hold-deadline shed, release the slot +
   *  re-acquire + retry (no slot held during the wait → no wedge) instead of 429ing, up to this budget. 0 = OFF. */
  requestAbsorbMs?: number;
  /** Cap on the extended-absorb budget for a HUMAN-facing caller (priority `interactive`/`operator`) so a
   *  person fails fast with a clear retry-after instead of the long autonomous hold. Default
   *  `INTERACTIVE_ABSORB_MS` (env `PAPERCUSP_GATEWAY_INTERACTIVE_ABSORB_MS`, 8s); 0 disables the cap. */
  interactiveAbsorbMs?: number;
  /** Wall-clock ceiling on internal retrying before a request sheds + frees its slot (wedge-prevention
   *  ladder). Default 60s (`INTERNAL_RETRY_DEADLINE_MS`); tests inject a tiny value to exercise the shed. */
  internalRetryDeadlineMs?: number;
  /** Short bare-429 account pause. Production uses 15s; deterministic rigs inject a smaller value so
   *  retry-amplification tests don't spend real wall-clock time waiting out the production penalty. */
  bare429FailoverBackoffMs?: number;
  /** B-HOT-2: live pool config (version + account ids) for `GET /admin/config`. Absent ⇒ the endpoint
   *  reports `hotReload:false`. */
  adminConfig?: () => { version: number; accounts: string[] };
  /** B-HOT-2: hot-reload the account pool from the DB source-of-truth for `POST /admin/reload` (the
   *  on-demand twin of the launch-layer poll). Absent ⇒ `/admin/reload` returns 503 (not hot-reloadable). */
  onAdminReload?: () => Promise<{ changed: boolean; version: number; accounts: string[] }>;
  /** Concurrency authority — max requests forwarded at once (the queue cap). Default 24. */
  concurrency?: number;
  /** Max requests allowed to WAIT for a slot before the gateway sheds load (429 + retry-after) instead
   *  of growing an unbounded backlog. Prevents the slot-squat-under-sustained-throttle wedge. Default 256.
   *  NOTE (D-003): once `payloadSpool` is configured this is no longer the primary backpressure — an
   *  accepted request becomes a durable receipt instead of a 429. The cap remains as the
   *  persistence-unavailable fallback, which is the one failure D-003 still permits. */
  maxQueued?: number;
  /** PRE-ACCEPTANCE request-body spool (capless-inference-gateway-2026-08-28 D-004/D-011).
   *  When present, a body-bearing proxy request is persisted to a content-addressed blob BEFORE the
   *  admission decision, and its `payloadRef` is the sha256 of that body — so queue depth stops
   *  scaling resident memory and a durable receipt can own execution after the socket is gone.
   *  ABSENT ⇒ byte-identical legacy behaviour: the body stays unread in the socket until a handler
   *  asks for it. Deliberately injected rather than constructed here, for the same reason the durable
   *  admission driver is: a hermetic `startGatewayService` unit test must not acquire a Postgres
   *  dependency. `sidecar-main` supplies the Postgres-backed spool in production. */
  payloadSpool?: GatewayPayloadSpool;
  /** Aging interval for the priority queue (ms a waiter takes to gain +1 priority). Default 1000. */
  agingIntervalMs?: number;
  /** OPTIONAL priority-TIER admission layer (gateway-priority-tiers-2026-06-22, `GATEWAY_PRIORITY_TIERS`).
   *  Resolved + flag-gated by the launch layer: ABSENT ⇒ the gateway behaves byte-identically to today (a
   *  flat priority+aging gate). PRESENT ⇒ the queue gains per-tier in-flight caps + a reserved tier-1 floor,
   *  requests are tiered from the `x-papercusp-priority` role via `map`, and the AIMD shrink also sheds the
   *  bottom tier caps (4→3→2, holding tier 1). */
  priorityTiers?: {
    /** Role/label → tier map (`x-papercusp-priority` header value → admission band, 1 = highest). */
    map: PriorityTierMap;
    /** Steady-state per-tier caps + reserved tier-1 floor (the un-shed baseline). */
    config: TierAdmissionConfig;
  };
  /** OPTIONAL Codex/OpenAI-compatible priority-tier layer. When omitted, Codex keeps the
   *  legacy compatibility behavior of reusing `priorityTiers`; the launch layer supplies this
   *  separately so each lane's reserve/caps start from the shared admission seed. */
  codexPriorityTiers?: {
    /** Role/label → tier map for Codex requests. */
    map: PriorityTierMap;
    /** Codex-sized steady-state per-tier caps + reserved tier-1 floor. */
    config: TierAdmissionConfig;
  };
  /** MAINTENANCE summarize lane (deterministic-context-carry P-002): model / output-cap / deadline
   *  overrides for POST /maintenance/summarize. Defaults: `claude-haiku-4-5` (env
   *  PAPERCUSP_GATEWAY_MAINTENANCE_MODEL), 8192 tokens, 150s. Tests inject small values. */
  maintenanceModel?: string;
  maintenanceMaxTokens?: number;
  maintenanceTimeoutMs?: number;
  /** DETERMINISTIC MAINTENANCE CARRY (deterministic-context-carry P-017, WI-4845): when present,
   *  POST /maintenance/summarize?carryOwner=<coord ownerId>[&carryWs=<ws>][&carryWindow=<tokens>]
   *  tries this builder FIRST and returns its deterministic summary in place of the LLM oneshot;
   *  a miss (null / throw) falls through to the LLM lane so a carry fault can never strand a live
   *  compaction. Resolved + flag-gated at the launch layer (FLAGS.GATEWAY_MAINTENANCE_CARRY,
   *  default OFF): ABSENT ⇒ the carry query params are ignored — byte-identical to today. */
  maintenanceCarry?: (
    ownerId: string,
    opts: { effectiveWindowTokens?: number; workspaceId?: string },
  ) => Promise<{ summary: string; deterministic: true; budgetChars: number } | null>;
  /** P-019 RESIDUAL SAMPLER (deterministic-context-carry D-010 live leg 2): fire-and-forget
   *  observability hook called AFTER a deterministic carry summary is served, with both pass
   *  inputs (the served stage-1 doc + the raw prompt material the compaction drops) and the
   *  launcher-threaded ?carryInteractive bit. Never awaited, never affects the response.
   *  Resolved + flag-gated at the launch layer (FLAGS.RESIDUAL_CARRY_SAMPLER); ABSENT ⇒ no-op. */
  residualSampler?: (input: {
    carryOwner: string;
    stage1Doc: string;
    droppedContext: string;
    interactive: boolean;
    workspaceId?: string;
  }) => void;
  /** Max wait for upstream RESPONSE HEADERS before the request is aborted as stalled. A stalled
   *  upstream (Anthropic accepts the socket during an overload but never responds) used to hang the
   *  proxy task forever, leaking its admission slot until the pool deadlocked (the 2026-06-19 outage).
   *  Generous by default because NON-streaming headers arrive only after the full generation; streaming
   *  headers are near-instant. Default 5 min (env PAPERCUSP_GATEWAY_UPSTREAM_HEADERS_MS). */
  upstreamHeadersTimeoutMs?: number;
  /** Headers/TTFB deadline for STREAMING requests (`stream:true`) — their first byte arrives in seconds,
   *  so a much shorter wait recovers from an Anthropic-side stall fast instead of squatting the slot for
   *  the generous non-streaming deadline. Default 60s (env PAPERCUSP_GATEWAY_UPSTREAM_STREAM_HEADERS_MS). */
  upstreamStreamHeadersTimeoutMs?: number;
  /** Max GAP between upstream BODY bytes once a response is streaming, before it is aborted as stalled.
   *  Reset on every chunk, so a legitimately long stream is never clipped — only a true mid-stream
   *  stall trips it. Default 90s (env PAPERCUSP_GATEWAY_UPSTREAM_BODY_IDLE_MS). */
  upstreamBodyIdleTimeoutMs?: number;
  /** Max wait for an OAuth token refresh (`active.token()`) before the attempt fails instead of hanging.
   *  token() does a deadline-less network refresh and runs BEFORE the upstream stall-guard, so a stalled
   *  refresh used to pin every admission slot until a manual restart (the 2026-06-20 token-hang wedge).
   *  Default 20s (env PAPERCUSP_GATEWAY_TOKEN_MS). */
  tokenTimeoutMs?: number;
  /** Downstream-idle timeout (ms): a hung/half-open client that stops reading mid-response is torn down
   *  after this much socket inactivity so it can't pin the proxy task's admission slot (the 2026-06-20
   *  wedge #2). Default 2 min (env PAPERCUSP_GATEWAY_DOWNSTREAM_IDLE_MS). */
  downstreamIdleMs?: number;
  /** Hard per-request lifetime ceiling (ms) — the universal backstop: a request that somehow outlives all
   *  activity timers is force-terminated (upstream abort + socket destroy) so it can't pin a slot from an
   *  unknown hang. Default 20 min (env PAPERCUSP_GATEWAY_REQUEST_CEILING_MS). */
  requestCeilingMs?: number;
  /** AIMD admission-concurrency tuning (B-GW-1). The gateway shrinks the admission queue's effective
   *  maxConcurrent under sustained upstream 429s and additively recovers when calls succeed. The cap is
   *  `concurrency`; these override the floor + the trip thresholds. Omit for env/defaults (floor 4,
   *  halve at net-pressure 6, +1 per 8 clean). Set `floor` ≥ cap to effectively DISABLE AIMD. */
  aimd?: { floor?: number; decreaseFactor?: number; decreaseThreshold?: number; increaseEvery?: number };
  /** Smooth each per-account RPM allowance into an even inter-request pace (governor.smoothRpm) so the
   *  fleet can't fire a sub-minute BURST that trips Anthropic's burst limit (the bare-burst 429 storm,
   *  2026-06-23). Throughput-neutral (the per-minute count gate still caps the rate). Default = env
   *  `PAPERCUSP_GATEWAY_RPM_SMOOTH` (on unless '0'); the test harness passes `false` so rapid-fire unit
   *  tests under a tiny maxQueueWaitMs are byte-identical. */
  smoothRpm?: boolean;
  /** In-process self-heal release valve (EI-2086): pre-empt the external watchdog's full restart by
   *  aborting the oldest stuck slot when saturated + nothing has naturally drained for `freezeMs`. Omit
   *  for env/defaults (enabled, freeze 75s, poll 10s). `enabled:false` disables it (e.g. unit tests
   *  that don't want the timer). */
  selfHeal?: { enabled?: boolean; freezeMs?: number; pollMs?: number };
  log?(level: 'info' | 'warn' | 'error', msg: string): void;
  /** Fired with each upstream response's headers + status + the account that served it (pool
   *  projection / observability) — the gateway is the only process that sees the unified-budget
   *  headers, so this is how the cross-process drain projection (account utilization) is fed. */
  onResponse?(headers: Record<string, string | undefined>, status: number, model: string, accountId: string): void;
  /** CREDENTIAL-HEALTH alert side-channel (#5 PART A). Fired FIRE-AND-FORGET (never awaited, never
   *  throws into the request path) the FIRST time an account's credential 401s `credential401DeadThreshold`
   *  times IN A ROW *despite* the gateway's drop+refresh (`invalidateToken`) — i.e. the refresh keeps
   *  yielding the same invalid credential, so it's genuinely DEAD/expired, not merely stale-cached. The
   *  launch layer wires this to a LOUD escalation (severity 'blocker', meta.source 'credential-health',
   *  transition-only so it doesn't re-open every request) + a fleet broadcast. The streak resets on the
   *  next successful auth (a 2xx) for that account, which re-arms a fresh alert for a later episode. */
  onCredentialDead?(info: { accountId: string; consecutive401s: number }): void;
  /** Peer-uid gate for every connection (WI-10003621). The gateway binds 127.0.0.1 and has no
   *  caller auth, so on a hosted workspace host — where the customer account shares loopback —
   *  a non-service uid must be refused before any route (inference or `/admin/*`) runs. Returns
   *  the foreign verdict to refuse, null to proceed. Default `foreignLoopbackPeerForSocket`, a
   *  no-op unless the loopback peer-uid policy is active; tests inject a fake. */
  loopbackPeerGate?(socket: NetSocket): { uid: number | null; reason: string } | null;
  /** Consecutive-401 streak that marks a credential DEAD (vs stale-cached) → fires `onCredentialDead`.
   *  Default `DEFAULT_CREDENTIAL_401_DEAD_THRESHOLD` (3); tests inject a small value. ≤0 disables the alert. */
  credential401DeadThreshold?: number;
  /** ORG-DISALLOWED persistent deactivation. Fired FIRE-AND-FORGET the first time an account returns
   *  `orgDisallowedDeactivateThreshold` consecutive org/subscription-disqualified 403s ("not allowed for this
   *  organization" / "subscription disabled for claude code") — a PERMANENT Anthropic-side disable the 6h
   *  in-memory pause can't cure (it resets on every gateway restart, re-exposing the dead account — ownerhandle,
   *  2026-07-01). The launch layer wires this to PERSISTENTLY remove the account from the pool (survives
   *  restarts, never re-selected) + a loud escalation. The per-account streak resets on the next 2xx. */
  onOrgDisallowed?(info: { accountId: string; consecutive: number; affectedOwners?: string[] }): void;
  /** Consecutive org-disallowed 403s that trigger `onOrgDisallowed` deactivation. Default
   *  `DEFAULT_ORG_DISALLOWED_DEACTIVATE_THRESHOLD` (1 — fire on the first definitive hit). ≤0 disables. */
  orgDisallowedDeactivateThreshold?: number;
  /** LOCAL inference-backend pool (local-concurrent-inference-2026-07-02 P-004, D-002): when present,
   *  a POST to `/v1/chat/completions` or `/v1/completions` whose `model` matches a registered local
   *  backend (llama-server | vllm | ollama) is proxied DIRECTLY to that backend — least-loaded routing,
   *  no account/credential/governor involvement (local backends need none). Absent ⇒ those two routes
   *  fall through to the normal 404 (byte-identical to today). */
  localBackends?: LocalBackendPool;
  /** Per-attempt timeout for a local-backend proxy request. Default DEFAULT_LOCAL_BACKEND_TIMEOUT_MS (5m). */
  localBackendTimeoutMs?: number;
  /** HOT-RELOAD the local-backend registry from the DB source of truth (parity with `onAdminReload` for
   *  the account pool) — folded into the SAME `POST /admin/reload` response when present. Absent ⇒
   *  `/admin/reload` simply omits the `localBackends` field (no error — this is an independent axis from
   *  the account pool's hot-reload). */
  onAdminReloadLocalBackends?: () => Promise<{ changed: boolean; count: number }>;
  /** START a stopped on-demand local backend and wait for it to answer (P-008/D-009).
   *
   *  Called ONLY on a genuine routing dead end — no healthy backend serves the model AND the pool
   *  is not merely saturated — and only for a backend whose registry row says `lifecycle:'on-demand'`
   *  with a `unitName`. Absent ⇒ a stopped backend stays a 502 exactly as before (this whole axis is
   *  opt-in, matching `localBackends` itself).
   *
   *  INJECTED rather than imported so the gateway keeps its systemd-free and PG-free posture: the
   *  implementation (launch.ts) closes over provision.ts's `ensureLocalBackendRunning` with the
   *  MEASURED readyTimeoutMs, plus the `last_busy_at` watermark stamp. The gateway owns the
   *  ELIGIBILITY judgement; the mechanism stays outside it. */
  ensureLocalBackendRunning?: (backend: LocalBackend) => Promise<{ ok: boolean; error?: string }>;
}

export type GatewayRoutingSelectionMode = 'automatic' | 'affinity' | 'soft-pin' | 'hard-pin';

/** One bounded, privacy-safe explanation of the gateway's INITIAL account choice for a logical request.
 * Retries remain attempt telemetry; keeping them out of this ring makes `upstream429s / picks` a useful
 * amplification ratio instead of silently changing the denominator on every internal failover. */
export interface GatewayRoutingDecision {
  sequence: number;
  at: number;
  provider: 'claude' | 'codex';
  owner: string | null;
  selectedAccount: string;
  mode: GatewayRoutingSelectionMode;
  reason: 'health-ranked' | 'fallback-list-order' | 'affinity-kept' | 'pin-kept' | 'pin-yield';
  requestedAccount: string | null;
  yieldedFrom: string | null;
  /** accountLoadKey is lower-is-better. null means the account was not serviceable (Infinity), never 0. */
  selectedScore: number | null;
  selectedServiceable: boolean;
  bestAvailableAccount: string | null;
  bestAvailableScore: number | null;
  /** null means no serviceable comparator existed at pick time. */
  divergedFromBest: boolean | null;
  /** Intentional affinity/hard/soft pins are evidence, but never automatic-router defects. */
  includedInAutomaticDivergence: boolean;
}

export interface GatewayRoutingQualitySnapshot {
  countersSinceMs: number;
  recentLimit: number;
  scoreSemantics: 'accountLoadKey; lower-is-better; null=unserviceable';
  picks: number;
  /** True HTTP 429 attempts only. Unlike legacy GatewayStats.upstream429, this excludes HTTP 529. */
  upstream429s: number;
  /** May exceed 1 when one logical pick produces multiple throttled retry attempts. */
  upstream429PerPick: number | null;
  automatic: {
    picks: number;
    comparablePicks: number;
    divergences: number;
    divergenceRate: number | null;
  };
  pins: {
    picks: number;
    explicitPicks: number;
    affinityPicks: number;
    yields: number;
    yieldRate: number | null;
  };
  byProvider: Record<
    'claude' | 'codex',
    {
      picks: number;
      upstream429s: number;
      upstream429PerPick: number | null;
      automatic: {
        picks: number;
        comparablePicks: number;
        divergences: number;
        divergenceRate: number | null;
      };
      pins: {
        picks: number;
        explicitPicks: number;
        affinityPicks: number;
        yields: number;
        yieldRate: number | null;
      };
      byAccount: Record<string, { picks: number; upstream429s: number; upstream429PerPick: number | null }>;
    }
  >;
  /** null on /stats and the owner-report overview; an owner id on ?owner= filters only this bounded ring. */
  recentScope: string | null;
  recent: GatewayRoutingDecision[];
}

export interface GatewayCacheCounts {
  /** Exact aggregate; null if any observed usage omitted this field. */
  read: number | null;
  create: number | null;
  input: number | null;
  /** Sums of reported values only, explicitly lower bounds when coverage is incomplete. */
  knownTokenTotals: { read: number; create: number; input: number };
  hits: number;
  misses: number;
  failoverMisses: number;
  /** Token reuse for the comparable population, not requests with any cache read. */
  hitRate: number | null;
  tokenRateBasis: { read: number; inputTotal: number };
  coverage: { requests: number; readKnown: number; writeKnown: number; uncachedInputKnown: number; inputTotalKnown: number; tokenRateRequests: number };
}

/** How a served Claude request was billed (P-009): the flat-rate subscription allowance, subscription
 *  usage credits (overage, per token at API rates), or API credits (an api-key account, per token). */
export type GatewayBillingClass = 'included' | 'usage-credits' | 'api-credits';
/** Requests served in one billing class and the token usage they reported. Only KNOWN counts are added:
 *  `usageKnown` = requests whose input-side usage was read, `outputKnown` = requests whose final output
 *  count was read (a stream cut before its closing `message_delta` reports no output count). */
export interface GatewayBillingTally {
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  usageKnown: number;
  outputKnown: number;
}
/** One Claude account's billing view (P-009). `state` is its CURRENT billing state from the latest
 *  upstream response (`api-credits` for an api-key account; `unknown` before any response); `stateUntil`
 *  is the allowance reset that response named. `meteredNow` = billed per token right now. */
export interface GatewayAccountBilling {
  state: ClaudeBillingStateKind | 'api-credits' | 'unknown';
  stateUntil?: number;
  meteredNow: boolean;
  authMode: 'oauth' | 'api-key';
  meteredPolicy: 'overflow' | 'never';
  classes: Partial<Record<GatewayBillingClass, GatewayBillingTally>>;
  metered: GatewayBillingTally;
  /** Present while the account sits behind a credit wall (D-004): WHY (402 billing_error →
   *  `billing-error`, 429 enforced_spend_limit_reached → `spend-limit`, 400 API usage limits →
   *  `api-usage-limit`) and the epoch-ms the wall's pause ends. Absent once it clears. */
  wall?: { cause: ClaudeCreditWallCause | 'unknown'; until: number };
}

export interface GatewayStats {
  accountId: string;
  upstreamBase: string;
  /** Epoch ms when THIS gateway process started. Optional for deploy-skew readers of older live gateways. */
  processStartedAt?: number;
  /** Milliseconds since THIS gateway process started. Lets capacity readers distinguish a fresh restart
   *  bootstrap snapshot from sustained pool exhaustion. Optional for deploy-skew readers. */
  processUptimeMs?: number;
  /** Live recurring timers in this gateway process, reconciled from the managed registry. */
  scheduledTimers?: ReturnType<typeof listManaged>;
  totalRequests: number;
  /**
   * Correlated, privacy-safe request-stage timelines + bounded p50/p95/p99 histograms (P-001).
   * Optional only for deploy-skew readers of an older live gateway; this implementation emits it on
   * every `/stats` read. The same collector augments `/admin/owner-report`.
   */
  requestStages?: GatewayRequestTelemetrySnapshot;
  /** Routing-quality evidence and ratios since this gateway process started (P-007). Optional only for
   * deploy-skew readers of an older live gateway; this implementation emits it on every stats read. */
  routingQuality?: GatewayRoutingQualitySnapshot;
  /** Prompt-cache-policy telemetry (gateway-cache-plane-shared-prefix-ttl-2026-07-19 P-002):
   *  what the request-body rewrite did, as a byproduct of doing it. `breakpointHistogram[n]` =
   *  requests that arrived carrying n cache_control markers (the headroom for the opt-in
   *  tools-span breakpoint is observable here). Optional for deploy-skew readers of older gateways. */
  cachePolicy?: {
    policyVersion?: string;
    enabled: boolean;
    toolsBreakpoint: boolean;
    splitBoundary: boolean;
    anthropicRequests: number;
    ttlUpgraded: number;
    toolsBreakpointInjected: number;
    toolsBreakpointSkippedNoBudget: number;
    toolsBreakpointSkippedAllDeferred: number;
    boundarySplit: number;
    /** P-002 per-tool deferral: the flag's live state, plus what the pass actually did. The
     *  counters are what makes the P-003 both-arms A/B checkable from outside the process —
     *  a flag that reads "on" while deferring nothing is the failure mode to catch. */
    deferLargeTools: boolean;
    toolsDeferred: number;
    toolsDeferredBytes: number;
    searchToolInjected: number;
    breakpointHistogram: number[];
    codexRequests: number;
    codexLegacyRetention: number;
    codexModernTtl: number;
    codexCacheKeySet: number;
  };
  inFlight: number;
  queueDepth: number;
  /** Pool-wide count of accounts that can serve a request RIGHT NOW — in rotation AND not governor-paused
   *  for SERVICEABLE_CLAMP_MODEL (so a weekly-usage-walled account at util7d≈1.0 does NOT count, EI-11511).
   *  The SAME governor-narrowed serviceable count the serviceable-admission clamp enforces and
   *  `priorityTiers.healthyAccounts` reports, hoisted to the top level (unconditionally, not gated behind the
   *  priority-tier flag) so a plain consumer (WI-390 spawn-readiness gate) can read it without opting into the
   *  tier layer. `1` when the pool has no healthyCount() (single-account pool). */
  healthyAccounts: number;
  /** Per-priority queue breakdown (P-011 / P-014). With the priority-TIER layer on, `admission.byTier`
   *  carries the per-tier {cap,inFlight,queued} and `admission.tier1Reserve` the reserved floor. */
  admission: AdmissionSnapshot;
  /** Codex/OpenAI-compatible traffic has its own smaller admission gate so its
   *  tier-1 reserve is sized to Codex capacity, not the larger Claude queue. */
  codexAdmission: AdmissionSnapshot;
  /** Priority-TIER admission summary (gateway-priority-tiers-2026-06-22) — the per-tier
   *  {tier,cap,inFlight,queued} from the queue PLUS the pool-wide `healthyAccounts` capacity denominator,
   *  and the reserved tier-1 floor. PRESENT only when the tier layer is configured (flag ON); ABSENT under
   *  flag-OFF so the stats payload is byte-identical to today. */
  priorityTiers?: {
    healthyAccounts: number;
    tier1Reserve: number;
    tiers: { tier: number; minShare: number | null; inFlight: number; queued: number }[];
  };
  upstream429: number;
  queued429: number;
  /** Count of 429s returned because the admission queue hit `maxQueued` (load-shed, not a task error). */
  shed429: number;
  /** Live Cloudflare/per-IP bare-429 evidence, keyed by account. Optional for deploy-skew readers. */
  edgeThrottleByAccount?: Record<
    string,
    { edgeThrottled: boolean; cooldownUntil: number; cooledIpCount: number; bare429Streak: number }
  >;
  /** EI-18791887279744938 (defect B): pool-wide egress-PROXY reachability, computed from the SAME
   *  per-IP cooldown map `pickEgress` reads — this can never diverge from what routing actually sees.
   *  `allDown` is the detector gap the bug named: "nothing alarmed when every proxy was down" —
   *  `accounts:status` showed only the SYMPTOM (accounts unavailable), never this CAUSE. `totalProxyEntries
   *  === 0` (no account configures a proxy) or `proxyEgressDisabled` (the kill-switch is on) both read as
   *  `allDown:false` — there is no proxy path to be down. That is a SECOND, distinct condition from
   *  "healthy", and EI-19962845612125031 named the gap: a bare `allDown:false` cannot tell a caller
   *  which of the two it's looking at (population-empty vs population-healthy), so a monitor reading
   *  `allDown` alone concludes "fine" when there is no proxy egress at all. `configured` disambiguates:
   *  `false` means there is no proxy path to judge in the first place (zero entries, or the kill-switch
   *  is on) — `allDown` is then vacuously `false` and must NOT be read as a health verdict. Optional for
   *  deploy-skew readers. */
  egressProxyHealth?: {
    totalProxyEntries: number;
    reachableProxyEntries: number;
    allDown: boolean;
    configured: boolean;
  };
  /** Count of 429s shed at ADMISSION because the WHOLE pool was throttled with a far-off reset — the
   *  fail-fast path (B-GW-1) that frees the slot immediately instead of taking the acquire/retry path. */
  shedAllThrottled: number;
  /** G1 (WI-649): count of bare-429 rotate-retries SUPPRESSED because ≥half the pool was out of rotation
   *  (a fleet-wide bare-burst storm) — the request fell through to the bounded wait/absorb/shed instead of
   *  fanning out another upstream call. A climbing value = the gateway is actively damping a storm. */
  bareBurstRotateSuppressed: number;
  /** WI-1073: count of requests the gateway last-resort DOWNGRADED opus→sonnet because opus was walled
   *  pool-wide (a hard 403 org-disallow / usage-cap / unified-window rejection it could not route or wait
   *  around). A non-zero value = the fleet is running critical work on sonnet because opus is exhausted. */
  opusToSonnetDowngrades: number;
  /** WI-10005833: unsupported reasoning-effort clamp. `retries` = requests retried once after an upstream
   *  400 named their `output_config.effort` unsupported; `rewrites` = requests rewritten from a learned
   *  clamp before they were sent; `learned` = the live (model, from → to) substitutions. A non-zero
   *  `retries` means some launch path is still sending a level its model refuses. */
  effortClamps: {
    retries: number;
    rewrites: number;
    learned: Array<{ model: string; from: string; to: string; learnedAt: number; applied: number }>;
  };
  /** The admission backlog cap that triggers load-shedding (0 = unbounded). */
  maxQueued: number;
  /** The CONFIGURED admission-concurrency cap (the AIMD ceiling). `admission.maxConcurrent` is the LIVE
   *  effective concurrency after AIMD adaptation; this is the ceiling it recovers toward. */
  concurrencyCap: number;
  /** AIMD admission-concurrency state (B-GW-1): effective vs cap/floor + lifetime decrease/increase
   *  counts — the dashboard's adaptive-throttle signal (a climbing `decreases` = a sustained storm). */
  aimd: AimdSnapshot;
  /** ChatGPT/Codex has an independent adaptive controller. A Codex throttle must never shrink the
   *  Claude queue (and a Claude success must never prematurely recover Codex admission). */
  codexAimd?: AimdSnapshot;
  /** Serviceable-count clamp state (2026-07-09 advisory-clamp directive). `recommendation` is what the
   *  clamp WOULD cap live admission to (null = unbounded/not yet computed); `applied` is what admission
   *  actually is after `mode` is honored; `overridden` is true when a recommendation exists and was NOT
   *  applied (`mode:'off'`). Makes an override impossible to mistake for a healthy pool.
   *
   *  OPTIONAL BY NECESSITY: `/admin/stats` is parsed off a REMOTE gateway process (observability
   *  .fetchGatewayHeadroom), which under deploy skew may be an older binary that predates this field —
   *  exactly the case on 2026-07-09, when the running gateway was older than the routes being shipped.
   *  A consumer must treat its absence as "unknown", never as "not clamped". */
  clamp?: {
    mode: ServiceableClampMode;
    recommendation: number | null;
    applied: number;
    overridden: boolean;
    /** Legacy configuration readback; neither field is an admission authority. */
    legacyConfigured?: boolean;
    legacyTickMs?: number;
    /** Serviceable accounts the recommendation was computed FROM — the raw input, published so a reader
     *  never has to invert `max(MIN_SERVICEABLE_ADMISSION, n * PER_ACCOUNT_ADMISSION)` to recover it. That
     *  inversion is not even well-defined at the floor: a recommendation of 2 is produced by BOTH 0
     *  serviceable accounts and the MIN floor. Optional for the same deploy-skew reason as `clamp` itself. */
    serviceableAccounts?: number | null;
  };
  /** MAINTENANCE summarize lane (deterministic-context-carry P-002): compaction summaries served /
   *  failed via POST /maintenance/summarize. Optional for deploy-skew readers of older gateways.
   *  `carried` (P-017) = requests answered by the DETERMINISTIC carry branch instead of the LLM
   *  oneshot — optional for the same deploy-skew reason (pre-P-017 gateways omit it). */
  maintenance?: { requests: number; errors: number; carried?: number };
  /** Count of 5h-exhaustion failovers between pool accounts (EI-535). */
  failovers: number;
  upstreamErrors: number;
  /** Count of egress-circuit OPENs (B-GW-EGRESS): how many times a per-account egress proxy hit the
   *  consecutive-transport-failure threshold and was paused out of rotation. A climbing value = a
   *  flapping/dead proxy IP (distinct from `upstreamErrors`, which also counts Anthropic-side stalls). */
  egressCircuitOpens: number;
  /** Per-account egress transport-failure tally (2026-06-22 audit) — which proxy is failing, for the Rayobyte
   *  fix (log-independent, since the journald circuit-open logs are unreliable). Empty when no egress proxies. */
  egressFailsByAccount: Record<string, number>;
  /** Per-account upstream-ATTEMPT tally (2026-06-22 audit) — the DENOMINATOR for egressFailsByAccount. A single
   *  bee request can make several attempts (failover rotations), so this counts attempts-through-this-account's-
   *  proxy, not distinct requests. Only accounts that reached the egress dial appear. */
  egressAttemptsByAccount: Record<string, number>;
  /** Per-account egress transport-failure RATE = egressFailsByAccount / egressAttemptsByAccount (0..1, 4dp). The
   *  VOLUME-FAIR culprit signal: raw fail counts rank the BUSIEST proxy worst, but a low-traffic proxy failing
   *  95% of its few attempts is the true dead proxy. Sort DESC by this to pick the Rayobyte proxy to fix/pull.
   *  Only accounts with ≥1 attempt appear. */
  egressFailRateByAccount: Record<string, number>;
  /** Count of in-process self-heal slot-reclaims (EI-2086) — how many times the release valve pre-empted
   *  a watchdog full-restart. A climbing value = the gateway is wedging but recovering itself instead of
   *  restarting; pair it with the watchdog's restart count to see the valve doing its job. */
  selfHealReclaims: number;
  /** P-005/W3 slot-leak RECURRENCE GUARD (D-001): count of self-heal sweeps where the held-slot counter
   *  (`inFlight`) and the in-flight registry (`inFlightTracked`) disagreed in a way the valve could NOT
   *  reclaim — a leaked admission slot surfaced as a COUNTED signal instead of a silent wedge→watchdog
   *  restart. Two shapes are counted: the registry outliving its slot (structurally impossible → a broken
   *  decrement path), and a wedge with slots held but nothing registered to reclaim (an un-registered leak
   *  the valve is blind to). 0 in healthy operation; any climb is a page (folded into the gateway health
   *  vector / Infra SLO). De-bounced (only a mismatch sustained ≥2 sweeps counts) so a normal
   *  admit/complete transient never trips it. */
  slotReconcileMismatch: number;
  /** Live count of requests tracked in the self-heal in-flight registry — the reconcile DENOMINATOR against
   *  `inFlight` (held admission slots). The registry is a strict subset of held slots, so a persistent
   *  `inFlight` > this while wedged = an un-reclaimable leak (drives `slotReconcileMismatch`). */
  inFlightTracked: number;
  /** Age (ms) of the OLDEST slot in the self-heal registry (0 when idle) — the live "how long has anything
   *  been held" gauge. A value approaching the self-heal freeze (75s) / watchdog (120s) is a wedge's leading edge. */
  oldestHeldSlotAgeMs: number;
  /** Count of rate-limit STALL candidates recorded (P-002): all-throttled sheds to an identified bee. The
   *  full {ownerId, accountId, soonestResetAt} events are on GET /admin/stalls (for the stall-waker). */
  stallsRecorded: number;
  /** PROACTIVE egress prober health (gateway-rayobyte-hardening P-002): idle proxy routes are probed on a
   *  cadence and cooled BEFORE live traffic burns on a dead squid. `circuitOpens` counts circuits the
   *  prober (vs live requests) opened; a non-empty `failStreakByAccount` = a route failing but not yet at
   *  the open threshold. */
  proactiveEgressProbe: {
    enabled: boolean;
    intervalMs: number;
    lastTickAt: number;
    circuitOpens: number;
    failStreakByAccount: Record<string, number>;
  };
  /** Per-backend Codex/OpenAI counters (2026-06-22 audit) — kept SEPARATE from the Claude counters above so
   *  /stats distinguishes Codex health from Claude health. All zero until Codex accounts are configured. */
  codex: { requests: number; upstream429: number; failovers: number; errors: number };
  /** Codex accounts that can serve right now, including ChatGPT-subscription CLI bridge accounts. */
  codexHealthyAccounts?: number;
  /** Total configured Codex/OpenAI accounts, including temporarily parked accounts. */
  codexTotalAccounts?: number;
  /** WI-10003306: (account, model) pairs routed around because the ChatGPT backend refused that
   *  model for that account. The accounts stay in the pool; each entry lapses or clears on a 2xx. */
  codexModelRefusals?: CodexModelRefusalEntry[];
  /**
   * Pool-wide Codex recovery horizon: 0 while an account can serve now, an epoch-ms instant
   * when every account is out but one has a known return, or null when no return is known.
   */
  codexEarliestRecoveryAt?: number | null;
  /** Bee-FACING final 503s (2026-06-22 audit) — what the bee receives after the gateway exhausts internal
   *  retries. Makes egress-proxy leakage visible (it isn't a rate shed, so shedAllThrottled never counted it). */
  beeFacing503: { egressExhausted: number; tokenStall: number };
  /** The bound account's most-constraining unified window, if seen (D-009 / P-014).
   *  `observedAt`/`staleAsOfMs`/`rejectedActuallyEnforced` (EI-535, gateway-healthz-stale-latch fix):
   *  this reading freezes at its last-observed value once traffic goes idle (no new upstream response
   *  to run `recordHeaders` again) — `rejected` alone can't tell a caller "genuinely still rejected"
   *  from "last seen hours ago, and that window has long since rolled over". `observedAt` = when this
   *  reading was actually taken; `staleAsOfMs` = how long ago (derived, `now - observedAt`, present
   *  only when observedAt is known); `rejectedActuallyEnforced` = `rejected && resetAt > now` — the
   *  self-describing verdict a consumer should trust instead of the raw (possibly stale) `rejected`. */
  unified?: {
    window: string;
    utilization: number;
    resetAt: number;
    rejected: boolean;
    observedAt?: number;
    staleAsOfMs?: number;
    rejectedActuallyEnforced?: boolean;
  };
  /** RPM-SMOOTHING observability (hive-inference-gateway-stability P-005): is the burst-dodging pace
   *  actually engaged, AS DATA not inference. The gateway runs its OWN per-account governor registry
   *  (invisible to dev:rate_governor_status), so this is the only window into "is smoothing working".
   *  `engaged` = the gateway-wide smoothRpm config; `byAccount` = each gateway governor's effective pace:
   *  `smoothRpm` engaged on it, the configured `rpm` floor, the time-decayed learned `rpmFactor`, the
   *  effective per-minute allowance `effRpm` = floor(rpm × rpmFactor), the header-driven `paceDelayMs`,
   *  and the EFFECTIVE inter-request pace ENFORCED `effectivePaceMs` = max(paceDelayMs, smoothing floor
   *  60_000/effRpm). effectivePaceMs > 0 ⇒ requests are being spaced (the burst-dodge is live). Present
   *  only once a per-account governor exists; ABSENT (undefined) on a never-served gateway so the payload
   *  stays byte-identical to before. */
  smoothing?: {
    engaged: boolean;
    byAccount: Record<
      string,
      {
        smoothRpm: boolean;
        rpm: number | null;
        rpmFactor: number;
        effRpm: number | null;
        paceDelayMs: number;
        effectivePaceMs: number;
      }
    >;
  };
  pausedUntil: number;
  /** Self-describing companion to `pausedUntil` (EI-535, gateway-healthz-stale-latch fix): whether that
   *  deadline is STILL in the future as of this read (`pausedUntil > now`). `/healthz`'s HTTP status code
   *  already reflects this live at the top-level handler, but any OTHER reader of this payload (`/stats`,
   *  `/admin/stats`, a direct curl during an incident) got only the raw epoch-ms `pausedUntil` with no
   *  hint whether it's a live deadline or a long-lapsed one from an idle account — this makes that
   *  unambiguous without the reader doing its own clock math. */
  pausedActuallyEnforced: boolean;
  /** Per-account and total cache observations. Unknown counts stay null; token reuse
   * only compares observations whose read count and total input are both known.
   * Failover misses are correlated with failover, not an attribution of cause. */
  cache: GatewayCacheCounts & {
    byAccount: Record<string, GatewayCacheCounts>;
    /** AUTO-ROUTE SESSION AFFINITY (WI-2140943): how unpinned requests were routed since boot. `nokey` is
     *  the population still on per-request round-robin (no owner header, no per-session metadata). */
    affinity: { hits: number; cold: number; nokey: number; yields: number; enabled: boolean; ttlMs: number };
  };
  /** METERED SPEND VISIBILITY (anthropic-credits-gateway-2026-09-30 P-009). One row per Claude pool
   *  account: its CURRENT billing state and the requests + tokens it served per billing class since boot.
   *  `metered` sums the per-token-billed classes (usage-credits + api-credits), per account and pool-wide. */
  billing: {
    byAccount: Record<string, GatewayAccountBilling>;
    metered: GatewayBillingTally;
  };
  /** DURABLE-PATH health (EI-19303809952284205). The gateway's DB-touching side-paths (usage-window
   *  projection, pool reload, rate hints, scale observer) are all fire-and-forget by design, so when
   *  Postgres went away on 2026-08-01 the gateway kept serving traffic and reporting `ok: true` while
   *  three durable subsystems sat completely inert for hours — the account pool could not load at all,
   *  so it collapsed to a single synthetic `local` credential with `healthyAccounts: 0`, and the only
   *  evidence anywhere was the gateway's own journal.
   *
   *  `db.ok === false` is the machine-readable form of that condition: it degrades `/healthz` to a 503
   *  (so every existing prober sees it) and drives the operator's system-health `tokens` panel. See
   *  db-health.ts for the streak/sustain rule — it is deliberately NOT "one write failed".
   *
   *  OPTIONAL for deploy-skew readers (`/admin/stats` is parsed off a REMOTE gateway process that may
   *  predate this field). Absence means UNKNOWN, never healthy. */
  db?: DbHealthSnapshot;
}

/** Rough token estimate for admission (refined once the account exposes real headroom). */
export function estimateTokens(body: unknown): { inTok: number; outTok: number } {
  let inTok = 0;
  let outTok = 0;
  if (body && typeof body === 'object') {
    const b = body as { max_tokens?: number; system?: unknown; messages?: unknown };
    // ~4 chars/token over the serialized system + messages.
    const text = JSON.stringify({ system: b.system ?? '', messages: b.messages ?? [] });
    inTok = Math.ceil(text.length / 4);
    outTok = typeof b.max_tokens === 'number' ? b.max_tokens : 1024;
  }
  return { inTok, outTok };
}

/** A unified-7d (weekly) utilization at/over this is the BINDING cap: the account cannot serve until its
 *  7d window resets, so the pause must use the 7d reset, NOT the (fresh) 5h reset. Env-tunable. */
const WEEKLY_CAP_BINDING_UTIL = Number(process.env.PAPERCUSP_GATEWAY_WEEKLY_CAP_UTIL) || 0.99;
/** Cap on the pause applied for a 7d (weekly) cap — bounds a wrong/huge `unified-7d-reset` header so a bad
 *  value can't strand an account for days. The half-open readmit probe + the drainUtil7d window-reset
 *  expiry re-admit it earlier if it actually recovers. Default 6h. Env-tunable. */
const WEEKLY_CAP_MAX_PAUSE_MS = Number(process.env.PAPERCUSP_GATEWAY_WEEKLY_CAP_MAX_PAUSE_MS) || 6 * 60 * 60 * 1000;

/** Parse an upstream rate-limit reset (prefer the unified unix-seconds window) → {resetAt, retryAfterMs}. */
export function parseRateReset(
  h: Record<string, string | undefined>,
  now = Date.now(),
): { resetAt?: number; retryAfterMs?: number } {
  const out: { resetAt?: number; retryAfterMs?: number } = {};
  const unified = h['anthropic-ratelimit-unified-5h-reset'] ?? h['anthropic-ratelimit-unified-reset'];
  if (unified && /^\d+$/.test(unified)) out.resetAt = Number(unified) * 1000;
  else {
    const iso = h['anthropic-ratelimit-requests-reset'];
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isNaN(t)) out.resetAt = t;
  }
  const ra = h['retry-after'];
  if (ra && /^\d+$/.test(ra)) out.retryAfterMs = Number(ra) * 1000;
  // Guard: a wildly-large retry-after that disagrees with a near unified reset is untrustworthy
  // (observed: retry-after 15210s vs a 10-min reset). Prefer resetAt when both present.
  if (out.resetAt && out.retryAfterMs && out.resetAt - now > 0 && out.retryAfterMs > out.resetAt - now) {
    out.retryAfterMs = undefined;
  }
  // WEEKLY-CAP (7d) BINDING OVERRIDE (capacity-oracle-false-saturation-2026-06-29 / WI-1083): when the
  // unified-7d (weekly) window is the binding cap, the account CANNOT serve until that window resets — but
  // it has a FRESH 5h window, so the 5h reset above is only minutes away. Pausing until the 5h reset
  // re-admits the weekly-capped account within minutes → it 429s again on the 7d cap → every request
  // storms through it on failover → the proxy IPs get cloudflare bare-429'd. Pause until the 7d reset
  // instead (capped to WEEKLY_CAP_MAX_PAUSE_MS; the half-open readmit + drainUtil7d expiry clear it early
  // if it recovers sooner), so a weekly-capped account stays OUT of rotation until it can actually serve.
  const u7 = Number(h['anthropic-ratelimit-unified-7d-utilization']);
  const r7 = h['anthropic-ratelimit-unified-7d-reset'];
  if (Number.isFinite(u7) && u7 >= WEEKLY_CAP_BINDING_UTIL && r7 && /^\d+$/.test(r7)) {
    const reset7 = Number(r7) * 1000;
    if (reset7 > (out.resetAt ?? now)) {
      out.resetAt = Math.min(reset7, now + WEEKLY_CAP_MAX_PAUSE_MS);
      out.retryAfterMs = undefined; // the 7d reset is the authoritative boundary — don't let a 5h retry-after shorten it
    }
  }
  return out;
}

/** The actionable SHAPE of a 429 — the hard-evidence distinction the recurring "is this real capacity?"
 *  question always needs, made loggable. The gateway already DERIVES these internally; naming them lets
 *  the journal record WHICH kind every 429 was, so a capacity-vs-routing read comes from data, not a guess:
 *   - `bare-burst`         — x-should-retry:true, NO window/retry-after headers → a TRANSIENT burst throttle:
 *                            CAPACITY EXISTS, the move is rotate/retry, NOT "we're out".
 *   - `usage-cap`          — the body named a session/usage limit → a REAL per-account wall (pause to reset).
 *   - `rate-window`        — a per-window retry-after / unified reset is present → wait the bounded window.
 *   - `unified-5h-rejected`— the rolling 5h budget latched over-util (no per-request retry signal).
 *   - `unclassified`       — not a 429, or none of the above. */
export type Gateway429Shape = 'bare-burst' | 'usage-cap' | 'rate-window' | 'unified-5h-rejected' | 'unclassified';

export function classify429Shape(o: {
  status: number;
  /** The peeked body named a usage/session limit (a hard per-account wall) — takes precedence. */
  isUsageCap: boolean;
  /** The gateway's `bare429` verdict: a 429 with no window headers + (x-should-retry or no latch). */
  bare: boolean;
  /** A per-window `retry-after` / unified reset boundary was present on the response. */
  hasWindowReset: boolean;
  /** The governor's unified 5h window is latched rejected (over its utilization). */
  unifiedRejected: boolean;
}): Gateway429Shape {
  if (o.status !== 429) return 'unclassified';
  if (o.isUsageCap) return 'usage-cap';
  if (o.bare) return 'bare-burst';
  if (o.hasWindowReset) return 'rate-window';
  if (o.unifiedRejected) return 'unified-5h-rejected';
  return 'unclassified';
}

/** Cold-rest causation probe (WI-3151): a 429 that lands within this many ms of an account rejoining
 *  rotation from a cold rest is a "cold-rest event" — the account JUST rested, so a still-429 here is
 *  strong evidence the throttle is not this account's own budget. Env-tunable; default 2 min (a rested
 *  account that 429s minutes later is back to normal load, not a cold-rest signal). */
export const COLD_REST_CAUSATION_WINDOW_MS = Number(process.env.PAPERCUSP_GATEWAY_COLD_REST_WINDOW_MS) || 120_000;
/** Cold-rest causation probe (WI-3151): at/above this unified-5h utilization a bare-burst on a
 *  freshly-rested account can't be cleanly blamed on the edge — the account IS near its own budget, so
 *  the verdict degrades to `inconclusive` rather than `edge-not-account`. */
export const COLD_REST_HIGH_UTIL = Number(process.env.PAPERCUSP_GATEWAY_COLD_REST_HIGH_UTIL) || 0.8;

/** The causation verdict for a 429 on a freshly-cold-rested account (WI-3151) — the loggable answer to
 *  "the account just rested; why is it STILL 429ing?", the diagnostic sibling of {@link classify429Shape}:
 *   - `edge-not-account`     — a bare-burst (no window headers) moments after a cold rest, at util well
 *                              below budget → resting the account did NOT clear it AND the account has
 *                              headroom, so the throttle is a SHARED edge/IP layer, not this account's quota.
 *   - `account-still-latched`— a usage-cap / rate-window / unified-5h 429 within the window → the account
 *                              genuinely still has a wall (a premature readmit / real per-account cap).
 *   - `not-cold-rest`        — the 429 is outside the cold-rest window (or the account was never rested),
 *                              so this probe doesn't apply.
 *   - `inconclusive`         — cold-rested, but the shape/util don't cleanly separate edge from account
 *                              (a bare-burst while the account itself is near budget, or a non-429 shape). */
export type ColdRest429Cause = 'edge-not-account' | 'account-still-latched' | 'not-cold-rest' | 'inconclusive';

export function classifyColdRest429(o: {
  /** The 429's shape (from classify429Shape). */
  shape: Gateway429Shape;
  /** ms since the account rejoined rotation from a cold rest (pool.msSinceReadmit); undefined ⇒ never
   *  rested / currently paused. */
  msSinceReadmit: number | undefined;
  /** The cold-rest window; a 429 later than this is `not-cold-rest`. */
  windowMs: number;
  /** The account's observed unified-5h utilization fraction [0,1], or undefined when the header was absent. */
  utilization5h: number | undefined;
  /** The high-util cutoff above which a bare-burst can't be cleanly blamed on the edge. */
  highUtil: number;
}): ColdRest429Cause {
  if (o.msSinceReadmit === undefined || o.msSinceReadmit > o.windowMs) return 'not-cold-rest';
  switch (o.shape) {
    case 'usage-cap':
    case 'rate-window':
    case 'unified-5h-rejected':
      // A real per-account boundary right after a rest ⇒ the account itself is still walled.
      return 'account-still-latched';
    case 'bare-burst':
      // Rested + still bare-throttled. Low/unknown util ⇒ the account has budget, so the edge caused it.
      return o.utilization5h === undefined || o.utilization5h < o.highUtil ? 'edge-not-account' : 'inconclusive';
    default:
      return 'inconclusive';
  }
}

/**
 * Classify a top-level proxy-handler rejection (after the QueueFullError load-shed is handled
 * separately): a benign DOWNSTREAM `client-abort` (the caller gave up / the connection dropped)
 * vs a real handler `crash` (a gateway/upstream fault → loud error log + HTTP 500).
 *
 * A client abort is benign WHETHER OR NOT response headers were already sent. The distinguishing
 * signal is that the DOWNSTREAM response object went away: `res.destroyed || res.writableEnded`
 * is true only when the CLIENT tore down the connection — an upstream/internal abort (stall-waker,
 * internal timeout) throws an abort-shaped error but leaves `res` intact, so it correctly stays a
 * `crash`. The previous inline logic additionally required `res.headersSent`, which wrongly
 * excluded the PRE-headers case: a caller that aborted while still QUEUED (before the gateway sent
 * a byte) was misread as a crash → `upstreamErrors++` + an HTTP 500 "inference-gateway internal
 * error". Under fan-out (subscription buckets pace at maxConcurrent=3, so the 4th/5th caller queues
 * in the absorb window and often aborts before headers) that produced the ~1700 `proxy handler
 * crashed: aborted` log storm and agent-visible 500s — the "gateway fails at a few agents" report.
 * Pure + exported so both cases (pre- and post-headers) are unit-testable.
 */
export type ProxyHandlerFailure = 'client-abort' | 'crash';

export function classifyProxyHandlerError(
  msg: string,
  res: { destroyed: boolean; writableEnded: boolean },
): ProxyHandlerFailure {
  const clientAbort =
    /\baborted\b|ERR_STREAM_PREMATURE_CLOSE|ECONNRESET/i.test(msg) && (res.destroyed || res.writableEnded);
  return clientAbort ? 'client-abort' : 'crash';
}

/**
 * Parse the unified-5h rolling budget window from an upstream response (present on 200s too, not
 * just 429s) → the fraction used + the reset boundary. This is the cross-process signal the drain
 * selector routes by (more Max subscriptions = more aggregate 5h budget — the capacity lever).
 * `utilization` is a fraction where 1.0 = 100% (1.01 = over budget); `windowResetAt` is epoch ms.
 */
export function parseUnifiedWindow(h: Record<string, string | undefined>): {
  utilization?: number;
  windowResetAt?: number;
} {
  const out: { utilization?: number; windowResetAt?: number } = {};
  const u = h['anthropic-ratelimit-unified-5h-utilization'] ?? h['anthropic-ratelimit-unified-utilization'];
  if (u !== undefined) {
    const n = Number(u);
    if (Number.isFinite(n) && n >= 0) out.utilization = n;
  }
  const r = h['anthropic-ratelimit-unified-5h-reset'] ?? h['anthropic-ratelimit-unified-reset'];
  if (r && /^\d+$/.test(r)) out.windowResetAt = Number(r) * 1000;
  return out;
}

/**
 * Parse the unified-7d (weekly) rolling budget window from an upstream response
 * (`anthropic-ratelimit-unified-7d-*`) — the LONGER Claude Max limit alongside the 5h.
 * Sibling of parseUnifiedWindow: `utilization7d` is a fraction (1.0 = 100%); `windowResetAt7d`
 * is epoch ms. Surfaced read-only on the Accounts tab (accounts-pool-tab P-006); not (yet) a
 * routing input — the 5h window remains the drain selector's signal.
 */
export function parseUnified7dWindow(h: Record<string, string | undefined>): {
  utilization7d?: number;
  windowResetAt7d?: number;
} {
  const out: { utilization7d?: number; windowResetAt7d?: number } = {};
  const u = h['anthropic-ratelimit-unified-7d-utilization'];
  if (u !== undefined) {
    const n = Number(u);
    if (Number.isFinite(n) && n >= 0) out.utilization7d = n;
  }
  const r = h['anthropic-ratelimit-unified-7d-reset'];
  if (r && /^\d+$/.test(r)) out.windowResetAt7d = Number(r) * 1000;
  return out;
}

function headersToObject(h: Headers): Record<string, string | undefined> {
  const o: Record<string, string | undefined> = {};
  h.forEach((v, k) => {
    o[k.toLowerCase()] = v;
  });
  return o;
}

/**
 * Bodies consumed BEFORE admission by the pre-acceptance spool (D-004).
 *
 * The spool has to read the request stream to persist it, but the six handler
 * sites below all call `readBody(req)` AFTER admission — by which point the
 * stream is drained and would yield an empty buffer. Rather than add a seventh
 * body-reading path (D-011 explicitly forbids that), the already-read bytes are
 * parked here and handed back by `readBody` itself, so every existing call site
 * inherits the behaviour unchanged.
 *
 * A WeakMap keyed on the request keeps this leak-free: the entry dies with the
 * request object, with no explicit cleanup for a handler to forget on an error
 * path.
 */
const preReadRequestBodies = new WeakMap<http.IncomingMessage, Buffer>();

/** Park a body the spool has already consumed, so `readBody` can serve it. */
function setPreReadBody(req: http.IncomingMessage, body: Buffer): void {
  preReadRequestBodies.set(req, body);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  // The spool path already drained the stream; iterating it again yields nothing.
  const preRead = preReadRequestBodies.get(req);
  if (preRead) return preRead;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Read up to `capBytes` of a web ReadableStream into a `head` Buffer. If the stream ENDS within the cap
 * (the usual case for tiny error/limit bodies), `rest` is null and `head` is the whole body. If the cap
 * is hit first (a large streamed response), `rest` is a Node Readable yielding the REMAINING bytes (the
 * head is returned separately so the caller writes it first). Lets the gateway peek a NON-200 upstream
 * body for a usage/session-limit signature without buffering successful 200 streams. The generator's
 * finally cancels the reader on natural end OR an early destroy(), so a discarded body never leaks the
 * upstream connection.
 */
// Exported for direct unit tests (byte-exact head/rest split + cap-boundary correctness is load-bearing —
// a bug here truncates/corrupts the error body the gateway forwards, or buffers a 200 stream).
export async function peekBody(
  webStream: ReadableStream<Uint8Array>,
  capBytes: number,
): Promise<{ head: Buffer; rest: Readable | null }> {
  const reader = webStream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      reader.releaseLock?.();
      return { head: Buffer.concat(chunks), rest: null };
    }
    chunks.push(Buffer.from(value));
    total += value.byteLength;
    if (total >= capBytes) break;
  }
  const head = Buffer.concat(chunks);
  const rest = Readable.from(
    (async function* () {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield Buffer.from(value);
        }
      } finally {
        reader.cancel?.().catch(() => {});
      }
    })(),
  );
  return { head, rest };
}

/** One exact prompt-usage sample observed on the upstream `message_start`. */
export interface GatewayRouteUsageSample {
  inputTotal: number;
  inputTokens: number;
  cacheRead: number;
  cacheCreate: number;
}

/**
 * Per-native-session prompt measurement exposed by `GET /admin/route`.
 *
 * `observedInputFloor` is deliberately named as an OBSERVATION, not an exact
 * fixed-prefix size: it is the smallest total prompt the gateway has served for
 * this native session, so it can still include first-turn conversation content.
 * Consequently `limit - observedInputFloor` is a conservative lower bound on
 * usable conversation runway. `observations` makes the evidence depth explicit.
 */
export interface GatewayRouteUsage extends GatewayRouteUsageSample {
  observedInputFloor: number;
  observations: number;
  at: number;
}

/** Pure accumulator for the bounded route entry's per-session prompt telemetry. */
export function accumulateGatewayRouteUsage(
  prior: GatewayRouteUsage | null | undefined,
  sample: GatewayRouteUsageSample,
  at: number = Date.now(),
): GatewayRouteUsage {
  return {
    ...sample,
    observedInputFloor: Math.min(prior?.observedInputFloor ?? sample.inputTotal, sample.inputTotal),
    observations: (prior?.observations ?? 0) + 1,
    at,
  };
}

export function createInferenceGateway(deps: GatewayDeps) {
  // Snapshot the binding so a mutable dependency cannot change an arm or remove
  // its enforcement while the request is queued or waiting on authorization.
  const carryTrialProtocols = deps.carryTrial?.protocols === undefined
    ? ['openai-responses'] : deps.carryTrial.protocols;
  if (deps.carryTrial && (!Array.isArray(carryTrialProtocols) || carryTrialProtocols.length === 0 ||
    carryTrialProtocols.length > 2 || new Set(carryTrialProtocols).size !== carryTrialProtocols.length ||
    carryTrialProtocols.some(protocol => protocol !== 'openai-responses' && protocol !== 'anthropic-messages'))) {
    throw new Error('inference-gateway: invalid carry trial protocols');
  }
  const carryTrial = deps.carryTrial ? Object.freeze({ ...deps.carryTrial,
    protocols: Object.freeze([...carryTrialProtocols]),
  }) : null;
  if (carryTrial && (!/^[a-f0-9]{64}$/.test(carryTrial.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(carryTrial.requestTokenSha256) || !carryTrial.armId.trim() ||
    typeof carryTrial.authorizeAttempt !== 'function')) {
    throw new Error('inference-gateway: invalid carry trial binding');
  }
  const carryTrialRequests = new WeakSet<http.IncomingMessage>();
  const trialRefusal = () => new GatewayRequestKernelError('carry trial attempt not authorized', {
    code: 'invalid-route', outcome: 'gateway-error', status: 403, retryable: false,
  });
  async function authorizeCarryTrialAttempt(
    req: http.IncomingMessage,
    transport: GatewayCarryTrialAttempt['transport'],
    accountId: string | undefined,
    target: string,
    init: { headers: Record<string, string>; body?: Uint8Array | null; signal: AbortSignal },
  ): Promise<() => void> {
    if (!carryTrial) return () => {};
    if (!carryTrialRequests.has(req) || !accountId || !init.body || init.signal.aborted) throw trialRefusal();
    const headers = new Headers(init.headers);
    const authorization = headers.get('authorization');
    const apiKey = transport === 'anthropic-http' ? headers.get('x-api-key') : null;
    // Hash the actual selected provider credential, not the incoming binding
    // token. Ambiguous auth shapes cannot establish which credential pays.
    if ((!authorization && !apiKey) || (authorization && apiKey)) throw trialRefusal();
    const credentialHeader = authorization ? 'authorization' : 'x-api-key';
    const credential = authorization ?? apiKey!;
    const body = Buffer.from(init.body).toString('utf8');
    const attemptId = randomUUID();
    let reservation: Awaited<ReturnType<GatewayCarryTrialBinding['authorizeAttempt']>>;
    try {
      reservation = await carryTrial.authorizeAttempt(Object.freeze({
        attemptId, manifestSha256: carryTrial.manifestSha256, armId: carryTrial.armId,
        transport, accountId, target, body,
        bodySha256: createHash('sha256').update(init.body).digest('hex'),
        credentialHeader, credentialSha256: createHash('sha256').update(credential).digest('hex'),
        clockId: processMonotonicClock.id, signal: init.signal,
      }));
    } catch { throw trialRefusal(); } // Do not expose private controller errors.
    // Copy the receipt: mutation after return must not extend the send window.
    const receipt = reservation ? { ...reservation } : null;
    return () => {
      // Last synchronous check INSIDE the observed fetch callback, after any
      // authorization wait. Post-send headers-write evidence still judges the
      // actual D017 band; this is not proof of remote receipt or invoice cost.
      if (init.signal.aborted || !receipt || receipt.attemptId !== attemptId ||
        typeof receipt.reservationRef !== 'string' || !receipt.reservationRef.trim() ||
        receipt.clockId !== processMonotonicClock.id ||
        !Number.isFinite(receipt.validUntilMonotonicMs) ||
        processMonotonicClock.now() >= receipt.validUntilMonotonicMs) throw trialRefusal();
    };
  }
  const processStartedAt = Date.now();
  // EI-22038414992051268: the FALLBACK admission idempotency keys below are derived from
  // process-local sequence counters (`legacyAdmissionRequestSeq`, `gatewayAdmissionRequestSeq`,
  // and telemetry's own `span.requestId`) that all reset to 0 on every process start. Across a
  // gateway RESTART, a fresh process's first few requests can therefore compute the exact same
  // fallback key (e.g. `gateway:openai-responses:5`) as a DIFFERENT, unrelated request the prior
  // process admitted — and if that old durable admission record hasn't been reconciled away yet,
  // the new request's fingerprint mismatches the stored one and the durable queue rejects it with
  // AdmissionIdempotencyConflictError (surfaced to the caller as a proxy-handler 500). This
  // per-process instance id is folded into every FALLBACK key (never into an explicit
  // caller-supplied `x-papercusp-request-id`, which stays caller-owned) so two different process
  // incarnations can never coin the same fallback key, while the sequence counters still keep
  // keys unique WITHIN one process's lifetime exactly as before.
  const gatewayProcessInstanceId = randomUUID();
  // First request per owner is journaled as bounded startup-cache evidence (R-10): the 256-row
  // in-process ring spans only minutes, so a ten-launch cohort rolls out before it can be assessed.
  // `log` is initialised later in this closure but is only invoked at request-completion time.
  const requestStageTelemetry = new GatewayRequestTelemetry({
    onStartupEvidence: (line) => log('info', line),
  });
  interface RequestTelemetryState {
    span: GatewayRequestSpan;
    finished: boolean;
    shed: boolean;
    gatewayError: boolean;
  }
  const requestTelemetryByRequest = new WeakMap<http.IncomingMessage, RequestTelemetryState>();
  function beginRequestTelemetry(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    provider: GatewayTelemetryProvider,
    protocol: GatewayTelemetryProtocol,
    transport: GatewayTelemetryTransport = 'unknown',
  ): GatewayRequestSpan {
    const span = requestStageTelemetry.begin({
      ownerId: (req.headers[OWNER_HEADER] as string | undefined)?.trim() || null,
      provider,
      protocol,
      transport,
    });
    const state: RequestTelemetryState = { span, finished: false, shed: false, gatewayError: false };
    requestTelemetryByRequest.set(req, state);
    const finish = (closedBeforeFinish: boolean) => {
      if (state.finished) return;
      state.finished = true;
      span.endStage('stream');
      const hasStatus = res.headersSent || res.writableEnded;
      const finalStatus = hasStatus ? res.statusCode : null;
      span.finish(
        classifyGatewayTelemetryOutcome(finalStatus, {
          cancelled: closedBeforeFinish && !res.writableEnded,
          shed: state.shed,
          gatewayError: state.gatewayError,
        }),
        finalStatus,
      );
      requestTelemetryByRequest.delete(req);
    };
    res.once('finish', () => finish(false));
    res.once('close', () => finish(true));
    return span;
  }
  const requestSpan = (req: http.IncomingMessage): GatewayRequestSpan | undefined =>
    requestTelemetryByRequest.get(req)?.span;
  const markRequestShed = (req: http.IncomingMessage): void => {
    const state = requestTelemetryByRequest.get(req);
    if (state) state.shed = true;
  };
  const markRequestGatewayError = (req: http.IncomingMessage): void => {
    const state = requestTelemetryByRequest.get(req);
    if (state) state.gatewayError = true;
  };
  const upstreamBase = (deps.upstreamBase ?? DEFAULT_UPSTREAM).replace(/\/$/, '');
  const openaiUpstreamBase = (deps.openaiUpstreamBase ?? 'https://api.openai.com').replace(/\/$/, '');
  const doFetch = deps.fetchImpl ?? fetch;
  const doProbeEgress = deps.probeEgressImpl ?? probeEgress;
  // Proactive egress probing (gateway-rayobyte-hardening P-002): 0 disables. Default 45s — well under the
  // ~90s a dead squid needs to burn two live requests into the reactive circuit, cheap enough to run always.
  const proactiveEgressProbeMs =
    deps.proactiveEgressProbeMs ?? Number(process.env.PAPERCUSP_GATEWAY_PROACTIVE_PROBE_MS ?? 45_000);
  const maxQueueWaitMs = deps.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS;
  const requestAbsorbMs = deps.requestAbsorbMs ?? DEFAULT_REQUEST_ABSORB_MS;
  const interactiveAbsorbMs = deps.interactiveAbsorbMs ?? INTERACTIVE_ABSORB_MS;
  const internalRetryDeadlineMs = deps.internalRetryDeadlineMs ?? INTERNAL_RETRY_DEADLINE_MS;
  const bare429FailoverBackoffMs = deps.bare429FailoverBackoffMs ?? BARE_429_FAILOVER_BACKOFF_MS;
  const credential401DeadThreshold = deps.credential401DeadThreshold ?? DEFAULT_CREDENTIAL_401_DEAD_THRESHOLD;
  const orgDisallowedDeactivateThreshold =
    deps.orgDisallowedDeactivateThreshold ?? DEFAULT_ORG_DISALLOWED_DEACTIVATE_THRESHOLD;
  // P-010: this is a SEED — where a cold lane starts — not a cap. `deps.concurrency`
  // survives as a bootstrap input (P-012 migrates the deployment paths that still
  // pass it) but it no longer bounds anything: the lifecycle grows both lanes past
  // it under clean traffic.
  const admissionSeedWindow = Math.max(
    1,
    Math.floor(
      deps.concurrency !== undefined && Number.isFinite(deps.concurrency) && deps.concurrency > 0
        ? deps.concurrency
        : INITIAL_PROVIDER_ADMISSION_WINDOW,
    ),
  );
  // Default OFF: the LAUNCH layer (startGatewayService) opts production in from the env (like priorityTiers).
  // Off-by-default keeps every direct-construction unit test byte-identical (their tiny maxQueueWaitMs is
  // incompatible with second-scale pacing — a test opts in explicitly with a realistic maxQueueWaitMs).
  const smoothRpm = deps.smoothRpm ?? false;
  const upstreamHeadersTimeoutMs = deps.upstreamHeadersTimeoutMs ?? DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS;
  const upstreamStreamHeadersTimeoutMs =
    deps.upstreamStreamHeadersTimeoutMs ?? DEFAULT_UPSTREAM_STREAM_HEADERS_TIMEOUT_MS;
  const upstreamBodyIdleTimeoutMs = deps.upstreamBodyIdleTimeoutMs ?? DEFAULT_UPSTREAM_BODY_IDLE_TIMEOUT_MS;
  const tokenTimeoutMs = deps.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
  const downstreamIdleMs = deps.downstreamIdleMs ?? DEFAULT_DOWNSTREAM_IDLE_MS;
  const requestCeilingMs = deps.requestCeilingMs ?? DEFAULT_REQUEST_CEILING_MS;
  // Every log line passes through scrubSecrets — an upstream/runtime error message can embed a
  // live credential (the 2026-07-03 invalid-header 502 echoed a full sk-ant-oat token).
  const rawLog = deps.log ?? (() => {});
  const log: NonNullable<typeof deps.log> = (level, msg) => rawLog(level, scrubSecrets(msg));
  // P-002 compatibility seam: the canonical Governor records typed gateway
  // admission context, while the established provider queues below continue
  // to own live execution until the durable-driver migration lands.
  const gatewayAdmissionGovernor: GatewayAdmissionGovernor =
    deps.admissionGovernor ??
    new Governor(new AdmitImmediatelyDriver(), { bypassKeys: GATEWAY_ADMISSION_BYPASS_REGISTRY });
  const gatewayAdmissionParent = deps.admissionParent ?? null;
  let gatewayAdmissionRequestSeq = 0;
  // D-004 pre-acceptance body spool. Absent ⇒ legacy behaviour, byte-identical.
  const payloadSpool = deps.payloadSpool;
  /** Requests that carry a body worth spooling. GET/HEAD/DELETE have nothing to persist. */
  const METHODS_WITH_SPOOLABLE_BODY = new Set(['POST', 'PUT', 'PATCH']);
  let spooledPayloads = 0;
  let spooledPayloadBytes = 0;
  let spoolDedupes = 0;
  /**
   * Persist this request's body and return its `payloadRef`, BEFORE the admission decision.
   *
   * Returns undefined — meaning "carry no payloadRef", exactly as before this existed — when no
   * spool is configured, the method cannot carry a body, or the body is empty. Those are not
   * failures and must not be turned into one.
   *
   * Throws only what D-003 permits a request to fail on: an oversize body (the client's fault) or
   * a genuine inability to persist. Both are handled by the dispatch catch below; neither may be
   * swallowed into an admitted request the gateway cannot honour.
   */
  async function spoolRequestBodyForAdmission(req: http.IncomingMessage): Promise<string | undefined> {
    if (!payloadSpool) return undefined;
    if (!METHODS_WITH_SPOOLABLE_BODY.has((req.method ?? '').toUpperCase())) return undefined;

    // Reading here drains the stream; `readBody` serves the parked copy to the handler afterwards.
    const body = await readBody(req);
    setPreReadBody(req, body);
    if (body.byteLength === 0) return undefined;

    const result = await payloadSpool.spool(body, {
      contentType: (req.headers['content-type'] as string | undefined) ?? undefined,
    });
    if (result.payloadRef) {
      spooledPayloads += 1;
      spooledPayloadBytes += result.bytes;
      if (result.deduped) spoolDedupes += 1;
    }
    return result.payloadRef ?? undefined;
  }
  // D-003: "capacity pressure never returns QueueFullError/load-shed when persistence works."
  //
  // With the payload spool active, capacity pressure has to become a durable receipt rather than a
  // 429, so the in-memory BACKLOG CAP is switched off — 0 is PriorityAdmissionQueue's uncapped
  // sentinel (its shed test is `maxQueued > 0 && …`). maxConcurrent is untouched: concurrency
  // limiting is still this queue's job, and only the *rejection* is being retired.
  //
  // This does not reinstate the unbounded-backlog wedge the cap was added for. That cap existed
  // because every waiter pinned a request — and its body — in resident memory; the spool is
  // precisely what removes that, since a waiting request now holds a 64-char ref while its bytes
  // sit in Postgres. An explicit deps.maxQueued still wins, so a caller can restore the cap.
  const maxQueued = deps.maxQueued ?? (payloadSpool ? 0 : DEFAULT_MAX_QUEUED);
  const maintenanceModel = deps.maintenanceModel ?? DEFAULT_MAINTENANCE_MODEL;
  const maintenanceMaxTokens = deps.maintenanceMaxTokens ?? DEFAULT_MAINTENANCE_MAX_TOKENS;
  const maintenanceTimeoutMs = deps.maintenanceTimeoutMs ?? DEFAULT_MAINTENANCE_TIMEOUT_MS;
  const selfHealEnabled = deps.selfHeal?.enabled ?? DEFAULT_SELFHEAL_ENABLED;
  const selfHealFreezeMs = deps.selfHeal?.freezeMs ?? DEFAULT_SELFHEAL_FREEZE_MS;
  const selfHealPollMs = deps.selfHeal?.pollMs ?? DEFAULT_SELFHEAL_POLL_MS;
  // Priority-TIER layer (gateway-priority-tiers-2026-06-22, flag-gated upstream): when `deps.priorityTiers`
  // is present the queue gains per-tier in-flight caps + a reserved tier-1 floor; when absent it is a flat
  // priority+aging gate, byte-identical to before. `tierMap` resolves a request's `x-papercusp-priority`
  // role → its band; `baseTierCaps` is the steady-state ceiling the AIMD shrink sheds from (4→3→2 first).
  const tierLayer = deps.priorityTiers;
  // Codex has a smaller admission pool. Keep the fallback for direct callers that only know the
  // original `priorityTiers` option, while allowing launch.ts to provide a separately sized layer.
  const codexTierLayer = deps.codexPriorityTiers ?? tierLayer;
  const tiered = !!tierLayer;
  const codexTiered = !!codexTierLayer;
  const tierMap = tierLayer?.map;
  const codexTierMap = codexTierLayer?.map;
  /**
   * One absorb-budget calculation for every provider lane. The lane-neutral
   * recovery decision consumes only the resulting deadline; role/tier policy
   * stays here at the gateway boundary where request headers are available.
   */
  const absorbDeadlineForRequest = (req: http.IncomingMessage, requestTierMap: PriorityTierMap | undefined): number => {
    const priLabel = effectivePriorityLabel(req.headers);
    const reqTier = requestTierMap ? tierOf(priLabel ?? undefined, requestTierMap) : undefined;
    let effectiveMs = requestAbsorbMs > 0 ? Math.round(requestAbsorbMs * absorbTierFactor(reqTier)) : 0;
    if (
      interactiveAbsorbMs > 0 &&
      effectiveMs > interactiveAbsorbMs &&
      priLabel !== undefined &&
      HUMAN_PRIORITY_LABELS.has(priLabel)
    ) {
      effectiveMs = interactiveAbsorbMs;
    }
    return effectiveMs > 0 ? Date.now() + effectiveMs : 0;
  };
  /** Wait through gateway-owned recovery work without letting the downstream
   * idle timer kill a request whose silence is intentional. Abort wakes the
   * wait immediately so a disconnected caller never leaves a parked timer. */
  const waitForCodexRecovery = async (res: http.ServerResponse, waitMs: number, signal: AbortSignal): Promise<void> => {
    if (waitMs <= 0 || signal.aborted) return;
    res.setTimeout(downstreamIdleMs > 0 ? waitMs + downstreamIdleMs : 0);
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        timer.unref?.();
        signal.addEventListener('abort', finish, { once: true });
      });
    } finally {
      res.setTimeout(downstreamIdleMs);
    }
  };
  const baseTierCaps: Record<number, number> = { ...(tierLayer?.config.caps ?? {}) };
  const codexBaseTierCaps: Record<number, number> = { ...(codexTierLayer?.config.caps ?? {}) };
  const queue = new PriorityAdmissionQueue({
    maxConcurrent: admissionSeedWindow,
    agingIntervalMs: deps.agingIntervalMs,
    maxQueued,
    ...(tierLayer ? { tiers: tierLayer.config } : {}),
  });
  // ChatGPT-subscription bridge (codex-cli-bridge.ts): CLI-served codex accounts + the runner.
  const codexCliAccounts = () => deps.codexCliAccounts?.() ?? [];
  const codexCliPool = deps.codexCliPool;
  const codexCliRun = deps.codexCliRun ?? runCodexCliCompletion;
  const codexModelsCacheRead =
    deps.codexModelsCacheRead ?? ((home: string) => readFileSync(join(home, 'models_cache.json'), 'utf8'));
  const codexModelsCatalogTtlMs = Math.max(
    0,
    Math.floor(deps.codexModelsCatalogTtlMs ?? DEFAULT_CODEX_MODELS_CATALOG_TTL_MS),
  );
  const codexModelsCatalogTimeoutMs = Math.max(
    1,
    Math.floor(deps.codexModelsCatalogTimeoutMs ?? DEFAULT_CODEX_MODELS_CATALOG_TIMEOUT_MS),
  );
  const accountPoolSize = (accountPool?: AccountPool): number => {
    const size = accountPool?.size?.();
    if (typeof size === 'number' && Number.isFinite(size)) return Math.max(0, Math.floor(size));
    return accountPool?.entries?.().length ?? 0;
  };
  const codexAccountCount = () =>
    accountPoolSize(deps.codexPool) + (codexCliPool ? accountPoolSize(codexCliPool) : codexCliAccounts().length);
  // P-010: Codex no longer derives a DIFFERENT starting window from its account
  // count. Account arithmetic described serviceability, not physical capacity, and
  // clamping it to Claude's configured concurrency is precisely the "parallel
  // Claude-default / Codex-special capacity logic" this item deletes. Both lanes
  // now start from the same seed and are separated only by the outcomes they
  // actually observe. `codexAccountCount` remains for routing/telemetry.
  // WI-2198: when ON, a codex-cli account STREAMS /v1/responses via the OAuth reverse-proxy.
  const codexOAuthProxyEnabled = deps.codexOAuthProxy === true;
  const codexOAuthNonStreamEnabled = deps.codexOAuthNonStream ?? DEFAULT_CODEX_OAUTH_NONSTREAM;
  const codexOAuthNonStreamMaxBytes = Math.max(
    1,
    Math.floor(deps.codexOAuthNonStreamMaxBytes ?? DEFAULT_CODEX_OAUTH_NONSTREAM_MAX_BYTES),
  );
  const codexOAuthNonStreamTimeoutMs = resolveCodexOAuthNonStreamTimeoutMs(
    requestCeilingMs,
    deps.codexOAuthNonStreamTimeoutMs ?? DEFAULT_CODEX_OAUTH_NONSTREAM_TIMEOUT_MS,
  );
  const isCodexCliAccountId = (accountId: string) => codexCliAccounts().some((a) => a.accountId === accountId);
  const codexQueue = new PriorityAdmissionQueue({
    maxConcurrent: admissionSeedWindow,
    agingIntervalMs: deps.agingIntervalMs,
    maxQueued,
    ...(codexTierLayer ? { tiers: codexTierLayer.config } : {}),
  });

  // AIMD adaptive admission concurrency (B-GW-1 compatibility path): the queue's
  // maxConcurrent remains the legacy execution bound until the durable queue
  // migration; this controller shrinks the LIVE effective concurrency under sustained upstream 429s (driving queue.setMaxConcurrent
  // down → fewer concurrent upstream calls → lower per-IP RPM → the throttle eases, breaking the
  // retry-storm amplification) and additively recovers toward the cap as calls succeed. Fed by
  // aimd.recordThrottle() on each upstream 429 + aimd.recordSuccess() on each forwarded 2xx below.
  // SERVICEABLE-COUNT ADMISSION CLAMP (2026-06-23 thundering-herd fix): the AIMD cap reacts to admission-QUEUE
  // pressure, NOT to how many accounts can actually SERVE. When only 1-2 accounts are unpaused it would still
  // admit the full cap, so a resume-burst piles all of it onto the few healthy accounts and 429s them into a
  // cascade (the observed ownerhandle→definitelyahuman chain). `serviceableAdmissionCapFn` (assigned below, once the
  // pool + governors exist) still computes the old recommendation for diagnostics, but P-007 deliberately keeps
  // it out of `setMaxConcurrent`: serviceability is routing/causal evidence, not productive capacity.
  let serviceableAdmissionCapFn: () => number = () => Number.POSITIVE_INFINITY;
  // Compatibility readback for the retired serviceable clamp. Both modes are now
  // advisory; retaining the field lets older status consumers understand a
  // deploy-skewed response without allowing it to reinstate a hard cap.
  let clampMode: ServiceableClampMode = 'off';
  /** The clamp's most recent RECOMMENDATION (what it would cap to), recorded even when overridden. */
  let lastServiceableRecommendation = Number.POSITIVE_INFINITY;
  /** The RAW serviceable-account count behind the recommendation. Recorded so `/stats` can publish the
   *  clamp's INPUT and not only its output — `recommendation: 4` alone cannot tell a reader whether that
   *  came from one serviceable account or from the MIN floor. */
  let serviceableAccountsFn: () => number | null = () => null;
  let lastServiceableAccounts: number | null = null;

  // ────────────────────────────────────────────────────────────────────────────
  // P-010: ONE capless admission lifecycle for every provider lane.
  //
  // This replaces the two hand-kept AIMD controllers that used to live here — a
  // Claude one capped at `DEFAULT_CONCURRENCY` and a Codex one capped at an
  // account-scaled seed, each with its own apply-closure, its own floor
  // derivation and its own tier-shedding call. They were the same policy written
  // twice, and they had already drifted (the Codex lane clamped its effective
  // window to `min(codexConcurrency, eff)`; the Claude lane did not).
  //
  // Lanes share the POLICY and differ only in the outcomes they observe, so a
  // Codex 429 moves the Codex window and nothing else. The window has a floor and
  // no maximum: a lane whose traffic stays clean grows past its seed.
  // ────────────────────────────────────────────────────────────────────────────
  const providerAdmission = new ProviderAdmissionLifecycle({
    lanes: [
      { id: 'claude', queue, ...(tiered ? { baseTierCaps } : {}) },
      { id: 'codex', queue: codexQueue, ...(codexTiered ? { baseTierCaps: codexBaseTierCaps } : {}) },
    ],
    initialWindow: admissionSeedWindow,
    // The AIMD floor stays a floor — a minimum, never a maximum — so it is the one
    // legacy tuning input that survives P-010 unchanged.
    minimumWindow: deps.aimd?.floor ?? DEFAULT_AIMD_FLOOR,
    contractionFraction: deps.aimd?.decreaseFactor,
    contractionThreshold: deps.aimd?.decreaseThreshold ?? DEFAULT_AIMD_DECREASE_THRESHOLD,
    healthySamplesPerIncrease: deps.aimd?.increaseEvery ?? DEFAULT_AIMD_INCREASE_EVERY,
    log,
  });

  /**
   * Refresh the serviceable-clamp DIAGNOSTICS. P-007 retired the clamp as an
   * admission authority; these values are published so a reader can see the
   * recommendation and its input, and they never touch a queue.
   */
  const refreshServiceableDiagnostics = (): void => {
    lastServiceableRecommendation = serviceableAdmissionCapFn();
    lastServiceableAccounts = serviceableAccountsFn();
  };

  /**
   * AIMD-shaped view of a lane for status consumers written against the retired
   * controllers. `cap` reports the lane's own HIGH-WATER MARK — the most it has
   * ever sustained — because no configured maximum exists any more. Reading it as
   * a ceiling is wrong; it is evidence.
   */
  const laneAimdSnapshot = (lane: ProviderLaneId): AimdSnapshot => {
    const s = providerAdmission.snapshotFor(lane);
    return {
      effective: s.window,
      cap: s.observedPeak,
      floor: s.minimumWindow,
      pressure: s.pressure,
      cleanStreak: s.cleanStreak,
      decreases: s.contractions,
      increases: s.expansions,
      hardFailures: s.hardFailures,
      // PER-PROCESS, not lifetime: these three come from ProviderAdmissionLifecycle lane counters that are
      // reset when the gateway process restarts. Publishing the epoch beside them is what stops a reader
      // taking `decreases: 0` on a freshly-restarted gateway as "this lane has never contracted"
      // (EI-21842988251907640; the same class of misreading admission-ceiling.ts's header documents).
      countersSinceMs: s.countersSinceMs,
    };
  };

  // A single-account deps set synthesizes a one-entry, no-failover pool; a real `pool` supersedes it.
  const pool: AccountPool =
    deps.pool ??
    (() => {
      const accountId = deps.accountId;
      const token = deps.token;
      if (!accountId || !token)
        throw new Error('inference-gateway: createInferenceGateway needs a `pool` or accountId+token');
      const single: ActiveAccount = { accountId, token, invalidateToken: deps.invalidateToken };
      return { active: () => single, onExhausted: () => null };
    })();
  const providerAdapterOptions = {
    claudePool: pool,
    codexPool: deps.codexPool ?? null,
    // Codex CLI-bridge accounts live OUTSIDE the bearer pool; count them toward codex
    // availability so an all-CLI codex deployment doesn't read "not configured" (WI-3068).
    codexCliAccountCount: () => codexCliAccounts().length,
    anthropicUpstreamBase: upstreamBase,
    openaiUpstreamBase,
  };
  const gatewayLaneRegistry = makeGatewayLaneRegistry(providerAdapterOptions);
  const providerAdapters = makeGatewayProviderAdapters(providerAdapterOptions);

  // Governor is per (model, account). Reading the active account at call time means a failover
  // transparently moves pacing onto the new account's fresh bucket. The QUEUE is the concurrency
  // authority, so make the governor's own concurrency cap non-binding (raise it to the queue cap)
  // and let the governor enforce only rate/pause/pace — safe in the gateway's own process.
  const governorForAccount = (model: string, accountId: string): RateLimitGovernor => {
    // EI-2648: thread `accountId` into the injected factory too. The default branch already keys
    // by account; without this the injected branch could not, so a test double had no way to make
    // a penalty persist for one account across retries (the absorb's whole subject).
    const g = deps.governorFor
      ? deps.governorFor(model, accountId)
      : governorForBackend('claude-code', model, undefined, accountId);
    // The QUEUE is the concurrency authority, so the governor's own concurrency
    // limit must stay non-binding. It now tracks the LIVE learned window rather
    // than a configured cap, so a lane that grows past its seed does not start
    // tripping the governor it was supposed to have been freed from.
    const liveWindow = providerAdmission.windowFor('claude');
    if (g.state.limits.maxConcurrent < liveWindow) g.state.limits.maxConcurrent = liveWindow;
    // Smooth the static-floor RPM allowance into an even pace (subscription accounts return no per-minute
    // headers, so paceDelayMs stays 0 → the count gate alone lets effRpm fire as an instant burst that trips
    // the sub-minute burst limit). Gateway-only opt-in; the fleet concurrency governor is left untouched.
    g.state.smoothRpm = smoothRpm;
    return g;
  };

  // The SINGLE pool-wide serviceability count (EI-11511): accounts that can SERVE a request right now — in
  // rotation (no hard-429 / transport-circuit pause `active()` round-robins over) AND whose governor for the
  // representative model (SERVICEABLE_CLAMP_MODEL) isn't predictively paused (near its rolling cap — e.g. a
  // weekly 5h/7d usage wall at util≈1.0, which sets a bounded re-probe pause). Both the serviceable-admission
  // clamp AND `/stats.healthyAccounts` derive from THIS, so the capacity oracle (fleet:capacity, WI-390 spawn-
  // readiness) counts accounts ACTUALLY usable now — not merely "not circuit-paused". Before EI-11511 `/stats`
  // reported the un-narrowed `pool.healthyCount()`, so it read healthyAccounts:7/abundant while 6 of 7 were
  // weekly-usage-walled (util7d=1.0) — fleet:capacity then advised placing broadly into a days-walled pool.
  // `null` when the pool exposes no healthyCount (single-account pool) → the callers report 1.
  const serviceableHealthyCount = (): number | null => {
    if (!pool.healthyCount) return null;
    const now = Date.now();
    return pool.healthyCount((id) => governorForAccount(SERVICEABLE_CLAMP_MODEL, id).state.pausedUntil <= now);
  };

  // Fix 2 (serviceable-count admission clamp): now that `pool` + `governorForAccount` exist, give the clamp its
  // real implementation + start the periodic re-clamp. An account is SERVICEABLE iff the pool has it in rotation
  // (no hard-429 / transport-circuit pause — what `active()` round-robins over) AND its governor for the
  // representative model isn't predictively paused (near its rolling cap). Conservative by design: a tighter
  // count → a tighter clamp → safer under a storm; the MIN floor still lets the pool probe its way back.
  serviceableAdmissionCapFn = () => {
    const serviceable = serviceableHealthyCount();
    // The serviceable count is retained as causal/routing evidence. It is not a
    // productive-capacity formula, so even zero/unknown observations never feed
    // a minimum or maximum into the admission queue.
    if (serviceable == null) return Number.POSITIVE_INFINITY;
    return serviceableAdmissionFor(serviceable);
  };
  serviceableAccountsFn = () => serviceableHealthyCount() ?? null;
  // Apply the controller once now that the serviceability observer is wired. The
  // recommendation is recorded for `/stats` but cannot alter the productive
  // window; this also seeds the diagnostic readback from t=0.
  refreshServiceableDiagnostics();

  // G1 (WI-649): FLEET-WIDE bare-burst detector. True when ≥half the pool is currently OUT OF ROTATION
  // (pool.exhaustedUntil — the short bare-429 paces / hard caps / transport circuits that other in-flight
  // requests already rotated off), i.e. rotating this bare-429 onto "another" account would find no capacity
  // and just multiply upstream load. Reads the POOL's own rotation state (NOT the per-account governor) so it
  // stays correct under a shared-governor test pool, and counts the CURRENT (just-bursted) account as still
  // available (its onExhausted hasn't run yet) — so a LONE account bursting in an otherwise-healthy pool (the
  // few-maxed→rotate-to-healthy case) is never mistaken for a fleet-wide storm.
  const recentBareBurstByAccount = new Map<string, number>();
  const noteRecentBareBurstCluster = (accountId: string): boolean => {
    if (!SUPPRESS_BAREBURST_ROTATE_ON || !pool.size) return false;
    const total = pool.size();
    if (total < 2) return false; // single-account pool: nothing to rotate to anyway
    const now = Date.now();
    const cutoff = now - BAREBURST_CLUSTER_WINDOW_MS;
    for (const [id, ts] of recentBareBurstByAccount) {
      if (ts < cutoff) recentBareBurstByAccount.delete(id);
    }
    recentBareBurstByAccount.set(accountId, now);
    // Quarter-pool is the ramp detector (8 accounts ⇒ 2 accounts); min 2 avoids mistaking one
    // account's lone transient for a fleet-wide edge throttle.
    const threshold = Math.min(total, Math.max(BAREBURST_CLUSTER_MIN_ACCOUNTS, Math.ceil(total / 4)));
    return recentBareBurstByAccount.size >= threshold;
  };

  const isFleetWideBareBurst = (): boolean => {
    if (!SUPPRESS_BAREBURST_ROTATE_ON || !pool.healthyCount || !pool.size) return false;
    const total = pool.size();
    if (total < 2) return false; // single-account pool: nothing to rotate to anyway
    return pool.healthyCount() * 2 <= total; // ≤half the pool has rotation budget ⇒ ≥half is penalized
  };
  // No timer-driven clamp remains. Recommendation fields are refreshed by the
  // normal admission/stat paths; a stale serviceability read cannot mutate the
  // productive queue window in the background.
  const serviceableClampTimer = undefined;

  // Per-account egress dispatchers (per-account IP routing — D-003): a Max subscription can be pinned
  // to its own outbound IP via an HTTP/SOCKS proxy or a bound source address, so N subscriptions don't
  // all share one egress IP. Built lazily from undici + cached per (accountId + binding).
  const dispatcherCache = new Map<string, UndiciDispatcher>();
  let undiciMod: typeof import('undici') | undefined;
  async function dispatcherFor(
    account: ActiveAccount,
    eg: AccountEgress | undefined = account.egress,
  ): Promise<UndiciDispatcher | undefined> {
    // PROXY KILL-SWITCH CHOKEPOINT (egress-proxy-toggle / gateway-rayobyte-hardening, 2026-07-01): when
    // proxy egress is disabled, NO caller may build a proxy dispatcher — including callers that passed no
    // entry and landed on the `= account.egress` DEFAULT PARAMETER above. That default was the leak: the
    // request path's pickEgress correctly filtered every proxy entry and passed `entry: undefined`, but an
    // explicit `undefined` re-triggers the default, so disabled accounts kept dialing their squids (observed
    // live 22:33: ownerhandle6's 216.41.233.249:3128 in use minutes after ?proxy=off). Guarding HERE covers every
    // call site — request path, OpenAI proxy, and anything added later. A localAddress-only egress (a bound
    // source IP, not a datacenter proxy) is deliberately still honored.
    if (proxyEgressDisabled && eg?.proxyUrl) eg = eg.localAddress ? { ...eg, proxyUrl: undefined } : undefined;
    if (!eg || (!eg.proxyUrl && !eg.localAddress)) return undefined;
    // Two forward-proxy schemes are honored: http(s):// (undici's ProxyAgent, HTTP-CONNECT) and
    // socks5://|socks:// (undici's Socks5ProxyAgent, native SOCKS5 — WI-284). ANY other scheme
    // (e.g. ftp://) would CONSTRUCT without error via the old ProxyAgent-only path but fail at
    // REQUEST time (the proxy rejects the HTTP CONNECT), silently 502-ing every request for this
    // account — so it is IGNORED with a loud warning and we fall through to a bound source IP
    // (localAddress) if set, else default shared egress — fail SAFE, never silently break an
    // account. Kept IN LOCKSTEP with the canonical egress-dispatcher.ts (see its header note).
    const httpProxy = egressIsHttpProxy(eg.proxyUrl) ? eg.proxyUrl : undefined;
    const socks5Proxy = !httpProxy && egressIsSocks5Proxy(eg.proxyUrl) ? eg.proxyUrl : undefined;
    if (eg.proxyUrl && !httpProxy && !socks5Proxy) {
      log(
        'warn',
        `inference-gateway: egress proxyUrl for '${account.accountId}' ('${eg.proxyUrl}') is neither http(s) nor socks5 — ignoring it`,
      );
    }
    if (!httpProxy && !socks5Proxy && !eg.localAddress) return undefined;
    const key = egressCacheKey(account.accountId, eg);
    const hit = dispatcherCache.get(key);
    if (hit) return hit;
    try {
      undiciMod ??= await import('undici');
      const d: UndiciDispatcher = httpProxy
        ? new undiciMod.ProxyAgent(httpProxy)
        : socks5Proxy
          ? new undiciMod.Socks5ProxyAgent(socks5Proxy)
          : new undiciMod.Agent({ connect: { localAddress: eg.localAddress } });
      dispatcherCache.set(key, d);
      return d;
    } catch (e) {
      log(
        'warn',
        `egress dispatcher for '${account.accountId}' failed (${(e as Error).message}); using default egress`,
      );
      return undefined;
    }
  }

  // Egress circuit-breaker state (B-GW-EGRESS, 2026-06-20 dead-proxy wedge): per-account consecutive
  // upstream TRANSPORT-failure streak (a stall/abort/connect-fail carries NO HTTP status, so unlike a
  // 429 it never fed account health → a DEAD egress proxy scored "healthiest" + got flooded + overrode
  // pins). Reset on any upstream RESPONSE (even a 429 — the proxy works). A streak ≥ threshold opens the
  // account's circuit via gov.pausedUntil (the same lever the 429 hard-cap uses). `egressProbePending`
  // dedupes the half-open probe.
  const egressFailStreak = new Map<string, number>();
  /** Consecutive bare-429 streak per account → the BARE-429 PERSISTENCE CIRCUIT (auto-route-around). Reset on 2xx. */
  const bare429Streak = new Map<string, number>();
  /** Account-level edge pause deadline, distinct from quota utilization. A hard pin with no sibling IP
   * falls through to the account circuit; keep that live evidence visible to accounts:status. */
  const bare429PauseUntil = new Map<string, number>();
  const egressProbePending = new Set<string>();
  // FLAPPING BACKOFF state (2026-06-22): per-account reopen count + last-open time, so a proxy that keeps
  // reopening soon after readmit gets a progressively longer circuit-open (decays via EGRESS_FLAP_RESET_MS).
  const egressReopenCount = new Map<string, number>();
  const egressLastOpenAt = new Map<string, number>();
  // Per-account egress transport-failure TALLY (2026-06-22 audit) — surfaced in /stats so an operator can see
  // WHICH proxy is failing and fix the right one. The journald 'EGRESS CIRCUIT OPEN' logs are unreliable, so
  // this is the durable, log-independent culprit signal for the Rayobyte fix.
  const egressFailsByAccount = new Map<string, number>();
  // Per-account upstream ATTEMPT tally — the DENOMINATOR for egressFailsByAccount, so /stats can surface a
  // VOLUME-FAIR egress failure RATE (2026-06-22 audit). Raw fail counts rank the BUSIEST proxy worst (the
  // hand-triaged "ownerhandle is the culprit" was just the busiest account); the normalized rate finds the true
  // dead proxy — a low-traffic account failing 95% of its few attempts. Counts every attempt that reaches the
  // egress dial (post token-refresh), so a single bee request that failover-rotates increments once per account.
  const egressAttemptsByAccount = new Map<string, number>();
  /** Per-account TRANSPORT pause the egress circuit set (= the resetAt handed to gov.penalize), so the
   *  half-open probe can lift exactly THAT pause on recovery without ever shortening a real 429 pause. */
  const egressPauseUntil = new Map<string, number>();
  /** CREDENTIAL-HEALTH state (#5 PART A): per-account CONSECUTIVE upstream-401 streak. The gateway's 401
   *  handler drops+refreshes the cached token; if the refresh keeps yielding the SAME invalid credential it
   *  just 401s again — a SILENT dead-credential outage (spawns/evals die "produced no turn", no fleet alert).
   *  We count consecutive 401s per account and, the FIRST time the streak crosses credential401DeadThreshold,
   *  fire the loud `onCredentialDead` side-channel ONCE per episode. RESET on the next successful auth (a 2xx
   *  for that account — see the 2xx success path), which re-arms the alert for a later episode. */
  const credential401Streak = new Map<string, number>();
  /** WI-10003306: Codex (account, model) pairs the ChatGPT backend has refused. Selection routes
   *  around them per model; entries lapse on a TTL and clear on the next 2xx, so an account marked
   *  here is never removed from the pool and never needs a manual flip to come back. */
  const codexModelRefusals = createCodexModelRefusalRegistry();
  const orgDisallowedStreak = new Map<string, number>();
  // ── Per-account egress IP POOL rotation (gateway-per-account-egress-ip-pool-2026-06-30) ──────────────
  // An account can carry a POOL of egress IPs (ActiveAccount.egressPool). The gateway round-robins an
  // account's upstream across its IPs, and a bare-burst 429 (Cloudflare per-IP edge throttle) / transport
  // failure cools ONLY the IP that hit it — the SAME account/credential then retries on a sibling IP. So a
  // per-IP throttle no longer pauses the whole account, and a HARD pin rides its account's IP pool instead
  // of erroring on its one throttled IP. The existing account-level circuit (gov.pausedUntil / egressPauseUntil)
  // still fires — but only once ALL of an account's IPs are cooled, so a 0/1-IP account is byte-identical.
  const IP_TRANSPORT_COOLDOWN_MS = EGRESS_CIRCUIT_OPEN_MS; // a transport-failed egress IP rests this long
  const IP_COOLDOWN_MAX_MS = BARE429_CIRCUIT_MAX_MS; // ceiling for the escalating bare-429 per-IP cooldown
  // EI-18791887279744938 (defect A) — ceiling for the escalating per-IP TRANSPORT-failure cooldown, mirroring
  // the account-level flapping-backoff cap (EGRESS_CIRCUIT_OPEN_MAX_MS) rather than the (much shorter)
  // bare-429 ceiling: a transport failure means the proxy is unreachable, not merely edge-throttled, so it
  // deserves the SAME long-exile ceiling a chronically-flapping account already escalates toward.
  const IP_TRANSPORT_COOLDOWN_MAX_MS = EGRESS_CIRCUIT_OPEN_MAX_MS;
  const egressCursor = new Map<string, number>(); // per-account round-robin cursor over its egress IPs
  const ipCooldownUntil = new Map<string, number>(); // per-egress-IP key (egressCacheKey) → cooldown-until (epoch ms)
  const ipBare429Streak = new Map<string, number>(); // per-egress-IP consecutive bare-429s → escalating cooldown
  // EI-18791887279744938 (defect A): the TRANSPORT-failure sibling of ipBare429Streak. Before this, coolIp()
  // for a transport failure always used the SAME FIXED IP_TRANSPORT_COOLDOWN_MS — so a permanently-dead egress
  // (not merely flapping) was readmitted into pickEgress rotation on a constant cycle FOREVER, burning a full
  // transport timeout (~12s measured) on roughly half of all upstream attempts against a 2-entry pool. This
  // streak lets a hard-down IP's cooldown escalate (doubling, capped) toward effectively-removed, while a
  // genuinely-flapping one still recovers at the base pace (a real transport success clears the streak).
  const ipTransportFailStreak = new Map<string, number>();
  const egDesc = (eg?: AccountEgress): string =>
    eg?.proxyUrl ?? (eg?.localAddress ? `src ${eg.localAddress}` : 'default-egress');
  const coolIp = (key: string, ms: number): void => {
    ipCooldownUntil.set(key, Math.max(ipCooldownUntil.get(key) ?? 0, Date.now() + ms)); // take-MAX: never shorten
  };
  // Dynamic egress mode (egress-proxy-toggle-2026-06-30): operator-flippable kill-switch for the datacenter
  // PROXY egress IPs. When DISABLED, every account DROPS its proxyUrl pool entries so all upstream egresses
  // through the BOX's own outbound IP(s) — the stopgap for a Cloudflare per-IP EDGE throttle (bare-burst 429s,
  // cf-ray, no retry-after) hammering the shared datacenter proxy IPs while the box IP carries different edge
  // reputation. Seeded from PAPERCUSP_GATEWAY_DISABLE_PROXY_EGRESS; live-flippable (no restart) via
  // POST /admin/egress-mode?proxy=on|off (GET to read). An account left with no entry falls back to the
  // default box egress, so box-IP-only is always reachable.
  let proxyEgressDisabled =
    process.env.PAPERCUSP_GATEWAY_DISABLE_PROXY_EGRESS === '1' ||
    process.env.PAPERCUSP_GATEWAY_DISABLE_PROXY_EGRESS?.toLowerCase() === 'true';
  /** egressEntries(account) with proxy (proxyUrl) entries dropped when proxy egress is disabled. */
  const effectiveEgressEntries = (account: ActiveAccount): AccountEgress[] => {
    const entries = egressEntries(account);
    return proxyEgressDisabled ? entries.filter((e) => !e.proxyUrl) : entries;
  };
  /** All credential pools that share this gateway's transport/health plane. Keep the pool objects
   *  distinct (a deployment may intentionally reuse one pool for two provider adapters), and keep
   *  account ids distinct so shared observability never double-counts a credential. */
  const providerPools = (): AccountPool[] => {
    const out: AccountPool[] = [];
    for (const candidate of [pool, deps.codexPool, codexCliPool]) {
      if (candidate && !out.includes(candidate)) out.push(candidate);
    }
    return out;
  };
  const providerAccounts = (claudeFallback: ActiveAccount): ActiveAccount[] => {
    const byId = new Map<string, ActiveAccount>();
    for (const providerPool of providerPools()) {
      const entries =
        providerPool.entries?.() ??
        (providerPool.peek ? [providerPool.peek()] : providerPool === pool ? [claudeFallback] : []);
      for (const account of entries) byId.set(account.accountId, account);
    }
    return [...byId.values()];
  };
  /** The egress-probe TRANSPORT recovery readmit. Bounded by the circuit-open ceiling: a transport circuit
   *  can only ever have parked an account for at most EGRESS_CIRCUIT_OPEN_MAX_MS, so a park longer than
   *  that is a measured usage WALL (a 5h/7d 429 reset) a healthy proxy does not cure. Unbounded, every
   *  successful probe readmitted the whole walled pool and the fleet re-burned each account
   *  (codex-auto-route-all-walled-fail-fast-2026-09-05 P-005 / D-001). */
  const readmitProviderAccount = (accountId: string): void => {
    for (const providerPool of providerPools()) {
      const entries = providerPool.entries?.();
      const belongs = entries
        ? entries.some((entry) => entry.accountId === accountId)
        : providerPool.peek?.().accountId === accountId || providerPool === pool;
      if (belongs) providerPool.readmit?.(accountId, { reason: 'transport', maxParkMs: EGRESS_CIRCUIT_OPEN_MAX_MS });
    }
  };
  /**
   * EI-18791887279744938 (defect B) — pool-wide egress-PROXY reachability. Deliberately computed from the
   * SAME `ipCooldownUntil` map `pickEgress` reads, so this can never diverge from what routing actually
   * sees: a proxy entry counts as reachable iff `pickEgress` would currently be willing to pick it.
   * `fallback` covers a pool with no `entries()` (a single-account pool — the common test/dev shape).
   */
  function computeEgressProxyHealth(fallback: ActiveAccount): {
    totalProxyEntries: number;
    reachableProxyEntries: number;
    allDown: boolean;
    configured: boolean;
  } {
    const now = Date.now();
    let totalProxyEntries = 0;
    let reachableProxyEntries = 0;
    for (const account of providerAccounts(fallback)) {
      for (const entry of effectiveEgressEntries(account)) {
        if (!entry.proxyUrl) continue;
        totalProxyEntries++;
        const key = egressCacheKey(account.accountId, entry);
        const cooled = (ipCooldownUntil.get(key) ?? 0) > now;
        // A cooldown EXPIRING is permission to RETRY, not evidence of health — and counting it as
        // reachable made this alarm cancel itself (EI-18664933641195210). Measured 2026-08-11: 147
        // "EGRESS ALARM" + 147 "pool RECOVERED" in 24h while all three proxies were hard-refused the
        // whole time, so every recovery was FALSE and a 16-day outage read as routine flapping. An
        // entry counts as reachable only once a real transport SUCCESS clears its fail streak
        // (cleared alongside the cooldown at the success sites); an entry never yet tried has no
        // streak and still counts reachable, so a fresh boot is unchanged.
        const unprovenSinceFailure = (ipTransportFailStreak.get(key) ?? 0) > 0;
        if (!cooled && !unprovenSinceFailure) reachableProxyEntries++;
      }
    }
    return {
      totalProxyEntries,
      reachableProxyEntries,
      // No proxy configured, or the operator kill-switch is on ⇒ there is no proxy PATH to be down.
      allDown: !proxyEgressDisabled && totalProxyEntries > 0 && reachableProxyEntries === 0,
      // EI-19962845612125031: false ⇒ there is no proxy path to judge at all (zero entries, or the
      // kill-switch is on) — `allDown` is vacuously false in that case and callers must check THIS
      // field, not `allDown`, to tell "no proxy egress configured" apart from "proxy egress healthy".
      configured: !proxyEgressDisabled && totalProxyEntries > 0,
    };
  }
  // Edge-triggered — fires ONCE on the transition into "every proxy egress entry is currently cooled",
  // and once on recovery, instead of re-logging on every failed attempt while the outage persists.
  let egressAllProxiesDownAlarmed = false;
  function checkEgressProxyHealthAlarm(fallback: ActiveAccount): void {
    const health = computeEgressProxyHealth(fallback);
    if (health.allDown && !egressAllProxiesDownAlarmed) {
      egressAllProxiesDownAlarmed = true;
      log(
        'error',
        `inference-gateway: EGRESS ALARM — all ${health.totalProxyEntries} proxy egress ${health.totalProxyEntries === 1 ? 'entry is' : 'entries are'} currently unreachable (transport-cooled); every proxy-egress account is failing or has failed over to box-direct egress (EI-18791887279744938)`,
      );
    } else if (!health.allDown && egressAllProxiesDownAlarmed) {
      egressAllProxiesDownAlarmed = false;
      log(
        'warn',
        `inference-gateway: egress proxy pool RECOVERED — ${health.reachableProxyEntries}/${health.totalProxyEntries} proxy entries reachable again`,
      );
    }
  }
  /** Does `account` have an egress IP OTHER than `currentKey` that is off cooldown right now? */
  const siblingEgressAvailable = (account: ActiveAccount, now: number, currentKey: string): boolean => {
    const entries = effectiveEgressEntries(account);
    if (entries.length <= 1) return false;
    return entries.some((e) => {
      const k = egressCacheKey(account.accountId, e);
      return k !== currentKey && (ipCooldownUntil.get(k) ?? 0) <= now;
    });
  };
  /** Pick the egress IP this attempt egresses through: round-robin from the account's cursor, preferring an
   *  off-cooldown IP; if every IP is cooled, return the cursor IP (last resort — the account-level circuit
   *  fallback handles all-IPs-down). 0 entries ⇒ default egress; 1 entry ⇒ that entry (no cursor churn). */
  const pickEgress = (account: ActiveAccount, now: number): { entry: AccountEgress | undefined; key: string } => {
    const entries = effectiveEgressEntries(account);
    if (entries.length === 0) return { entry: undefined, key: egressCacheKey(account.accountId, undefined) };
    if (entries.length === 1) return { entry: entries[0], key: egressCacheKey(account.accountId, entries[0]) };
    const start = (egressCursor.get(account.accountId) ?? 0) % entries.length;
    let chosenIdx = start;
    for (let i = 0; i < entries.length; i++) {
      const idx = (start + i) % entries.length;
      if ((ipCooldownUntil.get(egressCacheKey(account.accountId, entries[idx])) ?? 0) <= now) {
        chosenIdx = idx;
        break;
      }
    }
    egressCursor.set(account.accountId, (chosenIdx + 1) % entries.length); // advance so the next attempt tries a different IP
    const entry = entries[chosenIdx];
    return { entry, key: egressCacheKey(account.accountId, entry) };
  };
  /** Half-open egress probe: after a circuit opens, re-test the account's proxy (egress-probe.ts) on a short
   *  LOOP. On the FIRST success it LIFTS the transport pause IMMEDIATELY — clears the streak, lifts the
   *  governor's transport pause (gov.liftTransportPause, a no-op if a real 429 pause superseded it), and
   *  readmits the account to the round-robin — so a flaky proxy that recovers in seconds rejoins rotation in
   *  seconds, NOT at the full circuit-window expiry. Before 2026-06-21 the probe only cleared the streak and
   *  the account waited the whole window (take-MAX pausedUntil can't be shortened) — which kept the only
   *  token-healthy accounts out together → empty-pool "all throttled" sheds. Keeps probing until recovery OR
   *  the circuit pause expires (bounded fallback). Best-effort, unref'd, never throws into the request path.
   *  `EGRESS_PROBE_DELAY_MS=0` disables it (pause-expiry half-open still applies). */
  function scheduleEgressProbe(account: ActiveAccount, gov: RateLimitGovernor | undefined, pausedUntil: number): void {
    // Proxy kill-switch: probing a squid we will not route through is pure log noise. A circuit pause left
    // un-lifted is bounded (≤EGRESS_CIRCUIT_OPEN_MAX_MS) and irrelevant while disabled; re-enabling proxies
    // resumes probing on the next circuit event.
    if (proxyEgressDisabled) return;
    if (EGRESS_PROBE_DELAY_MS <= 0 || egressProbePending.has(account.accountId)) return;
    egressProbePending.add(account.accountId);
    let probeSuccessStreak = 0; // consecutive OK probes; readmit only at EGRESS_PROBE_READMIT_STREAK (flap filter)
    const runProbe = (): void => {
      const t = setTimeout(() => {
        void (async () => {
          let readmitted = false;
          try {
            const probe = await doProbeEgress({ id: account.accountId, egress: account.egress } as ClaudeAccount, {
              timeoutMs: EGRESS_PROBE_HTTP_TIMEOUT_MS,
            });
            if (probe.exitIp) {
              probeSuccessStreak++;
              if (probeSuccessStreak >= EGRESS_PROBE_READMIT_STREAK) {
                egressFailStreak.delete(account.accountId);
                // H8 (inference-gateway-audit-2026-06-23): a CONFIRMED recovery (2 stable probes) resets the flap
                // escalation. Clearing the reopen count + last-open stamp means a LATER isolated blip re-opens at the
                // BASE backoff (~20s), not the escalated 2**reopen exile (up to 5min). A genuinely-flapping proxy
                // can't pass 2 stable probes, so it never reaches here — only a real recovery clears the history,
                // so sparse unrelated blips on a recovered-and-serving account stop compounding into a long exile.
                egressReopenCount.delete(account.accountId);
                egressLastOpenAt.delete(account.accountId);
                gov?.liftTransportPause(egressPauseUntil.get(account.accountId) ?? pausedUntil); // C3: lift the LIVE pause (an escalated reopen extends it past the captured value); no-op if a real 429 superseded it (undefined when the PROACTIVE prober opened the circuit — it never penalized a governor)
                readmitProviderAccount(account.accountId); // rejoin the owning provider pool's round-robin
                egressPauseUntil.delete(account.accountId);
                readmitted = true;
                log(
                  'warn',
                  `inference-gateway: egress probe for '${account.accountId}' RECOVERED (exit ${probe.exitIp}) after ${probeSuccessStreak} stable probes — readmitted`,
                );
              } else {
                log(
                  'warn',
                  `inference-gateway: egress probe for '${account.accountId}' OK ${probeSuccessStreak}/${EGRESS_PROBE_READMIT_STREAK} — confirming stability before readmit`,
                );
              }
            } else {
              // H10 (inference-gateway-audit-2026-06-23): DECREMENT, don't hard-reset. One slow/failed probe (a box
              // under load makes probes legitimately take 1.3–6.1s) would otherwise perpetually restart the 2-strict-
              // consecutive streak, so a recovered-but-jittery proxy never readmits before its pause elapses. A
              // leaky count (success +1, fail −1) still readmits a mostly-healthy proxy and keeps a dead one at 0.
              probeSuccessStreak = Math.max(0, probeSuccessStreak - 1);
              log(
                'warn',
                `inference-gateway: egress probe for '${account.accountId}' STILL DOWN (${probe.error ?? 'no exit IP'}) — stays circuit-paused`,
              );
            }
          } catch (err) {
            probeSuccessStreak = Math.max(0, probeSuccessStreak - 1); // H10: decrement (tolerate a transient probe error), not hard-reset
            log('warn', `inference-gateway: egress probe error for '${account.accountId}': ${(err as Error).message}`);
          } finally {
            // Keep probing until the proxy is CONFIRMED stable (readmitted) OR the circuit pause expires.
            // C3 (2026-06-23): compare against the LIVE deadline (egressPauseUntil), NOT the captured `pausedUntil`
            // from the FIRST open. An escalated reopen extends egressPauseUntil to a LONGER deadline; the stale
            // constant would stop the probe early, stranding a now-longer-paused account with NO active probe → it
            // sits out the full escalated backoff even after the proxy recovers (defeating the half-open mechanism
            // for exactly the chronically-flapping proxies it exists for). The live map is the source of truth.
            if (!readmitted && Date.now() < (egressPauseUntil.get(account.accountId) ?? pausedUntil)) runProbe();
            else egressProbePending.delete(account.accountId);
          }
        })();
      }, EGRESS_PROBE_DELAY_MS);
      t.unref?.();
    };
    runProbe();
  }

  // PROACTIVE EGRESS PROBING (gateway-rayobyte-hardening P-002): the reactive circuit above only opens
  // AFTER two live requests have burned on a dead proxy (each costing a caller a transport error / stall
  // absorb). This background loop probes every Claude, bearer-Codex, and ChatGPT-subscription account's
  // PROXY egress while it is IDLE — an account
  // that served real traffic within the last tick already proved its route (`lastEgressOkAt`), and an
  // account whose circuit is already open is the half-open prober's job. Two consecutive proactive
  // failures open the egress circuit exactly like the reactive path (pause + half-open recovery probe),
  // so a Rayobyte squid that dies while its account is idle is out of rotation BEFORE the next live
  // request would have failed on it. No governor is penalized (there is no request/model context) — the
  // `egressPauseUntil` map alone steers selection (keyOf ⇒ Infinity) and pin-yield away from the account.
  const lastEgressOkAt = new Map<string, number>();
  const proactiveProbeFailStreak = new Map<string, number>();
  let proactiveProbeLastTickAt = 0;
  let proactiveProbeOpens = 0;
  async function proactiveEgressProbeTick(): Promise<void> {
    const claudeFallback = pool.peek ? pool.peek() : pool.active();
    const entries = providerAccounts(claudeFallback);
    if (!entries.length) return;
    proactiveProbeLastTickAt = Date.now();
    await Promise.allSettled(
      entries.map(async (account) => {
        const id = account.accountId;
        const now = Date.now();
        // Resolve the proxy route from the EFFECTIVE POOL, not the legacy singular `account.egress`
        // (EI-18664933641195210). Reading `account.egress?.proxyUrl` here early-returned for every
        // pool-configured account — so this prober never ran, and the DEAD-PROXY watchdog it feeds went
        // silent from 2026-06-30 through a 16-day, three-proxy outage. `effectiveEgressEntries` also
        // applies the kill-switch, so the explicit `proxyEgressDisabled` check is subsumed.
        const proxyEntry = effectiveEgressEntries(account).find((e) => e.proxyUrl);
        if (!proxyEntry) return; // only proxy routes flap; box-direct is the fallback everything shares
        if ((egressPauseUntil.get(id) ?? 0) > now) return; // circuit already open — half-open prober owns recovery
        if (egressProbePending.has(id)) return;
        if (now - (lastEgressOkAt.get(id) ?? 0) < proactiveEgressProbeMs) return; // recent real traffic proved it
        try {
          const probe = await doProbeEgress({ id, egress: proxyEntry } as ClaudeAccount, {
            timeoutMs: EGRESS_PROBE_HTTP_TIMEOUT_MS,
          });
          if (probe.exitIp) {
            proactiveProbeFailStreak.delete(id);
            lastEgressOkAt.set(id, Date.now());
            return;
          }
          const streak = (proactiveProbeFailStreak.get(id) ?? 0) + 1;
          proactiveProbeFailStreak.set(id, streak);
          if (streak < EGRESS_FAIL_CIRCUIT_THRESHOLD) {
            log(
              'warn',
              `inference-gateway: proactive egress probe for '${id}' FAILED ${streak}/${EGRESS_FAIL_CIRCUIT_THRESHOLD} (${probe.error ?? 'no exit IP'})`,
            );
            return;
          }
          proactiveProbeFailStreak.delete(id);
          const resetAt = Date.now() + EGRESS_CIRCUIT_OPEN_MS;
          egressCircuitOpens++;
          proactiveProbeOpens++;
          egressPauseUntil.set(id, resetAt);
          log(
            'warn',
            `inference-gateway: PROACTIVE EGRESS CIRCUIT OPEN for '${id}' (${EGRESS_FAIL_CIRCUIT_THRESHOLD} consecutive idle-probe failures — cooled BEFORE live traffic burned on it); half-open probe readmits after ${EGRESS_PROBE_READMIT_STREAK} stable probes`,
          );
          scheduleEgressProbe(account, undefined, resetAt);
        } catch (err) {
          log('warn', `inference-gateway: proactive egress probe error for '${id}': ${(err as Error).message}`);
        }
      }),
    );
  }
  const proactiveProbeHandle =
    proactiveEgressProbeMs > 0 && providerPools().some((providerPool) => !!providerPool.entries)
      ? managedSetInterval(
          EXTERNAL_SCHEDULES.gatewayProactiveEgressProbe.name,
          proactiveEgressProbeMs,
          proactiveEgressProbeTick,
          {
            category: EXTERNAL_SCHEDULES.gatewayProactiveEgressProbe.category,
            classification: EXTERNAL_SCHEDULES.gatewayProactiveEgressProbe.classification,
            allowInTest: true,
          },
        )
      : null;

  let totalRequests = 0;
  /**
   * Prompt-cache policy telemetry (P-002). The measurement of "what breakpoint layout does the
   * fleet actually send?" happens HERE, as a byproduct of the rewrite, instead of via one-off
   * body capture: `breakpointHistogram[n]` counts requests that arrived with n markers, so the
   * headroom for the shared tools-span breakpoint is observable in /stats at any time.
   */
  const cachePolicyStats = {
    anthropicRequests: 0,
    ttlUpgraded: 0,
    toolsBreakpointInjected: 0,
    toolsBreakpointSkippedNoBudget: 0,
    /** Tool-search sessions: every tool deferred ⇒ no legal cache anchor (see cache-policy). */
    toolsBreakpointSkippedAllDeferred: 0,
    boundarySplit: 0,
    /** P-002: what the per-tool deferral pass actually did, cumulative over this process. */
    toolsDeferred: 0,
    toolsDeferredBytes: 0,
    searchToolInjected: 0,
    breakpointHistogram: [0, 0, 0, 0, 0] as number[],
    codexRequests: 0,
    codexLegacyRetention: 0,
    codexModernTtl: 0,
    codexCacheKeySet: 0,
  };
  /** D-016 / P-009(d): throttle counter for the deferral mechanism log below. */
  let cacheDeferralLogCount = 0;
  const cachePolicyEnabled = cachePolicyOn();
  const cacheToolsBreakpointEnabled = cacheToolsBreakpointOn();
  const cacheSplitBoundaryEnabled = cacheSplitBoundaryOn();
  const cacheDeferLargeToolsEnabled = cacheDeferLargeToolsOn();
  const cacheDeferMinToolBytesValue = cacheDeferMinToolBytes();
  function recordCachePolicy(provider: 'anthropic' | 'codex', stats: AnthropicCacheStats | OpenAiCacheStats): void {
    if (provider === 'anthropic') {
      const s = stats as AnthropicCacheStats;
      cachePolicyStats.anthropicRequests++;
      cachePolicyStats.ttlUpgraded += s.ttlUpgraded;
      if (s.toolsBreakpointInjected) cachePolicyStats.toolsBreakpointInjected++;
      if (s.toolsBreakpointSkippedNoBudget) cachePolicyStats.toolsBreakpointSkippedNoBudget++;
      if (s.toolsBreakpointSkippedAllDeferred) cachePolicyStats.toolsBreakpointSkippedAllDeferred++;
      if (s.boundarySplit) cachePolicyStats.boundarySplit++;
      if (s.toolDeferral) {
        cachePolicyStats.toolsDeferred += s.toolDeferral.toolsDeferred;
        cachePolicyStats.toolsDeferredBytes += s.toolDeferral.toolsDeferredBytes;
        if (s.toolDeferral.searchToolInjected) cachePolicyStats.searchToolInjected++;
        // D-016 / P-009(d): MECHANISM EVIDENCE for the gateway plane. These counters were
        // accumulated but never surfaced, so this plane was unobservable while the sibling
        // cache-proxy plane logged every rewrite — and D-002 Ruling 5 is explicit that a token
        // delta with no mechanism evidence is not a result (arm B's 163,508 nearly read as a 30%
        // win for that exact reason). Same wording as the proxy's line on purpose, so ONE grep
        // (`deferred .* tool`) answers "are both planes actually deferring?" instead of an
        // absence on one plane being misread as the flag being off there.
        // Throttled: first rewrite, then every 100th — enough to prove liveness, not a spam source.
        if (s.toolDeferral.toolsDeferred > 0) {
          cacheDeferralLogCount++;
          if (cacheDeferralLogCount === 1 || cacheDeferralLogCount % 100 === 0) {
            log(
              'info',
              `inference-gateway: deferred ${s.toolDeferral.toolsDeferred} tool(s), ${s.toolDeferral.toolsDeferredBytes} B` +
                `${s.toolDeferral.searchToolInjected ? ' + injected tool_search_tool_bm25' : ''}` +
                ` (rewrite #${cacheDeferralLogCount})`,
            );
          }
        }
      }
      const idx = Math.min(s.breakpointsBefore, cachePolicyStats.breakpointHistogram.length - 1);
      cachePolicyStats.breakpointHistogram[idx]++;
    } else {
      const s = stats as OpenAiCacheStats;
      cachePolicyStats.codexRequests++;
      if (s.retentionSet) cachePolicyStats.codexLegacyRetention++;
      if (s.ttlSet) cachePolicyStats.codexModernTtl++;
      if (s.cacheKeySet) cachePolicyStats.codexCacheKeySet++;
    }
  }
  let upstream429 = 0;
  let queued429 = 0;
  let shed429 = 0; // load-shed: 429s returned because the admission queue was at maxQueued (backlog cap)
  let shedAllThrottled = 0; // fail-fast: 429s shed at admission because the whole pool was throttled (B-GW-1)
  let bareBurstRotateSuppressed = 0; // G1 (WI-649): bare-429 rotate-retries suppressed because ≥half the pool was out of rotation (fleet-wide storm)
  let opusToSonnetDowngrades = 0; // WI-1073: last-resort opus→sonnet downgrades (opus walled pool-wide → sonnet-vs-nothing)
  // WI-10005833: unsupported reasoning-effort clamp. The cache is per gateway instance, learned from
  // upstream 400s that list the model's supported levels.
  const effortClampCache = createEffortClampCache();
  let effortClampRetries = 0; // requests retried once after a 400 named their effort unsupported
  let effortClampRewrites = 0; // requests rewritten from a learned clamp before they were sent
  let upstreamErrors = 0;
  let failovers = 0;
  let egressCircuitOpens = 0; // B-GW-EGRESS: per-account egress-proxy circuit opens (dead/flapping IP, transport-failure streak)
  // Per-backend (Codex/OpenAI) counters (2026-06-22 audit): the Codex path's 429s/failovers/errors are tracked
  // SEPARATELY so /stats can distinguish Codex health from Claude health (the shared counters above stay
  // Claude-only). All zero until Codex accounts are configured.
  let codexRequests = 0;
  let codexUpstream429 = 0;
  let codexFailovers = 0;
  let codexUpstreamErrors = 0;
  // Bee-FACING final 503s (2026-06-22 audit). What the bee actually RECEIVES after the gateway exhausts its
  // internal retries — distinct from the per-attempt upstreamErrors above and from shedAllThrottled (rate
  // sheds). Before this they were invisible in /stats, hiding that egress-proxy degradation (not rate limits)
  // had become the dominant bee-facing failure mode.
  let beeEgressExhausted = 0; // 503 after all egress-proxy retries stalled/errored (the flaky-proxy leak)
  let beeTokenStall = 0; // 503 from a stalled OAuth token refresh
  let selfHealReclaims = 0; // EI-2086: in-process release-valve slot reclaims (pre-empted watchdog restarts)
  // MAINTENANCE summarize lane (deterministic-context-carry P-002): how many compaction summaries this
  // gateway served / failed — the P-004 acceptance drain reads these to prove the lane actually carried
  // the fleet's compactions (a zero here with compactions happening = the omp remoteEndpoint never landed).
  let maintenanceRequests = 0;
  let maintenanceErrors = 0;
  let maintenanceCarried = 0; // summarize requests answered by the deterministic carry branch (P-017)
  // P-005/W3 slot-leak RECURRENCE GUARD (D-001): the reconcile-invariant counters. The self-heal sweep
  // cross-checks the queue's held-slot counter against the in-flight registry each tick and bumps
  // `slotReconcileMismatch` when they disagree in a way the valve cannot reclaim — a leak surfaced as a
  // COUNTED signal, not a silent wedge→watchdog restart. `...Consecutive`/`...Logged` de-bounce it (only a
  // violation sustained ≥2 sweeps counts; logs ONCE per contiguous streak). Fail-soft — never throws.
  let slotReconcileMismatch = 0;
  let slotReconcileConsecutive = 0;
  let slotReconcileLogged = false;

  // Rate-limit STALL events (gateway-rate-limit-stall-autowake P-002): when the gateway sheds an
  // all-throttled 429 to an IDENTIFIED bee (x-papercusp-owner present), record {ownerId, accountId,
  // soonestResetAt} so a stall-waker can confirm the bee actually went idle and wake it once the account
  // recovers. A bounded ring buffer surfaced on GET /admin/stalls; the gateway itself NEVER wakes (it stays
  // a thin proxy — the coordinator owns the confirm-wait-wake state).
  interface StallEvent {
    ownerId: string;
    accountId: string;
    soonestResetAt: number;
    at: number;
  }
  const STALL_BUFFER_MAX = 256;
  // WI-4994: the buffer was bounded only by COUNT, never by AGE — on a low-stall-volume box a
  // handful of entries can sit well under STALL_BUFFER_MAX for many hours, so a `since=0` read
  // (a fresh stall-waker instance, or a diagnostic curl) kept replaying hours-old stalls for
  // owners long gone. `recentStalls` (below) is filtered by BOTH `since` and this age at read
  // time — generous vs the stall-waker's own 2h pendingTtlMs give-up window, since this buffer's
  // job is only "don't serve stale diagnostic noise", not the waker's give-up business logic.
  const STALL_MAX_AGE_MS = 4 * 60 * 60_000;
  const recentStalls: StallEvent[] = [];
  let stallsRecorded = 0;
  function recordStall(ownerId: string | undefined, accountId: string, soonestResetAt: number): void {
    if (!ownerId) return; // only bees that identified themselves (x-papercusp-owner) are wake-able
    stallsRecorded++;
    const at = Date.now();
    recentStalls.push({ ownerId, accountId, soonestResetAt, at });
    if (recentStalls.length > STALL_BUFFER_MAX) recentStalls.splice(0, recentStalls.length - STALL_BUFFER_MAX);
    // Opportunistic age-based prune (belt-and-suspenders alongside the read-time filter below) —
    // keeps the array itself from carrying long-dead entries between stalls, not just hiding them.
    const cutoff = Date.now() - STALL_MAX_AGE_MS;
    while (recentStalls.length && recentStalls[0].at < cutoff) recentStalls.shift();
    recordOwnerOutcome(ownerId, 'stall', { account: accountId });
    // DURABILITY (EI-2431): the ring buffer above is gateway-PROCESS memory — a restart in the
    // window between this call and the stall-waker's next ~20s poll silently drops the stall and
    // the bee is never woken. Fire-and-forget a best-effort PG write-through so the waker can
    // recover this stall directly from PG even across a gateway restart (stall-waker-loop.ts's
    // fetchStalls merges it in). Never blocks/slows this request-serving path and never throws —
    // a DB outage degrades to today's in-memory-only behavior, it never affects serving. Skipped
    // hermetically under vitest (hive-directory-boot.ts's `!process.env.VITEST` convention) — this
    // function is exercised directly by gateway.test.ts's synthetic-owner stall tests, which have
    // no reason to reach a real DB and previously left junk `spawn-test-1`/`test-acct` rows in the
    // shared dev harness_shared.gateway_stall_events table on every test run (caught in review).
    if (!process.env.VITEST)
      void (async () => {
        try {
          const { activeWorkspaceId } = await import('../workspace-registry');
          await recordGatewayStall({ ownerId, accountId, soonestResetAt, at }, activeWorkspaceId());
        } catch (e) {
          log(
            'warn',
            `inference-gateway: stall PG durability write failed (non-fatal, in-memory ring still served): ${(e as Error)?.message ?? e}`,
          );
        }
      })();
  }

  // Per-owner LAST-ROUTED account (routed-account-visibility, 2026-06-22): the account that ACTUALLY served
  // this owner's most-recent turn, so a session can show "my turn → <account>" in its statusline (the gateway
  // already strips the routing headers, so the caller never sees the response header directly). Updated on the
  // served-response chokepoint; a bounded Map keyed by ownerId (delete-oldest over the cap). Read-only on
  // GET /admin/route?owner=<id>. Cheap: one Map.set on the hot path.
  interface RouteEntry {
    account: string;
    /** The model AS FORWARDED (after `[1m]` normalization and any WI-1073 downgrade) — the SERVED model. */
    model: string;
    /** Whether the forwarded request carried the 1M-context beta — with `model`, the served WINDOW. */
    context1m: boolean;
    /** The caller's native session id from `metadata.user_id` (null for non-CLI callers). */
    nativeSessionId: string | null;
    /** Latest exact usage for this route's native session; null until the first `message_start`. */
    usage: GatewayRouteUsage | null;
    at: number;
  }
  const ROUTE_MAP_MAX = 4096;
  const lastRouteByOwner = new Map<string, RouteEntry>();
  // DYNAMIC OWNER PIN (account-dynamic-pin-2026-06-29): a RUNTIME owner→account pin, set via accounts:pin
  // (POST /admin/owner-pin) and honored per-request keyed by the x-papercusp-owner header — it OVERRIDES the
  // static x-papercusp-account spawn header, so any agent can re-route ANY agent (by owner id; its own id to
  // self-pin) LIVE without a respawn. `hard` ⇒ no failover (like the static hard pin). This Map is the HOT
  // read only — the durable store is `operator_owner_pins` (migration 416, deployment/account-owner-pins.ts):
  // accounts:pin writes the DB first, then pushes here for immediate effect, and launch.ts re-seeds this Map
  // from the DB at gateway startup + on its periodic resync, so a pin survives a gateway restart.
  // `setAt`: when the route was (re)set — an explicit dynamic `auto` route resets auto-affinity's memory of
  // routes served BEFORE it (WI-2140943 × WI-4402: "return this session to fresh selection" must not be
  // undone by affinity re-pinning it to the account it was just told to leave).
  const ownerPinMap = new Map<string, { accountId: string; hard: boolean; setAt: number }>();
  // COLD-START RATE SEED (account-cold-start-seed-2026-06-29): the DURABLE per-account rate projection
  // (pausedUntil / 5h+7d utilization + window resets), loaded by the launch layer at startup + on its poll.
  // Right after a gateway restart the LIVE per-account governor is blank, so it can't yet know an account is
  // 403-disqualified / 429-exhausted / weekly-capped — it would bounce requests onto the dead accounts until
  // it re-learns by failing on each (the owner-reported "the fleet can't use the one healthy account's room
  // after a restart"). keyOf consults this as a fallback so a known-bad account is disqualified IMMEDIATELY.
  const accountRateHints = new Map<
    string,
    {
      pausedUntil?: number;
      utilization?: number;
      utilization7d?: number;
      windowResetAt?: number;
      windowResetAt7d?: number;
      burnAction?: AccountBurnAction;
      /** When the store TOOK this reading (`utilizationAt`). The store↔pool reconciliation clears a
       *  park only on a reading NEWER than the park — an older reading says nothing about it. */
      readingAt?: number;
      usageCreditsAvailable?: boolean;
    }
  >();
  /** P-008 (anthropic-credits-gateway-2026-09-30): each Claude account's latest billing state, parsed
   *  from the unified-limiter headers of its OWN upstream responses. `until` = the allowance reset the
   *  same response named: a `usage-credits` reading stops applying there (the allowance is back). */
  const claudeBillingByAccount = new Map<string, { state: ClaudeBillingStateKind; until?: number }>();
  /** D-004 / D-008 E4: each account's latest credit wall — its cause and when the wall's pause ends.
   *  Stats report it while `until` is in the future; a served (2xx) response from the account clears it. */
  const claudeCreditWallByAccount = new Map<string, { cause: ClaudeCreditWallCause | 'unknown'; until: number }>();
  const recordClaudeBilling =(account: ActiveAccount, headers: Record<string, string | undefined>): void => {
    const billing = parseClaudeBillingState(headers);
    if (!billing) return;
    const secToMs = (v: string | undefined): number | undefined =>
      v && /^\d+$/.test(v.trim()) ? Number(v.trim()) * 1000 : undefined;
    const namedUntil =
      secToMs(headers['anthropic-ratelimit-unified-reset']) ?? secToMs(headers['anthropic-ratelimit-unified-5h-reset']);
    // A usage-credits reading that named no reset is bounded by the SAME horizon the pool parks for
    // (FIVE_HOURS_MS, onExhausted's no-reset default). Unbounded, it stayed "metered" forever: a
    // `metered: never` account then outlived its park and every route to it — auto or pinned — was
    // refused with no response ever arriving to clear the reading (D-008 E1, never held indefinitely).
    const until = namedUntil ?? (billing.state === 'usage-credits' ? Date.now() + FIVE_HOURS_MS : undefined);
    claudeBillingByAccount.set(account.accountId, { state: billing.state, ...(until !== undefined ? { until } : {}) });
    // `metered: never` makes usage-credit overage a WALL (D-003). Park the account in the pool until its
    // allowance resets: every selection path (round-robin, failover walk, kernel rotation, internal retry)
    // already skips a parked account, so no further request is billed per token. A hard pin bypasses the
    // pool (select() ignores parks) and is refused before admission instead.
    if (account.meteredPolicy === 'never' && inUsageCredits(account, Date.now())) {
      pool.onExhausted(account.accountId, until ?? 0);
    }
  };
  /** True while this subscription account is past its allowance and serving from usage credits. */
  const inUsageCredits = (account: ActiveAccount, at: number): boolean => {
    if (account.authMode === 'api-key') return false;
    const h = accountRateHints.get(account.accountId);
    if (h?.usageCreditsAvailable === true && [
      { utilization: h.utilization, resetAt: h.windowResetAt },
      { utilization: h.utilization7d, resetAt: h.windowResetAt7d },
    ].some((window) => (window.utilization ?? 0) >= HINT_CAPACITY_FULL_AT &&
      !(window.resetAt !== undefined && window.resetAt <= at))) return true;
    const b = claudeBillingByAccount.get(account.accountId);
    return b?.state === 'usage-credits' && !(b.until !== undefined && b.until <= at);
  };
  /** Billed per token right now: an api-key account, or a subscription serving from usage credits. */
  const isMeteredNow = (account: ActiveAccount, at: number): boolean =>
    account.authMode === 'api-key' || inUsageCredits(account, at);
  /** P-009: the billing class a request served by `account` right now falls in. */
  const billingClassOf = (account: ActiveAccount, at: number): GatewayBillingClass =>
    account.authMode === 'api-key' ? 'api-credits' : inUsageCredits(account, at) ? 'usage-credits' : 'included';
  const newBillingTally = (): GatewayBillingTally => ({
    requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, usageKnown: 0, outputKnown: 0,
  });
  /** P-009: per-account, per-billing-class served requests + token usage since boot. */
  const billingTallyByAccount = new Map<string, Map<GatewayBillingClass, GatewayBillingTally>>();
  const billingTally = (accountId: string, cls: GatewayBillingClass): GatewayBillingTally => {
    let byClass = billingTallyByAccount.get(accountId);
    if (!byClass) billingTallyByAccount.set(accountId, (byClass = new Map()));
    let t = byClass.get(cls);
    if (!t) byClass.set(cls, (t = newBillingTally()));
    return t;
  };
  const addBillingTally = (into: GatewayBillingTally, t: GatewayBillingTally): void => {
    into.requests += t.requests;
    into.inputTokens += t.inputTokens;
    into.cacheReadTokens += t.cacheReadTokens;
    into.cacheCreationTokens += t.cacheCreationTokens;
    into.outputTokens += t.outputTokens;
    into.usageKnown += t.usageKnown;
    into.outputKnown += t.outputKnown;
  };
  function billingSnapshot(): GatewayStats['billing'] {
    const now = Date.now();
    const byAccount: Record<string, GatewayAccountBilling> = {};
    const poolMetered = newBillingTally();
    const known = new Map<string, ActiveAccount>((pool.entries?.() ?? []).map((a) => [a.accountId, a]));
    for (const id of new Set([...known.keys(), ...billingTallyByAccount.keys()])) {
      const account = known.get(id);
      const recorded = claudeBillingByAccount.get(id);
      const classes: GatewayAccountBilling['classes'] = {};
      const metered = newBillingTally();
      for (const [cls, t] of billingTallyByAccount.get(id) ?? []) {
        classes[cls] = { ...t };
        if (cls !== 'included') addBillingTally(metered, t);
      }
      addBillingTally(poolMetered, metered);
      const wall = claudeCreditWallByAccount.get(id);
      byAccount[id] = {
        ...(wall && wall.until > now ? { wall: { cause: wall.cause, until: wall.until } } : {}),
        state: account?.authMode === 'api-key' ? 'api-credits' : (recorded?.state ?? 'unknown'),
        ...(recorded?.until !== undefined && account?.authMode !== 'api-key' ? { stateUntil: recorded.until } : {}),
        meteredNow: account ? isMeteredNow(account, now) : false,
        authMode: account?.authMode ?? 'oauth',
        meteredPolicy: account?.meteredPolicy ?? 'overflow',
        classes,
        metered,
      };
    }
    return { byAccount, metered: poolMetered };
  }

  /** The ONE gateway adaptation into accountLoadKey. Claude supplies its live per-account governor;
   *  Codex supplies the same durable capacity/burn hints plus shared transport state. Keeping the
   *  adaptation here prevents the provider handlers from growing subtly different health formulas. */
  const accountHealthKey = (
    account: ActiveAccount,
    at: number,
    cgov?: RateLimitGovernor,
    inFlightAdjustment = 0,
  ): number => {
    const accountId = account.accountId;
    const h = accountRateHints.get(accountId);
    const unified = cgov?.snapshot().unified;
    // P-008/D-003: usage credits carry an overage account past its allowance, so the allowance walls
    // (a rejected/full unified window, the store's allowance readings and their park) do not stop it —
    // it is scored as METERED instead, behind every serviceable included-allowance account.
    const overage = inUsageCredits(account, at);
    const base = accountLoadKey({
      paused:
        (cgov?.state.pausedUntil ?? 0) > at ||
        (egressPauseUntil.get(accountId) ?? 0) > at ||
        ((!overage || h?.usageCreditsAvailable === true) && (h?.pausedUntil ?? 0) > at),
      exhausted: !overage && !!unified?.rejected && !(unified.resetAt > 0 && unified.resetAt <= at),
      transportHealth: (egressFailStreak.get(accountId) ?? 0) > 0 ? 'degraded' : 'healthy',
      inFlight: cgov ? Math.max(0, cgov.state.inFlight + inFlightAdjustment) : undefined,
      utilization: overage ? undefined : unified?.utilization,
      capacityWindows: overage
        ? []
        : [
            { utilization: unified?.utilization, resetAt: unified?.resetAt },
            { utilization: h?.utilization, resetAt: h?.windowResetAt },
            { utilization: h?.utilization7d, resetAt: h?.windowResetAt7d },
          ],
      now: at,
      burnAction: overage ? undefined : h?.burnAction,
      billing: account.authMode === 'api-key' || overage ? 'metered' : 'included',
      meteredPolicy: account.meteredPolicy,
    });
    if (base === Infinity) return base;
    const poolEntries = effectiveEgressEntries(account);
    if (poolEntries.length > 1) {
      let cooled = 0;
      for (const e of poolEntries) {
        if ((ipCooldownUntil.get(egressCacheKey(accountId, e)) ?? 0) > at) cooled++;
      }
      if (cooled >= poolEntries.length) return Infinity;
      if (cooled > 0) return base + cooled * ACCOUNT_INFLIGHT_LOAD_WEIGHT;
    }
    return base;
  };

  /** accountLoadKey's default `capacityFullAt` — hintRecoveryAt must call a window a wall at EXACTLY the
   *  utilization accountHealthKey turns into Infinity, or "walled per the store" and "walled per keyOf"
   *  disagree and the horizon lies about a pool keyOf refuses to pick from. */
  const HINT_CAPACITY_FULL_AT = 0.99;
  /** The instant the durable rate hints (+ the transport circuit) say `accountId` is back, or undefined
   *  when they report it serviceable / know nothing. The SAME walls accountHealthKey scores Infinity —
   *  a governor pause, a full 5h/7d window that has not reset, a burn SHED, an open egress circuit —
   *  read back as a RECOVERY INSTANT rather than a boolean, so the codex ladder can ask "when", not
   *  just "whether" (codex-auto-route-all-walled-fail-fast-2026-09-05, P-003). */
  const hintRecoveryAt = (accountId: string, at: number): number | undefined => {
    const h = accountRateHints.get(accountId);
    let recoverAt = 0;
    const consider = (value: number | undefined) => {
      if (value !== undefined && Number.isFinite(value) && value > at) recoverAt = Math.max(recoverAt, value);
    };
    if (h) {
      consider(h.pausedUntil);
      if (h.usageCreditsAvailable !== true) {
        if ((h.utilization ?? 0) >= HINT_CAPACITY_FULL_AT) consider(h.windowResetAt);
        if ((h.utilization7d ?? 0) >= HINT_CAPACITY_FULL_AT) consider(h.windowResetAt7d);
        if (h.burnAction === 'shed') consider(h.windowResetAt7d);
      }
    }
    consider(egressPauseUntil.get(accountId));
    return recoverAt > 0 ? recoverAt : undefined;
  };
  /** Count Codex accounts that automatic routing can actually select right now. The pool's
   *  `healthyCount()` only knows its in-memory park map; `accountHealthKey()` also knows the
   *  durable 5h/7d usage walls, burn SHED state, and egress circuit that the automatic picker
   *  rejects. Keeping the count on the same key prevents `/stats`, launch preflight, and the
   *  recovery horizon from advertising capacity the selector will never use. Pools without an
   *  entry snapshot retain their legacy count because there is no account object to evaluate. */
  const codexServiceableCount = (
    source: AccountPool | null | undefined,
    at: number,
    fallbackEntries: readonly ActiveAccount[] = [],
  ): number => {
    const entries = source?.entries?.() ?? fallbackEntries;
    if (entries.length === 0) return source?.healthyCount?.() ?? 0;
    const byId = new Map(entries.map((account) => [account.accountId, account]));
    const serviceable = (accountId: string): boolean => {
      const account = byId.get(accountId);
      return !!account && accountHealthKey(account, at) < Infinity;
    };
    return source?.healthyCount
      ? source.healthyCount(serviceable)
      : entries.reduce((count, account) => count + (serviceable(account.accountId) ? 1 : 0), 0);
  };
  /** Legacy CLI-only configurations may expose accounts without the routing twin pool. Adapt
   *  their non-secret routing fields into the shared health contract for truthful diagnostics. */
  const codexCliHealthEntries = (): ActiveAccount[] =>
    codexCliAccounts().map(({ accountId, egress, egressPool }) => ({
      accountId,
      egress,
      egressPool,
      token: async () => '',
    }));
  /** The codex POOL's recovery horizon for ONE 429 decision (0 = a sibling can serve now; epoch ms = the
   *  earliest known return; Infinity = every account is out with no known reset) — the pool's
   *  `earliestAvailableAt` under the shared health key + the store's hint horizon, with the account that
   *  JUST 429'd overlaid as out until `failed.resetAt` whether or not the kernel ladder parked it (the
   *  kernel settles its last attempt without an onExhausted). A HARD pin narrows the pool to the pinned
   *  account — no sibling may serve — so its horizon is that account's own reset. A pool without the
   *  method (a bare test double) reports 0, the ladder's pre-horizon behaviour. */
  const codexPoolRecoveryAt = (
    source: AccountPool | null | undefined,
    at: number,
    failed: { accountId: string; resetAt: number },
    hardPin: boolean,
  ): number => {
    const failedRecoverAt = Math.max(
      failed.resetAt > at ? failed.resetAt : 0,
      hintRecoveryAt(failed.accountId, at) ?? 0,
    );
    if (hardPin) return failedRecoverAt > 0 ? failedRecoverAt : Infinity;
    if (!source?.earliestAvailableAt) return 0;
    return source.earliestAvailableAt({
      now: at,
      keyOf: (a) => (a.accountId === failed.accountId ? Infinity : accountHealthKey(a, at)),
      recoverAtOf: (a) =>
        a.accountId === failed.accountId
          ? failedRecoverAt > 0
            ? failedRecoverAt
            : undefined
          : hintRecoveryAt(a.accountId, at),
    });
  };
  /** Render a pool horizon for the response header / log line. */
  const describePoolRecovery = (poolRecoveryAt: number, at: number): string =>
    poolRecoveryAt === Infinity ? 'unknown' : poolRecoveryAt > at ? new Date(poolRecoveryAt).toISOString() : 'now';
  /** The stall-waker's capacity gate for a terminal codex 429: the POOL horizon when one is known (a
   *  sibling's park expiring sooner than the failed account's own reset is when capacity actually
   *  returns), else the failed account's reset, floored at 30s as before. */
  const codexStallSoonestAt = (poolRecoveryAt: number, failedResetAt: number | null, at: number): number =>
    Number.isFinite(poolRecoveryAt) && poolRecoveryAt > at
      ? Math.max(poolRecoveryAt, at + 30_000)
      : Math.max(failedResetAt ?? 0, at + 30_000);
  /** STORE↔POOL RECONCILIATION (codex-auto-route-all-walled-fail-fast-2026-09-05 P-008; owner 2026-09-05:
   *  "auto routing should look at the same system that knows which accounts are available"). The pool's
   *  in-memory park and the durable availability store (operator_account_pool, refreshed into
   *  accountRateHints) can disagree: a 7d 429 parks an account here for days, while the store's next
   *  reading — taken AFTER the park, by a probe or a peer gateway's traffic — shows the window rolled.
   *  Before this the park won until it expired or a transport probe blindly cleared it. Now a reading
   *  NEWER than the park (readingAt > parkedAt) that reports the account serviceable (the shared
   *  accountHealthKey is finite) readmits it with reason 'store'; a reading that predates the park, or
   *  one that still reports a wall, leaves the park alone. Do not infer serviceability from an absent
   *  recovery timestamp: SHED/full readings can be walls whose reset is unknown. Runs after every hint
   *  refresh and at every absorb re-entry, so a re-pick honours the freshest availability the system
   *  has. Returns the readmitted count. */
  const reconcileParksWithStore = (at: number = Date.now()): number => {
    let readmitted = 0;
    for (const providerPool of providerPools()) {
      if (!providerPool.parkState || !providerPool.readmit || !providerPool.entries) continue;
      for (const entry of providerPool.entries()) {
        const park = providerPool.parkState(entry.accountId);
        if (!park || park.until <= at) continue;
        const h = accountRateHints.get(entry.accountId);
        if (!h || h.readingAt === undefined || h.readingAt <= park.parkedAt) continue;
        if (accountHealthKey(entry, at) === Infinity) continue;
        if (providerPool.readmit(entry.accountId, { reason: 'store' })) {
          readmitted++;
          log(
            'warn',
            `inference-gateway: '${entry.accountId}' park (${Math.round((park.until - at) / 1000)}s left) cleared — availability store reports capacity (reading ${Math.round((at - h.readingAt) / 1000)}s old, u5h=${h.utilization ?? '?'}, u7d=${h.utilization7d ?? '?'})`,
          );
        }
      }
    }
    return readmitted;
  };

  // ROUTING-QUALITY OBSERVABILITY (intelligent-account-routing P-007): one bounded decision ring plus
  // process-local aggregates, attached to the existing /stats + /admin/owner-report plane. A "pick" is the
  // final INITIAL account decision for one logical inference request. Internal retries increment only their
  // attempted account's true-429 numerator, so `upstream429PerPick` exposes retry amplification rather than
  // hiding it by growing both sides of the ratio.
  interface RoutingQualityTally {
    picks: number;
    upstream429s: number;
    automaticPicks: number;
    comparableAutomaticPicks: number;
    automaticDivergences: number;
    pinPicks: number;
    explicitPinPicks: number;
    affinityPicks: number;
    pinYields: number;
  }
  const newRoutingQualityTally = (): RoutingQualityTally => ({
    picks: 0,
    upstream429s: 0,
    automaticPicks: 0,
    comparableAutomaticPicks: 0,
    automaticDivergences: 0,
    pinPicks: 0,
    explicitPinPicks: 0,
    affinityPicks: 0,
    pinYields: 0,
  });
  const ROUTING_DECISION_RECENT_MAX = 128;
  const routingQualityTotal = newRoutingQualityTally();
  const routingQualityByProvider: Record<'claude' | 'codex', RoutingQualityTally> = {
    claude: newRoutingQualityTally(),
    codex: newRoutingQualityTally(),
  };
  const routingQualityByAccount: Record<'claude' | 'codex', Map<string, { picks: number; upstream429s: number }>> = {
    claude: new Map(),
    codex: new Map(),
  };
  const recentRoutingDecisions: GatewayRoutingDecision[] = [];
  let routingDecisionSequence = 0;
  const routingRatio = (numerator: number, denominator: number): number | null =>
    denominator > 0 ? Math.round((numerator / denominator) * 1_000_000) / 1_000_000 : null;
  const routingAccountRow = (provider: 'claude' | 'codex', accountId: string) => {
    let row = routingQualityByAccount[provider].get(accountId);
    if (!row) {
      row = { picks: 0, upstream429s: 0 };
      routingQualityByAccount[provider].set(accountId, row);
    }
    return row;
  };
  const routingAccountScore = (
    provider: 'claude' | 'codex',
    source: AccountPool | undefined,
    account: ActiveAccount,
    model: string | undefined,
    at: number,
    inFlightAdjustment = 0,
  ): number => {
    const inRotation = source?.healthyCount
      ? source.healthyCount((accountId) => accountId === account.accountId) > 0
      : true;
    if (!inRotation) return Infinity;
    return accountHealthKey(
      account,
      at,
      provider === 'claude' ? governorForAccount(model ?? SERVICEABLE_CLAMP_MODEL, account.accountId) : undefined,
      inFlightAdjustment,
    );
  };
  function recordRoutingPick(input: {
    provider: 'claude' | 'codex';
    ownerId?: string;
    source?: AccountPool;
    selected: ActiveAccount;
    model?: string;
    mode: GatewayRoutingSelectionMode;
    reason: GatewayRoutingDecision['reason'];
    requestedAccount?: string | null;
    yieldedFrom?: string | null;
    /** Claude records after governor admission; subtract this request's own slot from decision-time evidence. */
    selectedAdmissionHeld?: boolean;
  }): void {
    const at = Date.now();
    const sourceEntries = input.source?.entries?.();
    const candidates = sourceEntries?.length ? [...sourceEntries] : [input.selected];
    if (!candidates.some((account) => account.accountId === input.selected.accountId)) candidates.push(input.selected);
    const scores = candidates.map((account) => ({
      account,
      score: routingAccountScore(
        input.provider,
        input.source,
        account,
        input.model,
        at,
        input.selectedAdmissionHeld && account.accountId === input.selected.accountId ? -1 : 0,
      ),
    }));
    const selectedScoreRaw = routingAccountScore(
      input.provider,
      input.source,
      input.selected,
      input.model,
      at,
      input.selectedAdmissionHeld ? -1 : 0,
    );
    const best = scores
      .filter((candidate) => Number.isFinite(candidate.score))
      .sort((a, b) => a.score - b.score || a.account.accountId.localeCompare(b.account.accountId))[0];
    const divergedFromBest = best ? selectedScoreRaw > best.score : null;
    const includedInAutomaticDivergence = input.mode === 'automatic' && divergedFromBest !== null;
    const decision: GatewayRoutingDecision = {
      sequence: ++routingDecisionSequence,
      at,
      provider: input.provider,
      owner: input.ownerId ?? null,
      selectedAccount: input.selected.accountId,
      mode: input.mode,
      reason: input.reason,
      requestedAccount: input.requestedAccount ?? null,
      yieldedFrom: input.yieldedFrom ?? null,
      selectedScore: Number.isFinite(selectedScoreRaw) ? Math.round(selectedScoreRaw * 1000) / 1000 : null,
      selectedServiceable: Number.isFinite(selectedScoreRaw),
      bestAvailableAccount: best?.account.accountId ?? null,
      bestAvailableScore: best ? Math.round(best.score * 1000) / 1000 : null,
      divergedFromBest,
      includedInAutomaticDivergence,
    };
    recentRoutingDecisions.push(decision);
    if (recentRoutingDecisions.length > ROUTING_DECISION_RECENT_MAX) {
      recentRoutingDecisions.splice(0, recentRoutingDecisions.length - ROUTING_DECISION_RECENT_MAX);
    }
    const account = routingAccountRow(input.provider, input.selected.accountId);
    account.picks++;
    for (const tally of [routingQualityTotal, routingQualityByProvider[input.provider]]) {
      tally.picks++;
      if (input.mode === 'automatic') {
        tally.automaticPicks++;
        if (includedInAutomaticDivergence) {
          tally.comparableAutomaticPicks++;
          if (divergedFromBest) tally.automaticDivergences++;
        }
      } else {
        tally.pinPicks++;
        if (input.mode === 'affinity') tally.affinityPicks++;
        else tally.explicitPinPicks++;
        if (input.yieldedFrom) tally.pinYields++;
      }
    }
  }
  function recordRoutingUpstream429(provider: 'claude' | 'codex', accountId: string): void {
    routingQualityTotal.upstream429s++;
    routingQualityByProvider[provider].upstream429s++;
    routingAccountRow(provider, accountId).upstream429s++;
  }
  const routingQualitySnapshot = (recentOwner?: string): GatewayRoutingQualitySnapshot => {
    const snapshotTally = (provider: 'claude' | 'codex') => {
      const tally = routingQualityByProvider[provider];
      return {
        picks: tally.picks,
        upstream429s: tally.upstream429s,
        upstream429PerPick: routingRatio(tally.upstream429s, tally.picks),
        automatic: {
          picks: tally.automaticPicks,
          comparablePicks: tally.comparableAutomaticPicks,
          divergences: tally.automaticDivergences,
          divergenceRate: routingRatio(tally.automaticDivergences, tally.comparableAutomaticPicks),
        },
        pins: {
          picks: tally.pinPicks,
          explicitPicks: tally.explicitPinPicks,
          affinityPicks: tally.affinityPicks,
          yields: tally.pinYields,
          yieldRate: routingRatio(tally.pinYields, tally.pinPicks),
        },
        byAccount: Object.fromEntries(
          [...routingQualityByAccount[provider]].map(([accountId, row]) => [
            accountId,
            {
              ...row,
              upstream429PerPick: routingRatio(row.upstream429s, row.picks),
            },
          ]),
        ),
      };
    };
    return {
      countersSinceMs: processStartedAt,
      recentLimit: ROUTING_DECISION_RECENT_MAX,
      scoreSemantics: 'accountLoadKey; lower-is-better; null=unserviceable',
      picks: routingQualityTotal.picks,
      upstream429s: routingQualityTotal.upstream429s,
      upstream429PerPick: routingRatio(routingQualityTotal.upstream429s, routingQualityTotal.picks),
      automatic: {
        picks: routingQualityTotal.automaticPicks,
        comparablePicks: routingQualityTotal.comparableAutomaticPicks,
        divergences: routingQualityTotal.automaticDivergences,
        divergenceRate: routingRatio(
          routingQualityTotal.automaticDivergences,
          routingQualityTotal.comparableAutomaticPicks,
        ),
      },
      pins: {
        picks: routingQualityTotal.pinPicks,
        explicitPicks: routingQualityTotal.explicitPinPicks,
        affinityPicks: routingQualityTotal.affinityPicks,
        yields: routingQualityTotal.pinYields,
        yieldRate: routingRatio(routingQualityTotal.pinYields, routingQualityTotal.pinPicks),
      },
      byProvider: { claude: snapshotTally('claude'), codex: snapshotTally('codex') },
      recentScope: recentOwner ?? null,
      recent: recentOwner
        ? recentRoutingDecisions.filter((decision) => decision.owner === recentOwner)
        : [...recentRoutingDecisions],
    };
  };

  /** Request-local view of a Codex pool: pins remain strict through select(), while every unpinned
   *  initial pick and post-failure rotation asks the pool to rank with the shared health key. */
  const healthAwareCodexPool = (source: AccountPool, model?: string | null): AccountPool => {
    // WI-10003306: with a request model, an account that has refused THAT model scores Infinity,
    // so it is never the health-ranked pick while a non-refusing sibling exists.
    const keyOf = (account: ActiveAccount) =>
      model && codexModelRefusals.isRefused(account.accountId, model) ? Infinity : accountHealthKey(account, Date.now());
    return {
      active: (override) => source.active(override ?? keyOf),
      onExhausted: (accountId, resetAt, override) => source.onExhausted(accountId, resetAt, override ?? keyOf),
      select: (accountId) => source.select?.(accountId) ?? null,
      readmit: (accountId, opts) => source.readmit?.(accountId, opts) ?? false,
      parkState: (accountId) => source.parkState?.(accountId),
      // The horizon ranks with the SAME health key + hint horizon the picks use, unless the caller
      // overrides them — so "no account can serve" and "no account will be picked" cannot diverge.
      earliestAvailableAt: (opts) =>
        source.earliestAvailableAt?.({
          ...opts,
          keyOf: opts?.keyOf ?? ((account) => accountHealthKey(account, opts?.now ?? Date.now())),
          recoverAtOf: opts?.recoverAtOf ?? ((account) => hintRecoveryAt(account.accountId, opts?.now ?? Date.now())),
        }) ?? 0,
      healthyCount: (extra) => source.healthyCount?.(extra) ?? 0,
      size: () => source.size?.() ?? source.entries?.().length ?? 0,
      peek: () => source.peek?.() ?? source.active(keyOf),
      entries: () => source.entries?.() ?? [],
      msSinceReadmit: (accountId, nowMs) => source.msSinceReadmit?.(accountId, nowMs),
    };
  };
  /** Resolve a Codex SOFT pin before the first upstream attempt.
   *
   * `AccountPool.select()` is intentionally strict: it resolves the named account even while that
   * account is paused, because HARD pins must never be substituted. Codex used that strict resolver
   * for every pin, though, so a SOFT header/dynamic pin (and the implicit auto-affinity pin) bypassed
   * the health-aware initial picker and burned one known-doomed upstream attempt before rotating.
   *
   * Keep the cache-affinity commitment whenever the pin is serviceable. Only an account that the
   * pool has removed from rotation or whose shared health score is Infinity may yield. Re-running
   * this on every request is the return-on-recovery mechanism: as soon as the pause/window/circuit
   * clears, the original pin wins again without mutating it. The returned `yieldedFrom` stays attached
   * to the request so response headers and owner telemetry report the divergence rather than hiding it.
   */
  const resolveCodexSoftPin = (
    source: AccountPool | undefined,
    pinned: ActiveAccount,
    hardPin: boolean,
    model?: string | null,
  ): { selected: ActiveAccount; yieldedFrom: string | null } => {
    if (!source || hardPin) return { selected: pinned, yieldedFrom: null };
    const at = Date.now();
    // WI-10003306: a pinned account that has refused the request model is unserviceable FOR THIS
    // REQUEST — the soft pin yields exactly as it does for a paused account, and resumes on recovery.
    const refused = (account: ActiveAccount) => !!model && codexModelRefusals.isRefused(account.accountId, model);
    const inRotation = source.healthyCount ? source.healthyCount((id) => id === pinned.accountId) > 0 : true;
    if (inRotation && !refused(pinned) && accountHealthKey(pinned, at) < Infinity) {
      return { selected: pinned, yieldedFrom: null };
    }
    try {
      const selected = healthAwareCodexPool(source, model).active();
      if (selected.accountId === pinned.accountId || refused(selected) || accountHealthKey(selected, at) === Infinity) {
        return { selected: pinned, yieldedFrom: null };
      }
      log(
        'warn',
        `inference-gateway: Codex pinned '${pinned.accountId}' UNSERVICEABLE → soft-pin failover to '${selected.accountId}' (pin resumes on recovery)`,
      );
      return { selected, yieldedFrom: pinned.accountId };
    } catch {
      // An all-unserviceable pool still needs the pinned account to render the truthful terminal
      // response. Yielding without a demonstrably serviceable sibling would only move the failure.
      return { selected: pinned, yieldedFrom: null };
    }
  };
  function recordRoute(
    ownerId: string | undefined,
    accountId: string,
    model: string,
    served: { context1m?: boolean; nativeSessionId?: string | null } = {},
  ): void {
    if (!ownerId) return; // only identified callers (x-papercusp-owner present) are addressable
    const prior = lastRouteByOwner.get(ownerId);
    if (!prior && lastRouteByOwner.size >= ROUTE_MAP_MAX) {
      const oldest = lastRouteByOwner.keys().next().value; // Map preserves insertion order → oldest first
      if (oldest !== undefined) lastRouteByOwner.delete(oldest);
    }
    const nativeSessionId = served.nativeSessionId ?? null;
    lastRouteByOwner.set(ownerId, {
      account: accountId,
      model,
      context1m: served.context1m ?? false,
      nativeSessionId,
      // A usage reading belongs to ONE native session: keep it across requests of the same session
      // (the next message_start updates latest usage + the observed floor), drop it the moment the
      // caller's native id changes.
      usage: prior && prior.nativeSessionId === nativeSessionId ? prior.usage : null,
      at: Date.now(),
    });
  }
  /** Attach the exact `message_start` usage to the caller's current route entry (WI-2140943 lane 2).
   *  The entry is written by `recordRoute` synchronously on the response headers, BEFORE the stream's
   *  first data event, so this always finds it unless the map evicted it in between (then: no-op). */
  function recordOwnerUsage(ownerId: string | undefined, usage: GatewayRouteUsageSample): void {
    if (!ownerId) return;
    const e = lastRouteByOwner.get(ownerId);
    if (!e) return;
    e.usage = accumulateGatewayRouteUsage(e.usage, usage);
  }
  /** AUTO-ROUTE SESSION AFFINITY (WI-2140943): the account that last served `key`, when it is still a usable
   *  SOFT-pin candidate — remembered within AUTO_AFFINITY_TTL_MS, and NOT from before an explicit dynamic
   *  `auto` route for this owner (accounts:pin … auto = "return this session to fresh selection"; routes
   *  remembered BEFORE it was set do not count, so affinity cannot re-pin the caller to the account it was
   *  just told to leave — WI-4402. Picks made AFTER the override stick.) ONE helper for every provider lane
   *  (Anthropic, codex bearer, codex CLI/OAuth) so the semantics cannot drift between them (owner directive
   *  2026-09-02: "make sure codex works the same way"). Returns the remembered account id or null; the caller
   *  still resolves it against its own pool (`select`) so an account that left the pool is a cold pick. */
  function affinityPriorAccount(
    key: string | undefined,
    dynPin: { setAt: number } | undefined,
    wantAccount: string | undefined,
  ): string | null {
    if (!key || !AUTO_AFFINITY_ENABLED) return null;
    const prior = lastRouteByOwner.get(key);
    if (prior === undefined || Date.now() - prior.at > AUTO_AFFINITY_TTL_MS) return null;
    if (dynPin !== undefined && wantAccount === undefined && prior.at <= dynPin.setAt) return null;
    return prior.account;
  }

  // PER-OWNER OUTCOME LEDGER (gateway-rayobyte-hardening P-008): bounded per-owner counters + a short
  // recent-event ring, so "agent su-X is erroring — why?" reads from ONE query (GET /admin/owner-report,
  // surfaced as the gateway:owner_report tool) instead of grepping journald. Same bounded-Map discipline
  // as lastRouteByOwner; one Map.set per outcome on the hot path.
  interface OwnerOutcomeEvent {
    at: number;
    kind: string;
    account: string | null;
    detail?: string;
  }
  interface OwnerLedgerEntry {
    requests: number;
    ok: number;
    upstreamErrors: number;
    upstream429: number;
    sheds: number;
    stalls: number;
    pinYields: number;
    lastAccount: string | null;
    lastStatus: number | null;
    /** When the most recent request STARTED. Unlike lastAt, this never moves when a
     *  pre-existing request later completes/errors, so liveness consumers can tell
     *  new owner activity from a late outcome on old work. */
    lastRequestAt: number;
    lastAt: number;
    recent: OwnerOutcomeEvent[];
  }
  const OWNER_LEDGER_MAX = 4096;
  const OWNER_LEDGER_RECENT_MAX = 10;
  const ownerLedger = new Map<string, OwnerLedgerEntry>();
  function recordOwnerOutcome(
    ownerId: string | undefined,
    kind: 'request' | 'ok' | 'upstream_error' | 'upstream_429' | 'shed' | 'stall' | 'pin_yield' | 'context_1m_restored',
    opts: { account?: string; status?: number; detail?: string } = {},
  ): void {
    if (!ownerId) return;
    let e = ownerLedger.get(ownerId);
    if (!e) {
      if (ownerLedger.size >= OWNER_LEDGER_MAX) {
        const oldest = ownerLedger.keys().next().value;
        if (oldest !== undefined) ownerLedger.delete(oldest);
      }
      e = {
        requests: 0,
        ok: 0,
        upstreamErrors: 0,
        upstream429: 0,
        sheds: 0,
        stalls: 0,
        pinYields: 0,
        lastAccount: null,
        lastStatus: null,
        lastRequestAt: 0,
        lastAt: 0,
        recent: [],
      };
      ownerLedger.set(ownerId, e);
    }
    e.lastAt = Date.now();
    if (opts.account) e.lastAccount = opts.account;
    if (opts.status !== undefined) e.lastStatus = opts.status;
    if (kind === 'request') {
      e.requests++;
      e.lastRequestAt = e.lastAt;
    } else {
      if (kind === 'ok') e.ok++;
      else if (kind === 'upstream_error') e.upstreamErrors++;
      else if (kind === 'upstream_429') e.upstream429++;
      else if (kind === 'shed') e.sheds++;
      else if (kind === 'stall') e.stalls++;
      else if (kind === 'pin_yield') e.pinYields++;
      // Only non-request outcomes enter the recent ring — 'request' would drown it.
      e.recent.push({
        at: e.lastAt,
        kind,
        account: opts.account ?? null,
        ...(opts.detail ? { detail: opts.detail } : {}),
      });
      if (e.recent.length > OWNER_LEDGER_RECENT_MAX) e.recent.splice(0, e.recent.length - OWNER_LEDGER_RECENT_MAX);
    }
  }

  // Prompt-cache instrumentation (#0, 2026-06-21): a PASSIVE per-account tally of cache read/write tokens
  // parsed from each response's usage (the `message_start` SSE event), so we can SEE the prompt-cache hit
  // rate per account + the cost of routing a bee off its cache-warm account. Zero hot-path cost: the
  // observer runs ALONGSIDE the client pipe (never in it) and detaches after the first event.
  const CACHE_MISS_MIN_TOKENS = 1024; // ignore tiny requests — only a non-trivial cold prefix counts as a "miss"
  interface CacheTally {
    read: number;
    create: number;
    input: number;
    hits: number;
    misses: number;
    failoverMisses: number;
    comparableRead: number;
    comparableInput: number;
    coverage: GatewayCacheCounts['coverage'];
  }
  const newTally = (): CacheTally => ({ read: 0, create: 0, input: 0, hits: 0, misses: 0, failoverMisses: 0,
    comparableRead: 0, comparableInput: 0,
    coverage: { requests: 0, readKnown: 0, writeKnown: 0, uncachedInputKnown: 0, inputTotalKnown: 0, tokenRateRequests: 0 } });
  const cacheByAccount = new Map<string, CacheTally>();
  const cacheTotal = newTally();
  /** AUTO-ROUTE SESSION AFFINITY counters (WI-2140943), surfaced on /stats `cache.affinity`: `hits` =
   *  unpinned requests routed to the caller's warm account · `cold` = identifiable caller with no usable
   *  prior route (first turn / TTL lapsed / account left the pool) · `nokey` = unpinned AND unidentifiable
   *  (no owner header, no per-session metadata) — the residual per-request round-robin population ·
   *  `yields` = affinity pins that had to fail over because the warm account was unserviceable. */
  const autoAffinityTally = { hits: 0, cold: 0, nokey: 0, yields: 0 };
  function recordCacheUsage(
    accountId: string,
    input: number | null,
    read: number | null,
    create: number | null,
    inputTotal: number | null,
    didFailover: boolean,
  ): void {
    const t = cacheByAccount.get(accountId) ?? newTally();
    for (const x of [t, cacheTotal]) {
      x.coverage.requests++;
      if (read !== null) { x.read += read; x.coverage.readKnown++; }
      if (create !== null) { x.create += create; x.coverage.writeKnown++; }
      if (input !== null) { x.input += input; x.coverage.uncachedInputKnown++; }
      if (inputTotal !== null) x.coverage.inputTotalKnown++;
      if (read !== null && inputTotal !== null && read <= inputTotal) {
        x.comparableRead += read;
        x.comparableInput += inputTotal;
        x.coverage.tokenRateRequests++;
      }
      // HIT = reused a cached prefix. MISS = processed a non-trivial prefix with NO cache read (a cold
      // (re)write — first-time, expired, or wrong-account). A miss AFTER failover is correlated,
      // not proof that routing caused the miss (prefix drift/expiry are not observed here).
      if (read !== null && read > 0) x.hits++;
      else if (read === 0 && inputTotal !== null && inputTotal >= CACHE_MISS_MIN_TOKENS) {
        x.misses++;
        if (didFailover) x.failoverMisses++;
      }
    }
    cacheByAccount.set(accountId, t);
  }
  const observedCount = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  // Attach a bounded, passive 'data' observer that captures the message_start usage then detaches. Runs
  // ALONGSIDE the client pipe (never in it), so it adds zero client-visible latency and can never break the
  // stream (all parsing is wrapped + best-effort).
  function observeCacheUsage(
    stream: Readable,
    accountId: string,
    didFailover: boolean,
    /** The route key (`affinityKey ?? wantOwner`) whose entry receives the exact usage reading. */
    routeKey?: string,
    stageSpan?: GatewayRequestSpan,
    /** P-009: the billing class this request was served in — its usage is tallied under it. */
    billedClass?: GatewayBillingClass,
  ): void {
    let buf = '';
    let done = false;
    // P-009: output tokens are only known at the END of a stream (the closing `message_delta` carries the
    // cumulative count), so after `message_start` a line-split watcher keeps reading — O(chunk) per chunk,
    // never buffering the body — and the LAST count seen is tallied once when the stream ends.
    let lineCarry = '';
    let outputTokens: number | null = null;
    let settled = false;
    const onDelta = (chunk: Buffer | string) => {
      const lines = (lineCarry + chunk.toString()).split('\n');
      lineCarry = lines.pop() ?? '';
      // A giant unterminated line is a content delta, never the small message_delta event.
      if (lineCarry.length > 65_536) lineCarry = '';
      for (const line of lines) {
        if (!line.startsWith('data: {"type":"message_delta"')) continue;
        try {
          const n = observedCount((JSON.parse(line.slice(6)) as { usage?: { output_tokens?: number } }).usage?.output_tokens);
          if (n !== null) outputTokens = n;
        } catch {
          /* malformed message_delta — ignore; never break the stream */
        }
      }
    };
    const settleOutput = () => {
      if (settled || !billedClass) return;
      settled = true;
      stream.off('data', onDelta);
      if (lineCarry) onDelta('\n');
      if (outputTokens === null) return;
      const t = billingTally(accountId, billedClass);
      t.outputTokens += outputTokens;
      t.outputKnown++;
    };
    const onData = (chunk: Buffer) => {
      if (done) return;
      buf += chunk.toString('utf8');
      const m = buf.match(/^data: (\{"type":"message_start".*\})$/m);
      if (m) {
        done = true;
        stream.off('data', onData);
        if (billedClass) {
          stream.on('data', onDelta);
          stream.once('end', settleOutput);
          stream.once('close', settleOutput);
          onDelta(buf.slice((m.index ?? 0) + m[0].length));
        }
        try {
          const message = (
            JSON.parse(m[1]) as {
              message?: {
                id?: string;
                usage?: {
                  input_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                };
              };
            }
          ).message;
          const u = message?.usage;
          if (u) {
            const inputTokens = observedCount(u.input_tokens);
            const cacheRead = observedCount(u.cache_read_input_tokens);
            const cacheCreate = observedCount(u.cache_creation_input_tokens);
            const inputTotal = inputTokens !== null && cacheRead !== null && cacheCreate !== null
              ? inputTokens + cacheRead + cacheCreate : null;
            recordCacheUsage(accountId, inputTokens, cacheRead, cacheCreate, inputTotal, didFailover);
            if (billedClass && inputTokens !== null) {
              const t = billingTally(accountId, billedClass);
              t.inputTokens += inputTokens;
              t.cacheReadTokens += cacheRead ?? 0;
              t.cacheCreationTokens += cacheCreate ?? 0;
              t.usageKnown++;
            }
            if (inputTokens !== null && cacheRead !== null) stageSpan?.recordCacheUsage(inputTokens, cacheRead, cacheCreate ?? undefined, message?.id);
            // Never lower the observed prompt floor using an incomplete total.
            if (inputTotal !== null && inputTokens !== null && cacheRead !== null && cacheCreate !== null) {
              recordOwnerUsage(routeKey, { inputTotal, inputTokens, cacheRead, cacheCreate });
            }
          }
        } catch {
          /* malformed message_start — ignore; never break the stream */
        }
      } else if (buf.length > 32_768) {
        done = true; // message_start not in the first 32KB (non-stream JSON / odd framing) → give up
        stream.off('data', onData);
      }
    };
    stream.on('data', onData);
  }
  /** Responses API twin of `observeCacheUsage`. Streaming usage arrives on a late
   *  `response.completed` SSE event as `response.usage`; non-streaming responses expose `usage`
   *  at the top level. Parse incrementally so a long agent stream never needs to be buffered. */
  function observeOpenAiCacheUsage(stream: Readable, accountId: string, didFailover: boolean, stageSpan?: GatewayRequestSpan): void {
    let carry = '';
    let done = false;
    const detach = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
    };
    const inspect = (raw: string): boolean => {
      const text = raw.trim().replace(/^data:\s*/, '');
      if (!text || text === '[DONE]') return false;
      try {
        const parsed = JSON.parse(text) as {
          id?: string;
          usage?: {
            input_tokens?: number;
            input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
          };
          response?: {
            id?: string;
            usage?: {
              input_tokens?: number;
              input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
            };
          };
        };
        const usage = parsed.response?.usage ?? parsed.usage;
        if (!usage) return false;
        const read = observedCount(usage.input_tokens_details?.cached_tokens);
        const create = observedCount(usage.input_tokens_details?.cache_write_tokens);
        const total = observedCount(usage.input_tokens);
        const input = total !== null && read !== null && create !== null && read + create <= total ? total - read - create : null;
        // Inclusive OpenAI input still supplies the denominator when its write breakdown is absent.
        recordCacheUsage(accountId, input, read, create, total, didFailover);
        if (total !== null && read !== null) stageSpan?.recordCacheUsage(input, read, create ?? undefined, parsed.response?.id ?? parsed.id);
        return true;
      } catch {
        return false;
      }
    };
    const finish = (raw?: string) => {
      if (done) return;
      if (raw && !inspect(raw)) return;
      done = true;
      detach();
    };
    const onData = (chunk: Buffer) => {
      if (done) return;
      carry += chunk.toString('utf8');
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:') && inspect(line)) {
          finish();
          return;
        }
      }
      // A non-streaming JSON response normally has no newline. Keep it bounded; usage-bearing SSE
      // lines are handled above regardless of total stream length.
      if (carry.length > 1_048_576) carry = carry.slice(-65_536);
    };
    const onEnd = () => {
      if (!done && carry) finish(carry);
      else finish();
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
  }
  const cacheSummary = (t: CacheTally): GatewayCacheCounts => ({
    read: t.coverage.readKnown === t.coverage.requests ? t.read : null,
    create: t.coverage.writeKnown === t.coverage.requests ? t.create : null,
    input: t.coverage.uncachedInputKnown === t.coverage.requests ? t.input : null,
    knownTokenTotals: { read: t.read, create: t.create, input: t.input },
    hits: t.hits, misses: t.misses, failoverMisses: t.failoverMisses,
    hitRate: t.comparableInput > 0 ? Math.round((t.comparableRead / t.comparableInput) * 1000) / 1000 : null,
    tokenRateBasis: { read: t.comparableRead, inputTotal: t.comparableInput },
    coverage: { ...t.coverage },
  });
  function cacheSnapshot(): GatewayStats['cache'] {
    const byAccount: GatewayStats['cache']['byAccount'] = {};
    for (const [id, t] of cacheByAccount) {
      byAccount[id] = cacheSummary(t);
    }
    return {
      ...cacheSummary(cacheTotal),
      byAccount,
      affinity: { ...autoAffinityTally, enabled: AUTO_AFFINITY_ENABLED, ttlMs: AUTO_AFFINITY_TTL_MS },
    };
  }

  // Self-heal in-flight registry (EI-2086): every Claude or Codex request currently holding an admission slot, keyed by
  // a per-request id, carrying its start time + stream flag + an abort hook (the same force-terminate
  // path as the hard-ceiling backstop). The sweeper reclaims the oldest stuck slot from here.
  interface InFlightEntry {
    id: number;
    provider: 'claude' | 'codex';
    startedAt: number;
    isStream: boolean;
    reclaimed: boolean; // set when the self-heal valve aborts it → the finally skips the drain-clock bump
    abort: (reason: string) => void;
  }
  const inFlightReg = new Map<number, InFlightEntry>();
  let reqSeq = 0;
  // Per-provider TRUE drain signals: epoch ms of the last NATURAL completion (a real upstream settle,
  // NOT a self-heal abort). Keeping the clocks separate prevents a busy healthy provider from masking
  // a wedge in the other provider's independently capped admission queue.
  const lastDrainAt: Record<'claude' | 'codex', number> = { claude: Date.now(), codex: Date.now() };

  function stats(): GatewayStats {
    // Reflect the active account's opus bucket (the fleet's class) for the headline unified window.
    const active = pool.peek ? pool.peek() : pool.active(); // H3: observe WITHOUT advancing the rr-cursor
    const gov = governorForAccount('claude-opus-4', active.accountId);
    const snap = gov.snapshot();
    const admission = queue.snapshot();
    const codexAdmission = codexQueue.snapshot();
    // The pool-wide serviceable-account count (EI-11511): governor-narrowed so a weekly-usage-walled
    // account (util7d≈1.0, governor predictively paused) does NOT inflate the capacity denominator, matching
    // what the admission clamp already enforces + the WI-390 spawn-readiness gate reads. `null` (single-account
    // pool) → 1.
    const healthyAccounts = serviceableHealthyCount() ?? 1;
    // Priority-tier /stats (step 5): per-tier demand from the queue + the pool-wide healthy-account
    // capacity denominator. Present only with the tier layer (admission.byTier set) → flag-OFF stays
    // byte-identical.
    const priorityTiers = admission.byTier
      ? {
          healthyAccounts,
          tier1Reserve: admission.tier1Reserve ?? 0,
          tiers: admission.byTier,
        }
      : undefined;
    // P-005 smoothing observability: surface each gateway per-account governor's EFFECTIVE pace so
    // "is smoothing working?" is data. Enumerate the gateway's own registry (only the gateway sets
    // `smoothRpm` on a per-account governor → typeof boolean uniquely selects them; the fleet
    // concurrency governor leaves it undefined). The active/bound account is added from `snap` first
    // so it is present even when a test injects governors via deps.governorFor (registry bypassed).
    const now = Date.now();
    const codexHealthyAccounts =
      codexServiceableCount(deps.codexPool, now) +
      codexServiceableCount(codexCliPool, now, codexCliPool ? [] : codexCliHealthEntries());
    const codexRecoveryHorizons = [deps.codexPool, codexCliPool]
      .filter((candidate): candidate is AccountPool => !!candidate?.earliestAvailableAt)
      .map((candidate) =>
        candidate.earliestAvailableAt!({
          now,
          keyOf: (account) => accountHealthKey(account, now),
          recoverAtOf: (account) => hintRecoveryAt(account.accountId, now),
        }),
      );
    const codexEarliestRecoveryAt =
      codexHealthyAccounts > 0 ? 0 : codexRecoveryHorizons.length > 0 ? Math.min(...codexRecoveryHorizons) : Infinity;
    const paceEntry = (st: typeof snap) => ({
      smoothRpm: st.smoothRpm === true,
      rpm: st.limits.rpm ?? null,
      rpmFactor: Math.round(effectiveRpmFactor(st, now) * 1000) / 1000,
      effRpm: effectiveRpm(st, now),
      paceDelayMs: st.paceDelayMs,
      effectivePaceMs: effectivePaceMs(st, now),
    });
    const smoothingByAccount: NonNullable<GatewayStats['smoothing']>['byAccount'] = {};
    if (typeof snap.smoothRpm === 'boolean') smoothingByAccount[active.accountId] = paceEntry(snap);
    for (const gs of snapshotGovernors()) {
      if (gs.accountId && typeof gs.state.smoothRpm === 'boolean' && !smoothingByAccount[gs.accountId]) {
        smoothingByAccount[gs.accountId] = paceEntry(gs.state);
      }
    }
    const smoothing = Object.keys(smoothingByAccount).length
      ? { engaged: smoothRpm, byAccount: smoothingByAccount }
      : undefined;
    const edgeThrottleByAccount: NonNullable<GatewayStats['edgeThrottleByAccount']> = {};
    for (const account of providerAccounts(active)) {
      const entries = effectiveEgressEntries(account);
      const cooled = entries.filter(
        (entry) => (ipCooldownUntil.get(egressCacheKey(account.accountId, entry)) ?? 0) > now,
      );
      const cooldownUntil = Math.max(
        bare429PauseUntil.get(account.accountId) ?? 0,
        ...cooled.map((entry) => ipCooldownUntil.get(egressCacheKey(account.accountId, entry)) ?? 0),
      );
      edgeThrottleByAccount[account.accountId] = {
        edgeThrottled: cooldownUntil > now || cooled.length > 0,
        cooldownUntil,
        cooledIpCount: cooled.length,
        bare429Streak: bare429Streak.get(account.accountId) ?? 0,
      };
    }
    return {
      accountId: active.accountId,
      upstreamBase,
      processStartedAt,
      processUptimeMs: Math.max(0, now - processStartedAt),
      scheduledTimers: listManaged(),
      totalRequests,
      requestStages: requestStageTelemetry.snapshot(),
      routingQuality: routingQualitySnapshot(),
      // P-002: the live breakpoint-layout measurement (see recordCachePolicy).
      cachePolicy: {
        policyVersion: CACHE_POLICY_VERSION,
        enabled: cachePolicyEnabled,
        toolsBreakpoint: cacheToolsBreakpointEnabled,
        splitBoundary: cacheSplitBoundaryEnabled,
        deferLargeTools: cacheDeferLargeToolsEnabled,
        ...cachePolicyStats,
      },
      inFlight: admission.running + codexAdmission.running,
      queueDepth: admission.queued + codexAdmission.queued,
      healthyAccounts,
      // EI-19303809952284205: the durable side-paths' health. Computed fresh on every read (pure), so
      // /healthz, /stats and /admin/stats can never disagree about whether the gateway still has a DB.
      db: dbHealthSnapshot(now),
      admission,
      codexAdmission,
      ...(priorityTiers ? { priorityTiers } : {}),
      upstream429,
      queued429,
      shed429,
      edgeThrottleByAccount,
      // EI-18791887279744938 (defect B): pool-wide egress-proxy reachability, computed fresh on every read
      // (never diverges from what pickEgress actually sees) — the CAUSE `accounts:status`'s "accounts
      // unavailable" SYMPTOM never showed.
      egressProxyHealth: computeEgressProxyHealth(active),
      shedAllThrottled,
      bareBurstRotateSuppressed,
      opusToSonnetDowngrades,
      effortClamps: {
        retries: effortClampRetries,
        rewrites: effortClampRewrites,
        learned: effortClampCache
          .entries()
          .map(({ model: m, from, to, learnedAt, applied }) => ({ model: m, from, to, learnedAt, applied })),
      },
      clamp: {
        mode: clampMode,
        recommendation: Number.isFinite(lastServiceableRecommendation) ? lastServiceableRecommendation : null,
        applied: providerAdmission.windowFor('claude'),
        overridden:
          Number.isFinite(lastServiceableRecommendation) &&
          lastServiceableRecommendation < providerAdmission.windowFor('claude'),
        legacyConfigured: SERVICEABLE_CLAMP_ON,
        legacyTickMs: SERVICEABLE_CLAMP_TICK_MS,
        serviceableAccounts: lastServiceableAccounts,
      },
      maxQueued,
      // Compatibility field: the lane's high-water mark, not a configured cap (P-010).
      concurrencyCap: providerAdmission.snapshotFor('claude').observedPeak,
      aimd: laneAimdSnapshot('claude'),
      codexAimd: laneAimdSnapshot('codex'),
      failovers,
      upstreamErrors,
      egressCircuitOpens,
      egressFailsByAccount: Object.fromEntries(egressFailsByAccount),
      egressAttemptsByAccount: Object.fromEntries(egressAttemptsByAccount),
      egressFailRateByAccount: Object.fromEntries(
        [...egressAttemptsByAccount].map(([id, attempts]) => [
          id,
          attempts > 0 ? Math.round(((egressFailsByAccount.get(id) ?? 0) / attempts) * 10_000) / 10_000 : 0,
        ]),
      ),
      maintenance: { requests: maintenanceRequests, errors: maintenanceErrors, carried: maintenanceCarried },
      selfHealReclaims,
      slotReconcileMismatch,
      inFlightTracked: inFlightReg.size,
      // Oldest tracked slot age — the live "how long has anything been held" gauge (0 when idle). `now` is
      // the stats() clock read above; inFlightReg carries each admitted request's startedAt.
      oldestHeldSlotAgeMs: inFlightReg.size ? now - Math.min(...[...inFlightReg.values()].map((e) => e.startedAt)) : 0,
      stallsRecorded,
      proactiveEgressProbe: {
        enabled: proactiveProbeHandle !== null,
        intervalMs: proactiveEgressProbeMs,
        lastTickAt: proactiveProbeLastTickAt,
        circuitOpens: proactiveProbeOpens,
        failStreakByAccount: Object.fromEntries(proactiveProbeFailStreak),
      },
      codex: {
        requests: codexRequests,
        upstream429: codexUpstream429,
        failovers: codexFailovers,
        errors: codexUpstreamErrors,
      },
      codexHealthyAccounts,
      codexTotalAccounts: codexAccountCount(),
      /** WI-10003306: (account, model) pairs currently routed around because the backend refused
       *  the model for that account. In the pool, not parked; each lapses or clears on a 2xx. */
      codexModelRefusals: codexModelRefusals.snapshot(),
      codexEarliestRecoveryAt: Number.isFinite(codexEarliestRecoveryAt) ? codexEarliestRecoveryAt : null,
      beeFacing503: { egressExhausted: beeEgressExhausted, tokenStall: beeTokenStall },
      // EI-535 (gateway-healthz-stale-latch fix): `snap.unified` freezes at its last-observed value once
      // traffic goes idle — no new upstream response means recordHeaders never runs again to update it.
      // Attach the self-describing companions HERE (the one place every consumer — /healthz, /stats,
      // /admin/stats, a direct incident curl — reads through) so nobody has to re-derive them: `staleAsOfMs`
      // (age of the reading, when observedAt is known) and `rejectedActuallyEnforced` (the trustworthy
      // verdict — `rejected` alone can't distinguish "genuinely still rejected" from "last seen hours ago,
      // that window has long since reset").
      unified: snap.unified
        ? {
            ...snap.unified,
            staleAsOfMs: snap.unified.observedAt !== undefined ? Math.max(0, now - snap.unified.observedAt) : undefined,
            rejectedActuallyEnforced: snap.unified.rejected && snap.unified.resetAt > now,
          }
        : undefined,
      ...(smoothing ? { smoothing } : {}),
      pausedUntil: snap.pausedUntil,
      pausedActuallyEnforced: snap.pausedUntil > now,
      cache: cacheSnapshot(),
      billing: billingSnapshot(),
    };
  }

  function sendJson(res: http.ServerResponse, status: number, body: unknown, extra?: Record<string, string>) {
    res.writeHead(status, { 'content-type': 'application/json', ...extra });
    // Scrub the SERIALIZED body: error messages built from upstream/runtime exceptions can embed a
    // live credential (the 2026-07-03 invalid-header 502 echoed a full sk-ant-oat token to every
    // caller's terminal). sendJson only carries gateway-authored error/status/admin bodies — never
    // proxied model output — so a blanket scrub here is safe and covers every call site at once.
    res.end(scrubSecrets(JSON.stringify(body)));
  }

  /** Max distinct local backends to try for one incoming request before giving up (in-request
   *  failover — a dead backend is skipped immediately rather than waiting for the health-check
   *  tick or HEALTH_FAIL_THRESHOLD live failures to demote it out of `select()`). */
  const LOCAL_BACKEND_MAX_ATTEMPTS = 3;
  /** Retry-After (seconds) hint on a SATURATION 429 — a small local batch frees a slot fast, so a
   *  concurrent agent should back off briefly and retry, not treat capacity as a hard failure. */
  const LOCAL_BACKEND_SATURATION_RETRY_AFTER_SEC = 1;

  /** In-flight cold starts, keyed by backend id (P-008/D-009). systemd already merges concurrent
   *  `start` jobs for one unit, so this is not needed for CORRECTNESS — it de-duplicates the WAIT,
   *  so N simultaneous requests for a stopped backend share ONE poll loop instead of each holding a
   *  connection through the whole model load. Entries are deleted on settle, so this never grows. */
  const localBackendColdStarts = new Map<string, Promise<{ ok: boolean; error?: string }>>();

  /**
   * COLD START (P-008/D-009): a request found no healthy backend for `model`. If a registered
   * on-demand backend serves it, start it and wait for it to answer; on success feed the health
   * state back so the normal selection path can route to it immediately.
   *
   * Returns an error string when a start was attempted and failed (surfaced in the 502 so a failed
   * cold start never reads as "none registered"), or null when nothing was attempted or it worked.
   */
  /**
   * UNREACHABLE-shaped upstream statuses (D-014): what a hop in FRONT of a dead backend emits when
   * it cannot reach it. ornith's registered baseUrl is a sanitizing proxy (:11435) that converts an
   * ECONNREFUSED on the unit's real port (:11436) into a well-formed `502 {"error":"connect
   * ECONNREFUSED ..."}` — so a dead backend arrives here as a RESPONSE, never as a transport throw.
   *
   * ⚠ 500 is deliberately EXCLUDED. llama-server emits 500 for a genuine inference error; treating
   * that as "the process is down" would restart-probe and re-issue a request that already burned
   * real GPU work. 502/503/504 are the codes that actually mean "nothing answered upstream".
   */
  function isUpstreamUnreachable(status: number): boolean {
    return status === 502 || status === 503 || status === 504;
  }

  /** A backend whose PROCESS this gateway may start: on-demand lifecycle + a recorded unit to start.
   *  `unitName` is required and never derived from baseUrl (D-005) — baseUrl may be a proxy, as
   *  ornith's is. `enabled` is already the pool's admission filter (launch.ts drops disabled rows),
   *  but is re-checked so this stays correct if a caller ever constructs a pool by hand. */
  function startableOnDemand(backend: LocalBackend): boolean {
    return backend.enabled && backend.lifecycle === 'on-demand' && !!backend.unitName;
  }

  /** Start ONE known-startable backend and fold success back into the pool's health state.
   *  Returns an error string when a start was attempted and failed, else null. */
  async function ensureOnDemandBackend(candidate: LocalBackend): Promise<string | null> {
    const pool = deps.localBackends;
    const ensure = deps.ensureLocalBackendRunning;
    if (!pool || !ensure) return null;

    let started = localBackendColdStarts.get(candidate.id);
    if (!started) {
      log(
        'info',
        `inference-gateway: local backend '${candidate.id}' (${candidate.unitName}) is not answering — starting it on demand`,
      );
      started = ensure(candidate).finally(() => localBackendColdStarts.delete(candidate.id));
      localBackendColdStarts.set(candidate.id, started);
    }

    let result: { ok: boolean; error?: string };
    try {
      result = await started;
    } catch (e) {
      // A throwing ensure impl must not crash the request — it is an upstream-shaped failure.
      return `cold start of '${candidate.id}' threw: ${(e as Error).message ?? String(e)}`;
    }
    if (!result.ok) return `cold start of '${candidate.id}' failed: ${result.error ?? 'unknown error'}`;

    // The pool still believes this backend unhealthy — health state moves only on probes and live
    // outcomes, and the probe that demoted it ran while the unit was down. A single ok resets
    // consecutiveFailures and flips healthy back to true (nextHealthState), which is what makes the
    // unchanged attempt loop below able to select it on this very request.
    pool.recordOutcome(candidate.id, true);
    log(
      'info',
      `inference-gateway: local backend '${candidate.id}' started on demand and is answering — routing resumed`,
    );
    return null;
  }

  /** Cold-start entry for the DEAD-END pre-flight: no healthy backend serves `model`, so find a
   *  startable one that does. (The forward-failure path in proxyLocal already holds the specific
   *  backend that just failed and calls `ensureOnDemandBackend` directly.) */
  async function ensureOnDemandBackendForModel(model: string): Promise<string | null> {
    const pool = deps.localBackends;
    if (!pool || !deps.ensureLocalBackendRunning) return null;
    const candidate = pool.entries().find((b) => b.models.includes(model) && startableOnDemand(b));
    if (!candidate) return null;
    return ensureOnDemandBackend(candidate);
  }

  /**
   * Proxy an OpenAI-compatible `/v1/chat/completions` or `/v1/completions` request to the LOCAL
   * backend pool (local-concurrent-inference-2026-07-02 P-004, D-002). The server boundary admits the
   * request through the canonical resource governor before this function; local backends themselves
   * are unauthenticated localhost/LAN processes. Least-loaded routing via `deps.localBackends.select()`;
   * on a connect/transport failure, retries against a
   * DIFFERENT backend (up to LOCAL_BACKEND_MAX_ATTEMPTS) before giving up with a 502. Streams the
   * upstream response body through untouched (SSE `stream:true` included).
   */
  async function proxyLocal(req: http.IncomingMessage, res: http.ServerResponse, url: string) {
    const stageSpan = requestSpan(req);
    const pool = deps.localBackends;
    if (!pool) {
      sendJson(res, 404, {
        type: 'error',
        error: { type: 'not_found_error', message: 'inference-gateway: no local-backend pool configured' },
        gateway: true,
      });
      return;
    }

    // Owner attribution is used only for slot affinity and request telemetry. Admission is owned by
    // the canonical durable gateway governor, so no local per-client cap/circuit may shed work before
    // a receipt exists.
    const ownerId = (req.headers[OWNER_HEADER] as string | undefined)?.trim();
    try {
      stageSpan?.beginStage('bodyRead');
      let bodyBuf: Buffer;
      try {
        bodyBuf = await readBody(req);
      } finally {
        stageSpan?.endStage('bodyRead');
      }
      let model: string | undefined;
      let isStream = false;
      try {
        const j = JSON.parse(bodyBuf.toString('utf8')) as { model?: string; stream?: boolean };
        if (typeof j.model === 'string') model = j.model;
        isStream = j.stream === true;
      } catch {
        /* non-JSON body — fall through to the "no model" 400 below */
      }
      if (!model) {
        sendJson(res, 400, {
          error: { message: 'request body must be JSON with a "model" field', type: 'invalid_request_error' },
        });
        return;
      }
      stageSpan?.setModel(model);
      stageSpan?.setStreaming(isStream);

      // COLD-START PRE-FLIGHT (P-008/D-009). A STOPPED on-demand backend fails its health probe, so
      // it is never SELECTED — the request would 502 before any forward, which is why ensure-running
      // attaches here rather than at the forward below. Both reads are PURE: select() without an
      // ownerId takes the no-affinity branch (no bookkeeping mutated), and saturatedFor() is pure by
      // construction — so the warm path costs one in-memory scan and zero I/O.
      //
      // The `!saturatedFor` guard is load-bearing: a SATURATED pool must keep answering 429 +
      // Retry-After. Starting more GPU processes is not the answer to backpressure, only to a model
      // that nothing healthy serves.
      let coldStartError: string | null = null;
      if (!pool.select(model) && !pool.saturatedFor(model)) {
        coldStartError = await ensureOnDemandBackendForModel(model);
      }

      // P-007: the hand-rolled attempt loop is GONE. `executeGatewayRequestKernel` owns
      // attempt counting, failover bookkeeping, per-attempt deadlines, abort wiring, the
      // stage spans and the response relay; `createLocalKernelAdapter` owns backend
      // selection, the forward, and the on-demand cold-start rescue.
      //
      // D-015 side-effect difference over the deleted region: the only `X++` in it was the
      // loop's own `attempt`, which the kernel now owns as `attemptsUsed`; every pool
      // side effect (`recordStart`/`recordEnd`/`recordOutcome`) moved into the adapter's
      // `executeAttempt`, and `recordFailover` is now the kernel's `adoptRoute`, which
      // fires on exactly the same condition the ladder used — the backend CHANGING.
      const localAttemptTimeoutMs = deps.localBackendTimeoutMs ?? DEFAULT_LOCAL_BACKEND_TIMEOUT_MS;
      const kernelAdapter = createLocalKernelAdapter({
        pool,
        model,
        // P-028 slot affinity: the owner's last backend is preferred while eligible, so the
        // session's KV prefix survives across hops (a process switch = full re-prefill).
        ownerId: ownerId || null,
        url,
        body: new Uint8Array(bodyBuf),
        // Request-derived, parsed once above — the same one fact drives the span.
        streaming: isStream,
        attemptTimeoutMs: localAttemptTimeoutMs,
        fetchImpl: (target, init) => doFetch(target, init as RequestInit) as unknown as Promise<LocalFetchResponse>,
        isUpstreamUnreachable,
        startableOnDemand,
        ensureOnDemandBackend,
        // The DEAD-END pre-flight already ran above; its result seeds the adapter so
        // `state()` stays the single terminal-rendering source rather than a second copy.
        initialColdStartError: coldStartError,
        log,
      });

      try {
        await executeGatewayRequestKernel<LocalRouteValue, LocalRouteValue, LocalChunk, LocalResponseMetadata>({
          request: {
            lane: gatewayLaneRegistry.localOpenAiChat,
            body: (async function* () {
              yield bodyBuf;
            })(),
            ownerId: ownerId || null,
            // The lane declares `accountPinning: 'none'`, so a pin is a 400 by contract.
            pin: null,
          },
          policy: {
            // Kernel adoption necessarily adds a request-body byte cap the hand-rolled
            // path never had. Sized so it cannot bind on a local chat completion.
            maxBodyBytes: Number(process.env.PAPERCUSP_GATEWAY_MAX_BODY_BYTES) || 64 * 1024 * 1024,
            bodyReadTimeoutMs: localAttemptTimeoutMs,
            // The ladder bounded each ATTEMPT and never the whole request, so this is set
            // to the worst case that per-attempt budget already permits: deliberately
            // non-binding, not a new shed policy folded into an extraction (D-003).
            requestCeilingMs: localAttemptTimeoutMs * LOCAL_BACKEND_MAX_ATTEMPTS,
            ttfbTimeoutMs: localAttemptTimeoutMs,
            bodyIdleTimeoutMs: localAttemptTimeoutMs,
            downstreamIdleTimeoutMs: localAttemptTimeoutMs,
            maxAttempts: LOCAL_BACKEND_MAX_ATTEMPTS,
          },
          telemetry: requestStageTelemetry,
          // Adopt the span this HTTP request already opened, or the kernel would begin a
          // SECOND one and double-count the request.
          span: stageSpan,
          admission: {
            // PASS-THROUGH: `withDurableGatewayAdmission` already crossed the canonical
            // durable governor before this handler was entered, and that crossing is this
            // lane's ONLY real admission — it has no queue of its own — so re-admitting
            // here would self-deadlock on the slot the request already holds.
            run: (_context, task) => task(),
          },
          adapter: kernelAdapter,
          // Parity with the ladder, which never registered here either. Registering is a
          // real improvement and belongs in its own change (D-003).
          inFlight: { register: () => ({ unregister: () => undefined }) },
          downstream: {
            start: ({ status, metadata }) => {
              res.writeHead(status, { 'content-type': metadata.contentType });
            },
            write: async (chunk) => {
              // Honour downstream backpressure exactly as `nodeStream.pipe(res)` did.
              // The old hand-rolled pipe needed an explicit 'error' guard because an
              // unhandled stream error would crash the whole gateway; the kernel consumes
              // the body by async iteration, so that failure is now a rejected promise it
              // already owns rather than an unhandled event.
              if (!res.write(chunk)) {
                await new Promise<void>((resolve) => {
                  const settle = () => {
                    res.off('drain', settle);
                    res.off('close', settle);
                    res.off('error', settle);
                    resolve();
                  };
                  res.once('drain', settle);
                  res.once('close', settle);
                  res.once('error', settle);
                });
              }
            },
            end: () => {
              res.end();
            },
          },
        });
        return;
      } catch (kernelFailure) {
        // The kernel ran out of routes — the ladder's fall-through past its loop. Once
        // bytes are on the wire there is no status left to choose.
        if (res.headersSent) {
          try {
            res.destroy();
          } catch {
            /* already torn down */
          }
          return;
        }
        void kernelFailure;
        const state = kernelAdapter.state();

        // Distinguish RETRYABLE SATURATION (the model IS served by a healthy backend, but
        // every slot is busy — selection returned null purely from being at capacity) from a
        // genuine DEAD END (unmatched model / all-unhealthy / the backends we tried errored).
        // D-010/D-012: saturation → 429 + Retry-After (backpressure a concurrent agent should
        // wait-and-retry on, not a 502 it may treat as a hard failure / storm on); dead end →
        // 502. Only saturation when we never got a backend to even try (triedCount === 0, no
        // transport error) — once a real backend error occurred, that's a 502.
        if (state.triedCount === 0 && state.lastError === null && pool.saturatedFor(model)) {
          // Retryable backpressure from the measured backend state. The canonical durable
          // admission lease remains the only request-level capacity authority; local routing
          // does not maintain a second owner or backend policy cap.
          sendJson(
            res,
            429,
            {
              type: 'error',
              error: {
                type: 'rate_limit_error',
                message: `inference-gateway: local backend for model '${model}' is at capacity — retry shortly`,
              },
              gateway: true,
            },
            { 'retry-after': String(LOCAL_BACKEND_SATURATION_RETRY_AFTER_SEC) },
          );
          return;
        }
        sendJson(res, 502, {
          type: 'error',
          // A FAILED COLD START outranks both generic readings (P-008/D-009): "we tried to start
          // the backend that serves this model and could not" is a different operator problem
          // from "none registered / all unhealthy", and reporting it as the latter hides the
          // actual fault.
          error: {
            type: 'api_error',
            message: `inference-gateway: no reachable local backend for model '${model}'${
              state.coldStartError
                ? ` (${state.coldStartError})`
                : state.lastError
                  ? ` (last error: ${state.lastError})`
                  : ' (none registered / all unhealthy)'
            }`,
          },
          gateway: true,
        });
      }
    } catch (e) {
      // Keep an unexpected local proxy failure request-scoped after removing
      // the legacy per-client circuit's finally block.
      if (!res.headersSent) {
        sendJson(res, 502, {
          type: 'error',
          error: {
            type: 'api_error',
            message: `inference-gateway local backend error: ${(e as Error).message ?? String(e)}`,
          },
          gateway: true,
        });
      } else {
        try {
          res.destroy();
        } catch {
          /* already torn down */
        }
      }
    }
  }

  type CodexModelsCatalog = { models: unknown[]; [key: string]: unknown };
  type CachedCodexModelsCatalog = {
    catalog: CodexModelsCatalog;
    clientVersion: string | null;
    freshUntil: number;
  };
  const codexModelsCatalogCache = new Map<string, CachedCodexModelsCatalog>();
  const codexModelsCatalogInFlight = new Map<string, Promise<CodexModelsCatalog | null>>();

  const parsedCodexModelsCatalog = (value: unknown): CodexModelsCatalog | null => {
    let parsed = value;
    if (typeof parsed === 'string' || Buffer.isBuffer(parsed)) {
      try {
        parsed = JSON.parse(String(parsed));
      } catch {
        return null;
      }
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
    const models = (parsed as Record<string, unknown>).models;
    if (!Array.isArray(models)) return null;
    const usable = models.filter(
      (row) =>
        row !== null &&
        !Array.isArray(row) &&
        typeof row === 'object' &&
        typeof (row as Record<string, unknown>).slug === 'string' &&
        ((row as Record<string, unknown>).slug as string).trim() !== '',
    );
    if (usable.length === 0) return null;
    return { ...(parsed as Record<string, unknown>), models: usable } as CodexModelsCatalog;
  };

  const codexModelsClientVersion = (url: string): string | null => {
    try {
      const value = new URL(url, 'http://127.0.0.1').searchParams.get('client_version')?.trim();
      return value || null;
    } catch {
      return null;
    }
  };

  /** Fetch the selected subscription account's NATIVE catalog. The old implementation only
   *  overlaid `<home>/models_cache.json`; pool homes are seldom launched directly, so their
   *  caches can remain months stale and silently hide every newly released model. This lookup
   *  uses the same account OAuth, refresh, and egress seams as Responses traffic. A failure
   *  returns the stale last-known-good (if any), then the caller merges disk/static fallback. */
  async function liveCodexModelsCatalog(cli: CodexCliAccount, url: string): Promise<CodexModelsCatalog | null> {
    const clientVersion = codexModelsClientVersion(url);
    const cached = codexModelsCatalogCache.get(cli.accountId);
    if (cached && cached.clientVersion === clientVersion && cached.freshUntil > Date.now()) {
      return cached.catalog;
    }
    const existing = codexModelsCatalogInFlight.get(cli.accountId);
    if (existing) return existing;

    const task = (async (): Promise<CodexModelsCatalog | null> => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error(`codex models catalog timed out after ${codexModelsCatalogTimeoutMs}ms`)),
        codexModelsCatalogTimeoutMs,
      );
      timer.unref?.();
      try {
        // CodexCliAccount intentionally carries no token() method; dispatcherFor/pickEgress need only
        // the common account-id/egress fields, so adapt it to the shared routing shape without copying
        // credential material into the account object.
        const routingAccount: ActiveAccount = {
          accountId: cli.accountId,
          token: async () => '',
          egress: cli.egress,
          egressPool: cli.egressPool,
        };
        const egress = pickEgress(routingAccount, Date.now());
        const dispatcher = await dispatcherFor(routingAccount, egress.entry);
        const fetchViaDispatcher = ((target: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const fetchInit: FetchInit = { ...init, signal: init?.signal ?? controller.signal };
          if (dispatcher) fetchInit.dispatcher = dispatcher;
          return doFetch(target, fetchInit);
        }) as typeof fetch;

        let auth = await resolveCodexAccessToken(cli.home, { fetchImpl: fetchViaDispatcher });
        const upstreamUrl = new URL(`${CODEX_CHATGPT_BACKEND_BASE.replace(/\/$/, '')}/models`);
        if (clientVersion) upstreamUrl.searchParams.set('client_version', clientVersion);

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const baseHeaders: Record<string, string> = { accept: 'application/json' };
          if (clientVersion) baseHeaders['user-agent'] = `codex_cli_rs/${clientVersion}`;
          const response = await fetchViaDispatcher(upstreamUrl, {
            method: 'GET',
            signal: controller.signal,
            headers: buildCodexUpstreamHeaders({
              base: baseHeaders,
              accessToken: auth.accessToken,
              accountId: auth.accountId,
            }),
          });
          if (response.status === 401 && attempt === 0) {
            await response.body?.cancel().catch(() => undefined);
            auth = await refreshCodexToken(cli.home, auth, { fetchImpl: fetchViaDispatcher });
            continue;
          }
          if (!response.ok) throw new Error(`upstream returned HTTP ${response.status}`);
          const text = await response.text();
          if (Buffer.byteLength(text, 'utf8') > CODEX_MODELS_CATALOG_MAX_BYTES) {
            throw new Error(`upstream catalog exceeded ${CODEX_MODELS_CATALOG_MAX_BYTES} bytes`);
          }
          const catalog = parsedCodexModelsCatalog(text);
          if (!catalog) throw new Error('upstream returned an invalid or empty catalog');
          codexModelsCatalogCache.set(cli.accountId, {
            catalog,
            clientVersion,
            freshUntil: Date.now() + codexModelsCatalogTtlMs,
          });
          return catalog;
        }
        throw new Error('upstream authentication retry was exhausted');
      } catch (error) {
        log(
          'warn',
          `inference-gateway: live Codex model catalog unavailable for '${cli.accountId}' — using last-known-good/local/static fallback (${(error as Error).message})`,
        );
        return cached?.catalog ?? null;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      if (codexModelsCatalogInFlight.get(cli.accountId) === task) {
        codexModelsCatalogInFlight.delete(cli.accountId);
      }
    });
    codexModelsCatalogInFlight.set(cli.accountId, task);
    return task;
  }

  function codexModelsResponse(cliHome?: string, liveCatalog?: CodexModelsCatalog | null) {
    const reasoningDescriptions = {
      low: 'Fast responses with lighter reasoning',
      medium: 'Balances speed and reasoning depth for everyday tasks',
      high: 'Greater reasoning depth for complex problems',
      xhigh: 'Extra high reasoning depth for complex problems',
      max: 'Maximum reasoning depth for the hardest problems',
      ultra: 'Maximum reasoning with automatic task delegation',
    } as const;
    type ReasoningEffort = keyof typeof reasoningDescriptions;
    type ReasoningLevel = { effort: string; description: string; [key: string]: unknown };
    type CodexModel = { slug: string; supported_reasoning_levels?: ReasoningLevel[]; [key: string]: unknown };
    const reasoningLevels = (...efforts: ReasoningEffort[]): ReasoningLevel[] =>
      efforts.map((effort) => ({ effort, description: reasoningDescriptions[effort] }));
    const standardReasoningLevels = reasoningLevels('low', 'medium', 'high', 'xhigh');
    const maxReasoningLevels = reasoningLevels('low', 'medium', 'high', 'xhigh', 'max');
    const ultraReasoningLevels = reasoningLevels('low', 'medium', 'high', 'xhigh', 'max', 'ultra');
    /**
     * `contextWindow` / `maxContextWindow` are per-model on purpose (plan
     * codex-1m-context-window-2026-08-17 P-005). They used to be a flat 272,000
     * for EVERY model, which told each gateway-routed Codex agent that no
     * extended window existed anywhere — the CLI cannot fetch the account's real
     * catalog through a custom `model_provider`, so whatever we return HERE is
     * the only catalog it ever sees. Values mirror the upstream registry
     * (codex-cli 0.147.0, 2026-08-17); keep them in sync alongside the lineup
     * itself, and note `max == context` is a real state meaning "no extended
     * window", not a placeholder to fill in.
     */
    const model = (
      slug: string,
      displayName: string,
      description: string,
      priority: number,
      contextWindow = 272_000,
      maxContextWindow = contextWindow,
      supportedReasoningLevels = standardReasoningLevels,
    ) => ({
      slug,
      display_name: displayName,
      description,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: supportedReasoningLevels,
      shell_type: 'shell_command',
      visibility: 'list',
      supported_in_api: true,
      priority,
      additional_speed_tiers: [],
      service_tiers: [],
      availability_nux: { message: '' },
      upgrade: null,
      base_instructions: '',
      model_messages: { instructions_template: '' },
      supports_reasoning_summaries: true,
      default_reasoning_summary: 'none',
      support_verbosity: true,
      default_verbosity: 'low',
      apply_patch_tool_type: 'freeform',
      web_search_tool_type: 'text_and_image',
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: true,
      context_window: contextWindow,
      max_context_window: maxContextWindow,
      // NO comp_hash here, deliberately (WI-10005673). Codex compares each turn's comp_hash with
      // the previous turn's and, when both are present and differ, compacts before the turn
      // (CompactionReason::CompHashChanged). This used to say 'papercusp-gateway' while the live
      // upstream catalog says e.g. '3000', so every thread that crossed between the two sources
      // compacted on its next turn, and the managed PreCompact hook turned that into a
      // carry-respawn that lost the history. The gateway does not know the compaction hash, so
      // it must not claim one: Codex skips the check when either side is absent.
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ['text', 'image'],
      supports_search_tool: true,
      use_responses_lite: false,
    });
    const reasoningTiers: Record<CodexFallbackReasoningTier, ReasoningLevel[]> = {
      standard: standardReasoningLevels,
      max: maxReasoningLevels,
      ultra: ultraReasoningLevels,
    };
    const fallbackModels: CodexModel[] = CODEX_GATEWAY_FALLBACK_LINEUP.map((entry) =>
      model(
        entry.slug,
        entry.displayName,
        entry.description,
        entry.priority,
        entry.contextWindow,
        entry.maxContextWindow,
        reasoningTiers[entry.reasoning ?? 'standard'],
      ),
    );
    const validReasoningLevels = (value: unknown): ReasoningLevel[] =>
      Array.isArray(value)
        ? value.flatMap((level) => {
            if (!level || Array.isArray(level) || typeof level !== 'object') return [];
            const effort = (level as Record<string, unknown>).effort;
            if (typeof effort !== 'string' || effort.trim() === '') return [];
            const description = (level as Record<string, unknown>).description;
            return [
              {
                ...(level as Record<string, unknown>),
                effort,
                description: typeof description === 'string' ? description : '',
              } as ReasoningLevel,
            ];
          })
        : [];
    const modelsFromCatalog = (catalog: unknown): CodexModel[] => {
      const parsed = parsedCodexModelsCatalog(catalog);
      if (!parsed) return [];
      return parsed.models.flatMap((row) => {
          if (!row || Array.isArray(row) || typeof row !== 'object') return [];
          const slug = (row as Record<string, unknown>).slug;
          if (typeof slug !== 'string' || slug.trim() === '') return [];
          const normalized = { ...(row as Record<string, unknown>), slug } as CodexModel;
          const levels = validReasoningLevels(normalized.supported_reasoning_levels);
          if (levels.length > 0) normalized.supported_reasoning_levels = levels;
          else delete normalized.supported_reasoning_levels;
          return [normalized];
        });
    };
    let localCatalog: unknown = null;
    if (cliHome) {
      try {
        localCatalog = codexModelsCacheRead(cliHome);
      } catch {
        /* live/static fallback below */
      }
    }
    const localModels = modelsFromCatalog(localCatalog);
    const liveModels = modelsFromCatalog(liveCatalog);
    const mergeReasoningLevels = (native: unknown, fallback: unknown): ReasoningLevel[] => {
      const merged: ReasoningLevel[] = [];
      const seen = new Set<string>();
      for (const level of [...validReasoningLevels(native), ...validReasoningLevels(fallback)]) {
        if (seen.has(level.effort)) continue;
        seen.add(level.effort);
        merged.push(level);
      }
      return merged;
    };
    const order = fallbackModels.map((entry) => entry.slug);
    const modelsBySlug = new Map(fallbackModels.map((entry) => [entry.slug, entry]));
    // Old pool-home cache first, then the freshly fetched account catalog. Later sources win
    // metadata while retaining any reasoning level the safer fallback knew about.
    // comp_hash is taken ONLY from the live account catalog (WI-10005673). A pool-home cache can
    // be arbitrarily stale, and serving its hash while live is unavailable reintroduces the
    // cross-source flip that forces Codex into a pre-turn CompHashChanged compaction.
    const withoutCompHash = (row: CodexModel): CodexModel => {
      const { comp_hash: _staleCompHash, ...rest } = row;
      return rest as CodexModel;
    };
    for (const source of [localModels.map(withoutCompHash), liveModels]) {
      for (const incoming of source) {
        const prior = modelsBySlug.get(incoming.slug);
        if (!prior) order.push(incoming.slug);
        modelsBySlug.set(
          incoming.slug,
          prior
            ? {
                ...prior,
                ...incoming,
                supported_reasoning_levels: mergeReasoningLevels(
                  incoming.supported_reasoning_levels,
                  prior.supported_reasoning_levels,
                ),
              }
            : incoming,
        );
      }
    }
    const models = order.map((slug) => modelsBySlug.get(slug)!).filter(Boolean);
    return {
      // Mirror of the ChatGPT backend's Codex model catalog so the Codex CLI
      // `/model` picker offers the full current lineup when routed THROUGH the
      // gateway. A custom `model_provider` (our gateway) can't fetch the
      // account's model catalog the way native ChatGPT-login does — so whatever
      // we return HERE *is* the picker. A short/stale list silently caps every
      // gateway-routed Codex agent to just these models (owner-reported
      // 2026-07-10: only gpt-5 / gpt-5.5 were offered through the gateway while
      // the same account showed the full lineup natively). Keep in sync with the
      // upstream catalog. The selected configured CLI account's native cache
      // overlays this fallback on every request, preserving new metadata/models
      // without letting an older cache remove fallback reasoning levels.
      models,
    };
  }

  /**
   * P-011 / D-027: the ADMITTED body of the `anthropic-messages` lane. Its caller
   * (`proxy`) has already taken the lane's admission slot, which is why this function
   * receives a PASS-THROUGH kernel admission and must never be entered directly.
   *
   * Why the slot is taken above this function rather than at the kernel's own
   * `admission.run` seam: the seam lives INSIDE `executeGatewayRequestKernel`
   * (request-kernel.ts:887) and this handler calls the kernel from inside the `for (;;)`
   * internal-retry loop below, so a seam-placed slot would be taken PER PASS — a request
   * that absorbs a 429 would surrender its queue slot and re-queue behind newcomers
   * mid-flight — and it would sit inside the per-account governor hold acquired below,
   * inverting queue→governor into governor→queue.
   */
  async function proxyAdmitted(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    kernelAdmission: GatewayLaneAdmission,
  ) {
    const stageSpan = requestSpan(req);
    stageSpan?.setTransport('oauth-http');
    // `let` (not const): WI-1073 may rewrite this to a sonnet body as a last resort when opus is walled
    // pool-wide (see the downgrade hook in the internal-retry loop below).
    stageSpan?.beginStage('bodyRead');
    let bodyBuf: Buffer;
    try {
      bodyBuf = await readBody(req);
    } finally {
      stageSpan?.endStage('bodyRead');
    }
    let model = 'claude-opus-4';
    let requestedModelPresent = false;
    let context1m = false;
    // WI-1073: at-most-once guard — we downgrade a walled OPUS request to sonnet only ONCE per request,
    // so a failed sonnet retry forwards (never opus→sonnet→sonnet looping).
    let opusDowngraded = false;
    // WI-10005833: at-most-once guard for the unsupported-effort retry, plus what was substituted (for
    // the response header). A second effort 400 after the retry is forwarded, never looped on.
    let effortClampRetried = false;
    let effortClampedFrom: string | null = null;
    let effortClampedTo: string | null = null;
    let est = { inTok: 0, outTok: 1024 };
    // Streaming requests get the SHORT TTFB headers deadline (first byte in seconds); non-streaming the
    // generous one (headers only after the full generation). Default false → generous, so an unparseable
    // body never gets the short clip.
    let isStream = false;
    /** Claude CLI `metadata.user_id` from the body — the auto-affinity fallback key (WI-2140943). */
    let bodyMetaUserId: string | undefined;
    if (url.startsWith('/v1/messages') && bodyBuf.length) {
      const normalized = normalizeGatewayRequestBody(bodyBuf);
      bodyBuf = normalized.body;
      context1m = normalized.context1m;
      // Prompt-cache policy (gateway-cache-plane-shared-prefix-ttl-2026-07-19 P-001/P-003):
      // extended ttl on every ephemeral marker + the org-shared tools-span breakpoint. Pure
      // request-body rewrite, idempotent, budget-safe; kill-switch PAPERCUSP_CACHE_POLICY=0.
      if (cachePolicyEnabled) {
        const cached = rewriteAnthropicCacheBody(bodyBuf, {
          injectToolsBreakpoint: cacheToolsBreakpointEnabled,
          splitBoundary: cacheSplitBoundaryEnabled,
          deferLargeTools: cacheDeferLargeToolsEnabled,
          deferMinToolBytes: cacheDeferMinToolBytesValue,
        });
        bodyBuf = cached.body;
        if (cached.stats) {
          recordCachePolicy('anthropic', cached.stats);
          stageSpan?.setCacheRouting('rewritten');
        }
      }
      try {
        const j = JSON.parse(bodyBuf.toString('utf8')) as {
          model?: string;
          stream?: boolean;
          metadata?: { user_id?: unknown };
        };
        if (typeof j.model === 'string') {
          model = j.model;
          requestedModelPresent = true;
        }
        if (j.stream === true) isStream = true;
        // Claude CLI per-session caller id — the auto-affinity fallback key when no x-papercusp-owner
        // header is present (WI-2140943). Read-only; the body is forwarded unchanged.
        if (typeof j.metadata?.user_id === 'string') bodyMetaUserId = j.metadata.user_id;
        est = estimateTokens(j);
      } catch {
        /* non-JSON body (e.g. a count_tokens variant) — keep defaults */
      }
    }
    const requestedModel = model;
    stageSpan?.setModel(model);
    stageSpan?.setStreaming(isStream);
    stageSpan?.setCacheShape(bodyBuf);
    /** The caller's native session id — what a per-owner served-route reading is bound to. */
    const nativeSessionId = nativeSessionIdFromMetaUserId(bodyMetaUserId);
    // Cache-affinity routing (P-002/P-003): a spawn pins its requests to one account via the
    // x-papercusp-account header so its per-credential conversation cache survives; an unknown id
    // (or no header / a single-account pool) falls back to the active account — today's behavior.
    const wantAccountHeader = (req.headers[ACCOUNT_HEADER] as string | undefined)?.trim();
    // The bee's coord ownerId (== spawnId), if it identified itself — lets the gateway attribute an
    // all-throttled shed back to this bee for the stall-waker (P-002). Absent ⇒ not wake-able (no-op).
    const wantOwner = (req.headers[OWNER_HEADER] as string | undefined)?.trim() || undefined;
    recordOwnerOutcome(wantOwner, 'request'); // P-008 per-owner ledger
    // This server-side read is bound to the applied launch receipt and immutable
    // operation pin. A caller-supplied owner header cannot grant model authority.
    // Check once per HTTP request, before account selection or upstream I/O; reuse
    // the same verdict if the internal retry ladder reaches a substitution.
    let operationModelPolicy: ActiveOperationModelPolicyRead = { status: 'none' };
    if (wantOwner && deps.readAcceptedOperationModelPolicy) {
      try {
        operationModelPolicy = await deps.readAcceptedOperationModelPolicy(wantOwner);
      } catch {
        operationModelPolicy = { status: 'unavailable', reason: 'model policy lookup failed' };
      }
      if (operationModelPolicy.status === 'unavailable') {
        sendJson(res, 503, {
          type: 'error',
          error: { type: 'api_error', message: `accepted operation model policy unavailable: ${operationModelPolicy.reason}` },
          gateway: true,
        }, { 'x-should-retry': 'false' });
        return;
      }
      if (operationModelPolicy.status === 'bound' &&
          (!requestedModelPresent || !acceptedClaudeModelAllows(operationModelPolicy.policy, model))) {
        sendJson(res, 403, {
          type: 'error',
          error: { type: 'permission_error', message: `requested model is outside the accepted ${operationModelPolicy.policy.mode} model policy` },
          gateway: true,
        }, { 'x-should-retry': 'false' });
        return;
      }
      if (operationModelPolicy.status === 'bound' && operationModelPolicy.policy.effort &&
          forwardedClaudeEffort(bodyBuf) !== operationModelPolicy.policy.effort.toLowerCase()) {
        sendJson(res, 503, { type: 'error',
          error: { type: 'api_error', message: 'forwarded reasoning effort differs from the accepted operation policy' },
          gateway: true }, { 'x-should-retry': 'false' });
        return;
      }
      if (operationModelPolicy.status === 'bound' && operationModelPolicy.attestation &&
          !deps.recordAcceptedOperationModelAttestation) {
        sendJson(res, 503, { type: 'error',
          error: { type: 'api_error', message: 'accepted operation request attestation writer is unavailable' },
          gateway: true }, { 'x-should-retry': 'false' });
        return;
      }
    }
    // DYNAMIC OWNER PIN (account-dynamic-pin-2026-06-29): a runtime pin (accounts:pin) keyed by owner id
    // OVERRIDES the static x-papercusp-account spawn header — so an agent can re-route itself or another LIVE.
    // Absent ⇒ the static header (today's behavior). The dynamic pin also carries its own hard/soft choice.
    const dynPin = wantOwner ? ownerPinMap.get(wantOwner) : undefined;
    const wantAccount = dynPin
      ? dynPin.accountId.trim().toLowerCase() === OWNER_AUTO_ACCOUNT_ROUTE
        ? undefined
        : dynPin.accountId
      : wantAccountHeader;
    const headerPinned = (wantAccount && pool.select?.(wantAccount)) || null;
    // AUTO-ROUTE SESSION AFFINITY (WI-2140943, 2026-09-02): an UNPINNED request from an identifiable caller
    // prefers the account that last served it (`lastRouteByOwner`, written on the served-response chokepoint)
    // as a SOFT pin, so its per-account prompt cache is READ (0.1×) instead of RE-CREATED (1.25×). Soft ⇒ the
    // soft-pin failover below still yields the moment that account is UNSERVICEABLE; a caller with no prior
    // route (or none within AUTO_AFFINITY_TTL_MS, or whose account left the pool) takes the health-aware pick
    // exactly as before. Never overrides an explicit pin (header / dynamic), and is never HARD.
    const affinityKey =
      headerPinned === null && AUTO_AFFINITY_ENABLED ? autoAffinityKey(wantOwner, bodyMetaUserId) : undefined;
    let affinityPinned: ActiveAccount | null = null;
    if (affinityKey) {
      // TTL + the WI-4402 dynamic-`auto` guard live in affinityPriorAccount (shared with the codex lanes).
      const priorAccount = affinityPriorAccount(affinityKey, dynPin, wantAccount);
      if (priorAccount) affinityPinned = pool.select?.(priorAccount) ?? null;
      autoAffinityTally[affinityPinned ? 'hits' : 'cold']++;
      // P-008/D-007: affinity is an IMPLICIT pin kept only for prompt-cache savings, so it never buys
      // metered (per-token) spend while an included-allowance account can serve (D-003). Explicit header
      // and hard pins are untouched.
      if (affinityPinned) {
        const at = Date.now();
        if (isMeteredNow(affinityPinned, at)) {
          const includedServes =
            (pool.healthyCount?.((id) => {
              const a = pool.select?.(id);
              return !!a && !isMeteredNow(a, at) && accountHealthKey(a, at, governorForAccount(model, id)) < Infinity;
            }) ?? 0) > 0;
          if (includedServes) {
            affinityPinned = null;
            autoAffinityTally.yields++;
          }
        }
      }
    } else if (headerPinned === null) {
      autoAffinityTally.nokey++;
    }
    const pinned: ActiveAccount | null = headerPinned ?? affinityPinned;
    // HARD PIN (account-hard-pin-2026-06-29): an operator / PSU-utility pin that must NEVER fail over.
    // When set (only honored once the pin resolved to a live pool account), every "cache-affinity yields
    // to liveness/load/stall" branch below is suppressed AND the upstream retry loop never rotates off the
    // account — the request waits / 429s / 503s ON its pinned credential. The operator explicitly chose
    // this account and accepts its latency/limits. Soft (bee) pins are unaffected: hardPin stays false for
    // them, so all guards below are no-ops and their behavior is byte-identical to before.
    const hardPin =
      headerPinned !== null &&
      (dynPin ? dynPin.hard : (req.headers[ACCOUNT_PIN_HEADER] as string | undefined)?.trim().toLowerCase() === 'hard');
    // Claude CLI commonly resolves `[1m]` into a bare API model and puts the
    // window in the beta header before it reaches us. The header is therefore
    // part of the effective request window even when body normalization did not
    // see the marker.
    // WI-10006049: the 1M DEFAULT for papercusp-managed callers on a 1M-capable family — decided
    // HERE, before the window is read, so account/model alternates are chosen for the window the
    // request will actually be served at (see shouldDefaultContext1m).
    if (
      shouldDefaultContext1m({
        owner: wantOwner,
        url,
        model,
        context1m,
        clientHas1m: hasContext1mBeta(req.headers['anthropic-beta'] as string | undefined),
      })
    ) {
      context1m = true;
    }
    const requestedWindow1m = context1m || hasContext1mBeta(req.headers['anthropic-beta'] as string | undefined);
    if (operationModelPolicy.status === 'bound' && pool.healthyCount) {
      const policy = operationModelPolicy.policy;
      const healthyFor = (candidate: string) => pool.healthyCount!((id) =>
        (!hardPin || id === headerPinned!.accountId) &&
        governorForAccount(candidate, id).state.pausedUntil <= Date.now());
      // The launch-selected model stays in place while any eligible account can
      // serve it. Change models only on measured pool-wide (or hard-pin-local)
      // unavailability, and only within the accepted allowed/preferred list.
      if (healthyFor(model) === 0) {
        const alternate = policy.mode === 'exact' ? null : policy.models
          .map(acceptedClaudeUpstreamModel)
          .find((candidate) => candidate &&
            (requestedWindow1m ? supportsContext1m(candidate.model, model) : !candidate.context1m) &&
            normalizeModelId(candidate.model) !== normalizeModelId(model) &&
            acceptedClaudeModelAllows(policy, candidate.model) && healthyFor(candidate.model) > 0);
        const rewritten = alternate ? rewriteRequestModel(bodyBuf, alternate.model) : null;
        if (alternate && rewritten) {
          bodyBuf = rewritten;
          model = alternate.model;
          stageSpan?.setModel(model);
          stageSpan?.setCacheShape(bodyBuf);
        } else {
          const wait = policy.onUnavailable === 'wait';
          sendJson(res, wait ? 429 : 503, {
            type: 'error',
            error: { type: wait ? 'rate_limit_error' : 'api_error',
              message: `no accepted ${policy.mode} model is currently serviceable on the eligible account pool` },
            gateway: true,
          }, wait ? { 'retry-after': '30' } : { 'x-should-retry': 'false' });
          return;
        }
      }
    }
    const poolActive = pool.active();
    // Fault #3 — pinned-but-paced failover. The spawn-side drain selector pins a bee to an account by
    // its cross-process BUDGET projection, which can't see the gateway's LIVE pacing — so it can pin a
    // bee to an account that's currently paced/exhausted by recent 429s. Strict-honoring the header
    // would 429-loop that bee into an indefinite $0 hang (alive, no model calls). So cache-affinity
    // YIELDS TO LIVENESS: if the pinned account's live governor is paused (or can't admit within a
    // short window), serve this request through the pool's active() (failover-walked to a healthy
    // account). The pin still holds for the bee's later requests — each re-checks, so it returns to
    // its per-credential cache once the account recovers.
    const canFailover = !hardPin && pinned !== null && poolActive.accountId !== pinned.accountId;
    let active = pinned ?? poolActive;
    let gov = governorForAccount(model, active.accountId);
    if (canFailover && active.accountId === pinned!.accountId && gov.state.pausedUntil > Date.now()) {
      log(
        'warn',
        `inference-gateway: pinned '${pinned!.accountId}' paused → routing via active '${poolActive.accountId}' (cache-affinity yields to liveness)`,
      );
      active = poolActive;
      gov = governorForAccount(model, active.accountId);
    }

    // PROACTIVE HEALTH-AWARE PICK FOR UNPINNED REQUESTS (no-pin-hang fix, 2026-06-23). `pool.active()` is a
    // blind round-robin, so an unpinned request COMMITS to whatever account it lands on — including a budget-
    // exhausted or flaky-EGRESS-PROXY account whose governor isn't paused THIS instant — and only rotates
    // REACTIVELY after the upstream stalls/429s, burning the internal-retry + stall-absorb ladder (the
    // observed ~90s no-pin hang that surfaces to the caller as an opaque 500, while a request PINNED to a
    // healthy account returned 200 in <25s). The reactive walk below only fires when the chosen account is
    // ALREADY governor-paused, so a not-yet-circuit-open flaky proxy slips through. Steer up front instead:
    // among governor-healthy accounts pick the one with the freshest egress proxy (no unrecovered transport-
    // failure streak, no live transport pause) and the most residual budget (lowest unified utilization). Only
    // for UNPINNED requests (a pin already expresses an explicit choice + has its liveness-yield above), and we
    // only SWITCH to a strictly-different account — a single-account / all-paused pool keeps today's behavior
    // (the reactive walk + fail-fast shed below still handle the all-paused case). `pool.active()` advances the
    // rr-cursor exactly like the reactive walk, so fairness/cursor semantics are unchanged.
    // Health score (lower = better): governor-paused / live-transport-paused ⇒ never pick (Infinity); else a
    // recent UNRECOVERED transport failure (egressFailStreak>0, cleared on the next success) is the dead/flaky-
    // proxy hint — bucket those behind every clean account (+1) so a clean one always wins, then break ties by
    // lowest unified utilization (most residual budget). u ∈ [0,1] keeps the flaky bucket disjoint; a clean,
    // idle, fresh-proxy account scores 0. SHARED by the unpinned proactive pick AND the soft-pin failover.
    const now0 = Date.now();
    const keyOf = (cgov: RateLimitGovernor, account: ActiveAccount): number => accountHealthKey(account, now0, cgov);
    let routingPickRecorded = false;
    const recordClaudeRoutingPick = (selectedAdmissionHeld = false): void => {
      if (routingPickRecorded) return;
      routingPickRecorded = true;
      const mode: GatewayRoutingSelectionMode = hardPin
        ? 'hard-pin'
        : headerPinned
          ? 'soft-pin'
          : affinityPinned
            ? 'affinity'
            : 'automatic';
      const yieldedFrom = pinned && active.accountId !== pinned.accountId ? pinned.accountId : null;
      recordRoutingPick({
        provider: 'claude',
        ownerId: wantOwner,
        source: pool,
        selected: active,
        model,
        mode,
        reason: yieldedFrom
          ? 'pin-yield'
          : mode === 'automatic'
            ? 'health-ranked'
            : mode === 'affinity'
              ? 'affinity-kept'
              : 'pin-kept',
        requestedAccount: pinned?.accountId ?? null,
        yieldedFrom,
        selectedAdmissionHeld,
      });
    };
    if (pinned === null) {
      // SEED with the round-robin pick so a healthy active() is KEPT — round-robin fairness is preserved and
      // only a STRICTLY-better account displaces it. A key-0 active (healthy, idle, fresh proxy) can't be beaten
      // → skip the walk entirely (zero added cost on the happy path). A paused/paced/flaky active (key > 0)
      // triggers a bounded scan for a healthier sibling; finding none leaves `active` unchanged so the reactive
      // paused-walk + fail-fast shed below still handle the genuinely all-throttled case exactly as before.
      let bestCand = active;
      let bestGov = gov;
      let bestKey = keyOf(gov, active);
      for (let walk = 0; bestKey > 0 && walk < POOL_WALK_MAX_ATTEMPTS; walk++) {
        const cand = pool.active();
        if (cand.accountId === bestCand.accountId) continue;
        const cgov = governorForAccount(model, cand.accountId);
        const key = keyOf(cgov, cand);
        if (key < bestKey) {
          bestKey = key;
          bestCand = cand;
          bestGov = cgov;
        }
      }
      if (bestCand.accountId !== active.accountId) {
        active = bestCand;
        gov = bestGov;
      }
    } else if (!hardPin) {
      // SOFT-PIN FAILOVER (dedicated-pin redesign 2026-07-01, gateway-rayobyte-hardening P-004): yield the
      // pin ONLY when it is UNSERVICEABLE — keyOf() === Infinity (governor/egress/rate-hint paused, window
      // exhausted or rejected, every pooled IP cooled). A merely-busy pin (in-flight load, high-but-open
      // utilization, some IPs cooled) queues + paces on its own governor and KEEPS its warm per-credential
      // cache; see the header note above `ALL_THROTTLED_RECOVERY_WAIT_CAP_MS` for why the load-aware yield
      // was removed. Per-request re-evaluation returns traffic to the pin the moment it recovers.
      const pinKey = keyOf(gov, active);
      if (pinKey === Infinity) {
        let bestCand: ActiveAccount | null = null;
        let bestGov: RateLimitGovernor | null = null;
        let bestKey = Infinity;
        for (let walk = 0; walk < POOL_WALK_MAX_ATTEMPTS; walk++) {
          const cand = pool.active();
          if (cand.accountId === pinned!.accountId) continue;
          const cgov = governorForAccount(model, cand.accountId);
          const key = keyOf(cgov, cand);
          if (key < bestKey) {
            bestKey = key;
            bestCand = cand;
            bestGov = cgov;
          }
        }
        // `bestKey` is Infinity when no serviceable sibling exists → never yields (the reactive
        // paused-walk + fail-fast shed below handle the all-paused pool exactly as before).
        if (bestCand && bestGov && bestKey < Infinity) {
          log(
            'warn',
            `inference-gateway: pinned '${pinned!.accountId}' UNSERVICEABLE (paused/exhausted/all-IPs-cooled; inflight=${gov.state.inFlight}) → soft-pin failover to least-loaded '${bestCand.accountId}' (key=${bestKey.toFixed(2)}; pin resumes on recovery)`,
          );
          active = bestCand;
          gov = bestGov;
          if (affinityPinned) autoAffinityTally.yields++;
        }
      }
    }

    // ROUTE TO CAPACITY (2026-06-18, owner-reported "accounts unused / opus hangs"): if the chosen
    // UNPINNED (or pinned-yielded-to-active) account's governor is currently PAUSED, round-robin the
    // pool to an account whose governor has headroom NOW — rather than hanging the full maxQueueWaitMs
    // (2 min) on a paused account while sibling accounts sit admittable (some Max accounts return opus
    // 200 upstream while others are 429-paused; the pool must egress through one with capacity). A
    // still-pinned request is left on its pin (it already yielded to active() above if its pin was
    // paused). `pool.active()` round-robins, so each hop advances to a different account.
    // Walk whenever the CHOSEN account's live governor is paused — PINNED or unpinned. Gated on the GOVERNOR
    // pause, NOT pool.active()/exhaustedUntil (which only tracks ACTUAL-429 exhaustion, never a PREDICTIVE
    // pause): a 97%-7d account is predictively paused but not 429'd, so pool.active() still returns it — the
    // old `active != pinned` guard (and the canFailover==(poolActive!=pin) yield) then stranded a bee PINNED
    // to such an account on its own paused pin and 429'd it ("account X paced/paused; retry after Ns") instead
    // of yielding to liveness (owner-reported 2026-06-21). Now a paused pin walks to a healthy account too.
    const chosenWasPin = pinned !== null && active.accountId === pinned.accountId;
    // Serving a SERVICEABLE soft-paused account as a last resort (predictively near its cap but Anthropic
    // still ALLOWS it) → acquire with allowSoftPaused so the governor admits it. See the graceful-degradation
    // tier below.
    let serveSoft = false;
    if (hardPin && gov.state.pausedUntil > Date.now()) {
      // HARD PIN: never route off the pinned account. If it's only SOFT-paused (predictively near-cap but
      // still ALLOWED by Anthropic + its egress proxy is up), serve it; a HARD pause falls through to
      // acquire(maxQueueWaitMs) below, which waits it out or 429s ON the pin — we never fail over.
      if (gov.softPaused(Date.now()) && (egressPauseUntil.get(active.accountId) ?? 0) <= Date.now()) serveSoft = true;
    } else if (gov.state.pausedUntil > Date.now()) {
      let soonestPaused = gov.state.pausedUntil;
      let found = false;
      // Best SERVICEABLE soft-paused fallback: predictively paused (still ALLOWED, util < 1) AND its egress
      // proxy is up — usable if NO fully-healthy account exists, so we serve residual budget instead of
      // manufacturing "all accounts throttled" from accounts that can still serve (owner-reported 2026-06-21:
      // a pin to a 0.98-7d / 0.05-5h account was shed though it was serviceable). Lowest-util wins (most residual).
      let softCand: ActiveAccount | null = null;
      let softGov: RateLimitGovernor | null = null;
      let softUtil = Infinity;
      // H1 (inference-gateway-audit-2026-06-23): COLLECT the least-loaded healthy candidate across the bounded
      // walk rather than early-returning the FIRST one. Under a mass-pause that flips N accounts paused in one
      // tick, the in-flight wave scans the same paused prefix and would all converge on the SAME first-healthy
      // account + 429 it → cascade (the observed ownerhandle→definitelyahuman chain). Routing to the account with the
      // MOST residual budget (lowest unified utilization) — together with the admission clamp that caps the burst
      // size — keeps the wave off a single account. (Mirrors the soft-pause lowest-util pick below.)
      let healthyCand: ActiveAccount | null = null;
      let healthyGov: RateLimitGovernor | null = null;
      let healthyUtil = Infinity;
      for (let walk = 0; walk < POOL_WALK_MAX_ATTEMPTS; walk++) {
        const cand = pool.active();
        const cgov = governorForAccount(model, cand.accountId);
        if (cgov.state.pausedUntil <= Date.now()) {
          const u = cgov.snapshot().unified?.utilization ?? 0; // no util data ⇒ treat as idle (eligible)
          if (u < healthyUtil) {
            healthyUtil = u;
            healthyCand = cand;
            healthyGov = cgov;
          }
          continue; // keep walking — pick the LEAST-loaded healthy account, don't stack on the first
        }
        soonestPaused = Math.min(soonestPaused, cgov.state.pausedUntil);
        if (cgov.softPaused(Date.now()) && (egressPauseUntil.get(cand.accountId) ?? 0) <= Date.now()) {
          const u = cgov.snapshot().unified?.utilization ?? 1;
          if (u < softUtil) {
            softUtil = u;
            softCand = cand;
            softGov = cgov;
          }
        }
      }
      if (healthyCand && healthyGov) {
        active = healthyCand;
        gov = healthyGov;
        found = true;
      }
      if (found && chosenWasPin) {
        log(
          'warn',
          `inference-gateway: pinned '${pinned!.accountId}' paused → routed to '${active.accountId}' (cache-affinity yields to liveness)`,
        );
      }
      // GRACEFUL DEGRADATION (2026-06-21): no fully-IDLE account, but a SERVICEABLE soft-paused one exists
      // (predictively near its cap, yet still ALLOWED by Anthropic, proxy up) → SERVE it (residual budget)
      // rather than shed. Only the genuinely-exhausted case (every account hard-rejected / transport-down)
      // falls through to the shed below. This is what lets a pin to a 98%-account run instead of 429ing.
      if (!found && softCand && softGov) {
        active = softCand;
        gov = softGov;
        found = true;
        serveSoft = true;
        log(
          'warn',
          `inference-gateway: no idle account → SERVING serviceable near-cap account '${active.accountId}' (util ${softUtil.toFixed(2)}, still allowed) instead of shedding`,
        );
      }
      // FAIL-FAST SHED when the WHOLE reachable pool is throttled (B-GW-1 / audit P1). The walk found no
      // account with headroom AND the soonest reset is beyond maxQueueWaitMs — so gov.acquire would just
      // fast-fail with a 429 anyway (its first iteration returns null when the pause exceeds maxWaitMs,
      // never forwarding). Shed NOW instead: free the admission slot immediately (no acquire/retry path
      // squatting it) and return an ACCURATE pool-wide retry-after + a distinct signal, rather than the
      // chosen-account retry-after the acquire-timeout path emits. A NEARER pause (≤ maxQueueWaitMs) falls
      // through to acquire, which waits it out → real 200, and the post-acquire retry-loop still absorbs a
      // short transient for an in-process caller — AIMD (above), not this shed, bounds that absorb's blast
      // radius by shrinking how many slots are admitted at once.
      if (!found && soonestPaused - Date.now() > maxQueueWaitMs) {
        recordClaudeRoutingPick();
        totalRequests++;
        shedAllThrottled++;
        markRequestShed(req);
        recordOwnerOutcome(wantOwner, 'shed', { detail: 'all-throttled fail-fast' }); // P-008 ledger
        // P-002: the whole pool is out of budget until `soonestPaused` — record a stall candidate so the
        // waker can wake this bee then (only if it identified itself + its CLI doesn't recover on its own).
        recordStall(wantOwner, active.accountId, soonestPaused);
        const retryAfterSec = Math.min(
          BEE_RETRY_AFTER_CAP_S,
          Math.max(1, Math.ceil((soonestPaused - Date.now()) / 1000)),
        );
        log(
          'warn',
          `inference-gateway: whole pool throttled (soonest reset ${Math.ceil((soonestPaused - Date.now()) / 1000)}s > admission wait cap) → fail-fast shed 429 (slot freed; bee retry-after ${retryAfterSec}s)`,
        );
        sendJson(
          res,
          429,
          {
            type: 'error',
            error: {
              type: 'rate_limit_error',
              message: `inference-gateway: all accounts throttled; retry after ${retryAfterSec}s`,
            },
            gateway: true,
          },
          {
            ...shapeTerminalThrottle({
              // No upstream attempt ran: this is the pre-admission terminal rung.
              attempts: 0,
              retriesExhaustedHeader: RETRIES_EXHAUSTED_HEADER,
              retryAfter: {
                resetAt: soonestPaused,
                fallbackSec: retryAfterSec,
                capS: BEE_RETRY_AFTER_CAP_S,
              },
              suppressClientRetry: true,
            }).headers,
            [ROUTED_ACCOUNT_HEADER]: active.accountId,
          },
        );
        return;
      }
    }

    // P-008 / D-003: `metered: never` turns usage-credit overage into a WALL. Selection already scores such
    // an account Infinity, but when EVERY alternative is also unserviceable (or the request is hard-pinned)
    // routing still lands on it. Refuse here instead of sending a request that would bill per token. This
    // is exact on purpose: a governor pause would re-probe the account on its reprobe cap, and each probe
    // would itself be a metered charge the owner opted out of.
    if (active.meteredPolicy === 'never' && isMeteredNow(active, Date.now())) {
      const at = Date.now();
      recordClaudeRoutingPick();
      totalRequests++;
      markRequestShed(req);
      recordOwnerOutcome(wantOwner, 'shed', { detail: 'metered-never wall' });
      const wallUntil = claudeBillingByAccount.get(active.accountId)?.until;
      const retryAfterSec = Math.min(
        BEE_RETRY_AFTER_CAP_S,
        Math.max(1, Math.ceil(((wallUntil ?? at + 60_000) - at) / 1000)),
      );
      log(
        'warn',
        `inference-gateway: '${active.accountId}' is metered now (policy never) and no included-allowance account can serve → 429 wall`,
      );
      sendJson(
        res,
        429,
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: `inference-gateway: no included-allowance account can serve and '${active.accountId}' has metered policy never; retry after ${retryAfterSec}s`,
          },
          gateway: true,
        },
        { 'retry-after': String(retryAfterSec), 'x-should-retry': 'false' },
      );
      return;
    }

    totalRequests++;
    // A still-pinned request gets only a SHORT admission wait, then fails over to active() rather than
    // waiting the full maxQueueWaitMs and 429-looping the bee.
    const stillPinned = pinned !== null && active.accountId === pinned.accountId;
    // HARD PIN waits the FULL queue on its own account (not the short PINNED_FAILOVER_WAIT_MS, which exists
    // only to fail soft pins over fast) and never fails over on an admission timeout — it 429s on the pin.
    let release = await gov.acquire(est, {
      maxWaitMs: stillPinned && !hardPin ? PINNED_FAILOVER_WAIT_MS : maxQueueWaitMs,
      allowSoftPaused: serveSoft,
    });
    if (!release && stillPinned && !hardPin) {
      log(
        'warn',
        `inference-gateway: pinned '${pinned!.accountId}' admission-timeout → failover to active '${poolActive.accountId}'`,
      );
      active = poolActive;
      gov = governorForAccount(model, active.accountId);
      release = await gov.acquire(est, { maxWaitMs: maxQueueWaitMs, allowSoftPaused: serveSoft });
    }
    if (!release) {
      recordClaudeRoutingPick();
      queued429++;
      // This 429 originates before an upstream attempt. Preserve the same
      // attribution in the request timeline as in the owner outcome ledger.
      markRequestShed(req);
      recordOwnerOutcome(wantOwner, 'shed', { account: active.accountId, detail: 'admission timeout' }); // P-008 ledger
      const retryAfterSec = Math.min(
        BEE_RETRY_AFTER_CAP_S,
        Math.max(1, Math.ceil((gov.state.pausedUntil - Date.now()) / 1000)),
      );
      log('warn', `admission timed out for ${model}; 429 retry-after ${retryAfterSec}s (account ${active.accountId})`);
      sendJson(
        res,
        429,
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: `inference-gateway: account '${active.accountId}' paced/paused; retry after ${retryAfterSec}s`,
          },
          gateway: true,
        },
        { 'retry-after': String(retryAfterSec), [ROUTED_ACCOUNT_HEADER]: active.accountId },
      );
      return;
    }

    recordClaudeRoutingPick(true);

    // Downstream-idle guard (2026-06-20 wedge #2): a hung/half-open bee that stopped reading mid-stream
    // had no deadline — the upstream stall-guard aborts UPSTREAM only, so a completed-upstream + dead
    // client pinned the admission slot forever. Tear the socket down after downstreamIdleMs of NO socket
    // progress → res emits 'close' → the streaming await below resolves → finally releases the slot.
    res.setTimeout(downstreamIdleMs, () => res.destroy());

    // Opt-in per-request routing trace (PAPERCUSP_GATEWAY_ROUTE_LOG=1): logs the pinned account
    // requested via the x-papercusp-account header and the account PICKED at this route-decision point.
    // This is deliberately not labelled "routed": the upstream retry loop below can rotate to a
    // different serving account. The response's x-papercusp-routed-account header is the ground truth
    // for the account that served the final response. Off by default (noisy).
    if (process.env.PAPERCUSP_GATEWAY_ROUTE_LOG === '1') {
      log(
        'info',
        `gw-route: client=${req.socket?.remotePort ?? '?'} want=${wantAccount ?? '-'} aff=${affinityPinned ? 'hit' : affinityKey ? 'cold' : headerPinned ? 'pin' : 'nokey'} picked=${active.accountId} model=${model}`,
      );
    }

    // Upstream stall guard (2026-06-19 deadlock fix). An activity-reset deadline that aborts the
    // upstream call if it stalls, so a hung upstream can never pin the proxy task (and leak its
    // admission slot) forever. Hoisted above the try so `finally` clears it as a backstop. The
    // AbortController itself is per-attempt (created in the loop), but the timer handle lives here.
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const clearStall = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
    };
    // Hard per-request lifetime ceiling (universal backstop): regardless of WHICH await a request is stuck
    // in, force it to terminate after requestCeilingMs so it can never pin its admission slot from an
    // unknown hang. Aborts the in-flight upstream (currentAc) AND destroys the client socket → every await
    // below (fetch / peekBody / the streaming pipe) resolves → the finally releases the slot.
    let currentAc: AbortController | undefined;
    // H12 (inference-gateway-audit-2026-06-23): a STABLE per-request abort signal. `currentAc` is re-created per
    // attempt, so during an absorb RE-ACQUIRE (which holds NO upstream fetch) it is already settled → aborting it
    // does nothing. The ceiling + the self-heal reclaim abort THIS too, and the absorb re-acquires below wait on
    // it — so a reclaimed/ceilinged request truly CANCELS its parked gov.acquire instead of waiting the full
    // absorb budget after being declared freed (which mis-reported self-heal progress + risked a double reclaim).
    const reqAbort = new AbortController();
    const ceilingTimer = setTimeout(() => {
      log(
        'error',
        `inference-gateway: request hit the ${requestCeilingMs}ms hard ceiling on '${active.accountId}' — force-terminating (slot backstop)`,
      );
      try {
        currentAc?.abort(new Error(`request ceiling: ${requestCeilingMs}ms`));
      } catch {
        /* already settled */
      }
      try {
        reqAbort.abort(new Error(`request ceiling: ${requestCeilingMs}ms`));
      } catch {
        /* already aborted */
      } // H12: cancel a parked absorb re-acquire
      try {
        res.destroy();
      } catch {
        /* already torn down */
      }
    }, requestCeilingMs);
    ceilingTimer.unref?.();
    // Register in the self-heal in-flight registry (EI-2086) BEFORE the try so the finally ALWAYS
    // deregisters it. abort() mirrors the hard-ceiling backstop (abort the current attempt + destroy the
    // socket) so a reclaimed request frees its admission slot the same proven way.
    const reqId = ++reqSeq;
    inFlightReg.set(reqId, {
      id: reqId,
      provider: 'claude',
      startedAt: Date.now(),
      isStream,
      reclaimed: false,
      abort: (reason) => {
        try {
          currentAc?.abort(new Error(reason));
        } catch {
          /* already settled */
        }
        try {
          reqAbort.abort(new Error(reason));
        } catch {
          /* already aborted */
        } // H12: cancel a parked absorb re-acquire
        try {
          res.destroy();
        } catch {
          /* already torn down */
        }
      },
    });
    try {
      // Constant request headers (everything but the per-account credential/dispatcher, set per attempt).
      // The credential SHAPE is per ATTEMPT (anthropic-credits-gateway-2026-09-30 P-006): a subscription
      // OAuth account gets `Authorization: Bearer` + the `oauth-2025-04-20` beta; a Console API-key
      // account gets `x-api-key` and must NOT carry that beta (the key 400s against it). So this base
      // carries only the CLIENT's betas; `claudeAttemptHeaders` layers the auth + OAuth flag on for the
      // account each attempt lands on (a caller's own authorization/x-api-key is stripped above by
      // STRIP_REQUEST and again per attempt). NOTE for raw-SDK callers routed through here on a
      // Max token: the FIRST `system` block must be the Claude Code identifier or the request is
      // shunted to a far stricter bucket and 429s — the `claude` CLI bees already frame themselves.
      const baseHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || STRIP_REQUEST.has(k.toLowerCase())) continue;
        baseHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      // STICKY 1M WINDOW (WI-2140943 lane 2): the caller was served at 1M moments ago, now asks for a
      // 1M-capable model WITHOUT the marker while carrying a body a 200k window cannot hold. Forwarding
      // it as-is is a certain "Prompt is too long" — the CLI's own silent 1M→200k fallback is how
      // da701a71 died at 248,703 tokens on 2026-09-02. Restore the beta; a 1M request the account
      // cannot serve right now is a 429 the CLI retries, which is strictly better than a dead session.
      // The `[1m]` BODY marker is one of two ways a caller gets the 1M window: the Claude CLI resolves
      // `model[1m]` CLIENT-SIDE into a bare model id + its own `anthropic-beta: context-1m-…` header
      // (measured 2026-09-02: a live 289k-token fable session arrives as `claude-fable-5-1` with
      // context1m=false and the beta in its header). The SERVED window is therefore the header's, so
      // both the sticky rule and the recorded route read the effective header, never the marker alone.
      const clientHas1m = hasContext1mBeta(
        baseHeaders['anthropic-beta'] ?? (req.headers['anthropic-beta'] as string | undefined),
      );
      if (!context1m && !clientHas1m && url.startsWith('/v1/messages')) {
        const prior = lastRouteByOwner.get(affinityKey ?? wantOwner ?? '');
        if (shouldRestoreContext1m(prior, model, est.inTok, Date.now())) {
          context1m = true;
          recordOwnerOutcome(wantOwner, 'context_1m_restored', {
            detail: `${model} est≈${est.inTok} (prior ${prior?.model}@1M)`,
          });
          log(
            'warn',
            `inference-gateway: restoring the 1M-context beta for '${wantOwner ?? affinityKey ?? 'unpinned'}' — ` +
              `request names '${model}' without [1m] at est≈${est.inTok} tokens, but the caller was served ` +
              `'${prior?.model}' at 1M ${Math.round((Date.now() - (prior?.at ?? 0)) / 1000)}s ago; a 200k ` +
              `forward would die on "Prompt is too long" (WI-2140943)`,
          );
        }
      }
      const clientBetas = withClientBetas(
        baseHeaders['anthropic-beta'] ?? (req.headers['anthropic-beta'] as string | undefined),
        context1m,
      );
      if (clientBetas) baseHeaders['anthropic-beta'] = clientBetas;
      else delete baseHeaders['anthropic-beta'];
      /** What the route record and the compaction watchdog mean by "served at 1M": the beta is in the
       *  header that actually leaves this machine, whichever of the two paths put it there. */
      const servedContext1m = hasContext1mBeta(baseHeaders['anthropic-beta']);
      if (!baseHeaders['anthropic-version']) baseHeaders['anthropic-version'] = ANTHROPIC_VERSION;
      baseHeaders['accept-encoding'] = 'identity';

      // INTERNAL FAILOVER LOOP. On most responses this runs ONCE. It re-runs only to route past a
      // usage/session CAP ("You've hit your session limit · resets 10:50am") — a hard wall the bee
      // classifies as `usage_limit` and will NOT retry, so the gateway must rotate to a healthy account
      // and return a GOOD response itself rather than forwarding the wall (the account-routing-fault the
      // owner flags: a $0 bee while idle accounts sit unused). A transient/bare 429 is NOT looped here —
      // the bee's CLI retries those, and the next request lands on the failover-rotated active().
      let transientWaitedMs = 0; // total time spent WAITING out short transient throttles (budget #2)
      // Did this request ROTATE to a different account (⇒ the pool has a serviceable ALTERNATIVE)? Gates the
      // stall-absorb (#2): a lone permanently-dead proxy (no alternative) must shed FAST; only a multi-account
      // stall storm — alternatives that flap/recover via the half-open probe — is worth holding the caller for.
      let everRotated = false;
      // Wedge-prevention ladder: the wall-clock instant past which this request STOPS retrying, sheds a
      // retryable 429, and frees its admission slot — strictly before the self-heal valve (75s) / watchdog
      // (120s) would forcibly reclaim it. Computed from the slot-acquire moment (this is the same request
      // lifetime the inFlightReg `startedAt` tracks), so total slot-hold is bounded under any storm.
      let retryDeadlineAt = Date.now() + internalRetryDeadlineMs;
      // EXTENDED ABSORPTION (env-gated): the wall-clock past which we stop the release-slot-and-re-acquire
      // park-retry loop and finally shed. 0 = OFF (the slot-hold deadline above is the only bound, as before).
      // P-003 (safe variant): scale the budget by the request's TIER so a high-priority caller out-waits a batch
      // one for the recovered account (the priority-throttle-park OUTCOME, no governor wait-queue). Identity off.
      const absorbDeadlineAt = absorbDeadlineForRequest(req, tierMap);

      /*
       * KERNEL ADOPTION — plan `gateway-kernel-adoption-2026-08-29`, P-006.
       *
       * What used to be one ~1,050-line hand-rolled ladder is now an OUTER loop
       * whose every pass makes exactly ONE `executeGatewayRequestKernel` call.
       *
       * THE KERNEL + ADAPTER own the inner ladder: per-attempt token resolution,
       * egress selection, the upstream call, the TTFB-then-body-idle deadlines,
       * the sibling-egress retry, the 529 backoff, and account rotation.
       *
       * THE CALLER (this loop) keeps the four things that RESET a budget, none of
       * which the kernel has any concept of: the absorb release-and-re-acquire,
       * the bounded transient WAIT, the wedge-prevention shed, and the last-resort
       * opus→sonnet downgrade. Each hands the request a fresh attempt budget and a
       * fresh `retryDeadlineAt`, which is precisely why they cannot live inside a
       * single kernel call.
       *
       * THREE SEAMS CARRY LIVE BEHAVIOUR THE OBVIOUS WIRING WOULD DROP:
       *
       *  1. D-013 — three retry branches are decided from the response BODY, and
       *     `observeAttempt` is handed `{context,response,error}` with no body. So
       *     `classifyResponse` classifies in the adapter (which holds the body) and
       *     every SIDE EFFECT still fires from `observeAttempt` (D-012 c1).
       *
       *  2. D-014 — `retryDeadlineAt` is a wall-clock bound the kernel does not
       *     model. It reaches the kernel as `policy.ttfbCapMs` (so each attempt's
       *     headers wait gets only what the budget has LEFT, not a fresh full
       *     deadline) and the adapter as `retryBudgetExhausted` (so route
       *     selection stops at the deadline). An attempt COUNT is not a substitute.
       *
       *  3. Two side effects are conditional on a decision the ADAPTER now owns —
       *     the AIMD throttle record (fires only for a 429 that was NOT routed
       *     around) and the account-level egress circuit (opens only when the
       *     sibling-IP retry was NOT taken). Neither can fire from `observeAttempt`,
       *     which runs BEFORE the route is chosen. Both are stashed and resolved
       *     against the next route's `reason` — read from the adapter's answer,
       *     never recomputed, so there stays exactly one decision-maker.
       */

      /** Adapt a WHATWG response body to the byte-iterable the adapter consumes,
       *  keeping an explicit `cancel` so a discarded attempt tears the socket down
       *  instead of leaking it — the live `peekedRest?.destroy()`. */
      const toClaudeKernelBody = (web: Response['body']): ClaudeFetchResponse['body'] => {
        if (!web) return null;
        const node = Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]);
        const iterable = node as unknown as AsyncIterable<Uint8Array> & { cancel?(): Promise<void> | void };
        iterable.cancel = () => {
          node.destroy();
        };
        return iterable;
      };

      // Downstream cancellation. The kernel relays through `downstream.write`, so a
      // vanished client must abort the request rather than leave that await hanging
      // — the same wiring P-004 proved on the codex-oauth lane.
      const abortRequest = (reason: string) => {
        if (!reqAbort.signal.aborted) reqAbort.abort(new Error(reason));
      };
      req.once('aborted', () => abortRequest('claude downstream request aborted'));
      res.once('close', () => abortRequest('claude downstream response closed'));

      // ── per-request bookkeeping the kernel deliberately does not own ─────────
      // Carried ACROSS passes: the live `attempt` counter bounds rotations for the
      // WHOLE request, not per ladder entry, so each pass gets only what is left.
      let attemptsUsed = 0;
      let curEgressKey = egressCacheKey(active.accountId, undefined);
      let lastTransportHadProxy = false;
      let shedRecorded = false;
      // D-015: the G1 suppression counter's only increment lived in the deleted
      // ladder. Guarded per pass so a repeated `canRotate` consult cannot inflate it.
      let rotateSuppressRecorded = false;
      let cacheProbe: PassThrough | null = null;
      const modelAttestation = operationModelPolicy.status === 'bound' ? operationModelPolicy.attestation : null;
      const modelAttestationRequestId = randomUUID();
      let pendingAttestedHead: { status: number; headers: Record<string, string>; sse: boolean } | null = null;
      const pendingAttestedChunks: Buffer[] = [];
      let pendingAttestedBytes = 0;
      let attestationFailed = false;
      const forwardedEffort = forwardedClaudeEffort(bodyBuf);
      const writeDownstream = async (chunk: Buffer) => {
        if (!res.write(chunk)) {
          await new Promise<void>((resolve) => {
            const settle = () => {
              res.off('drain', settle);
              res.off('close', settle);
              res.off('error', settle);
              resolve();
            };
            res.once('drain', settle);
            res.once('close', settle);
            res.once('error', settle);
          });
        }
      };
      const attestAndFlush = async (raw: Buffer, sse: boolean) => {
        let message: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | undefined;
        try {
          const text = raw.toString('utf8');
          const event = sse ? /^data: (\{"type":"message_start".*\})$/m.exec(text)?.[1] : text;
          if (event) message = (sse ? JSON.parse(event).message : JSON.parse(event)) as typeof message;
        } catch { /* malformed provider evidence is refused below */ }
        if (!message || typeof message.id !== 'string' || !message.id ||
            typeof message.model !== 'string' || !message.model || !modelAttestation ||
            !deps.recordAcceptedOperationModelAttestation) {
          throw new Error('accepted operation provider response lacks model attestation');
        }
        const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
          ? value : null;
        const usage = message.usage ?? {};
        try {
          if (operationModelPolicy.status !== 'bound' ||
              !acceptedClaudeModelAllows(operationModelPolicy.policy, message.model)) {
            throw new Error('provider returned a model outside the accepted operation policy');
          }
          if (count(usage.input_tokens) === null || (!sse && count(usage.output_tokens) === null)) {
            throw new Error('provider response lacks request token usage');
          }
          await deps.recordAcceptedOperationModelAttestation(modelAttestation, {
            requestId: modelAttestationRequestId, providerResponseId: message.id,
            backend: 'claude', provider: 'anthropic', requestedModel,
            actualModel: message.model,
            forwardedEffort, effortSource: forwardedEffort ? 'forwarded-request' : 'unavailable',
            usage: { inputTokens: count(usage.input_tokens), outputTokens: sse ? null : count(usage.output_tokens),
              cacheReadTokens: count(usage.cache_read_input_tokens),
              cacheCreationTokens: count(usage.cache_creation_input_tokens) },
          });
        } catch (error) {
          attestationFailed = true;
          throw error;
        }
        const head = pendingAttestedHead;
        if (!head) throw new Error('accepted operation attestation response head disappeared');
        pendingAttestedHead = null;
        res.writeHead(head.status, head.headers);
        for (const chunk of pendingAttestedChunks) await writeDownstream(chunk);
        pendingAttestedChunks.length = 0;
        pendingAttestedBytes = 0;
      };
      const endCacheProbe = () => {
        if (!cacheProbe) return;
        cacheProbe.end();
        cacheProbe = null;
      };
      // Reset per ATTEMPT, exactly as the live loop re-declares them each iteration.
      let suppressBareBurstRotate = false;
      let shape429Suffix = '';
      let throttled429AccountId = active.accountId;
      /**
       * WI-3150. The internal-retry line used to be emitted by the caller's `wait`
       * intercept branch, because the caller owned the rotation. The KERNEL now
       * rotates internally, so a request that fails over A→B and succeeds never
       * re-enters that branch and the line was silently lost — the failover still
       * works, but it stopped being observable.
       *
       * It cannot simply be logged at the 429 site either: at that moment we do not
       * yet know a retry will follow, and the old line only ever described a retry
       * that actually happened. So the line is BUILT here, while the throttled
       * account and ITS `shape429Suffix` are still current (`prepareAttempt` clears
       * the suffix at the top of every attempt), and FLUSHED from `observeAttempt`
       * on attempt N>1 — which by construction only runs when the kernel really did
       * retry.
       */
      let pendingRetryLog: string | null = null;
      // The live `internalRetry.exhaustResetAt` — when the account this attempt hit
      // is expected to be serviceable again. Drives the transient-vs-hard-wall split.
      let lastExhaustResetAt = 0;

      // ── the deferred pair (seam 3) ───────────────────────────────────────────
      let pendingThrottle = false;
      let pendingTransport: { account: ActiveAccount; egressKey: string; stalled: boolean } | null = null;

      /** The live account-level egress circuit (gateway.ts pre-migration :4222-4257). */
      const openEgressCircuit = (failed: { account: ActiveAccount; stalled: boolean }) => {
        const id = failed.account.accountId;
        const streak = (egressFailStreak.get(id) ?? 0) + 1;
        egressFailStreak.set(id, streak);
        const circuitOpen = streak >= EGRESS_FAIL_CIRCUIT_THRESHOLD;
        let openMs = EGRESS_CIRCUIT_OPEN_MS;
        if (circuitOpen) {
          const nowMs = Date.now();
          const stableFor = nowMs - (egressLastOpenAt.get(id) ?? 0);
          // C2: only a DEAD proxy (connect error) escalates the flap backoff. A TTFB
          // stall hits every account during a hold-storm; doubling would exile a
          // budget-healthy account that recovers in seconds.
          const reopen = !failed.stalled && stableFor < EGRESS_FLAP_RESET_MS ? (egressReopenCount.get(id) ?? 0) + 1 : 0;
          egressReopenCount.set(id, reopen);
          egressLastOpenAt.set(id, nowMs);
          openMs = Math.min(EGRESS_CIRCUIT_OPEN_MS * 2 ** reopen, EGRESS_CIRCUIT_OPEN_MAX_MS);
        }
        const pauseMs = circuitOpen ? openMs : TRANSIENT_429_BACKOFF_MS;
        const resetAt = Date.now() + pauseMs;
        // transport:true — this pauses the account ONLY to route around its bad egress
        // PROXY. It is not a rate/budget signal, so the exhaustion observer and the
        // fleet AIMD must not count it against a quota-healthy account.
        governorForAccount(model, id).penalize({ retryAfterMs: pauseMs, resetAt, transport: true });
        if (circuitOpen) {
          egressCircuitOpens++;
          egressPauseUntil.set(id, resetAt);
          const reopen = egressReopenCount.get(id) ?? 0;
          log(
            'warn',
            `inference-gateway: EGRESS CIRCUIT OPEN for '${id}' (${streak} consecutive transport failures${reopen > 0 ? `, flap×${reopen}` : ''}) — out of rotation ≤${Math.round(pauseMs / 1000)}s; half-open probe readmits after ${EGRESS_PROBE_READMIT_STREAK} stable probes`,
          );
          scheduleEgressProbe(failed.account, governorForAccount(model, id), resetAt);
        }
      };

      /**
       * Settle the effects that were waiting on the adapter's routing decision.
       * `nextReason` is the reason of the route the adapter chose next, or null when
       * this pass produced no further attempt.
       */
      const resolvePending = (nextReason: ClaudeRouteReason | null) => {
        if (pendingThrottle) {
          pendingThrottle = false;
          // Fix B: a 429 we successfully routed around is a ROUTING event, not
          // pool-wide over-drive, and must stay invisible to global AIMD. A next
          // attempt of ANY reason is exactly the live `routedAround` — both the
          // cross-account rotate and the sibling-IP retry set it.
          if (nextReason === null) providerAdmission.recordThrottle('claude');
        }
        const transport = pendingTransport;
        if (transport) {
          pendingTransport = null;
          // The live circuit sits in the ELSE of the sibling-egress retry: taking a
          // sibling IP skips it entirely, while a rotate still opens it.
          if (nextReason !== 'sibling-egress') openEgressCircuit(transport);
        }
      };

      /** D-014: the wedge-prevention deadline, asked as a question by both selection
       *  hooks. The shed ledger fires HERE — the one moment a retry that would
       *  otherwise have happened is actually blocked — and at most once per pass. */
      const retryBudgetExhausted = () => {
        if (Date.now() < retryDeadlineAt) return false;
        if (!shedRecorded) {
          shedRecorded = true;
          shedAllThrottled++;
          recordOwnerOutcome(wantOwner, 'shed', { account: active.accountId, detail: 'internal-retry deadline' });
          log(
            'warn',
            `inference-gateway: internal-retry deadline ${internalRetryDeadlineMs}ms hit on '${active.accountId}' (model ${model}) → shed 429, free slot (wedge-prevention ladder)`,
          );
        }
        return true;
      };

      /** D-013: the Anthropic predicates stay HERE, where they already live; the
       *  adapter contributes only the peek, the replay and the branch. */
      const classifyClaudeResponse = (input: ClaudeClassifyInput): ClaudeResponseClassification => {
        // Credit exhaustion is checked FIRST: a 429 enforced-spend-limit or a 400
        // API-usage-limit would otherwise read as a rate 429 / a forwardable 400.
        const creditWall = classifyClaudeCreditWallResponse(input);
        if (creditWall) return creditWall;
        if (input.status === 529) return { kind: 'overload' };
        if (input.status === 429) {
          // A 429 may be a hard usage/session CAP, which ONLY the body names —
          // util can read 0 on a capped account because the cap is a different
          // meter — so the body is checked before the header-derived shapes.
          if (classifyHttpError({ status: undefined, message: input.body }, 'anthropic').class === 'usage_limit') {
            return {
              kind: 'usage-cap',
              resetAt: parseUsageReset(input.body)?.atMs ?? Date.now() + USAGE_LIMIT_DEFAULT_PAUSE_MS,
            };
          }
          const reset = parseRateReset(input.headers);
          const unifiedRejected = gov.snapshot().unified?.rejected === true;
          // `x-should-retry: true` is Anthropic's authoritative per-request signal
          // that capacity exists; it OVERRIDES a stale `unified.rejected` latch.
          const shouldRetry = String(input.headers['x-should-retry'] ?? '').toLowerCase() === 'true';
          const bare =
            reset.retryAfterMs === undefined && reset.resetAt === undefined && (!unifiedRejected || shouldRetry);
          return bare ? { kind: 'bare-429' } : { kind: 'rate-429' };
        }
        if (input.status === 403 && ORG_DISALLOWED_RE.test(input.body)) {
          return { kind: 'org-disallowed', resetAt: Date.now() + ORG_DISALLOW_PAUSE_MS };
        }
        return { kind: 'forward' };
      };

      // ── the caller's interception seam ───────────────────────────────────────
      // The kernel relays whatever response it settles on, so a retryable failure
      // the ladder gave up on would reach the client before the caller could absorb
      // it. `downstream.start` therefore DECIDES first and throws to intercept —
      // which `pumpResponse` handles by discarding the body, exactly as the live
      // handler's `peekedRest?.destroy()` did. The decision is read from a flag
      // rather than the error's identity so no error-normalisation can lose it.
      const INTERCEPT = new Error('claude gateway: caller intercepted before relay');
      type Intercept = {
        action: 'wait' | 'absorb' | 'downgrade' | 'effort-clamp';
        status: number;
        outHeaders: Record<string, string>;
        peeked: string;
        waitMs: number;
        backoffMs: number;
        /**
         * Whether the throttle behind this intercept is one we could wait out. Carried
         * on the intercept because the last-resort downgrade guard is evaluated in the
         * CATCH — reachable both from the `downgrade` action and from an absorb that
         * gave up — while `transient` is computed inside `downstream.start`.
         */
        transient: boolean;
      };
      // Held behind a ref rather than a bare `let`, and touched ONLY through the two
      // helpers below. The ref alone is not enough: the sole writer is the
      // `downstream.start` closure the kernel invokes, which control-flow analysis
      // cannot see, so a `interception.taken = null` reset written INLINE narrows the
      // property to `null` for the rest of the pass — the catch below then reads
      // `null`, `if (taken)` narrows to `never`, and every field access is TS2339.
      // An explicit annotation at the read site does NOT repair that: a declaration's
      // type only constrains assignability, while the binding still takes the
      // initializer's NARROWED type. Routing both the clear and the read through
      // function calls is what actually fixes it — CFA does not track assignments
      // across a call boundary, so no narrowing is ever established.
      const interception: { taken: Intercept | null } = { taken: null };
      const clearIntercept = (): void => {
        interception.taken = null;
      };
      /** Read the pass's interception and clear it in one step. */
      const takeIntercept = (): Intercept | null => {
        const taken = interception.taken;
        interception.taken = null;
        return taken;
      };
      let sseForward = false;

      /** The forwarded head, byte-for-byte with the live path. */
      const buildOutHeaders = (metadata: ClaudeResponseMetadata): Record<string, string> => {
        const outHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(metadata.headers)) {
          if (!STRIP_RESPONSE.has(k.toLowerCase())) outHeaders[k] = v;
        }
        // Detectability: name the account this request ACTUALLY egressed on, so a
        // silent fallback off a pin is visible to the caller rather than invisible.
        outHeaders[ROUTED_ACCOUNT_HEADER] = metadata.accountId;
        if (pinned && !hardPin && metadata.accountId !== pinned.accountId) {
          outHeaders[PIN_YIELDED_HEADER] = `${pinned.accountId}->${metadata.accountId}`;
        }
        if (opusDowngraded) outHeaders[MODEL_DOWNGRADED_HEADER] = 'opus->sonnet';
        if (effortClampedFrom && effortClampedTo) {
          outHeaders[EFFORT_CLAMPED_HEADER] = `${effortClampedFrom}->${effortClampedTo}`;
        }
        return outHeaders;
      };

      /** P-005 structured mid-stream failure: an SSE stream gets a final Anthropic
       *  `error` event (which the SDK parses as overloaded_error and retries) rather
       *  than a bare socket reset the bee reads as an opaque "API Error". */
      const endStreamWithError = (reason: string): void => {
        if (res.writableEnded || res.destroyed) return;
        // EI-7168: this request was admitted, got a 2xx, already recorded its
        // optimistic success, and then died mid-relay — the expensive failure.
        // Correct that record with an immediate hard clamp, once.
        providerAdmission.recordHardFailure('claude');
        if (!sseForward) {
          try {
            res.destroy();
          } catch {
            /* already torn down */
          }
          return;
        }
        try {
          res.write(
            `\nevent: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: `inference-gateway: upstream stream ${reason} on '${active.accountId}' — retry` }, gateway: true })}\n\n`,
          );
          res.end();
        } catch {
          try {
            res.destroy();
          } catch {
            /* already torn down */
          }
        }
      };

      // WI-10005833: an accepted operation policy that pins an exact effort is enforced before any I/O
      // (the 503 above). Substituting a different level would violate it, so the clamp stays off there
      // and the upstream 400 is forwarded unchanged.
      const effortPinnedByPolicy =
        operationModelPolicy.status === 'bound' && Boolean(operationModelPolicy.policy.effort);
      /** Rewrite this request's `output_config.effort` from `from` to `to`; false when the body carries none. */
      const clampRequestEffort = (from: string, to: string): boolean => {
        const rewritten = rewriteRequestEffort(bodyBuf, to);
        if (!rewritten) return false;
        bodyBuf = rewritten;
        effortClampedFrom ??= from;
        effortClampedTo = to;
        return true;
      };
      /**
       * The substitution an upstream 400 body calls for, or null. Non-null only when the body names an
       * unsupported effort, that level is the one this request carries in `output_config.effort`, a
       * supported level exists to move to, and the body can be rewritten — so an intercept taken on it
       * always retries instead of falling through to a forward that skips the outcome records.
       */
      const effortClampFor = (peeked: string): { from: string; to: string; supported: string[] } | null => {
        if (effortPinnedByPolicy || effortClampRetried) return null;
        const unsupported = parseUnsupportedEffortError(peeked);
        if (!unsupported) return null;
        const from = readRequestEffort(bodyBuf);
        if (!from || from !== unsupported.requested) return null;
        const to = chooseSupportedEffort(from, unsupported.supported);
        if (!to || !rewriteRequestEffort(bodyBuf, to)) return null;
        return { from, to, supported: unsupported.supported };
      };

      for (;;) {
        clearIntercept();
        // A caller-level wait/absorb logs its own retry line, so a line left pending
        // by the previous pass must not be flushed against this one.
        pendingRetryLog = null;
        shedRecorded = false;
        rotateSuppressRecorded = false;
        let attemptsThisPass = 0;

        // WI-10005833: rewrite a level this model is already known to refuse BEFORE sending, so only
        // the first request per (model, level) pays the 400 round trip. Checked on every pass because
        // a pass may follow a model substitution (the WI-1073 downgrade), whose id has its own entry.
        if (!effortPinnedByPolicy) {
          const requestedEffort = readRequestEffort(bodyBuf);
          const learned = requestedEffort ? effortClampCache.apply(model, requestedEffort) : null;
          if (requestedEffort && learned && clampRequestEffort(requestedEffort, learned)) {
            effortClampRewrites++;
          }
        }

        const kernelAdapter = createClaudeKernelAdapter({
          // D-010: `proxy` spent this request's one `pool.active()` across the ~500
          // lines of selection above, and `active()` ADVANCES the round-robin. The
          // adapter replays the resolved account so a double-advance is structurally
          // impossible rather than merely avoided.
          initialAccount: active,
          pool: hardPin ? undefined : pool,
          upstreamUrl: `${upstreamBase}${url}`,
          method: req.method ?? 'POST',
          baseHeaders,
          body: bodyBuf.length ? new Uint8Array(bodyBuf) : null,
          streaming: isStream,
          tokenTimeoutMs,
          failoverBackoffMs: bare429FailoverBackoffMs,
          overloadBackoffMs: OVERLOAD_529_BACKOFF_MS,
          transientBackoffMs: TRANSIENT_429_BACKOFF_MS,
          pickEgress: (account, at) => {
            const picked = pickEgress(account, at);
            return { entry: picked.entry, key: picked.key };
          },
          siblingEgressAvailable: (account, at, currentKey) => siblingEgressAvailable(account, at, currentKey),
          dispatcherFor: (account, entry) => dispatcherFor(account, entry as AccountEgress | undefined),
          rateReset: (headers) => {
            const parsed = parseRateReset(headers);
            return { resetAt: parsed.resetAt ?? null, retryAfterMs: parsed.retryAfterMs ?? null };
          },
          // G1 (WI-649): a FLEET-WIDE bare burst means rotating A→B→C finds no
          // capacity and merely sustains the storm. Safe to read here because
          // `observeAttempt` fires BEFORE `chooseNextRoute`, so the flag this
          // attempt set is the one this attempt's rotation decision sees.
          canRotate: () => {
            if (!suppressBareBurstRotate) return true;
            // D-015: the live ladder incremented this at exactly this moment — the one
            // point a rotate that would otherwise have happened is BLOCKED. It cannot
            // fire from `observeAttempt` (which runs BEFORE the route is chosen), so it
            // belongs here, the same seam `retryBudgetExhausted` uses for its shed.
            if (!rotateSuppressRecorded) {
              rotateSuppressRecorded = true;
              bareBurstRotateSuppressed++;
            }
            return false;
          },
          retryBudgetExhausted,
          classifyResponse: classifyClaudeResponse,
          // The live peek set exactly: only these three statuses have a
          // body-derived branch, so nothing else pays for a peek.
          // 400 and 402 are peeked so a credit wall (400 API-usage-limit, 402
          // billing_error) is recognized from its body instead of forwarded.
          shouldPeek: (status) => status === 429 || status === 529 || status === 403 || status === 400 || status === 402,
          peekBytes: USAGE_LIMIT_PEEK_BYTES,
          // The peek reader is not wired to the attempt abort, so an
          // acknowledged-but-undelivered error body must not hold the slot.
          peekTimeoutMs: upstreamBodyIdleTimeoutMs,
          fetch: async (target, init) => {
            const fetchInit: FetchInit = { method: init.method, headers: init.headers, signal: init.signal };
            if (init.body) fetchInit.body = init.body as unknown as BodyInit;
            if (init.dispatcher) fetchInit.dispatcher = init.dispatcher as UndiciDispatcher;
            const check = await authorizeCarryTrialAttempt(req, 'anthropic-http', init.diagnosticAccountId, target, init);
            if (carryTrial) fetchInit.redirect = 'error';
            // Authorization sees the adapter's final body and selected provider
            // account. Re-check its copied receipt synchronously at every send.
            check();
            const upstream = await doFetch(target, fetchInit as RequestInit);
            return {
              status: upstream.status,
              headers: upstream.headers,
              body: toClaudeKernelBody(upstream.body),
            };
          },
        });

        const adapter = {
          ...kernelAdapter,
          // Sync the caller's view of the route BEFORE the attempt runs, so
          // `classifyResponse` and `observeAttempt` both read the account that is
          // actually being hit rather than the previous one.
          prepareAttempt: async (context: GatewayKernelAttemptContext<ClaudeRouteValue>) => {
            const routeAccount = context.route.value.account;
            curEgressKey = context.route.value.egress.key;
            suppressBareBurstRotate = false;
            shape429Suffix = '';
            if (routeAccount.accountId !== active.accountId) {
              // Count failovers by ACCOUNT change, never by route key: every
              // same-account re-attempt changes the egress key, so counting keys
              // would inflate this lane's failover count on every sibling retry.
              failovers++;
              stageSpan?.recordFailover();
              everRotated = true;
              active = routeAccount;
              gov = governorForAccount(model, active.accountId);
            }
            const prepared = await kernelAdapter.prepareAttempt(context);
            // Counted only once the token resolved — a token stall never reached
            // the proxy and must not count as an egress attempt.
            egressAttemptsByAccount.set(active.accountId, (egressAttemptsByAccount.get(active.accountId) ?? 0) + 1);
            return prepared;
          },
        };

        try {
          await executeGatewayRequestKernel<
            ClaudeRouteValue,
            ClaudePreparedAttempt,
            ClaudeChunk,
            ClaudeResponseMetadata
          >({
            request: {
              lane: providerAdapters.claude.lane,
              // Already read, normalized and cache-rewritten above — and rewritten
              // again by the opus→sonnet downgrade, which is why it is re-read from
              // `bodyBuf` on every pass rather than captured once.
              body: (async function* () {
                yield bodyBuf;
              })(),
              ownerId: wantOwner ?? null,
              pin: pinned ? { accountId: pinned.accountId, mode: hardPin ? 'hard' : 'soft' } : null,
              signal: reqAbort.signal,
            },
            policy: {
              maxBodyBytes: Number(process.env.PAPERCUSP_GATEWAY_MAX_BODY_BYTES) || 64 * 1024 * 1024,
              bodyReadTimeoutMs: requestCeilingMs,
              requestCeilingMs,
              // Decided ABOVE the kernel cut (it also picked the request's shape),
              // so a scalar rather than D-007's resolver — parsing the body a second
              // time here is precisely the drift D-007 exists to prevent.
              ttfbTimeoutMs: isStream ? upstreamStreamHeadersTimeoutMs : upstreamHeadersTimeoutMs,
              // D-014. Without this each attempt would arm the FULL headers deadline
              // — for a non-streaming request 300s, six times over — instead of the
              // ~60s the wedge-prevention ladder allows the whole request.
              ttfbCapMs: () => retryDeadlineAt - Date.now(),
              bodyIdleTimeoutMs: upstreamBodyIdleTimeoutMs,
              downstreamIdleTimeoutMs: downstreamIdleMs,
              // The live `attempt` bounds rotations for the WHOLE request, so a pass
              // gets only the remainder — and a budget RESET restores the full count.
              maxAttempts: Math.max(1, INTERNAL_RETRY_MAX_ATTEMPTS - attemptsUsed),
            },
            telemetry: requestStageTelemetry,
            // D-008: adopt the span this HTTP request already opened, or the kernel
            // would begin a SECOND one and double-count the request.
            span: stageSpan,
            // The outer recovery loop may intercept this pass before relay and re-enter
            // the kernel. Keep the adopted HTTP span open across that failed pass; the
            // terminal pass (or the response lifecycle when no span was adopted) owns
            // the one final timeline.
            deferSpanFinalization: stageSpan !== undefined,
            admission: {
              // P-011 / D-023: the lane's admission arrives from the entry executor's caller.
              // While `anthropic-messages` is still bridge-admitted this is the pass-through
              // (this request already holds its slot from the `gov.acquire` above, so
              // re-admitting would deadlock on itself); step (iii-b) swaps in the real
              // controller HERE and drops the bridge's, so exactly one of the two admits.
              run: (context, task) => kernelAdmission.run(context, task),
              observeAttempt: ({ context, response, error }) => {
                // Settle the previous attempt's deferred effects now that the
                // adapter's routing answer is visible on THIS attempt's route.
                if (context.attempt > 1) resolvePending(context.route.value.reason);
                // WI-3150: reaching attempt N>1 IS the proof that the kernel retried,
                // so this is where the previous attempt's retry line becomes true.
                // It names the THROTTLED account and carries ITS util headers — the
                // whole point of WI-3150 — rather than the rotated-to account we are
                // about to hit.
                if (context.attempt > 1 && pendingRetryLog) {
                  log('warn', pendingRetryLog);
                  pendingRetryLog = null;
                }
                attemptsThisPass = context.attempt;
                const account = context.route.value.account;
                const egressKey = context.route.value.egress.key;

                if (error) {
                  // A controller refusal occurred before provider I/O. It is a
                  // gateway policy outcome, not an account or egress failure.
                  if (error.code === 'invalid-route') {
                    lastTransportHadProxy = false;
                    return;
                  }
                  const requestRef = `${gatewayProcessInstanceId}:${stageSpan?.requestId ?? 'unobserved'}`;
                  // A client disconnect is not evidence that the upstream or its
                  // egress proxy failed. Keep the kernel's typed cancellation
                  // separate before touching either failure counter or cooldown.
                  if (error.code === 'cancelled') {
                    log('info', `downstream cancelled request=${requestRef} code=cancelled on '${account.accountId}': ${error.message}`);
                    lastTransportHadProxy = false;
                    return;
                  }
                  upstreamErrors++;
                  // The adapter's STATUS discriminates a token failure (503) from a
                  // transport failure (502); a TTFB timeout surfaces as its own code
                  // and classifies with transport, as the live catch did.
                  if (error.status === 503 && error.code === 'upstream-error') {
                    // TRANSPORT-vs-real-penalty split: a DEADLINE timeout means the
                    // refresh round-trip did not complete — a transport symptom, not
                    // evidence the credential or quota is bad. Only a genuine
                    // rejection keeps the real penalty.
                    const isTimeout = /timed out after \d+ms$/.test(error.message ?? '');
                    log(
                      'error',
                      `inference-gateway: token refresh ${isTimeout ? 'TIMED OUT (transport)' : 'failed'} on '${account.accountId}': ${error.message} — penalizing account + 503`,
                    );
                    governorForAccount(model, account.accountId).penalize({
                      retryAfterMs: bare429FailoverBackoffMs,
                      resetAt: Date.now() + bare429FailoverBackoffMs,
                      ...(isTimeout ? { transport: true } : {}),
                    });
                    lastTransportHadProxy = false;
                    return;
                  }
                  const stalled = error.code === 'ttfb-timeout';
                  log(
                    'error',
                    `upstream fetch ${stalled ? 'STALLED (aborted)' : 'failed'} request=${requestRef} code=${error.code} on '${account.accountId}': ${error.message}`,
                  );
                  // SCOPING: only an account WITH an http proxy can have a DEAD
                  // proxy. A no-proxy account that transport-fails is an
                  // Anthropic/network-side stall, which keeps the fast 502 and must
                  // NOT penalize a healthy account.
                  // The entry the adapter actually dialed, carried on the route —
                  // not re-derived from the key, which is a cache key rather than
                  // an identifier an egress entry exposes.
                  const usedEg = (context.route.value.egress.entry as AccountEgress | undefined) ?? account.egress;
                  const hasEgressProxy = !!usedEg?.proxyUrl && /^https?:\/\//i.test(usedEg.proxyUrl);
                  lastTransportHadProxy = hasEgressProxy;
                  if (!hasEgressProxy) return;
                  egressFailsByAccount.set(account.accountId, (egressFailsByAccount.get(account.accountId) ?? 0) + 1);
                  // ESCALATING per-IP cooldown: a FIXED one re-admitted a
                  // permanently-dead egress on a constant cycle forever, so a
                  // hard-down host got no worse treatment than a one-off blip.
                  const ipStreak = (ipTransportFailStreak.get(egressKey) ?? 0) + 1;
                  ipTransportFailStreak.set(egressKey, ipStreak);
                  coolIp(
                    egressKey,
                    Math.min(IP_TRANSPORT_COOLDOWN_MS * 2 ** (ipStreak - 1), IP_TRANSPORT_COOLDOWN_MAX_MS),
                  );
                  checkEgressProxyHealthAlarm(account);
                  // The ACCOUNT-level circuit is deferred: it opens only if the
                  // adapter does not take a sibling IP (seam 3).
                  pendingTransport = { account, egressKey, stalled };
                  return;
                }
                if (!response) return;

                const hobj = response.metadata.headers;
                const status = response.status;
                const accountGov = governorForAccount(model, account.accountId);
                accountGov.recordResponse(hobj);
                recordClaudeBilling(account, hobj as Record<string, string | undefined>);
                // A served response proves the account is past its credit wall (e.g. an operator readmit
                // after a top-up), so stats stop reporting a wall that no longer holds.
                if (status >= 200 && status < 300) claudeCreditWallByAccount.delete(account.accountId);
                deps.onResponse?.(hobj, status, model, account.accountId);

                // Transport succeeded for THIS account — its egress proxy works, so
                // clear the transport-failure streaks. A 429 still means the proxy
                // WORKED (just throttled), which is the 429 path's job, not the
                // egress circuit's.
                egressFailStreak.delete(account.accountId);
                lastEgressOkAt.set(account.accountId, Date.now());
                proactiveProbeFailStreak.delete(account.accountId);
                // A proven-live IP must rejoin rotation NOW, not sit out the
                // remainder of an escalated cooldown it just disproved.
                ipTransportFailStreak.delete(egressKey);
                ipCooldownUntil.delete(egressKey);
                checkEgressProxyHealthAlarm(account);

                const classification = response.metadata.classification;
                const peeked = response.metadata.peekedBody ?? '';
                lastExhaustResetAt = 0;

                if (classification?.kind === 'credit-wall') {
                  // Credit exhaustion (402 billing_error, 400 "specified API usage
                  // limits", 429 enforced_spend_limit_reached) is a billing WALL on
                  // THIS account, not a transient (plan anthropic-credits-gateway
                  // D-004): pause it until its reset so the selector skips it, then
                  // rotate. The cause is logged; the body and credential are not.
                  const wallResetAt = classification.resetAt ?? Date.now() + CREDIT_WALL_DEFAULT_PAUSE_MS;
                  accountGov.penalize({ resetAt: wallResetAt });
                  lastExhaustResetAt = wallResetAt;
                  const cause = (classification.detail as ClaudeCreditWall | undefined)?.cause ?? 'unknown';
                  // D-008 E4: keep the cause where stats can read it, so a walled account shows WHY it is
                  // out of rotation instead of only a bare pause deadline.
                  claudeCreditWallByAccount.set(account.accountId, { cause, until: wallResetAt });
                  log(
                    'warn',
                    `inference-gateway: account '${account.accountId}' hit a credit wall (${cause}, HTTP ${status}) → paused until ${new Date(wallResetAt).toISOString()}, failing over`,
                  );
                } else if (status === 429 || status === 529) {
                  upstream429++;
                  if (status === 429) recordRoutingUpstream429('claude', account.accountId);
                  throttled429AccountId = account.accountId;
                  const reset = parseRateReset(hobj);
                  const unifiedRejected = accountGov.snapshot().unified?.rejected === true;
                  const shouldRetry = String(hobj['x-should-retry'] ?? '').toLowerCase() === 'true';
                  const kind = classification?.kind ?? null;
                  if (status === 429) {
                    // Hard-evidence 429 shape: bare-burst means CAPACITY EXISTS
                    // (transient), usage-cap is a real per-account wall. Surfacing
                    // util5h/util7d at the 429 site lets the capacity-vs-routing read
                    // come from data rather than a guess.
                    const shape429 = classify429Shape({
                      status,
                      isUsageCap: kind === 'usage-cap',
                      bare: kind === 'bare-429',
                      hasWindowReset: reset.retryAfterMs !== undefined || reset.resetAt !== undefined,
                      unifiedRejected,
                    });
                    const u5 =
                      hobj['anthropic-ratelimit-unified-5h-utilization'] ??
                      hobj['anthropic-ratelimit-unified-utilization'] ??
                      '-';
                    const u7 = hobj['anthropic-ratelimit-unified-7d-utilization'] ?? '-';
                    shape429Suffix = ` [429-shape=${shape429} x-should-retry=${shouldRetry} retry-after=${reset.retryAfterMs ?? '-'}ms util5h=${u5} util7d=${u7}]`;
                    if (shape429 === 'bare-burst') {
                      // WI-650/G2: a bare-burst is a SHARED edge/infra throttle, not
                      // a per-account wall, so name WHO threw it — a Cloudflare edge
                      // carries `server`/`cf-ray`, an Anthropic app-layer 429 carries
                      // `request-id`/`anthropic-organization-id`.
                      const origin = (
                        [
                          ['server', hobj['server']],
                          ['cf-ray', hobj['cf-ray']],
                          ['via', hobj['via']],
                          ['req-id', hobj['request-id'] ?? hobj['x-request-id']],
                          ['org', hobj['anthropic-organization-id']],
                          ['unified-status', hobj['anthropic-ratelimit-unified-status']],
                        ] as const
                      )
                        .filter(([, v]) => v !== undefined)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(' ');
                      shape429Suffix += ` [bare-burst-origin ${origin || 'no-provenance-headers'}]`;
                    }
                    // WI-3151 cold-rest causation probe — pure observability, never
                    // a routing input.
                    const msSinceReadmit = pool.msSinceReadmit?.(throttled429AccountId);
                    const util5hNum = Number(u5);
                    const coldRestCause = classifyColdRest429({
                      shape: shape429,
                      msSinceReadmit,
                      windowMs: COLD_REST_CAUSATION_WINDOW_MS,
                      utilization5h: Number.isFinite(util5hNum) ? util5hNum : undefined,
                      highUtil: COLD_REST_HIGH_UTIL,
                    });
                    if (coldRestCause !== 'not-cold-rest') {
                      shape429Suffix += ` [cold-rest-cause=${coldRestCause} since-readmit=${msSinceReadmit ?? '-'}ms]`;
                    }
                    // Deferred: an AIMD throttle is recorded only for a 429 that
                    // could NOT be routed around (seam 3).
                    pendingThrottle = true;
                  }

                  if (status === 529) {
                    // SERVER overload — not account budget. No penalty, no rotation.
                    lastExhaustResetAt = 0;
                  } else if (kind === 'usage-cap') {
                    // A hard cap on THIS account: pause it to its reset so the pin
                    // yields and the selector skips it, then rotate.
                    const capResetAt = classification?.resetAt ?? Date.now() + USAGE_LIMIT_DEFAULT_PAUSE_MS;
                    accountGov.penalize({ resetAt: capResetAt });
                    lastExhaustResetAt = capResetAt;
                  } else if (!unifiedRejected && (reset.retryAfterMs !== undefined || reset.resetAt !== undefined)) {
                    // A per-minute/burst RATE 429 → AIMD-decrease this account's
                    // learned rpm so future requests are paced under its real rate.
                    accountGov.penalize({ ...reset, rateLimited: true });
                    lastExhaustResetAt =
                      reset.resetAt ??
                      Date.now() + Math.min(reset.retryAfterMs ?? bare429FailoverBackoffMs, 5 * 60 * 1000);
                  } else if (kind === 'bare-429') {
                    // A bare-burst is a Cloudflare per-IP EDGE throttle on whatever
                    // IP this attempt used, NOT the account budget — so if the SAME
                    // account has another usable IP, cool this one and let the
                    // adapter retry the same credential on the sibling, with NO
                    // whole-account pause. Only a lone-IP account falls through to
                    // the per-account circuit.
                    if (siblingEgressAvailable(account, Date.now(), egressKey)) {
                      const ipStreak = (ipBare429Streak.get(egressKey) ?? 0) + 1;
                      ipBare429Streak.set(egressKey, ipStreak);
                      const ipCoolMs = Math.min(bare429FailoverBackoffMs * 2 ** (ipStreak - 1), IP_COOLDOWN_MAX_MS);
                      coolIp(egressKey, ipCoolMs);
                      lastExhaustResetAt = Date.now() + bare429FailoverBackoffMs;
                      log(
                        'warn',
                        `inference-gateway: bare-burst 429 on egress IP ${egDesc((context.route.value.egress.entry as AccountEgress | undefined) ?? account.egress)} for '${account.accountId}' (cloudflare per-IP throttle) — cooling that IP ${Math.round(ipCoolMs / 1000)}s + rotating to a sibling IP on the SAME account (egress-ip-pool)`,
                      );
                    } else {
                      // BARE-429 PERSISTENCE CIRCUIT: a brief burst is paced, but a
                      // SUSTAINED streak is an edge throttle that is not clearing →
                      // escalate so the pool routes AROUND this IP rather than
                      // re-hammering it forever.
                      const streak = (bare429Streak.get(account.accountId) ?? 0) + 1;
                      bare429Streak.set(account.accountId, streak);
                      const circuitOn = BARE429_CIRCUIT_THRESHOLD > 0 && streak >= BARE429_CIRCUIT_THRESHOLD;
                      const pauseMs = circuitOn
                        ? Math.min(
                            bare429FailoverBackoffMs * 2 ** (streak - BARE429_CIRCUIT_THRESHOLD + 1),
                            BARE429_CIRCUIT_MAX_MS,
                          )
                        : bare429FailoverBackoffMs;
                      accountGov.penalize({ retryAfterMs: pauseMs, resetAt: Date.now() + pauseMs, rateLimited: true });
                      lastExhaustResetAt = Date.now() + pauseMs;
                      if (circuitOn) {
                        log(
                          'warn',
                          `inference-gateway: BARE-429 CIRCUIT for '${account.accountId}' (${streak} consecutive bare-429s — persistent per-IP edge throttle, not a brief burst) → pausing ${Math.round(pauseMs / 1000)}s so the pool routes around this IP`,
                        );
                      }
                      // G1: with ≥half the pool out of rotation, rotating finds no
                      // capacity and merely multiplies upstream load.
                      suppressBareBurstRotate = isFleetWideBareBurst() || noteRecentBareBurstCluster(account.accountId);
                    }
                  } else {
                    // unifiedRejected: recordResponse already set a BOUNDED re-probe
                    // pause, so do not penalize to the full multi-hour reset.
                    lastExhaustResetAt = reset.resetAt ?? Date.now() + 5 * 60 * 60 * 1000;
                  }
                  if (status === 429) {
                    // Keep the edge signal live even when a sibling IP lets this
                    // request succeed: the account stays serviceable, but operators
                    // must still see why a pinned route degraded.
                    bare429PauseUntil.set(
                      account.accountId,
                      Math.max(bare429PauseUntil.get(account.accountId) ?? 0, lastExhaustResetAt),
                    );
                  }
                  // WI-3150: built LAST in this branch, so it captures every suffix
                  // the branches above appended (bare-burst origin, cold-rest cause).
                  // Flushed only if the kernel actually goes on to retry.
                  pendingRetryLog = `inference-gateway: upstream ${status} → internal retry attempt=${attemptsUsed + context.attempt} wait=${transientWaitedMs}ms on '${throttled429AccountId}'${shape429Suffix}`;
                } else if (status === 403 && classification?.kind === 'org-disallowed') {
                  // Account-level org/subscription DISQUALIFICATION, not a throttle:
                  // forwarding it hard-fails the bee AND, when this account is
                  // active(), 403-blocks the whole fleet.
                  const resetAt = classification.resetAt ?? Date.now() + ORG_DISALLOW_PAUSE_MS;
                  accountGov.penalize({ resetAt });
                  lastExhaustResetAt = resetAt;
                  // The pause is IN-MEMORY and resets on every gateway restart, which
                  // kept re-exposing a permanently dead account. On a short streak,
                  // fire the persistent-deactivate side-channel ONCE.
                  const orgStreak = (orgDisallowedStreak.get(account.accountId) ?? 0) + 1;
                  orgDisallowedStreak.set(account.accountId, orgStreak);
                  if (orgDisallowedDeactivateThreshold > 0 && orgStreak === orgDisallowedDeactivateThreshold) {
                    log(
                      'error',
                      `inference-gateway: account '${account.accountId}' PERMANENTLY org/subscription-disallowed (${orgStreak} consecutive 403s) → deactivating it from the pool + failover`,
                    );
                    try {
                      // EI-15153: name the LIVE sessions that were routing through
                      // this account when it died, so the alert says WHICH sessions
                      // to check instead of an untargeted notice.
                      const affectedOwners = selectAffectedOwners(
                        [...ownerLedger.entries()].map(([ownerId, e]) => ({
                          ownerId,
                          lastAccount: e.lastAccount,
                          lastAt: e.lastAt,
                        })),
                        account.accountId,
                        Date.now(),
                      );
                      deps.onOrgDisallowed?.({
                        accountId: account.accountId,
                        consecutive: orgStreak,
                        affectedOwners,
                      });
                    } catch {
                      /* fire-and-forget: this must NEVER throw into the request hot path */
                    }
                  } else {
                    log(
                      'warn',
                      `inference-gateway: account '${account.accountId}' org/subscription-disallowed (403) → pausing ${Math.round(ORG_DISALLOW_PAUSE_MS / 3600000)}h + failover (org-disallowed streak ${orgStreak}/${orgDisallowedDeactivateThreshold})`,
                    );
                  }
                } else if (status === 401) {
                  // Drop + refresh the cached token. CREDENTIAL-HEALTH: a DEAD
                  // credential 401s AGAIN after the refresh yields the same invalid
                  // credential, silently breaking spawns with no fleet alert.
                  account.invalidateToken?.();
                  const streak = (credential401Streak.get(account.accountId) ?? 0) + 1;
                  credential401Streak.set(account.accountId, streak);
                  if (classifyCredential401Streak(streak, credential401DeadThreshold)) {
                    log(
                      'error',
                      `inference-gateway: credential for '${account.accountId}' is DEAD — ${streak} consecutive 401s despite token refresh; firing credential-health alert`,
                    );
                    try {
                      deps.onCredentialDead?.({ accountId: account.accountId, consecutive401s: streak });
                    } catch {
                      /* fire-and-forget: the alert side-channel must never throw here */
                    }
                  }
                }

                if (status >= 200 && status < 300) {
                  // AIMD clean signal: a forwarded 2xx means this account had real
                  // capacity — drain throttle pressure and nudge admission back up.
                  providerAdmission.recordSuccess('claude');
                  // A 2xx is a successful auth, so clear the streaks that would
                  // otherwise carry a stale escalation into a false alert.
                  credential401Streak.delete(account.accountId);
                  orgDisallowedStreak.delete(account.accountId);
                  bare429Streak.delete(account.accountId);
                  bare429PauseUntil.delete(account.accountId);
                  ipBare429Streak.delete(egressKey);
                  ipCooldownUntil.delete(egressKey);
                }
                if (peeked.length && classification && classification.kind !== 'forward') {
                  log(
                    'warn',
                    `inference-gateway: upstream ${status} classified ${classification.kind} on '${account.accountId}'${shape429Suffix}`,
                  );
                }
              },
            },
            adapter,
            // The old handler registered in `inFlightReg` itself, above the try, and
            // D-003 forbids folding a behaviour change into an extraction.
            inFlight: { register: () => ({ unregister: () => undefined }) },
            downstream: {
              start: ({ status, metadata }) => {
                // The ladder has settled: no further attempt is coming.
                resolvePending(null);
                attemptsUsed += attemptsThisPass;
                const outHeaders = buildOutHeaders(metadata);
                const classification = metadata.classification;
                const retryIntent = classification !== null && classification.kind !== 'forward';

                // WI-10005833: a 400 refusing the request's reasoning effort names the supported levels
                // itself, so retry once at a supported level instead of relaying a 400 that ends the
                // caller's turn. Decided here, before anything is relayed; applied in the catch.
                if (status === 400 && !res.headersSent && effortClampFor(metadata.peekedBody ?? '')) {
                  interception.taken = {
                    status,
                    outHeaders,
                    peeked: metadata.peekedBody ?? '',
                    transient: false,
                    action: 'effort-clamp',
                    waitMs: 0,
                    backoffMs: 0,
                  };
                  throw INTERCEPT;
                }

                if (retryIntent) {
                  const decision = decideThrottleRecovery({
                    status,
                    retryIntent,
                    lastExhaustResetAt,
                    state: {
                      transientWaitedMs,
                      retryDeadlineAt,
                      absorbDeadlineAt,
                      headersSent: res.headersSent,
                    },
                    budgets: {
                      waitCapMs: ALL_THROTTLED_RECOVERY_WAIT_CAP_MS,
                      transientTotalWaitBudgetMs: TRANSIENT_TOTAL_WAIT_BUDGET_MS,
                      overloadBackoffMs: OVERLOAD_529_BACKOFF_MS,
                    },
                  });
                  const base: Omit<Intercept, 'action' | 'waitMs' | 'backoffMs'> = {
                    status,
                    outHeaders,
                    peeked: metadata.peekedBody ?? '',
                    transient: decision.transient,
                  };
                  // (1) BOUNDED TRANSIENT WAIT. Rotation could not help, but the
                  // throttle is SHORT and capacity exists — wait the penalty out and
                  // retry the recovered account on this same slot.
                  if (decision.action === 'wait') {
                    interception.taken = { ...base, action: 'wait', waitMs: decision.waitMs, backoffMs: 0 };
                    throw INTERCEPT;
                  }
                  // (2) EXTENDED ABSORPTION. Release the slot (the wait below holds
                  // NONE, so it cannot wedge), wait the throttle out, re-acquire on
                  // the pool's current best, and retry — so the caller WAITS and
                  // succeeds instead of receiving an error.
                  if (decision.action === 'absorb') {
                    interception.taken = {
                      ...base,
                      action: 'absorb',
                      waitMs: 0,
                      backoffMs: decision.backoffMs,
                    };
                    throw INTERCEPT;
                  }
                  // (3) LAST-RESORT OPUS→SONNET DOWNGRADE (WI-1073). Rotation, wait
                  // and absorb have all failed on a HARD opus wall, so opus is
                  // exhausted pool-wide. An opus-floored critical role would
                  // otherwise hard-fail here; sonnet-vs-nothing wins.
                  if (
                    !opusDowngraded &&
                    !decision.transient &&
                    (status === 403 || status === 429) &&
                    model.includes('opus')
                  ) {
                    interception.taken = { ...base, action: 'downgrade', waitMs: 0, backoffMs: 0 };
                    throw INTERCEPT;
                  }
                }

                // ── forwarding for real ──────────────────────────────────────────
                stageSpan?.setServingAccount(metadata.accountId);
                if (status >= 200 && status < 300) {
                  // Cache instrumentation: a PASSIVE observer tallying this
                  // request's prompt-cache read/write from `message_start`, without
                  // touching the client pipe. A retry means the request failed over
                  // off its initially-selected account, so a miss is routing-induced.
                  cacheProbe = new PassThrough();
                  cacheProbe.on('data', () => undefined);
                  cacheProbe.on('error', () => undefined);
                  // P-009: every served Claude request is counted in the billing class it was served in
                  // (decided by this response's own billing headers, recorded just above); its usage is
                  // added by the observer as the body streams.
                  const servedAccount = (pool.entries?.() ?? []).find((a) => a.accountId === metadata.accountId);
                  const servedClass: GatewayBillingClass = servedAccount
                    ? billingClassOf(servedAccount, Date.now())
                    : 'included';
                  billingTally(metadata.accountId, servedClass).requests++;
                  observeCacheUsage(cacheProbe, metadata.accountId, attemptsUsed > 1, affinityKey ?? wantOwner, stageSpan, servedClass);
                } else if (status === 429 || status === 529) {
                  // The DOMINANT "nothing goes through" exit. Record a stall so the
                  // stall-waker re-wakes an IDENTIFIED bee when this account recovers
                  // — without it the bee simply dies and /admin/stalls sits empty.
                  if (wantOwner) {
                    recordStall(
                      wantOwner,
                      metadata.accountId,
                      Math.max(governorForAccount(model, metadata.accountId).state.pausedUntil, Date.now() + 30_000),
                    );
                  }
                }
                if (outHeaders[PIN_YIELDED_HEADER]) {
                  recordOwnerOutcome(wantOwner, 'pin_yield', {
                    account: metadata.accountId,
                    detail: outHeaders[PIN_YIELDED_HEADER],
                  });
                }
                recordRoute(affinityKey ?? wantOwner, metadata.accountId, model, {
                  context1m: servedContext1m,
                  nativeSessionId,
                });
                recordOwnerOutcome(
                  wantOwner,
                  status < 400 ? 'ok' : status === 429 ? 'upstream_429' : 'upstream_error',
                  { account: metadata.accountId, status },
                );
                // EI-21921571654476580: this is the OTHER exhaustion exit — reached
                // when the classifier already ruled retryIntent false, OR none of the
                // wait/absorb/downgrade rungs' own conditions matched (e.g. absorb is
                // disabled, or retryDeadlineAt/transientWaitedMs are already spent).
                // Either way this IS the gateway's final answer for this request, so
                // the same override applies as the catch-block exhaustion path: don't
                // forward a raw upstream `x-should-retry: true` that invites a
                // downstream SDK to retry a terminal condition silently forever.
                if (status === 429 || status === 529) {
                  Object.assign(
                    outHeaders,
                    shapeTerminalThrottle({
                      attempts: attemptsUsed,
                      retriesExhaustedHeader: RETRIES_EXHAUSTED_HEADER,
                      suppressClientRetry: true,
                    }).headers,
                  );
                  log(
                    'warn',
                    `inference-gateway: upstream ${status} on '${metadata.accountId}' for ${model} was not rescued (retry-intent=${retryIntent}) after ${attemptsUsed} attempt(s) — forwarding terminal ${status} with x-should-retry=false`,
                  );
                }
                sseForward = (outHeaders['content-type'] ?? '').includes('text/event-stream');
                if (status >= 200 && status < 300 && modelAttestation) {
                  pendingAttestedHead = { status, headers: outHeaders, sse: sseForward };
                } else {
                  res.writeHead(status, outHeaders);
                }
              },
              write: async (chunk) => {
                cacheProbe?.write(chunk);
                if (pendingAttestedHead) {
                  const buffered = Buffer.from(chunk);
                  pendingAttestedChunks.push(buffered);
                  pendingAttestedBytes += buffered.length;
                  if (pendingAttestedBytes > (pendingAttestedHead.sse ? 65_536 : 8_388_608)) {
                    throw new Error('accepted operation provider response exceeds the attestation buffer');
                  }
                  if (pendingAttestedHead.sse && /^data: \{"type":"message_start".*\}$/m.test(
                    Buffer.concat(pendingAttestedChunks).toString('utf8'))) {
                    await attestAndFlush(Buffer.concat(pendingAttestedChunks), true);
                  }
                } else {
                  // Honour downstream backpressure exactly as the old `pipe(res)` did.
                  await writeDownstream(Buffer.from(chunk));
                }
              },
              end: async () => {
                endCacheProbe();
                if (pendingAttestedHead) {
                  if (pendingAttestedHead.sse) throw new Error('accepted operation stream ended without model attestation');
                  await attestAndFlush(Buffer.concat(pendingAttestedChunks), false);
                }
                res.end();
              },
            },
          });
          return;
        } catch (error) {
          // A pass that threw settled without relaying, so any deferred effect is
          // final now.
          resolvePending(null);
          attemptsUsed += attemptsThisPass;

          // Read-and-clear through the helper (see its declaration): going through a
          // call is what keeps control-flow analysis from having narrowed this to
          // `null` at the pass reset, which would make every field access below TS2339.
          const taken = takeIntercept();
          if (taken) {
            if (taken.action === 'effort-clamp') {
              // WI-10005833: at most once per request. `effortClampFor` already proved the rewrite
              // applies; it is re-derived from the same peeked body and the unchanged request body.
              const clamp = effortClampFor(taken.peeked);
              effortClampRetried = true;
              if (clamp && clampRequestEffort(clamp.from, clamp.to)) {
                effortClampCache.learn(model, clamp.from, clamp.to);
                effortClampRetries++;
                log(
                  'warn',
                  `inference-gateway: upstream 400 — ${model} does not support effort '${clamp.from}' (supported: ${clamp.supported.join(', ')}) → retrying once at '${clamp.to}' for '${wantOwner ?? 'unpinned'}' on '${active.accountId}'; later ${model} '${clamp.from}' requests are rewritten before sending (WI-10005833)`,
                );
                continue;
              }
            }
            if (taken.action === 'wait') {
              transientWaitedMs += taken.waitMs;
              log(
                'warn',
                `inference-gateway: all accounts transiently throttled on ${model} → wait ${taken.waitMs}ms + retry (wait-budget ${transientWaitedMs}/${TRANSIENT_TOTAL_WAIT_BUDGET_MS}ms)`,
              );
              // EI-21922955765584730: `res.setTimeout` measures DOWNSTREAM socket
              // inactivity, but this wait withholds every downstream byte ON PURPOSE
              // (no headers sent yet — this is an internal retry, not a hung client).
              // Extend it to cover the KNOWN wait so the gateway's own 120s guard
              // cannot kill a live, patiently-waiting caller mid-retry (the same
              // extend/restore pattern already used for codex OAuth non-stream
              // aggregation below, @6064-6067/@6116/@6157).
              res.setTimeout(downstreamIdleMs > 0 ? taken.waitMs + downstreamIdleMs : 0);
              await new Promise<void>((r) => {
                const t = setTimeout(r, taken.waitMs);
                t.unref?.();
              });
              res.setTimeout(downstreamIdleMs);
              log(
                'warn',
                `inference-gateway: upstream ${taken.status} → internal retry attempt=${attemptsUsed} wait=${transientWaitedMs}ms on '${throttled429AccountId}'${shape429Suffix}`,
              );
              continue;
            }
            // Set when the absorb rung ran and could not re-acquire, so the shared
            // forward below still emits the routing/outcome records that path owes.
            let absorbGaveUp = false;
            if (taken.action === 'absorb') {
              // EI-21922955765584730: same "downstream-idle measures socket
              // inactivity, not gateway-internal work" gap as the 'wait' rung above
              // — extend the guard to cover the absorb's full remaining budget
              // (re-acquire's own maxWaitMs, below) before any of it elapses, so a
              // live caller mid-absorb is never killed out from under an in-progress
              // internal retry. Reset once the wait settles, win or lose.
              res.setTimeout(downstreamIdleMs > 0 ? Math.max(0, absorbDeadlineAt - Date.now()) + downstreamIdleMs : 0);
              // Free the slot NOW — the wait below admits nothing until an account
              // has serviceable budget, so it cannot wedge.
              release();
              release = () => {};
              if (taken.backoffMs > 0) {
                await new Promise<void>((r) => {
                  const t = setTimeout(r, Math.min(taken.backoffMs, Math.max(0, absorbDeadlineAt - Date.now())));
                  t.unref?.();
                });
              }
              // GRACEFUL RE-ROUTING: pick the NEXT round-robin account for the
              // re-acquire instead of re-holding the one we were just throttled on.
              // Under a fleet-wide bare burst the inner rotate is suppressed, so
              // without this the held caller stays pinned to one throttled account
              // for the whole absorb and never lands.
              if (!hardPin) {
                // EI-21922952513461817: `pool.active()` THROWS when every account in
                // the pool is exhausted (the exact "all accounts transiently
                // throttled" scenario this absorb rung exists to handle) — mirror the
                // try/catch the sibling stall-absorb rung already uses below
                // (@5231-5236): on exhaustion, keep holding `active` unchanged rather
                // than letting the throw escape uncaught to the generic 500 handler.
                let reCand = active;
                try {
                  // `pool.active()` falls back to a PARKED account when every account is parked, so the
                  // re-route can name a `metered: never` account serving from usage credits. That account
                  // is a wall (D-003): re-holding the throttled account is the only correct move.
                  const c = pool.active();
                  if (!(c.meteredPolicy === 'never' && isMeteredNow(c, Date.now()))) reCand = c;
                } catch {
                  /* pool empty / all-exhausted → keep the current account; the re-acquire still waits */
                }
                if (reCand.accountId !== active.accountId) {
                  stageSpan?.recordFailover();
                  everRotated = true;
                  active = reCand;
                  gov = governorForAccount(model, active.accountId);
                  log(
                    'warn',
                    `inference-gateway: absorb-retry re-routed to '${active.accountId}' instead of re-holding the throttled account`,
                  );
                }
              }
              const reacq = await gov.acquire(est, {
                maxWaitMs: Math.max(0, absorbDeadlineAt - Date.now()),
                allowSoftPaused: serveSoft,
                signal: reqAbort.signal, // a reclaim/ceiling truly cancels this parked re-acquire
              });
              // Restore the plain idle guard now that the known internal wait is
              // over — win or lose, downstream inactivity from here means the same
              // thing it always did (a hung client / a new attempt not yet writing).
              res.setTimeout(downstreamIdleMs);
              if (reacq) {
                release = reacq;
                retryDeadlineAt = Date.now() + internalRetryDeadlineMs; // fresh slot-hold budget
                attemptsUsed = 0;
                transientWaitedMs = 0; // the absorb is a SEPARATE outer budget
                log(
                  'warn',
                  `inference-gateway: absorb-retry on '${active.accountId}' — holding the caller instead of forwarding a ${taken.status} (${Math.round((absorbDeadlineAt - Date.now()) / 1000)}s budget left)`,
                );
                continue;
              }
              // The re-acquire timed out within the absorb budget. Do NOT forward from
              // here: rotation, the transient wait and the absorb have now ALL failed,
              // which is EXACTLY the precondition the last-resort downgrade documents.
              // The live ladder fell THROUGH to it at this point rather than
              // returning (`re-acquire timed out within the absorb budget → fall
              // through to forward`, gateway.ts@00cc8cc6cc:4879), and porting that
              // fall-through as a `return` is what made an opus wall hard-fail the
              // caller with a 403 instead of downgrading it (WI-1073's own test).
              absorbGaveUp = true;
            }
            // (3) LAST-RESORT OPUS→SONNET DOWNGRADE (WI-1073). Reached two ways, and
            // both mean rotation + wait + absorb are exhausted: `downstream.start`
            // chose it outright, or the absorb above gave up. The guard therefore
            // lives HERE rather than only at the decision site — `!transient` = a
            // usage cap / org-disallow 403 / unified-window rejection we cannot wait
            // out, and (403|429) excludes a 529 server-overload, where sonnet is
            // overloaded too and downgrading would not help. At-most-once, and it
            // reuses the same bounded machinery with reset budgets — exactly a fresh
            // request's bound — so a failure of this net degrades to the forward it
            // replaced and cannot wedge.
            if (
              !opusDowngraded &&
              !taken.transient &&
              (taken.status === 403 || taken.status === 429) &&
              model.includes('opus')
            ) {
              if (operationModelPolicy.status === 'bound') {
                const policy = operationModelPolicy.policy;
                if (!acceptedClaudeModelAllows(policy, model) ||
                    !acceptedClaudeModelAllows(policy, LAST_RESORT_SONNET_MODEL) || policy.effort ||
                    (servedContext1m && !supportsContext1m(LAST_RESORT_SONNET_MODEL, model))) {
                  const wait = policy.onUnavailable === 'wait';
                  sendJson(res, wait ? 429 : 503, {
                    type: 'error',
                    error: {
                      type: wait ? 'rate_limit_error' : 'api_error',
                      message: `accepted ${policy.mode} model policy cannot substitute ${LAST_RESORT_SONNET_MODEL} for ${model}`,
                    },
                    gateway: true,
                  }, wait
                    ? { 'retry-after': String(Math.max(1, Math.ceil((lastExhaustResetAt - Date.now()) / 1000))) }
                    : { 'x-should-retry': 'false' });
                  return;
                }
              }
              const sonnetBody = rewriteRequestModel(bodyBuf, LAST_RESORT_SONNET_MODEL);
              if (sonnetBody) {
                opusDowngraded = true;
                opusToSonnetDowngrades++;
                bodyBuf = sonnetBody;
                model = LAST_RESORT_SONNET_MODEL;
                stageSpan?.setModel(model);
                if (!hardPin) active = pool.active(); // spread the sonnet retry; a hard pin stays put
                gov = governorForAccount(model, active.accountId); // rebind pacing to the sonnet bucket
                attemptsUsed = 0;
                transientWaitedMs = 0;
                retryDeadlineAt = Date.now() + internalRetryDeadlineMs;
                log(
                  'warn',
                  `inference-gateway: opus exhausted pool-wide (hard wall, status ${taken.status}) → LAST-RESORT downgrade opus→${LAST_RESORT_SONNET_MODEL} for '${wantOwner ?? 'unpinned'}' on '${active.accountId}' (WI-1073) so the loop runs on available capacity`,
                );
                continue;
              }
            }
            // Nothing rescued it. The body was discarded when we intercepted, so
            // forward the peeked head alone — byte-for-byte what the live handler
            // sent on this same path.
            if (!res.headersSent && !reqAbort.signal.aborted) {
              // An absorb that gave up still routed and still owes its outcome
              // record; a downgrade-rung forward never recorded one.
              if (absorbGaveUp) {
                recordRoute(affinityKey ?? wantOwner, active.accountId, model, {
                  context1m: servedContext1m,
                  nativeSessionId,
                });
                recordOwnerOutcome(
                  wantOwner,
                  taken.status < 400 ? 'ok' : taken.status === 429 ? 'upstream_429' : 'upstream_error',
                  { account: active.accountId, status: taken.status },
                );
              }
              // EI-21921571654476580: this IS the gateway's final answer — wait,
              // absorb, and (for opus) the last-resort downgrade have all failed to
              // rescue it. Forwarding the raw upstream headers unchanged can carry
              // `x-should-retry: true` with no retry-after into a downstream SDK
              // that then retries this exhausted, terminal condition silently and
              // indefinitely (the client only ever sees "Working..."). Override it
              // and name the attempt count so "slow" is distinguishable from
              // "never" without grepping the gateway log.
              if (taken.status === 429 || taken.status === 529) {
                Object.assign(
                  taken.outHeaders,
                  shapeTerminalThrottle({
                    attempts: attemptsUsed,
                    retriesExhaustedHeader: RETRIES_EXHAUSTED_HEADER,
                    suppressClientRetry: true,
                  }).headers,
                );
                log(
                  'warn',
                  `inference-gateway: upstream ${taken.status} retry ladder EXHAUSTED on '${active.accountId}' for ${model} after ${attemptsUsed} attempt(s) — forwarding terminal ${taken.status} with x-should-retry=false`,
                );
              }
              res.writeHead(taken.status, taken.outHeaders);
              if (taken.peeked.length) res.write(taken.peeked);
              res.end();
            }
            return;
          }

          endCacheProbe();
          const failure =
            error instanceof GatewayRequestKernelError
              ? error
              : new GatewayRequestKernelError(error instanceof Error ? error.message : String(error), {
                  code: 'gateway-error',
                  outcome: 'gateway-error',
                  status: 500,
                  cause: error,
                });

          if (failure.code === 'request-ceiling') {
            log(
              'error',
              `inference-gateway: request hit the ${requestCeilingMs}ms hard ceiling on '${active.accountId}' — force-terminating`,
            );
            try {
              res.destroy();
            } catch {
              /* already torn down */
            }
            return;
          }
          // The relay had already begun, so there is no status left to send — give an
          // SSE client a parseable final error instead of a bare reset.
          if (res.headersSent) {
            endStreamWithError(failure.code === 'upstream-body-idle' ? 'stalled (aborted)' : 'errored');
            return;
          }
          if (reqAbort.signal.aborted) {
            try {
              res.destroy();
            } catch {
              /* already torn down */
            }
            return;
          }

          if (failure.code === 'invalid-route') {
            sendJson(res, failure.status ?? 403, { type: 'error', gateway: true,
              error: { type: 'invalid_request_error', message: failure.message } },
              { 'x-should-retry': 'false' });
            return;
          }

          if (attestationFailed) {
            sendJson(res, 503, { type: 'error',
              error: { type: 'api_error', message: 'accepted operation request attestation could not be verified or persisted' },
              gateway: true }, { 'x-should-retry': 'false' });
            return;
          }

          // A TOKEN failure: penalized per-attempt above. Shed a retryable 503 and
          // record the stall so the stall-waker re-wakes an identified bee when this
          // account recovers.
          if (failure.code === 'upstream-error' && failure.status === 503) {
            beeTokenStall++;
            recordOwnerOutcome(wantOwner, 'shed', { account: active.accountId, detail: 'token stall 503' });
            recordStall(wantOwner, active.accountId, Math.max(gov.state.pausedUntil, Date.now() + 30_000));
            sendJson(
              res,
              503,
              {
                type: 'error',
                error: {
                  type: 'overloaded_error',
                  message: `inference-gateway: token refresh stalled on '${active.accountId}'; retry shortly`,
                },
                gateway: true,
              },
              { 'retry-after': '5', [ROUTED_ACCOUNT_HEADER]: active.accountId },
            );
            return;
          }

          const stalled = failure.code === 'ttfb-timeout' || failure.code === 'upstream-body-idle';
          if (lastTransportHadProxy) {
            // STALL ABSORPTION: the DOMINANT failure under an Anthropic-wide stall
            // storm dies here (every proxy account TTFB-stalls, so rotation is
            // exhausted and the 429-absorb cannot help — there is no 429). Hold the
            // caller through it rather than shedding a 503.
            //   everRotated GUARD: only a MULTI-account storm — alternatives that
            //   flap and recover — is worth holding for. A LONE permanently-dead
            //   proxy must shed FAST, since re-acquiring on the same dead account
            //   would just re-stall for the whole absorb budget.
            if (
              ABSORB_STALLS_ON &&
              everRotated &&
              absorbDeadlineAt > 0 &&
              Date.now() < absorbDeadlineAt &&
              !res.headersSent
            ) {
              // EI-21922955765584730: same fix as the throttle-absorb rung above —
              // extend the downstream-idle guard to cover this known internal wait
              // (it withholds every downstream byte on purpose, not because the
              // client went away) so the 120s guard can't kill a live caller
              // mid-absorb; restore it once the wait settles.
              res.setTimeout(downstreamIdleMs > 0 ? Math.max(0, absorbDeadlineAt - Date.now()) + downstreamIdleMs : 0);
              release();
              release = () => {};
              let cand = active;
              let candGov = gov;
              try {
                cand = pool.active();
                candGov = governorForAccount(model, cand.accountId);
              } catch {
                /* pool empty / all-exhausted → keep the current account; the re-acquire still waits */
              }
              const reacq = await candGov.acquire(est, {
                maxWaitMs: Math.max(0, absorbDeadlineAt - Date.now()),
                allowSoftPaused: serveSoft,
                signal: reqAbort.signal,
              });
              res.setTimeout(downstreamIdleMs);
              if (reacq) {
                release = reacq;
                active = cand;
                gov = candGov;
                retryDeadlineAt = Date.now() + internalRetryDeadlineMs;
                attemptsUsed = 0;
                transientWaitedMs = 0;
                log(
                  'warn',
                  `inference-gateway: stall-absorb on '${active.accountId}' — holding the caller through the egress stall storm instead of a 503 (${Math.round((absorbDeadlineAt - Date.now()) / 1000)}s budget left)`,
                );
                continue;
              }
              // re-acquire timed out → fall through to the retryable 503
            }
            // No healthy account left / rotation budget spent — a RETRYABLE 503 (the
            // bee's CLI retries; the next request lands on the failover-rotated
            // active()), never a terminal 502.
            beeEgressExhausted++;
            recordOwnerOutcome(wantOwner, 'shed', { account: active.accountId, detail: 'egress exhausted 503' });
            recordStall(wantOwner, active.accountId, Math.max(gov.state.pausedUntil, Date.now() + 30_000));
            sendJson(
              res,
              503,
              {
                type: 'error',
                error: {
                  type: 'overloaded_error',
                  message: `inference-gateway: egress proxy ${stalled ? 'stall' : 'transport error'} on '${active.accountId}'; retry shortly`,
                },
                gateway: true,
              },
              { 'retry-after': '5', [ROUTED_ACCOUNT_HEADER]: active.accountId },
            );
            return;
          }
          // No egress proxy → an Anthropic/network-side stall, not a dead proxy:
          // keep the fast 502 and do NOT penalize a healthy account. Deliberately
          // NOT absorbed — absorbing a no-proxy stall would hold callers through a
          // persistent Anthropic-side storm, the 2026-06-19 deadlock.
          sendJson(res, 502, {
            type: 'error',
            error: {
              type: 'api_error',
              message: `inference-gateway upstream ${stalled ? 'stall timeout' : 'error'}: ${failure.message}`,
            },
            gateway: true,
          });
          return;
        }
      }
    } finally {
      clearStall();
      clearTimeout(ceilingTimer);
      const entry = inFlightReg.get(reqId);
      if (entry) {
        inFlightReg.delete(reqId);
        // A NATURAL completion (not a self-heal abort) refreshes the drain clock — proof the gateway is
        // draining, which keeps the valve dormant. A reclaimed request deliberately does NOT, so an
        // actively-reclaimed wedge stays "stalled" and the next tick frees another slot.
        if (!entry.reclaimed) lastDrainAt.claude = Date.now();
      }
      release();
    }
  }

  type CodexLegacyRouting = {
    hardPin: boolean;
    pinned: CodexCliAccount | null;
    ownerId?: string;
  };

  type AcceptedCodexRequest = {
    policy: AcceptedClaudeModelPolicy;
    context: ActiveOperationAttestationContext;
    requestedModel: string;
    forwardedEffort: string | null;
    requestId: string;
  };

  /** Bound Responses traffic cannot expose a successful head until the final
   * provider model and usage are durably recorded. Streaming bodies are held
   * with an explicit cap; an oversized reply fails closed before any 2xx. */
  function acceptedCodexResponse(
    request: AcceptedCodexRequest,
    contentType: string,
    bufferBody: boolean,
  ) {
    const decoder = createCodexProviderCompletionDecoder(contentType);
    const chunks: Buffer[] = [];
    let bufferedBytes = 0;
    return {
      push(chunk: Uint8Array) {
        decoder.push(chunk);
        if (!bufferBody) return;
        bufferedBytes += chunk.byteLength;
        if (bufferedBytes > 32 * 1024 * 1024) {
          throw new Error('accepted Codex response exceeds the attested relay bound');
        }
        chunks.push(Buffer.from(chunk));
      },
      async finish(): Promise<Buffer[]> {
        const evidence: CodexProviderCompletionEvidence = decoder.finish();
        if (!acceptedCodexModelAllows(request.policy, evidence.model, request.forwardedEffort)) {
          throw new Error('provider returned a model outside the accepted Codex operation policy');
        }
        if (request.forwardedEffort && evidence.providerEffort &&
            evidence.providerEffort !== request.forwardedEffort) {
          throw new Error('provider reported reasoning effort differs from the accepted forwarded effort');
        }
        if (!deps.recordAcceptedOperationModelAttestation) {
          throw new Error('accepted Codex operation attestation writer is unavailable');
        }
        await deps.recordAcceptedOperationModelAttestation(request.context, {
          requestId: request.requestId,
          providerResponseId: evidence.responseId,
          backend: 'codex', provider: 'openai',
          requestedModel: request.requestedModel,
          actualModel: evidence.model,
          forwardedEffort: request.forwardedEffort,
          providerEffort: evidence.providerEffort,
          effortSource: request.forwardedEffort ? 'forwarded-request' : 'unavailable',
          usage: evidence.usage,
        });
        return chunks;
      },
    };
  }

  async function flushAcceptedCodexChunks(res: http.ServerResponse, chunks: Buffer[]): Promise<void> {
    for (const chunk of chunks) {
      if (res.destroyed || res.writableEnded) return;
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => {
          const settle = () => {
            res.off('drain', settle);
            res.off('close', settle);
            res.off('error', settle);
            resolve();
          };
          res.once('drain', settle);
          res.once('close', settle);
          res.once('error', settle);
        });
      }
    }
  }

  interface CodexLegacyTransportExecution {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    cli: CodexCliAccount;
    url: string;
    preBody?: Buffer;
    routing: CodexLegacyRouting;
    acceptedOperation?: AcceptedCodexRequest;
  }

  /** Execute a ChatGPT-subscription strategy selected by the static lane
   * registry. Both handlers remain inside proxyOpenAi's already-admitted task. */
  async function executeCodexLegacyTransport(
    executor: GatewayLegacyExecutorId,
    execution: CodexLegacyTransportExecution,
    kernelAdmission: GatewayLaneAdmission,
  ): Promise<void> {
    switch (executor) {
      case 'serveCodexOAuthProxy':
        await serveCodexOAuthProxy(
          execution.req,
          execution.res,
          execution.cli,
          execution.url,
          kernelAdmission,
          execution.routing,
          execution.preBody,
          execution.acceptedOperation,
        );
        return;
      case 'serveCodexCliBridge':
        if (carryTrial) {
          sendJson(execution.res, 403, { error: { message: 'carry trial requires observed HTTP attempts' } },
            { 'x-should-retry': 'false' });
          return;
        }
        if (execution.acceptedOperation) {
          sendJson(execution.res, 503, { type: 'error',
            error: { type: 'api_error', message: 'accepted Codex operation requires provider-authored model attestation' },
            gateway: true }, { 'x-should-retry': 'false' });
          return;
        }
        await serveCodexCliBridge(
          execution.req,
          execution.res,
          execution.cli,
          kernelAdmission,
          execution.preBody,
          execution.routing,
        );
        return;
      default:
        throw new Error(`inference-gateway: executor '${executor}' is not a ChatGPT-subscription transport`);
    }
  }

  /** Serve one `/v1/responses` request by driving the codex CLI on a ChatGPT-subscription
   *  account (codex-cli-bridge.ts). Non-streaming only; runs INSIDE the codex admission
   *  queue (same slot accounting as the bearer path), so concurrent CLI spawns are bounded
   *  by the codex lane's live capless admission window. */
  async function serveCodexCliBridge(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    cli: CodexCliAccount,
    kernelAdmission: GatewayLaneAdmission,
    preBody?: Buffer,
    routing: CodexLegacyRouting = { hardPin: false, pinned: null },
  ) {
    const stageSpan = requestSpan(req);
    stageSpan?.setTransport('cli-exec');
    // `setStreaming` is deliberately NOT called here. The transport descriptor declares
    // `streaming: false` because the nested `codex exec` run is buffered, but this handler
    // ADAPTS that completed run back onto the SSE wire whenever the client sent `stream:true`
    // (see the response.completed write below). Stamping `false` up front therefore described
    // the implementation rather than the wire, and it disarmed the one detector that covers
    // this path: request-stage-telemetry's `missingStages` guard only requires the `stream`
    // stage when the span says the request streamed, so every gateway-routed Codex agent
    // request recorded `streaming:false` with no `stream` stage and no missing-stage finding —
    // a stream that opened and never terminated was indistinguishable from a non-streaming
    // request that correctly had no stream. It is set from the parsed body instead.
    totalRequests++;
    codexRequests++;
    recordOwnerOutcome(routing.ownerId, 'request');
    let bodyBuf: Buffer;
    if (preBody) {
      bodyBuf = preBody; // already-read body (the OAuth-proxy path hands off a non-streaming request here)
    } else {
      stageSpan?.beginStage('bodyRead');
      try {
        bodyBuf = await withPromiseDeadline(readBody(req), requestCeilingMs, `codex-cli readBody '${cli.accountId}'`);
      } catch {
        try {
          req.destroy();
        } catch {
          /* already torn down */
        }
        if (!res.headersSent) {
          sendJson(res, 503, {
            type: 'error',
            error: {
              type: 'overloaded_error',
              message: 'inference-gateway: codex-cli request body read stalled; retry shortly',
            },
            gateway: true,
          });
        }
        return;
      } finally {
        stageSpan?.endStage('bodyRead');
      }
    }
    let body: { model?: unknown; input?: unknown; instructions?: unknown; stream?: unknown; reasoning?: unknown } = {};
    try {
      body = JSON.parse(bodyBuf.toString('utf8')) as typeof body;
    } catch {
      sendJson(res, 400, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'inference-gateway: codex-cli bridge needs a JSON /v1/responses body',
        },
        gateway: true,
      });
      return;
    }
    const wantsStream = body.stream === true;
    // The wire contract this request will actually be served on — not the transport's buffered
    // implementation. This is what arms the `stream`-stage requirement in the span's finish gate.
    stageSpan?.setStreaming(wantsStream);
    const parsedBridgeModel = parseBridgeModel(typeof body.model === 'string' ? body.model : undefined);
    let effort = parsedBridgeModel.effort;
    if (body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)) {
      const requestedEffort = (body.reasoning as Record<string, unknown>).effort;
      if (
        typeof requestedEffort === 'string' &&
        /^(minimal|low|medium|high|xhigh|max)$/i.test(requestedEffort.trim())
      ) {
        effort = requestedEffort.trim().toLowerCase();
      }
    }
    const model = parsedBridgeModel.id;
    stageSpan?.setModel(model);
    const inputText = extractResponsesInputText(body.input);
    if (!inputText.trim()) {
      sendJson(res, 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'inference-gateway: codex-cli bridge got no input text' },
        gateway: true,
      });
      return;
    }
    const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
    const prompt = instructions ? `${instructions}\n\n${inputText}` : inputText;
    // Abort the CLI when the downstream hangs up so a dead scout call can't hold the slot.
    const ac = new AbortController();
    const onGone = () => ac.abort();
    res.once('close', onGone);
    res.setTimeout(downstreamIdleMs, () => res.destroy());
    // The stream is opened BEFORE the nested CLI run, not after it: the run is the part that
    // takes minutes, so deferring the first byte until it returns is exactly what trips the idle
    // deadline (see CODEX_CLI_SSE_KEEPALIVE_MS). Opening early commits the 200 and the
    // routed-account header at a point where a later failover can still move the account — the
    // ordinary cost of streaming, which the bearer SSE path above pays too — so an in-band
    // `event: error` has to stand in for the status code we can no longer set.
    let sseOpen = false;
    let keepalive: ManagedHandle | null = null;
    const initialPinYieldedFrom =
      routing.pinned && !routing.hardPin && routing.pinned.accountId !== cli.accountId
        ? routing.pinned.accountId
        : null;
    const stopKeepalive = () => {
      keepalive?.stop();
      keepalive = null;
    };
    const openSse = () => {
      if (sseOpen || res.headersSent) return;
      sseOpen = true;
      const headers: Record<string, string> = {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        [ROUTED_ACCOUNT_HEADER]: cli.accountId,
      };
      if (initialPinYieldedFrom) {
        headers[PIN_YIELDED_HEADER] = `${initialPinYieldedFrom}->${cli.accountId}`;
      }
      res.writeHead(200, headers);
      // A Responses client waits on `response.created` before it will sit through a long turn;
      // the keepalive comments then hold the socket open until the real payload lands.
      res.write(
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { object: 'response', status: 'in_progress', model } })}\n\n`,
      );
      // The stream is live from here. Pairing this with `setStreaming(wantsStream)` above is what
      // makes an SSE request that never opened its stream show up as a missing `stream` stage
      // instead of a clean `ok`.
      stageSpan?.beginStage('stream');
      keepalive = managedSetInterval(
        'inference-gateway:codex-cli-sse-keepalive',
        CODEX_CLI_SSE_KEEPALIVE_MS,
        () => {
          if (!res.writableEnded) res.write(': keepalive\n\n');
        },
        // `instanced` is what makes a per-connection timer legal here: without it each new
        // request would STOP the previous request's keepalive by name collision.
        { category: 'lifecycle', instanced: true, classification: 'timeout-reaper' },
      );
    };
    res.once('close', stopKeepalive);
    /*
     * gateway-kernel-adoption-2026-08-29 P-005 — this handler's attempt ladder now
     * lives in `executeGatewayRequestKernel`, and the transport-owned half (the
     * nested `codex exec` run, credential-death quarantine, rotation) in
     * `createCodexCliKernelAdapter`. The hand-rolled loop, its per-attempt
     * failover bookkeeping and its auth-quarantine branch are DELETED, not ported.
     *
     * WHY THE STREAM STILL OPENS BEFORE THE KERNEL RUNS: the kernel commits a
     * response only after an attempt has been chosen as final (retry decisions
     * all precede `downstream.start`). This transport must commit FIRST, because
     * a buffered multi-minute `codex exec` would otherwise deliver no bytes until
     * it finished and trip the client's idle deadline. Those are not in conflict:
     * `downstream` belongs to the CALLER, so the SSE head and its keepalive are
     * opened here and the kernel's `start()` is a no-op for an already-committed
     * head. The ladder then runs underneath the open stream exactly as before —
     * which is why a failover can still move the account after the routed-account
     * header has been written, and why a terminal failure has to travel in-band.
     */
    const kernelAdapter = createCodexCliKernelAdapter({
      // D-010: the caller already spent this request's one `codexCliPool.active()`
      // call to resolve `cli`, and `active()` ADVANCES the round-robin. Hand the
      // resolved account over rather than letting the adapter select again.
      initialAccount: cli,
      accounts: () => codexCliAccounts(),
      pool: codexCliPool ? healthAwareCodexPool(codexCliPool) : null,
      run: codexCliRun,
      model,
      effort,
      prompt,
      timeoutMs: requestCeilingMs,
      authQuarantineMs: CODEX_CLI_AUTH_QUARANTINE_MS,
      failoverBackoffMs: bare429FailoverBackoffMs,
      isAuthFailure: isCodexAuthFailure,
      hardPin: routing.hardPin,
      pinnedAccountId: routing.pinned?.accountId ?? null,
      // Once `openSse()` has committed the 200, a terminal failure is a GATEWAY
      // error: we promised the client a response and then did not serve one.
      responseCommitted: () => sseOpen,
    });
    let served: CodexCliSyntheticResponse | null = null;
    let attemptsSeen = 0;
    let lastFailureDetail = '';
    try {
      // THE INVERSION THIS LANE DEPENDS ON, and the reason the kernel needed no
      // change to host it. The kernel commits a response only once an attempt has
      // been chosen as final; this transport must commit BEFORE the first attempt,
      // because a buffered multi-minute `codex exec` would otherwise send no bytes
      // until it finished and trip the client's idle deadline. `downstream` is the
      // CALLER's, so the head and its keepalive open here and the kernel's
      // `start()` finds them already committed — the ladder then runs underneath
      // the open stream exactly as the hand-rolled loop's `openSse()`-before-`await`
      // did. Consequence, unchanged from before: past this point the status code is
      // spent, so a terminal failure has to travel in-band.
      if (wantsStream) openSse();
      await executeGatewayRequestKernel<
        CodexCliRouteValue,
        CodexCliRouteValue,
        CodexCliChunk,
        CodexCliResponseMetadata
      >({
        request: {
          lane: providerAdapters.codex.lane,
          // Already read and parsed above — the body is what SELECTS this transport
          // (and, on the OAuth kill-switch path, was read by the caller), so it
          // cannot be read inside the kernel.
          body: (async function* () {
            yield bodyBuf;
          })(),
          ownerId: routing.ownerId ?? null,
          pin: routing.pinned ? { accountId: routing.pinned.accountId, mode: routing.hardPin ? 'hard' : 'soft' } : null,
          signal: ac.signal,
        },
        policy: {
          maxBodyBytes: Number(process.env.PAPERCUSP_GATEWAY_MAX_BODY_BYTES) || 64 * 1024 * 1024,
          bodyReadTimeoutMs: requestCeilingMs,
          requestCeilingMs,
          // The nested run IS the whole request: the live handler passed
          // `requestCeilingMs` straight to `codexCliRun` and armed no separate
          // first-byte deadline, because a buffered subprocess has no TTFB.
          ttfbTimeoutMs: requestCeilingMs,
          bodyIdleTimeoutMs: requestCeilingMs,
          downstreamIdleTimeoutMs: downstreamIdleMs,
          maxAttempts: INTERNAL_RETRY_MAX_ATTEMPTS,
        },
        telemetry: requestStageTelemetry,
        span: stageSpan,
        admission: {
          // P-011 / D-027: threaded down from `proxyOpenAi` via `executeCodexLegacyTransport`,
          // and PASS-THROUGH by design rather than by transition. `proxyOpenAi` takes the
          // `openai-responses` slot at its own entry, above the account resolution and the
          // transport dispatch that reach this handler, so re-admitting here would deadlock on
          // the slot this request already holds. It is also why the slot cannot move down to
          // this seam: this transport commits its response head BEFORE the kernel call below.
          run: (context, task) => kernelAdmission.run(context, task),
          observeAttempt: ({ context, error }) => {
            attemptsSeen = context.attempt;
            const account = context.route.accountId ?? cli.accountId;
            // Follow the attempt, exactly as the old loop's `cli = nextCli` did: the
            // terminal 502 must report the account LAST tried, not the first candidate.
            cli = codexCliAccounts().find((a) => a.accountId === account) ?? cli;
            // The CLI home encapsulates its own credential — there is no token to
            // resolve — so the auth stage stays the zero-width seam it was.
            if (!error) return;
            const requestRef = `${gatewayProcessInstanceId}:${stageSpan?.requestId ?? 'unobserved'}`;
            if (error.code === 'cancelled') {
              log('info', `inference-gateway: codex-cli downstream cancelled request=${requestRef} code=cancelled on '${account}': ${error.message}`);
              return;
            }
            lastFailureDetail = error.message;
            if (isCodexRateLimitFailure(error.message)) {
              codexUpstream429++;
              recordRoutingUpstream429('codex', account);
              providerAdmission.recordThrottle('codex');
              recordOwnerOutcome(routing.ownerId, 'upstream_429', { account, status: 429, detail: 'cli-bridge' });
              log('warn', `inference-gateway: codex-cli bridge rate-limited on '${account}': ${error.message}`);
            } else {
              codexUpstreamErrors++;
              recordOwnerOutcome(routing.ownerId, 'upstream_error', { account, detail: 'cli-bridge' });
              log('error', `inference-gateway: codex-cli bridge failed request=${requestRef} code=${error.code} on '${account}': ${error.message}`);
            }
            // THE ONE HOOK THAT FIRES ON EVERY ATTEMPT. Credential death must park
            // the account even on the LAST attempt, when no retry remains and the
            // kernel therefore never consults `selectFailover`
            // (EI-21618978789879488). `onExhausted` both parks AND returns the next
            // account, so this is the single call site: `selectFailover` consumes
            // the decision rather than making it again, which is what stops one
            // failed attempt parking two accounts.
            const outcome = kernelAdapter.noteAttemptFailure({
              accountId: account,
              attempt: context.attempt,
              maxAttempts: INTERNAL_RETRY_MAX_ATTEMPTS,
              message: error.message,
              aborted: ac.signal.aborted,
            });
            if (outcome.authClass && outcome.parkedAccountId) {
              log(
                'error',
                `inference-gateway: codex-cli account '${outcome.parkedAccountId}' has an UNUSABLE CREDENTIAL (not a quota wall) — ` +
                  `quarantining for ${Math.round(CODEX_CLI_AUTH_QUARANTINE_MS / 1000)}s; repair with \`codex login\` in its CODEX_HOME (${cli.home})`,
              );
            }
            if (outcome.nextAccountId) codexFailovers++;
          },
        },
        adapter: kernelAdapter,
        // The old handler never registered in `inFlightReg`, and D-003 forbids
        // folding a behaviour change into an extraction.
        inFlight: { register: () => ({ unregister: () => undefined }) },
        downstream: {
          start: ({ metadata }) => {
            // Track the account that actually served, so the terminal error path
            // and the response headers report it rather than the first candidate.
            cli = codexCliAccounts().find((a) => a.accountId === metadata.accountId) ?? cli;
            stageSpan?.setServingAccount(metadata.accountId);
            // RESTORE THE WIRE TRUTH. The kernel has just stamped the span from
            // the UPSTREAM's shape (`request-kernel.ts:978`), which for this
            // transport is a buffered subprocess and therefore `false`. That is
            // the same mis-description the handler's opening comment documents:
            // stamping `streaming:false` disarms `missingStages`, whose `stream`
            // requirement is armed only when the span says the request streamed —
            // so an SSE stream that opened and never terminated became
            // indistinguishable from a correctly non-streaming request. The span
            // must describe the WIRE, which is what the client actually got.
            stageSpan?.setStreaming(wantsStream);
            providerAdmission.recordSuccess('codex');
            const headers: Record<string, string> = { [ROUTED_ACCOUNT_HEADER]: metadata.accountId };
            if (metadata.pinYieldedFrom) {
              headers[PIN_YIELDED_HEADER] = `${metadata.pinYieldedFrom}->${metadata.accountId}`;
              recordOwnerOutcome(routing.ownerId, 'pin_yield', {
                account: metadata.accountId,
                detail: headers[PIN_YIELDED_HEADER],
              });
            }
            recordRoute(routing.ownerId, metadata.accountId, model);
            recordOwnerOutcome(routing.ownerId, 'ok', { account: metadata.accountId, status: 200 });
            served = codexCliResponsesBody({ model, ...metadata.result });
            // The response is finished HERE, not after the kernel returns, because
            // the kernel finishes the span in a `finally` as it returns
            // (`request-kernel.ts:1036`). An `endStage('stream')` after that point
            // lands on an already-finished span and is silently dropped — the
            // stream stage then reads count 0 and shows up in `missingStages`,
            // which is the very signal this transport's opening comment exists to
            // keep armed.
            if (wantsStream) {
              // `codex exec` always asks a Responses endpoint for SSE. The bridge is
              // itself buffered (it drives a nested codex CLI to completion), but that
              // is an implementation detail: the completed result is adapted back onto
              // the streaming wire contract instead of rejecting every gateway-routed
              // agent. The stream is already open by here — this call only covers a run
              // that somehow finished before the opener ran. Output-item/content events
              // are required for Codex to materialize an agent_message;
              // response.completed alone records usage but drops the text.
              openSse();
              stopKeepalive();
              // The SSE head was committed before the kernel ran, so its routed-account
              // headers still describe the first attempt when the CLI ladder fails over.
              // Preserve the HTTP headers for compatibility, but carry the final route
              // truth in the response.completed response metadata, the last client-visible
              // payload on this already-committed streaming path.
              const responseMetadata =
                served &&
                typeof (served as { metadata?: unknown }).metadata === 'object' &&
                (served as { metadata?: unknown }).metadata !== null &&
                !Array.isArray((served as { metadata?: unknown }).metadata)
                  ? (served as unknown as { metadata: Record<string, unknown> }).metadata
                  : {};
              const streamResponse = {
                ...served,
                metadata: {
                  ...responseMetadata,
                  [ROUTED_ACCOUNT_HEADER]: metadata.accountId,
                  ...(metadata.pinYieldedFrom
                    ? { [PIN_YIELDED_HEADER]: `${metadata.pinYieldedFrom}->${metadata.accountId}` }
                    : {}),
                },
              } as CodexCliSyntheticResponse;
              res.end(codexCliResponsesCompletionSse(streamResponse));
              stageSpan?.endStage('stream');
            } else if (!res.headersSent) {
              sendJson(res, 200, served, headers);
            }
          },
          // The adapter returns no chunks: this transport's payload is a completed
          // object the caller serializes, either as JSON above or as SSE below.
          write: () => undefined,
          end: () => undefined,
        },
      });

      // Nothing to do on success: `downstream.start` already finished the response,
      // deliberately, so every stage closes before the kernel finalizes the span.
    } catch (e) {
      // Every retryable path was already spent inside the kernel; reaching here means
      // the ladder is exhausted, so this is only the terminal presentation. The
      // adapter already wraps a run failure in the live message shape — re-prefixing
      // a kernel-owned failure (ceiling, cancellation, downstream idle) keeps the one
      // wire contract clients match on.
      stopKeepalive();
      const detail = (e as Error).message;
      const message = detail.startsWith('inference-gateway: codex-cli bridge failed')
        ? detail
        : `inference-gateway: codex-cli bridge failed: ${detail}`;
      const rateLimited = isCodexRateLimitFailure(lastFailureDetail || detail);
      const rateShape = rateLimited
        ? shapeTerminalThrottle({
            attempts: attemptsSeen,
            retriesExhaustedHeader: RETRIES_EXHAUSTED_HEADER,
            retryAfter: {
              resetAt: null,
              fallbackSec: LOADSHED_RETRY_AFTER_SEC,
              capS: BEE_RETRY_AFTER_CAP_S,
            },
          })
        : null;
      if (rateLimited && routing.ownerId) {
        recordStall(routing.ownerId, cli.accountId, Date.now() + 30_000);
      }
      if (!res.headersSent) {
        sendJson(
          res,
          rateLimited ? 429 : 502,
          {
            type: 'error',
            error: { type: rateLimited ? 'rate_limit_error' : 'api_error', message },
            gateway: true,
          },
          { ...(rateShape?.headers ?? {}), [ROUTED_ACCOUNT_HEADER]: cli.accountId },
        );
      } else if (sseOpen && !res.writableEnded) {
        // The status line is already committed, so the failure has to travel in-band.
        // Destroying the socket instead makes a real bridge error indistinguishable from a
        // network drop — which is the shape a client retries blindly against.
        //
        // Telemetry has to be told, though: `classifyGatewayTelemetryOutcome` reads
        // `res.statusCode`, which is the 200 `openSse()` already committed, so a request that
        // FAILED for the client was finalized as `outcome:'ok'` — the same
        // records-success-from-a-partial-signal shape the bridge's own
        // `codexCliResponsesBody` comment documents. `gatewayError` outranks the status in
        // that classifier, so marking it here is what keeps the span honest.
        markRequestGatewayError(req);
        stageSpan?.endStage('stream');
        res.end(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: rateLimited ? 'rate_limit_error' : 'api_error', message }, gateway: true, ...(rateShape ? { retry_after: rateShape.retryAfterSec, retries_exhausted: attemptsSeen } : {}) })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        res.destroy();
      }
      return;
    } finally {
      res.removeListener('close', onGone);
      res.removeListener('close', stopKeepalive);
      // Belt and braces: a keepalive that outlives its request would write to a dead socket
      // forever, and `instanced` timers are only cheap while they are actually stopped.
      stopKeepalive();
    }
  }

  /** codex-gateway-oauth-proxy-2026-07-04 (WI-2198): serve one `/v1/responses` for a
   *  ChatGPT-SUBSCRIPTION codex-cli account as a TRANSPARENT STREAMING reverse-proxy to the
   *  ChatGPT backend (codex-oauth-proxy.ts) — the OAuth bearer from ~/.codex/auth.json is
   *  injected, the SSE streams straight back, and the token is refreshed once on a 401.
   *  A NON-streaming request is sent through the same OAuth transport by default: the
   *  ChatGPT SSE is aggregated boundedly into ordinary Responses JSON. The old exec bridge
   *  remains an explicit `PAPERCUSP_GATEWAY_CODEX_OAUTH_NONSTREAM=0` fallback. Runs inside
   *  the codex admission slot (same accounting as the bearer path). */
  async function serveCodexOAuthProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    cli: CodexCliAccount,
    url: string,
    kernelAdmission: GatewayLaneAdmission,
    routing: CodexLegacyRouting,
    preBody?: Buffer,
    acceptedOperation?: AcceptedCodexRequest,
  ) {
    const stageSpan = requestSpan(req);
    stageSpan?.setTransport('oauth-http');
    stageSpan?.beginStage('bodyRead');
    let bodyBuf: Buffer;
    try {
      bodyBuf =
        preBody ??
        (await withPromiseDeadline(readBody(req), requestCeilingMs, `codex-oauth readBody '${cli.accountId}'`));
    } catch {
      try {
        req.destroy();
      } catch {
        /* already torn down */
      }
      if (!res.headersSent)
        sendJson(res, 503, {
          type: 'error',
          error: {
            type: 'overloaded_error',
            message: 'inference-gateway: codex request body read stalled; retry shortly',
          },
          gateway: true,
        });
      return;
    } finally {
      stageSpan?.endStage('bodyRead');
    }
    if (bodyBuf.length) bodyBuf = normalizeCodexChatGptResponsesBody(bodyBuf).body;
    if (cachePolicyEnabled && bodyBuf.length) {
      const shardSeed = routing.ownerId || routing.pinned?.accountId || cli.accountId;
      const cached = rewriteOpenAiCacheBody(bodyBuf, {
        cacheKey: shardedCacheKey('psu', shardSeed, codexCacheShards()),
        injectRetention: false,
      });
      bodyBuf = cached.body;
      if (cached.stats) {
        recordCachePolicy('codex', cached.stats);
        stageSpan?.setCacheRouting('rewritten');
      }
    }
    // Non-streaming (scout/judge) uses the bounded OAuth transport by default. Keep the one-shot
    // CLI bridge as an emergency compatibility fallback: it is deliberately opt-out because every
    // internal retry otherwise launches another full `codex exec` subprocess.
    let wantStream = false;
    let bodyModel = '';
    if (bodyBuf.length) {
      try {
        const parsed = JSON.parse(bodyBuf.toString('utf8')) as { stream?: boolean; model?: string };
        wantStream = parsed.stream === true;
        if (typeof parsed.model === 'string') bodyModel = parsed.model;
      } catch {
        /* non-JSON — treat as non-stream */
      }
    }
    stageSpan?.setModel(bodyModel || null);
    stageSpan?.setStreaming(wantStream);
    stageSpan?.setCacheShape(bodyBuf);
    if (!wantStream && !codexOAuthNonStreamEnabled) {
      await executeCodexLegacyTransport(
        legacyExecutorForGatewayTransport(providerAdapters.codex.lane, 'cli-exec'),
        { req, res, cli, url, preBody: bodyBuf, routing, acceptedOperation },
        // Same request, same slot: the OAuth->CLI fallback hands its own admission down
        // rather than minting a second one, so the delegated transport cannot re-admit.
        kernelAdmission,
      );
      return;
    }
    if (!wantStream) {
      const upstreamBody = makeCodexNonStreamUpstreamBody(bodyBuf);
      if (!upstreamBody) {
        sendJson(res, 400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'inference-gateway: codex OAuth non-stream bridge needs a JSON /v1/responses body',
          },
          gateway: true,
        });
        return;
      }
      bodyBuf = upstreamBody;
    }
    totalRequests++;
    codexRequests++;
    recordOwnerOutcome(routing.ownerId, 'request');

    /*
     * KERNEL ADOPTION — plan `gateway-kernel-adoption-2026-08-29`, P-004.
     *
     * Everything below this point used to be a hand-rolled ladder: a re-armed
     * stall timer (headers TTFB → per-chunk body idle), a request ceiling, an
     * attempt loop, and a rotate-don't-surface failover cascade with its own
     * OAuth refresh and sibling-egress retries. Those are SHARED request
     * invariants, not Codex protocol, so they now live in
     * `executeGatewayRequestKernel`, and the oauth-specific half (account
     * selection, token resolve/refresh, egress choice, header construction, the
     * upstream call, retryability normalization) lives in
     * `createCodexOAuthKernelAdapter`.
     *
     * What stays HERE is genuinely this gateway's: the legacy counters, the
     * owner-outcome ledger, the routed/pin-yield response headers, the cache-usage
     * probe, and the non-streaming SSE→JSON aggregation, which is a DOWNSTREAM
     * presentation concern rather than a transport one.
     *
     * The two same-account re-attempts this lane needs — a 401 refresh and a
     * sibling egress IP — are expressed as the adapter's `selectReattempt`
     * routes (D-011). Neither is gated on the hard pin and neither counts as a
     * failover, which is why `observeAttempt` below counts failovers by ACCOUNT
     * change rather than by route-key change as the bearer lane does.
     */
    const reqAbort = new AbortController();
    const abortRequest = (reason: string) => {
      if (!reqAbort.signal.aborted) reqAbort.abort(new Error(reason));
    };
    const onReqAborted = () => abortRequest('codex downstream request aborted');
    const onResClose = () => abortRequest('codex downstream response closed');
    req.once('aborted', onReqAborted);
    res.once('close', onResClose);
    res.setTimeout(downstreamIdleMs, () => res.destroy());

    // Per-attempt bookkeeping the kernel deliberately does NOT own.
    let attemptsSeen = 0;
    let lastAccountId = cli.accountId;
    let cacheProbe: PassThrough | null = null;
    let acceptedRelay: ReturnType<typeof acceptedCodexResponse> | null = null;
    let pendingAcceptedHead: { status: number; headers: Record<string, string> } | null = null;
    const endCacheProbe = () => {
      if (!cacheProbe) return;
      cacheProbe.end();
      cacheProbe = null;
    };

    // Non-streaming aggregation state. The ChatGPT backend returns SSE even when
    // the public caller asked for a non-streaming response; the downstream head is
    // withheld until the final `response.completed` object is in hand.
    let aggregateSource: PassThrough | null = null;
    let aggregatePromise: Promise<Buffer> | null = null;
    let pendingHead: { status: number; headers: Record<string, string> } | null = null;

    const toKernelResponseBody = (web: Response['body']): CodexOAuthFetchResponse['body'] => {
      if (!web) return null;
      const node = Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]);
      // Caller-side recovery deliberately throws from downstream.start before
      // relay. The async iterator carries that rejection to the kernel; consume
      // the parallel EventEmitter error so it cannot become process-unhandled.
      node.on('error', () => undefined);
      const iterable = node as unknown as AsyncIterable<Uint8Array> & { cancel?(): Promise<void> | void };
      iterable.cancel = () => {
        node.destroy();
      };
      return iterable;
    };

    const makeKernelAdapter = () =>
      createCodexOAuthKernelAdapter({
        // D-010: the account was resolved by `proxyOpenAi` BEFORE this handler was
        // entered, and `AccountPool.active()` advances. The adapter replays it and
        // never selects an initial account itself.
        initialAccount: cli,
        accounts: () => codexCliAccounts(),
        pool: codexCliPool ? healthAwareCodexPool(codexCliPool) : undefined,
        upstreamUrl: codexBackendUrl(url),
        method: req.method ?? 'POST',
        requestHeaders: req.headers,
        stripRequestHeaders: STRIP_REQUEST,
        streaming: wantStream,
        // Public Luna may be backed by the ChatGPT subscription's hidden reserve
        // tier after a premium-window 429. The adapter keeps the public model in
        // telemetry and only rewrites the retry body at the upstream seam.
        // The hidden reserve tier is an upstream model substitution. A bound
        // operation waits/refuses when its accepted model has no capacity.
        reserveModel: acceptedOperation ? undefined : codexReserveModelFor(bodyModel),
        // WI-10003306: automatic per-(account, model) availability. A model refusal is recorded,
        // the request moves to a non-refusing sibling, and a later 2xx (or the TTL) clears the mark.
        model: bodyModel || null,
        onModelRefused: ({ accountId, model, status, detail }) => {
          if (codexModelRefusals.record(accountId, model, detail)) {
            log(
              'warn',
              `inference-gateway: Codex account '${accountId}' REFUSED model '${model}' (${status}: ${detail}) — marked unavailable for that model and routed around (stays in the pool; rechecked automatically)`,
            );
          }
        },
        onModelServed: ({ accountId, model }) => {
          if (codexModelRefusals.clear(accountId, model)) {
            log('warn', `inference-gateway: Codex account '${accountId}' serves model '${model}' again — refusal mark cleared`);
          }
        },
        selectAlternate: (exclude) => {
          if (!codexCliPool || !bodyModel) return null;
          const at = Date.now();
          let best: ActiveAccount | null = null;
          let bestParked = Infinity;
          let bestKey = Infinity;
          for (const account of codexCliPool.entries?.() ?? []) {
            if (exclude.has(account.accountId) || codexModelRefusals.isRefused(account.accountId, bodyModel)) continue;
            // Prefer an unparked, healthy account; a parked or saturated one is still better than
            // forwarding a false "model not supported" — its own 429 path then answers truthfully.
            const parked = codexCliPool.parkState?.(account.accountId) ? 1 : 0;
            const key = accountHealthKey(account, at);
            if (!best || parked < bestParked || (parked === bestParked && key < bestKey)) {
              best = account;
              bestParked = parked;
              bestKey = key;
            }
          }
          return best;
        },
        tokenTimeoutMs,
        authQuarantineMs: CODEX_CLI_AUTH_QUARANTINE_MS,
        failoverBackoffMs: bare429FailoverBackoffMs,
        ipCooldownMaxMs: IP_COOLDOWN_MAX_MS,
        transportCooldownMs: IP_TRANSPORT_COOLDOWN_MS,
        resolveAccessToken: (home) => resolveCodexAccessToken(home),
        refreshAccessToken: (home, current, dispatcher) =>
          refreshCodexToken(home, current, {
            fetchImpl: (target, init) => {
              const fetchInit: FetchInit = { ...init };
              if (dispatcher) fetchInit.dispatcher = dispatcher as UndiciDispatcher;
              return doFetch(target, fetchInit);
            },
          }),
        buildHeaders: buildCodexUpstreamHeaders,
        pickEgress: (account, at) => pickEgress(account, at),
        siblingEgressAvailable: (account, at, currentKey) => siblingEgressAvailable(account, at, currentKey),
        coolIp: (key, ms) => coolIp(key, ms),
        dispatcherFor: (account, entry) => dispatcherFor(account, entry as AccountEgress | undefined),
        rateReset: (headers) => {
          // WI-2038027 (codex 429 recovery P1): the ChatGPT codex backend speaks the x-codex-*
          // dialect, never anthropic-ratelimit-*. Wired to `parseRateReset` this always came back
          // empty, so `resolveResetAt` parked a WEEKLY-walled account only the 15s failover backoff
          // — it rejoined rotation still walled and re-burned an upstream 429 on nearly every
          // request. The codex parser reads the real dialect (exhausted-window resets + retry-after).
          const parsed = parseCodexRateReset(headers);
          return { resetAt: parsed.resetAt, retryAfterMs: parsed.retryAfterMs };
        },
        onEgressAttempt: (id) => egressAttemptsByAccount.set(id, (egressAttemptsByAccount.get(id) ?? 0) + 1),
        onEgressFailure: (id) => egressFailsByAccount.set(id, (egressFailsByAccount.get(id) ?? 0) + 1),
        fetch: async (target, init) => {
          const fetchInit: FetchInit = { method: init.method, headers: init.headers, signal: init.signal };
          if (init.body) fetchInit.body = init.body as unknown as BodyInit;
          if (init.dispatcher) fetchInit.dispatcher = init.dispatcher as UndiciDispatcher;
          const check = await authorizeCarryTrialAttempt(req, 'oauth-http', init.diagnosticAccountId, target, init);
          if (carryTrial) fetchInit.redirect = 'error'; // A redirect would be another, unreserved send.
          const send = () => { check(); return doFetch(target, fetchInit as RequestInit); };
          const upstream = stageSpan
            ? await stageSpan.observeUpstreamFetch(target, init.method, init.diagnosticAccountId, send)
            : await send();
          return { status: upstream.status, headers: upstream.headers, body: toKernelResponseBody(upstream.body) };
        },
      });

    type OAuthThrottleIntercept = {
      action: 'wait' | 'absorb';
      waitMs: number;
      backoffMs: number;
      resetAt: number | null;
      /** The POOL horizon at decision time — the absorb sleeps toward THIS, not the failed account's reset. */
      poolRecoveryAt: number;
      accountId: string;
    };
    const recovery = {
      transientWaitedMs: 0,
      retryDeadlineAt: Date.now() + internalRetryDeadlineMs,
      absorbDeadlineAt: absorbDeadlineForRequest(req, codexTierMap),
    };
    const INTERCEPT_OAUTH_THROTTLE = new Error('codex OAuth: outer recovery intercepted before relay');
    const interception: { taken: OAuthThrottleIntercept | null } = { taken: null };
    const takeOAuthIntercept = (): OAuthThrottleIntercept | null => {
      const taken = interception.taken;
      interception.taken = null;
      return taken;
    };
    let attemptsUsed = 0;
    let attemptsThisPass = 0;
    const runOAuthRecovery = async (): Promise<void> => {
      let continuationActive = false;
      interception.taken = null;
      attemptsThisPass = 0;
      // A resumed pass starts from the pool's CURRENT best account instead of
      // blindly re-holding the account that just exhausted. Hard pins remain strict.
      // First honour the freshest availability reading the system has (P-008): a store reading newer
      // than a park that says the account is back clears the park BEFORE the re-pick.
      if (attemptsUsed > 0) reconcileParksWithStore();
      if (attemptsUsed > 0 && !routing.hardPin && codexCliPool) {
        try {
          const candidateId = healthAwareCodexPool(codexCliPool, bodyModel || null).active().accountId;
          cli = codexCliAccounts().find((account) => account.accountId === candidateId) ?? cli;
        } catch {
          /* all accounts still exhausted — the adapter will make the truthful terminal decision */
        }
      }
      const kernelAdapter = makeKernelAdapter();
      try {
        await executeGatewayRequestKernel({
          request: {
            lane: providerAdapters.codex.lane,
            // Already read, normalized, cache-rewritten and (for a non-streaming
            // caller) converted to the upstream streaming shape above — the body is
            // what SELECTS this transport, so it cannot be read inside the kernel.
            body: (async function* () {
              yield bodyBuf;
            })(),
            ownerId: routing.ownerId ?? null,
            pin: routing.pinned
              ? { accountId: routing.pinned.accountId, mode: routing.hardPin ? 'hard' : 'soft' }
              : null,
            signal: reqAbort.signal,
          },
          policy: {
            maxBodyBytes: Number(process.env.PAPERCUSP_GATEWAY_MAX_BODY_BYTES) || 64 * 1024 * 1024,
            bodyReadTimeoutMs: requestCeilingMs,
            requestCeilingMs,
            // Always the SHORT deadline. Unlike the bearer and Claude lanes this one
            // does not need D-007's request-derived resolver: the ChatGPT backend
            // answers every request with a stream, so the live handler armed the
            // stream deadline unconditionally.
            ttfbTimeoutMs: upstreamStreamHeadersTimeoutMs,
            bodyIdleTimeoutMs: upstreamBodyIdleTimeoutMs,
            downstreamIdleTimeoutMs: downstreamIdleMs,
            maxAttempts: INTERNAL_RETRY_MAX_ATTEMPTS,
          },
          telemetry: requestStageTelemetry,
          span: stageSpan,
          // The outer recovery loop may intercept this pass before relay and re-enter
          // the kernel; do not publish that intermediate failure as the request's
          // terminal telemetry. A successful terminal pass still finalizes the span.
          deferSpanFinalization: stageSpan !== undefined,
          admission: {
            // P-011 / D-027: threaded down from `proxyOpenAi` via `executeCodexLegacyTransport`,
            // and PASS-THROUGH by design rather than by transition. `proxyOpenAi` takes the
            // `openai-responses` slot at its own entry, above the account resolution and the
            // transport dispatch that reach this handler, so re-admitting here would deadlock on
            // the slot this request already holds. It is also why the slot cannot move down to
            // this seam: this transport commits its response head BEFORE the kernel call below.
            run: (context, task) => kernelAdmission.run(context, task),
            observeAttempt: ({ context, response, error }) => {
              attemptsThisPass = context.attempt;
              attemptsSeen = attemptsUsed + context.attempt;
              const account = context.route.accountId ?? lastAccountId;
              // A same-account re-attempt (refreshed token, sibling IP) changes the
              // ROUTE KEY but is not a failover — `rotateCli` only counted account
              // changes, so count those.
              if (account !== lastAccountId) codexFailovers++;
              lastAccountId = account;
              if (error) {
                const requestRef = `${gatewayProcessInstanceId}:${stageSpan?.requestId ?? 'unobserved'}`;
                if (error.code === 'cancelled') {
                  log('info', `inference-gateway: codex OAuth downstream cancelled request=${requestRef} code=cancelled on '${account}': ${error.message}`);
                  return;
                }
                const authRefresh =
                  context.route.value.reason === 'refresh' ? kernelAdapter.noteRefreshFailure(context, error) : null;
                // The STATUS discriminates the token-resolve throw (503) from the
                // transport throw (502). Cancellation was separated above; genuine
                // deadlines retain their existing failure accounting.
                const tokenResolve = error.status === 503;
                codexUpstreamErrors++;
                recordOwnerOutcome(routing.ownerId, 'upstream_error', {
                  account,
                  detail: tokenResolve
                    ? 'oauth-token-resolve'
                    : authRefresh?.authClass
                      ? 'oauth-auth-refresh'
                      : 'oauth-transport',
                });
                if (authRefresh?.authClass) {
                  const disposition = authRefresh.parkedAccountId
                    ? 'quarantined for ' +
                      Math.round(CODEX_CLI_AUTH_QUARANTINE_MS / 1000) +
                      's' +
                      (authRefresh.nextAccountId ? ' and failing over to ' + authRefresh.nextAccountId : '')
                    : routing.hardPin
                      ? 'not quarantined because the request is hard-pinned'
                      : 'not quarantined because no account pool is available';
                  log(
                    'warn',
                    'inference-gateway: Codex OAuth account ' +
                      account +
                      ' rejected refresh credentials; ' +
                      disposition,
                  );
                }
                log(
                  'error',
                  `inference-gateway: codex OAuth ${tokenResolve ? 'token resolve' : 'upstream'} failed request=${requestRef} code=${error.code} on '${account}': ${error.message}`,
                );
                return;
              }
              if (!response) return;
              // WI-38582: feed the ChatGPT backend's x-codex-* rate-limit headers to
              // the SAME observer the Anthropic path uses. Every attempt counts — a
              // 429 carries the authoritative window too.
              deps.onResponse?.(response.metadata.headers, response.status, bodyModel, account);
              if (response.status === 429) {
                codexUpstream429++;
                recordRoutingUpstream429('codex', account);
                providerAdmission.recordThrottle('codex');
                recordOwnerOutcome(routing.ownerId, 'upstream_429', { account, status: 429 });
              } else if (response.status >= 200 && response.status < 300) {
                providerAdmission.recordSuccess('codex');
                lastEgressOkAt.set(account, Date.now());
                ipTransportFailStreak.delete(response.metadata.egressKey);
              }
            },
          },
          adapter: kernelAdapter,
          // The old handler never registered in `inFlightReg`, and D-003 forbids
          // folding a behaviour change into an extraction.
          inFlight: { register: () => ({ unregister: () => undefined }) },
          downstream: {
            start: ({ status, metadata }) => {
              const outHeaders: Record<string, string> = { [ROUTED_ACCOUNT_HEADER]: metadata.accountId };
              for (const [key, value] of Object.entries(metadata.headers)) {
                if (!STRIP_RESPONSE.has(key.toLowerCase())) outHeaders[key] = value;
              }
              if (metadata.pinYieldedFrom) {
                outHeaders[PIN_YIELDED_HEADER] = `${metadata.pinYieldedFrom}->${metadata.accountId}`;
                recordOwnerOutcome(routing.ownerId, 'pin_yield', {
                  account: metadata.accountId,
                  detail: outHeaders[PIN_YIELDED_HEADER],
                });
              }
              // WI-2038027 (codex 429 recovery P1): this head IS the gateway's final answer — the
              // kernel ladder (reserve-tier retry, sibling-IP, rotation) is exhausted. Forwarding
              // the raw upstream 429 stranded codex sessions: the backend's retry-after is absent
              // or hours long, the codex CLI's ~4 client retries burn in seconds ("exceeded retry
              // limit, last status: 429"), and nothing ever woke the session when capacity
              // returned. Shape it exactly as the Claude lane shapes its terminal 429s: (1) a
              // retry-after CAPPED at BEE_RETRY_AFTER_CAP_S so the client re-asks soon (by then
              // routing has walked to a healthy account, or the stall-waker resumes it later);
              // (2) the retries-exhausted marker so "slow" is distinguishable from "never";
              // (3) recordStall, which is what plugs codex sessions into the stall-waker's
              // confirm → un-wedge → capacity-gated wake recovery (stall-waker.ts).
              if (status === 429) {
                const parsed = parseCodexRateReset(metadata.headers);
                const now = Date.now();
                const ladderResetAt = parsed.resetAt ?? (parsed.transient ? now + bare429FailoverBackoffMs : 0);
                // The absorb is a bet the POOL recovers inside the budget — ask the pool when that is
                // (codex-auto-route-all-walled-fail-fast-2026-09-05 P-003): an all-walled pool whose
                // earliest reset is hours out fails fast here instead of sleeping the whole budget.
                const poolRecoveryAt = codexPoolRecoveryAt(
                  codexCliPool,
                  now,
                  { accountId: metadata.accountId, resetAt: ladderResetAt },
                  routing.hardPin,
                );
                const decision = decideThrottleRecovery({
                  status,
                  retryIntent: true,
                  lastExhaustResetAt: ladderResetAt,
                  poolRecoveryAt,
                  state: {
                    transientWaitedMs: recovery.transientWaitedMs,
                    retryDeadlineAt: recovery.retryDeadlineAt,
                    absorbDeadlineAt: recovery.absorbDeadlineAt,
                    headersSent: res.headersSent,
                  },
                  budgets: {
                    waitCapMs: ALL_THROTTLED_RECOVERY_WAIT_CAP_MS,
                    transientTotalWaitBudgetMs: TRANSIENT_TOTAL_WAIT_BUDGET_MS,
                    overloadBackoffMs: OVERLOAD_529_BACKOFF_MS,
                  },
                  now,
                });
                if (decision.action === 'wait') {
                  interception.taken = {
                    action: 'wait',
                    waitMs: decision.waitMs,
                    backoffMs: 0,
                    resetAt: parsed.resetAt,
                    poolRecoveryAt,
                    accountId: metadata.accountId,
                  };
                  throw INTERCEPT_OAUTH_THROTTLE;
                }
                if (decision.action === 'absorb') {
                  interception.taken = {
                    action: 'absorb',
                    waitMs: 0,
                    backoffMs: decision.backoffMs,
                    resetAt: parsed.resetAt,
                    poolRecoveryAt,
                    accountId: metadata.accountId,
                  };
                  throw INTERCEPT_OAUTH_THROTTLE;
                }
                if (routing.ownerId) {
                  recordStall(
                    routing.ownerId,
                    metadata.accountId,
                    codexStallSoonestAt(poolRecoveryAt, parsed.resetAt, now),
                  );
                }
                const shaped = shapeTerminalThrottle({
                  attempts: attemptsSeen,
                  retriesExhaustedHeader: RETRIES_EXHAUSTED_HEADER,
                  retryAfter: {
                    resetAt: parsed.resetAt,
                    fallbackSec: LOADSHED_RETRY_AFTER_SEC,
                    capS: BEE_RETRY_AFTER_CAP_S,
                  },
                });
                Object.assign(outHeaders, shaped.headers);
                const poolRecovery = describePoolRecovery(poolRecoveryAt, now);
                outHeaders[POOL_RECOVERY_AT_HEADER] = poolRecovery;
                log(
                  'warn',
                  `inference-gateway: codex upstream 429 not rescued after ${attemptsSeen} attempt(s) on '${metadata.accountId}' — forwarding terminal 429 (${parsed.transient ? 'transient burst' : 'window walled'}; retry-after ${shaped.retryAfterSec}s${routing.ownerId ? `; stall recorded for '${routing.ownerId}'` : ''}; pool recovery ${poolRecovery})`,
                );
              }
              recordRoute(routing.ownerId, metadata.accountId, 'codex');
              stageSpan?.setServingAccount(metadata.accountId);
              recordOwnerOutcome(
                routing.ownerId,
                status < 400 ? 'ok' : status === 429 ? 'upstream_429' : 'upstream_error',
                { account: metadata.accountId, status },
              );

              cacheProbe = new PassThrough();
              // Keep the tee flowing for the stream's whole life: the observer detaches
              // its own 'data' listener once it has the usage record.
              cacheProbe.on('data', () => undefined);
              cacheProbe.on('error', () => undefined);
              observeOpenAiCacheUsage(
                cacheProbe,
                metadata.accountId,
                attemptsSeen > 1 || metadata.pinYieldedFrom !== null,
                stageSpan,
              );

              // Do not expose the transport detail that a non-streaming request was
              // served by SSE: withhold the head and aggregate. Error statuses
              // (including a hard-pinned 429) stay byte-transparent.
              if (!wantStream && status >= 200 && status < 300) {
                if (acceptedOperation) {
                  acceptedRelay = acceptedCodexResponse(
                    acceptedOperation, metadata.headers['content-type'] ?? '', false,
                  );
                }
                pendingHead = { status, headers: { ...outHeaders, 'content-type': 'application/json' } };
                aggregateSource = new PassThrough();
                aggregateSource.on('error', () => undefined);
                // `res.setTimeout` measures DOWNSTREAM socket inactivity, while this
                // path withholds every downstream byte until aggregation completes.
                // Give aggregation its full budget plus one normal drain window.
                res.setTimeout(downstreamIdleMs > 0 ? codexOAuthNonStreamTimeoutMs + downstreamIdleMs : 0);
                aggregatePromise = aggregateCodexNonStreamResponse(aggregateSource, {
                  contentType: metadata.headers['content-type'] ?? null,
                  maxBytes: codexOAuthNonStreamMaxBytes,
                  timeoutMs: codexOAuthNonStreamTimeoutMs,
                  signal: reqAbort.signal,
                  onTimeout: () =>
                    abortRequest(`codex OAuth non-stream response timed out after ${codexOAuthNonStreamTimeoutMs}ms`),
                });
                // SINK the rejection at creation (P-004): `end()` awaits the ORIGINAL promise and owns
                // its error path, but a downstream abort / deadline that fires before the kernel ever
                // reaches end() left this promise rejected with no handler — an unhandledRejection in
                // the gateway process, not a response. The derived promise is discarded on purpose.
                aggregatePromise.catch(() => undefined);
                return;
              }
              if (acceptedOperation && status >= 200 && status < 300) {
                acceptedRelay = acceptedCodexResponse(
                  acceptedOperation, metadata.headers['content-type'] ?? '', true,
                );
                pendingAcceptedHead = { status, headers: outHeaders };
                res.setTimeout(0);
              } else {
                res.writeHead(status, outHeaders);
              }
            },
            write: async (chunk) => {
              cacheProbe?.write(chunk);
              acceptedRelay?.push(chunk);
              if (aggregateSource) {
                aggregateSource.write(chunk);
                return;
              }
              if (acceptedRelay) return;
              // Honour downstream backpressure exactly as the old `nodeStream.pipe(res)` did.
              if (!res.write(chunk)) {
                await new Promise<void>((resolve) => {
                  const settle = () => {
                    res.off('drain', settle);
                    res.off('close', settle);
                    res.off('error', settle);
                    resolve();
                  };
                  res.once('drain', settle);
                  res.once('close', settle);
                  res.once('error', settle);
                });
              }
            },
            end: async () => {
              endCacheProbe();
              if (acceptedRelay && pendingAcceptedHead) {
                const chunks = await acceptedRelay.finish();
                res.setTimeout(downstreamIdleMs);
                res.writeHead(pendingAcceptedHead.status, pendingAcceptedHead.headers);
                await flushAcceptedCodexChunks(res, chunks);
                res.end();
                return;
              }
              if (!aggregateSource || !aggregatePromise || !pendingHead) {
                res.end();
                return;
              }
              const source = aggregateSource;
              const pending = aggregatePromise;
              const head = pendingHead;
              aggregateSource = null;
              source.end();
              let aggregated: Buffer;
              try {
                aggregated = await pending;
              } catch (e) {
                res.setTimeout(downstreamIdleMs);
                const aggregateError =
                  e instanceof CodexNonStreamAggregateError
                    ? e
                    : new CodexNonStreamAggregateError(
                        'invalid',
                        `codex OAuth non-stream response aggregation failed: ${(e as Error).message}`,
                      );
                // `onTimeout` aborts the request so the socket is torn down. That abort
                // is an aggregation timeout, not a downstream cancellation, so only the
                // helper's explicit aborted code suppresses a gateway response.
                if (aggregateError.code === 'aborted') {
                  if (!res.destroyed && !res.writableEnded) res.destroy();
                  return;
                }
                codexUpstreamErrors++;
                recordOwnerOutcome(routing.ownerId, 'upstream_error', {
                  account: lastAccountId,
                  detail: `oauth-nonstream-${aggregateError.code}`,
                });
                log(
                  'error',
                  `inference-gateway: codex OAuth non-stream aggregation failed on '${lastAccountId}': ${aggregateError.message}`,
                );
                if (!res.headersSent) {
                  sendJson(
                    res,
                    aggregateError.code === 'timeout' ? 504 : 502,
                    {
                      type: 'error',
                      error: {
                        type: aggregateError.code === 'timeout' ? 'timeout_error' : 'api_error',
                        message: `inference-gateway: codex OAuth non-stream response ${aggregateError.message}`,
                      },
                      gateway: true,
                    },
                    { [ROUTED_ACCOUNT_HEADER]: lastAccountId },
                  );
                }
                return;
              }
              res.setTimeout(downstreamIdleMs);
              if (reqAbort.signal.aborted) {
                if (!res.destroyed && !res.writableEnded) res.destroy();
                return;
              }
              if (acceptedRelay) await acceptedRelay.finish();
              res.writeHead(head.status, head.headers);
              res.end(aggregated);
            },
          },
        });
      } catch (error) {
        const taken = takeOAuthIntercept();
        // As on the Claude and bearer lanes, the flag survives kernel error
        // normalization while thrown-error identity deliberately does not.
        if (taken) {
          attemptsUsed += attemptsThisPass;
          continuationActive = true;
          if (taken.action === 'wait') {
            recovery.transientWaitedMs += taken.waitMs;
            log(
              'warn',
              `inference-gateway: Codex OAuth pool transiently throttled → wait ${taken.waitMs}ms + retry (wait-budget ${recovery.transientWaitedMs}/${TRANSIENT_TOTAL_WAIT_BUDGET_MS}ms)`,
            );
            await waitForCodexRecovery(res, taken.waitMs, reqAbort.signal);
            return runOAuthRecovery();
          }
          if (!kernelAdmission.park) {
            throw new Error('inference-gateway: codex OAuth absorb requires cooperative lane admission');
          }
          const now = Date.now();
          const remainingMs = Math.max(0, recovery.absorbDeadlineAt - now);
          // Sleep toward the POOL's horizon, not the failed account's reset: a sibling whose park expires
          // in 40s is the capacity this re-pick will find, while the failed account's 3h reset is not
          // (codex-auto-route-all-walled-fail-fast-2026-09-05 P-003). A horizon of 0 (a sibling serves now)
          // takes the short failover backoff so the re-pick lands promptly.
          const capacityWaitMs =
            Number.isFinite(taken.poolRecoveryAt) && taken.poolRecoveryAt > now
              ? taken.poolRecoveryAt - now
              : Math.max(1, taken.backoffMs || bare429FailoverBackoffMs);
          const waitMs = Math.min(remainingMs, capacityWaitMs);
          recovery.transientWaitedMs = 0;
          log(
            'warn',
            `inference-gateway: Codex OAuth absorb on '${taken.accountId}' → release provider slot, wait ${waitMs}ms (pool recovery ${describePoolRecovery(taken.poolRecoveryAt, now)}), then re-enter (${remainingMs}ms budget left)`,
          );
          return kernelAdmission.park(async () => {
            await waitForCodexRecovery(res, waitMs, reqAbort.signal);
            recovery.retryDeadlineAt = Date.now() + internalRetryDeadlineMs;
          }, runOAuthRecovery);
        }
        endCacheProbe();
        const failure =
          error instanceof GatewayRequestKernelError
            ? error
            : new GatewayRequestKernelError(error instanceof Error ? error.message : String(error), {
                code: 'gateway-error',
                outcome: 'gateway-error',
                status: 500,
                cause: error,
              });

        if (failure.code === 'request-ceiling') {
          log(
            'error',
            `inference-gateway: codex OAuth request hit the ${requestCeilingMs}ms hard ceiling on '${lastAccountId}' — force-terminating`,
          );
          try {
            req.destroy();
          } catch {
            /* already torn down */
          }
          try {
            res.destroy();
          } catch {
            /* already torn down */
          }
          return;
        }

        if (failure.code === 'body-read-timeout' || failure.code === 'body-too-large') {
          try {
            req.destroy();
          } catch {
            /* already torn down */
          }
          if (!reqAbort.signal.aborted && !res.headersSent) {
            sendJson(res, 503, {
              type: 'error',
              error: {
                type: 'overloaded_error',
                message: 'inference-gateway: codex request body read stalled; retry shortly',
              },
              gateway: true,
            });
          }
          return;
        }

        if (res.headersSent) {
          res.destroy();
          return;
        }

        if (failure.code === 'upstream-error' && failure.status === 503) {
          // OAuth resolution never produced a usable token on any account.
          sendJson(
            res,
            503,
            { type: 'error', error: { type: 'overloaded_error', message: failure.message }, gateway: true },
            { 'retry-after': '5', [ROUTED_ACCOUNT_HEADER]: lastAccountId },
          );
          return;
        }
        if (failure.code === 'invalid-route' || failure.code === 'invalid-pin') {
          sendJson(
            res,
            failure.status ?? 503,
            { type: 'error', error: { type: 'api_error', message: failure.message }, gateway: true },
            { [ROUTED_ACCOUNT_HEADER]: lastAccountId, ...(failure.status === 403 ? { 'x-should-retry': 'false' } : {}) },
          );
          return;
        }
        sendJson(
          res,
          502,
          {
            type: 'error',
            error: {
              type: 'api_error',
              message: failure.message.startsWith('inference-gateway:')
                ? failure.message
                : `inference-gateway: codex OAuth upstream failed: ${failure.message}`,
            },
            gateway: true,
          },
          { [ROUTED_ACCOUNT_HEADER]: lastAccountId },
        );
      } finally {
        if (!continuationActive) {
          endCacheProbe();
          req.off('aborted', onReqAborted);
          res.off('close', onResClose);
        }
      }
    };
    await runOAuthRecovery();
  }

  /**
   * P-011 / D-027: the ADMITTED body of the `openai-responses` lane — see `proxyAdmitted`
   * for the rule. Its caller (`proxyOpenAi`) owns the lane's admission slot, so everything
   * this function does runs INSIDE it: account resolution, transport selection, and the
   * ChatGPT-subscription transports it dispatches through `executeCodexLegacyTransport`.
   *
   * That placement is load-bearing for `serveCodexCliBridge`, which commits the 200 + SSE
   * head BEFORE its kernel call (see the inversion it documents). Admitting at the kernel
   * seam there would decide to shed a request whose response head was already on the wire.
   */
  async function proxyOpenAiAdmitted(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    kernelAdmission: GatewayLaneAdmission,
  ) {
    const stageSpan = requestSpan(req);
    // Read and validate the request model before choosing an account or touching
    // an upstream. The durable admission layer has already buffered this body
    // for us (`readBody` replays its pre-read buffer), so this is a bounded
    // policy gate rather than a second socket read. It also makes an omitted
    // model explicit on the body sent to either bearer or ChatGPT transports.
    let preBody: Buffer | undefined;
    let requestModel: string | null = null;
    let requestEffort: string | null = null;
    const outputLimitHeader = req.headers[REQUIRE_OUTPUT_TOKEN_LIMIT_HEADER];
    const requiresOutputTokenLimit = outputLimitHeader !== undefined;
    const invalidOutputLimit = () => {
      req.resume();
      sendJson(res, 400, { type: 'error', gateway: true,
        error: { type: 'invalid_request_error', code: 'output_token_limit_invalid',
          message: 'Required output limit needs the header true and a positive integer max_output_tokens' } },
        { 'x-should-retry': 'false' });
    };
    if (requiresOutputTokenLimit && outputLimitHeader !== 'true') {
      invalidOutputLimit();
      return;
    }
    if (req.method === 'POST' && url.startsWith('/v1/responses')) {
      stageSpan?.beginStage('bodyRead');
      try {
        preBody = await withPromiseDeadline(readBody(req), requestCeilingMs, 'codex model-policy body read');
      } catch {
        req.resume();
        if (!res.headersSent) {
          sendJson(res, 503, {
            type: 'error',
            error: {
              type: 'overloaded_error',
              message: 'inference-gateway: Codex request body read stalled; retry shortly',
            },
            gateway: true,
          });
        }
        return;
      } finally {
        stageSpan?.endStage('bodyRead');
      }
      try {
        const parsed = JSON.parse(preBody.toString('utf8')) as Record<string, unknown>;
        // Same parsed request for bearer, OAuth and CLI routes, before model
        // policy/account selection; diagnostic ids are never routing inputs.
        stageSpan?.setNativeCorrelation(parsed);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
          throw new Error('request body must be a JSON object');
        if (requiresOutputTokenLimit && (!Number.isSafeInteger(parsed.max_output_tokens) ||
            (parsed.max_output_tokens as number) <= 0)) {
          invalidOutputLimit();
          return;
        }
        const modelSpec = typeof parsed.model === 'string' ? parsed.model : undefined;
        // Reuse the bridge parser as the one request-boundary policy seam. It
        // resolves omitted models, normalizes aliases/effort, and throws on the
        // retired Spark id before account selection or an upstream call.
        const parsedModel = parseBridgeModel(modelSpec);
        parsed.model = parsedModel.id;
        if (modelSpec == null || parsedModel.id !== modelSpec) {
          const reasoning =
            parsed.reasoning && typeof parsed.reasoning === 'object' && !Array.isArray(parsed.reasoning)
              ? (parsed.reasoning as Record<string, unknown>)
              : {};
          const existingEffort = typeof reasoning.effort === 'string' ? reasoning.effort.trim() : '';
          const existingEffortValid = /^(minimal|low|medium|high|xhigh|max)$/i.test(existingEffort);
          const modelCarriesEffort =
            typeof modelSpec === 'string' && /:(minimal|low|medium|high|xhigh|max)$/i.test(modelSpec.trim());
          parsed.reasoning = {
            ...reasoning,
            effort: modelCarriesEffort || !existingEffortValid ? parsedModel.effort : existingEffort.toLowerCase(),
          };
        }
        preBody = Buffer.from(JSON.stringify(parsed), 'utf8');
        requestModel = parsedModel.id;
        const forwardedReasoning = parsed.reasoning;
        requestEffort = forwardedReasoning && typeof forwardedReasoning === 'object' &&
          !Array.isArray(forwardedReasoning) && typeof (forwardedReasoning as Record<string, unknown>).effort === 'string'
          ? ((forwardedReasoning as Record<string, string>).effort).trim().toLowerCase() : null;
        stageSpan?.setModel(parsedModel.id);
        stageSpan?.setStreaming(parsed.stream === true);
      } catch (error) {
        req.resume();
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: `inference-gateway: ${message}` },
          gateway: true,
        });
        return;
      }
    }
    const adapter = providerAdapters.codex;
    const wantOwner = (req.headers[OWNER_HEADER] as string | undefined)?.trim() || undefined;
    let acceptedOperation: AcceptedCodexRequest | undefined;
    if (preBody && wantOwner && deps.readAcceptedOperationModelPolicy) {
      let operationModelPolicy: ActiveOperationModelPolicyRead;
      try {
        operationModelPolicy = await deps.readAcceptedOperationModelPolicy(wantOwner, 'codex');
      } catch {
        operationModelPolicy = { status: 'unavailable', reason: 'model policy lookup failed' };
      }
      if (operationModelPolicy.status === 'unavailable') {
        sendJson(res, 503, { type: 'error',
          error: { type: 'api_error',
            message: `accepted operation model policy unavailable: ${operationModelPolicy.reason}` },
          gateway: true }, { 'x-should-retry': 'false' });
        return;
      }
      if (operationModelPolicy.status === 'bound') {
        if (!requestModel || !acceptedCodexModelAllows(operationModelPolicy.policy, requestModel, requestEffort)) {
          sendJson(res, 403, { type: 'error',
            error: { type: 'permission_error', message: 'requested model or effort is outside the accepted Codex operation policy' },
            gateway: true }, { 'x-should-retry': 'false' });
          return;
        }
        if (!operationModelPolicy.attestation || !deps.recordAcceptedOperationModelAttestation) {
          sendJson(res, 503, { type: 'error',
            error: { type: 'api_error', message: 'accepted Codex operation attestation sink is unavailable' },
            gateway: true }, { 'x-should-retry': 'false' });
          return;
        }
        acceptedOperation = { policy: operationModelPolicy.policy, context: operationModelPolicy.attestation,
          requestedModel: requestModel, forwardedEffort: requestEffort, requestId: randomUUID() };
      }
    }
    const sendUnavailableCodexRoute = (message: string) => {
      const wait = acceptedOperation?.policy.onUnavailable === 'wait';
      sendJson(res, wait ? 429 : 503, {
        type: 'error',
        error: { type: wait ? 'rate_limit_error' : 'api_error', message },
        gateway: true,
      }, wait ? { 'retry-after': '30' } : acceptedOperation ? { 'x-should-retry': 'false' } : {});
    };
    const wantAccountHeader = (req.headers[ACCOUNT_HEADER] as string | undefined)?.trim();
    const dynPin = wantOwner ? ownerPinMap.get(wantOwner) : undefined;
    const wantAccount = dynPin
      ? dynPin.accountId.trim().toLowerCase() === OWNER_AUTO_ACCOUNT_ROUTE
        ? undefined
        : dynPin.accountId
      : wantAccountHeader;
    const requestedHardPin =
      wantAccount !== undefined &&
      (dynPin ? dynPin.hard : (req.headers[ACCOUNT_PIN_HEADER] as string | undefined)?.trim().toLowerCase() === 'hard');
    // AUTO-ROUTE SESSION AFFINITY (WI-2140943) — codex CLI/OAuth-pool parity: an unpinned request from an
    // identifiable caller prefers the ChatGPT-subscription account that last served it (OpenAI's prompt
    // cache is per-org too), when the CLI pool still considers it selectable. SOFT: the bridge's yield-to-
    // next-account and the OAuth kernel's rotate-don't-surface failover both still move off it on a
    // failure. `tally` is true on the primary (no-bearer-pool) path only — the bearer→CLI fallback path has
    // already counted this request in the bearer block.
    const codexCliAffinityId = (tally: boolean): string | null => {
      if (!wantOwner || !AUTO_AFFINITY_ENABLED) {
        if (tally) autoAffinityTally.nokey++;
        return null;
      }
      const priorAccount = affinityPriorAccount(wantOwner, dynPin, wantAccount);
      const usable = priorAccount && codexCliPool?.select?.(priorAccount) ? priorAccount : null;
      if (tally) autoAffinityTally[usable ? 'hits' : 'cold']++;
      return usable;
    };
    // ChatGPT-subscription bridge resolution (codex-cli-bridge.ts): an explicit pin to a
    // CLI account wins; otherwise the CLI list is the FALLBACK when there is no bearer
    // pool at all, or the bearer pool momentarily resolves no available account. Bearer
    // accounts keep priority when both exist (cheaper per call, streams supported).
    const cliList = codexCliAccounts();
    const pinnedCli = wantAccount ? (cliList.find((a) => a.accountId === wantAccount) ?? null) : null;
    let cli: CodexCliAccount | null = null;
    let cliPin: CodexCliAccount | null = null;
    let cliPinIsAffinity = false;
    let cliInitialPinYieldedFrom: string | null = null;
    const applyCliPin = (pin: CodexCliAccount, hardPin: boolean, affinityPin: boolean): void => {
      cliPin = pin;
      cliPinIsAffinity = affinityPin;
      const poolPin = codexCliPool?.select?.(pin.accountId) ?? null;
      if (!poolPin) {
        cli = pin;
        return;
      }
      const resolved = resolveCodexSoftPin(codexCliPool, poolPin, hardPin, requestModel);
      const selected = cliList.find((account) => account.accountId === resolved.selected.accountId);
      cli = selected ?? pin;
      cliInitialPinYieldedFrom = selected ? resolved.yieldedFrom : null;
      if (cliInitialPinYieldedFrom && affinityPin) autoAffinityTally.yields++;
    };
    if (pinnedCli) applyCliPin(pinnedCli, requestedHardPin, false);
    let pinnedBearer: ActiveAccount | null = null;
    let bearerPinIsAffinity = false;
    let bearerInitialPinYieldedFrom: string | null = null;
    // Definite-assignment assertion: every path below either assigns `active`, serves via
    // the CLI bridge and returns, or 503s and returns.
    let active!: ActiveAccount;
    if (!cli) {
      if (!adapter.pool || !adapter.upstreamBase) {
        const affinityId = codexCliAffinityId(true);
        const affinityCli = affinityId ? (cliList.find((account) => account.accountId === affinityId) ?? null) : null;
        if (affinityCli) applyCliPin(affinityCli, false, true);
        if (!cli) {
          let selectedId: string | undefined;
          try {
            selectedId = codexCliPool ? healthAwareCodexPool(codexCliPool, requestModel).active().accountId : undefined;
          } catch {
            /* unavailable pool; fall back to list */
          }
          cli = (selectedId ? cliList.find((a) => a.accountId === selectedId) : undefined) ?? cliList[0] ?? null;
        }
        if (!cli) {
          req.resume();
          sendUnavailableCodexRoute(adapter.unavailableMessage ?? 'inference-gateway: Codex provider unavailable');
          return;
        }
      } else {
        try {
          const explicitPinnedBearer = (wantAccount && adapter.pool.select?.(wantAccount)) || null;
          pinnedBearer = explicitPinnedBearer;
          // AUTO-ROUTE SESSION AFFINITY (WI-2140943) — codex parity: an unpinned request from an
          // identifiable caller prefers the bearer account that last served it (OpenAI's prompt cache is
          // per-org too). Soft: the kernel's rotate-don't-surface failover still moves off it on a 429.
          if (!pinnedBearer && wantOwner && AUTO_AFFINITY_ENABLED) {
            const priorAccount = affinityPriorAccount(wantOwner, dynPin, wantAccount);
            if (priorAccount) pinnedBearer = adapter.pool.select?.(priorAccount) ?? null;
            bearerPinIsAffinity = pinnedBearer !== null;
            autoAffinityTally[pinnedBearer ? 'hits' : 'cold']++;
          } else if (!pinnedBearer) {
            autoAffinityTally.nokey++;
          }
          if (pinnedBearer) {
            const resolved = resolveCodexSoftPin(
              adapter.pool,
              pinnedBearer,
              explicitPinnedBearer !== null && requestedHardPin,
            );
            active = resolved.selected;
            bearerInitialPinYieldedFrom = resolved.yieldedFrom;
            if (bearerInitialPinYieldedFrom && bearerPinIsAffinity) autoAffinityTally.yields++;
          } else {
            active = healthAwareCodexPool(adapter.pool).active();
          }
        } catch (e) {
          const affinityId = codexCliAffinityId(false);
          const affinityCli = affinityId ? (cliList.find((account) => account.accountId === affinityId) ?? null) : null;
          if (affinityCli) applyCliPin(affinityCli, false, true);
          if (!cli) {
            let selectedId: string | undefined;
            try {
              selectedId = codexCliPool ? healthAwareCodexPool(codexCliPool, requestModel).active().accountId : undefined;
            } catch {
              /* unavailable pool; fall back to list */
            }
            cli = (selectedId ? cliList.find((a) => a.accountId === selectedId) : undefined) ?? cliList[0] ?? null;
          }
          if (!cli) {
            req.resume();
            sendUnavailableCodexRoute(
              (e as Error).message || adapter.unavailableMessage || 'inference-gateway: Codex provider unavailable',
            );
            return;
          }
        }
      }
    }
    if (req.method === 'GET' && url.startsWith('/v1/models')) {
      req.resume();
      totalRequests++;
      codexRequests++;
      const routedAccount = cli ? cli.accountId : active.accountId;
      const pinYieldedFrom = cli ? cliInitialPinYieldedFrom : bearerInitialPinYieldedFrom;
      const liveCatalog = cli ? await liveCodexModelsCatalog(cli, url) : null;
      sendJson(res, 200, codexModelsResponse(cli?.home, liveCatalog), {
        [ROUTED_ACCOUNT_HEADER]: routedAccount,
        ...(pinYieldedFrom ? { [PIN_YIELDED_HEADER]: `${pinYieldedFrom}->${routedAccount}` } : {}),
      });
      return;
    }
    if (cli) {
      const hardPin = pinnedCli !== null && requestedHardPin;
      const mode: GatewayRoutingSelectionMode = hardPin
        ? 'hard-pin'
        : cliPin
          ? cliPinIsAffinity
            ? 'affinity'
            : 'soft-pin'
          : 'automatic';
      recordRoutingPick({
        provider: 'codex',
        ownerId: wantOwner,
        source: codexCliPool,
        selected:
          codexCliPool?.select?.(cli.accountId) ??
          ({ accountId: cli.accountId, token: async () => '' } satisfies ActiveAccount),
        mode,
        reason: cliInitialPinYieldedFrom
          ? 'pin-yield'
          : mode === 'automatic'
            ? codexCliPool
              ? 'health-ranked'
              : 'fallback-list-order'
            : mode === 'affinity'
              ? 'affinity-kept'
              : 'pin-kept',
        requestedAccount: (cliPin as CodexCliAccount | null)?.accountId ?? null,
        yieldedFrom: cliInitialPinYieldedFrom,
      });
      const transport = codexOAuthProxyEnabled ? 'oauth-http' : 'cli-exec';
      // Subscription normalization removes max_output_tokens; cli-exec cannot
      // enforce it either. Refuse before auth, normalization, or execution.
      if (requiresOutputTokenLimit &&
          adapter.lane.transports.find(t => t.id === transport)?.enforcesOutputTokenLimit !== true) {
        sendJson(res, 422, { type: 'error', gateway: true,
          error: { type: 'invalid_request_error', code: 'output_token_limit_unsupported',
            message: `Selected Codex transport '${transport}' cannot enforce the required output token limit` } },
          { 'x-should-retry': 'false' });
        return;
      }
      await executeCodexLegacyTransport(
        legacyExecutorForGatewayTransport(adapter.lane, transport),
        { req, res, cli, url, preBody, routing: { hardPin, pinned: cliPin, ownerId: wantOwner }, acceptedOperation },
        kernelAdmission,
      );
      return;
    }
    const hardPin = pinnedBearer !== null && !bearerPinIsAffinity && requestedHardPin;
    const bearerMode: GatewayRoutingSelectionMode = hardPin
      ? 'hard-pin'
      : pinnedBearer
        ? bearerPinIsAffinity
          ? 'affinity'
          : 'soft-pin'
        : 'automatic';
    recordRoutingPick({
      provider: 'codex',
      ownerId: wantOwner,
      source: adapter.pool ?? undefined,
      selected: active,
      mode: bearerMode,
      reason: bearerInitialPinYieldedFrom
        ? 'pin-yield'
        : bearerMode === 'automatic'
          ? 'health-ranked'
          : bearerMode === 'affinity'
            ? 'affinity-kept'
            : 'pin-kept',
      requestedAccount: pinnedBearer?.accountId ?? null,
      yieldedFrom: bearerInitialPinYieldedFrom,
    });
    stageSpan?.setTransport('bearer-http');

    /*
     * KERNEL ADOPTION — plan `gateway-kernel-adoption-2026-08-29`, P-003.
     *
     * Everything below this point used to be a hand-rolled ladder: a bounded body
     * read, a single re-armed stall timer (headers TTFB → per-chunk body idle), a
     * request ceiling, an attempt loop, and a rotate-don't-surface failover
     * cascade. All five are SHARED request invariants, not Codex protocol, so they
     * now live in `executeGatewayRequestKernel` and the bearer-specific half
     * (account selection, token read, header construction, the upstream call,
     * retryability normalization) lives in `createCodexBearerKernelAdapter`.
     *
     * What stays HERE is the part that is genuinely this gateway's: the legacy
     * counters, the owner-outcome ledger, the routed/pin-yield response headers,
     * and the Responses-API cache-usage probe. The kernel guarantees exactly ONE
     * `observeAttempt` callback per attempt, which is what those counters hang off.
     *
     * The characterization goldens in `gateway-openai-proxy.test.ts` (P-001) pin
     * the observable behaviour across this switch and must pass UNCHANGED.
     */

    // Stable request abort for the Codex proxy. Scout times out its in-process
    // `/v1/responses` call at the caller, but the gateway must also stop the
    // upstream OpenAI request or the protected Codex admission slot stays occupied
    // until the long non-streaming headers timeout. Installed BEFORE the body read
    // so a downstream disconnect cannot race the kernel's own abort wiring; the
    // kernel forwards this signal to every attempt and to the body pump.
    const reqAbort = new AbortController();
    const abortRequest = (reason: string) => {
      if (!reqAbort.signal.aborted) reqAbort.abort(new Error(reason));
    };
    const onReqAborted = () => abortRequest('openai downstream request aborted');
    const onResClose = () => abortRequest('openai downstream response closed');
    req.once('aborted', onReqAborted);
    res.once('close', onResClose);

    // Per-attempt bookkeeping the kernel deliberately does NOT own. `attemptsSeen`
    // and `lastRouteKey` reconstruct what the old loop knew from its own counter:
    // whether this request ever failed over (for the cache probe and `codexFailovers`).
    let attemptsSeen = 0;
    let lastRouteKey: string | null = null;
    let lastAccountId = active.accountId;
    // Responses-API cache-usage probe. The old path handed `observeOpenAiCacheUsage`
    // the same Node stream it piped downstream; the kernel hands chunks to
    // `downstream.write`, so they are tee'd into this PassThrough instead.
    let cacheProbe: PassThrough | null = null;
    let acceptedRelay: ReturnType<typeof acceptedCodexResponse> | null = null;
    let pendingAcceptedHead: { status: number; headers: Record<string, string> } | null = null;
    const endCacheProbe = () => {
      if (!cacheProbe) return;
      cacheProbe.end();
      cacheProbe = null;
    };

    /**
     * A WHATWG response body as the adapter's transport-neutral view of it. The
     * `cancel` seam is what the kernel calls to release a body it will not forward
     * (the 429 rotate path), replacing the old `await up.body?.cancel()`.
     */
    const toKernelResponseBody = (web: Response['body']): CodexBearerFetchResponse['body'] => {
      if (!web) return null;
      const node = Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]);
      // See the OAuth twin: the outer ladder intercepts before relay by
      // throwing from downstream.start, which also surfaces as a Node stream
      // error event while the kernel receives the iterator rejection.
      node.on('error', () => undefined);
      const iterable = node as unknown as AsyncIterable<Uint8Array> & { cancel?(): Promise<void> | void };
      iterable.cancel = () => {
        node.destroy();
      };
      return iterable;
    };

    // `AccountPool.active()` ADVANCES the round-robin — that is why the contract
    // also carries a non-advancing `peek()`. The bearer-vs-CLI resolution above has
    // already spent this request's one `active()` call to decide it could serve at
    // all, so letting the adapter's `selectInitial` call it again would advance the
    // pool TWICE per request and start every unpinned request on the SECOND account.
    // Replay that account for the initial selection and delegate everything after it.
    const bearerPool = adapter.pool!;
    const healthAwareBearerPool = healthAwareCodexPool(bearerPool);
    let initialSelectionServed = false;
    const kernelPool: AccountPool = {
      active: () => {
        if (initialSelectionServed) return healthAwareBearerPool.active();
        initialSelectionServed = true;
        return active;
      },
      onExhausted: (exhaustedId, resetAt) => healthAwareBearerPool.onExhausted(exhaustedId, resetAt),
      select: (accountId) => healthAwareBearerPool.select?.(accountId) ?? null,
    };

    const kernelAdapter = createCodexBearerKernelAdapter({
      // By here the `if (cli) { …; return }` above has served every CLI-bridge case,
      // and the no-pool case 503'd, so both of these are resolved.
      pool: kernelPool,
      upstreamBase: adapter.upstreamBase!,
      urlPath: url,
      method: req.method ?? 'POST',
      requestHeaders: req.headers,
      stripRequestHeaders: STRIP_REQUEST,
      tokenTimeoutMs,
      failoverBackoffMs: bare429FailoverBackoffMs,
      dispatcherFor: (account) => dispatcherFor(account),
      // The SAME dialect parser the outer ladder consults (parseCodexRateReset reads retry-after
      // durations + the OpenAI x-ratelimit-reset-* meters); the Anthropic-dialect parseRateReset
      // read neither, so every bearer 429 with a sub-second retry-after parked the account for the
      // 15s failover backoff while the outer ladder saw the real 80ms reset — an over-park the pool
      // horizon (P-003) now surfaces as a false "pool cannot recover in budget" forward.
      rateResetAt: (headers) => parseCodexRateReset(headers).resetAt ?? null,
      // Prompt-cache policy (P-005/P-008), model-generation-aware: legacy models take
      // prompt_cache_retention:'24h' (writes free there), gpt-5.6+ takes prompt_cache_options.ttl
      // (writes cost 1.25×). The sharded prompt_cache_key steers same-variant sessions onto one
      // cache shard while respecting OpenAI's ~15 req/min-per-key ceiling. Keyed by the pinned
      // account id, which is this session's stable routing identity — but the owner header wins
      // when present (a bee is pinned for its whole life). The adapter memoizes this to exactly
      // one call per request, so the counters cannot double-count across a failover.
      shapeRequestBody: (body, context) => {
        if (!cachePolicyEnabled || !body.length) { stageSpan?.setCacheShape(body); return body; }
        const shardSeed = wantOwner || context.accountId;
        const cached = rewriteOpenAiCacheBody(body, {
          cacheKey: shardedCacheKey('psu', shardSeed, codexCacheShards()),
        });
        if (cached.stats) {
          recordCachePolicy('codex', cached.stats);
          stageSpan?.setCacheRouting('rewritten');
        }
        stageSpan?.setCacheShape(cached.body);
        return cached.body;
      },
      // Fires ONCE, on the first attempt, immediately after the body is shaped and
      // before the first token read — the exact point the old code counted the
      // request at, so a body read that never completes still counts nothing.
      onRequestShape: ({ model, streaming }) => {
        stageSpan?.setModel(model);
        stageSpan?.setStreaming(streaming);
        totalRequests++;
        codexRequests++;
        recordOwnerOutcome(wantOwner, 'request');
        res.setTimeout(downstreamIdleMs, () => res.destroy());
      },
      fetch: async (target, init) => {
        const fetchInit: FetchInit = { method: init.method, headers: init.headers, signal: init.signal };
        // The adapter types its buffered body as `Uint8Array<ArrayBufferLike>`, which
        // is wider than `BodyInit` (that excludes a SharedArrayBuffer backing store).
        // Every producer here is a plain `new Uint8Array(Buffer)`, so this is a cast
        // rather than the per-attempt re-copy the widening would otherwise force.
        if (init.body) fetchInit.body = init.body as unknown as BodyInit;
        if (init.dispatcher) fetchInit.dispatcher = init.dispatcher as UndiciDispatcher;
        const check = await authorizeCarryTrialAttempt(req, 'bearer-http', init.diagnosticAccountId, target, init);
        if (carryTrial) fetchInit.redirect = 'error';
        const send = () => { check(); return doFetch(target, fetchInit as RequestInit); };
        const upstream = stageSpan
          ? await stageSpan.observeUpstreamFetch(target, init.method, init.diagnosticAccountId, send)
          : await send();
        return { status: upstream.status, headers: upstream.headers, body: toKernelResponseBody(upstream.body) };
      },
    });

    type BearerThrottleIntercept = {
      action: 'wait' | 'absorb';
      waitMs: number;
      backoffMs: number;
      resetAt: number | null;
      /** The POOL horizon at decision time — the absorb sleeps toward THIS, not the failed account's reset. */
      poolRecoveryAt: number;
      accountId: string;
    };
    const recovery = {
      transientWaitedMs: 0,
      retryDeadlineAt: Date.now() + internalRetryDeadlineMs,
      absorbDeadlineAt: absorbDeadlineForRequest(req, codexTierMap),
    };
    const INTERCEPT_BEARER_THROTTLE = new Error('codex bearer: outer recovery intercepted before relay');
    const interception: { taken: BearerThrottleIntercept | null } = { taken: null };
    const takeBearerIntercept = (): BearerThrottleIntercept | null => {
      const taken = interception.taken;
      interception.taken = null;
      return taken;
    };
    let attemptsUsed = 0;
    let attemptsThisPass = 0;
    const runBearerRecovery = async (): Promise<void> => {
      let continuationActive = false;
      interception.taken = null;
      attemptsThisPass = 0;
      // Absorb re-entry: honour the freshest availability reading before the re-pick (P-008).
      if (attemptsUsed > 0) reconcileParksWithStore();
      try {
        await executeGatewayRequestKernel({
          request: {
            lane: adapter.lane,
            // MUST go through readBody: it serves the admission spool's pre-read
            // buffer (`preReadRequestBodies`). Iterating `req` directly here would
            // send an EMPTY body on every request the spool already drained.
            body: (async function* () {
              yield preBody ?? (await readBody(req));
            })(),
            ownerId: wantOwner ?? null,
            // A pin that already yielded at the request-selection seam must not be re-selected by
            // the bearer adapter's strict `select()`. Its original identity remains in
            // `bearerInitialPinYieldedFrom` for the response/telemetry below; subsequent attempts
            // are intentionally unpinned because this request already chose liveness.
            pin:
              pinnedBearer && !bearerInitialPinYieldedFrom
                ? { accountId: pinnedBearer.accountId, mode: hardPin ? 'hard' : 'soft' }
                : null,
            signal: reqAbort.signal,
          },
          policy: {
            // D-009: kernel adoption necessarily adds a request-body byte cap the
            // hand-rolled path never had. Sized well above the admission spool's own
            // 32MB cap so it is non-binding wherever the spool is enabled.
            maxBodyBytes: Number(process.env.PAPERCUSP_GATEWAY_MAX_BODY_BYTES) || 64 * 1024 * 1024,
            bodyReadTimeoutMs: requestCeilingMs,
            requestCeilingMs,
            // D-007: a stream:true request gets the SHORT TTFB headers deadline, a
            // non-streaming one keeps the generous deadline. Derived from the REQUEST
            // body by the SAME parser the adapter uses — two hand-written parsers here
            // is precisely the drift D-007 was raised to correct.
            ttfbTimeoutMs: ({ body }) =>
              parseCodexRequestShape(body).streaming ? upstreamStreamHeadersTimeoutMs : upstreamHeadersTimeoutMs,
            bodyIdleTimeoutMs: upstreamBodyIdleTimeoutMs,
            downstreamIdleTimeoutMs: downstreamIdleMs,
            maxAttempts: INTERNAL_RETRY_MAX_ATTEMPTS,
          },
          telemetry: requestStageTelemetry,
          // D-008: adopt the span this HTTP request already opened. Without it the
          // kernel would begin a SECOND span and double-count the request.
          span: stageSpan,
          // The bearer 429 recovery loop may re-enter the kernel after an intercept;
          // preserve one borrowed span across those passes and finalize only the
          // eventual terminal response.
          deferSpanFinalization: stageSpan !== undefined,
          admission: {
            // P-011 / D-027: arrives from this executor's caller and is PASS-THROUGH by design.
            // `proxyOpenAi`'s entry wrapper already took the `openai-responses` slot around this
            // whole body, so exactly one of the two admits and re-admitting here would deadlock
            // against the slot this request already holds.
            run: (context, task) => kernelAdmission.run(context, task),
            observeAttempt: ({ context, response, error }) => {
              attemptsThisPass = context.attempt;
              attemptsSeen = attemptsUsed + context.attempt;
              const account = context.route.accountId ?? lastAccountId;
              lastAccountId = account;
              if (lastRouteKey !== null && lastRouteKey !== context.route.key) codexFailovers++;
              lastRouteKey = context.route.key;
              if (error) {
                const requestRef = `${gatewayProcessInstanceId}:${stageSpan?.requestId ?? 'unobserved'}`;
                if (error.code === 'cancelled') {
                  log('info', `inference-gateway: Codex bearer downstream cancelled request=${requestRef} code=cancelled on '${account}': ${error.message}`);
                  return;
                }
                // The STATUS is the only discriminator between the token-read throw
                // (`prepareAttempt`, 503) and the transport throw (`executeAttempt`,
                // 502). Genuine deadlines retain their failure accounting; a
                // downstream cancellation does not identify an upstream failure.
                const tokenResolve = error.status === 503;
                codexUpstreamErrors++;
                recordOwnerOutcome(wantOwner, 'upstream_error', {
                  account,
                  detail: tokenResolve ? 'bearer-token-resolve' : 'bearer-transport',
                });
                log('error', `inference-gateway: Codex ${tokenResolve ? 'token read' : 'upstream'} failed request=${requestRef} code=${error.code} on '${account}': ${error.message}`);
                return;
              }
              if (!response) return;
              // Project every bearer attempt through the same rate-window observer as the
              // OAuth lane; a 429 still carries authoritative credit and window headers.
              const responseModel = parseCodexRequestShape(context.body).model ?? '';
              deps.onResponse?.(response.metadata.headers, response.status, responseModel, account);
              if (response.status === 429) {
                // Counted here even when the kernel goes on to rotate: the old path
                // recorded the throttle against the account that emitted it.
                codexUpstream429++;
                recordRoutingUpstream429('codex', account);
                providerAdmission.recordThrottle('codex');
                recordOwnerOutcome(wantOwner, 'upstream_429', { account, status: 429 });
              } else if (response.status >= 200 && response.status < 300) {
                providerAdmission.recordSuccess('codex');
              }
            },
          },
          adapter: kernelAdapter,
          // The old handler never registered in `inFlightReg` (its own comment said
          // so), and D-003 forbids folding a behaviour change into an extraction.
          // Registering is a real improvement — it belongs in its own change.
          inFlight: { register: () => ({ unregister: () => undefined }) },
          downstream: {
            start: ({ status, metadata }) => {
              stageSpan?.setServingAccount(metadata.accountId);
              const outHeaders: Record<string, string> = { [ROUTED_ACCOUNT_HEADER]: metadata.accountId };
              for (const [key, value] of Object.entries(metadata.headers)) {
                if (!STRIP_RESPONSE.has(key.toLowerCase())) outHeaders[key] = value;
              }
              const pinYieldedFrom =
                metadata.pinYieldedFrom ??
                (bearerInitialPinYieldedFrom !== metadata.accountId ? bearerInitialPinYieldedFrom : null);
              if (pinYieldedFrom) {
                outHeaders[PIN_YIELDED_HEADER] = `${pinYieldedFrom}->${metadata.accountId}`;
                recordOwnerOutcome(wantOwner, 'pin_yield', {
                  account: metadata.accountId,
                  detail: outHeaders[PIN_YIELDED_HEADER],
                });
              }
              // WI-2038027 (codex 429 recovery P1): same terminal-429 shaping as the OAuth lane —
              // capped retry-after + retries-exhausted marker + stall attribution, so a bearer-pool
              // caller is paced and its session is stall-waker-recoverable instead of dying on the
              // raw upstream throttle. (api.openai.com speaks x-ratelimit-reset-* durations this
              // parser does not read — P2; a numeric retry-after still parses, and the shed floor
              // covers the rest.)
              if (status === 429) {
                const parsed = parseCodexRateReset(metadata.headers);
                const now = Date.now();
                const ladderResetAt = parsed.resetAt ?? (parsed.transient ? now + bare429FailoverBackoffMs : 0);
                // Same pool-horizon gate as the OAuth lane (P-003): absorb only when the pool can recover
                // inside the budget; sleep toward the pool, not the failed account.
                const poolRecoveryAt = codexPoolRecoveryAt(
                  bearerPool,
                  now,
                  { accountId: metadata.accountId, resetAt: ladderResetAt },
                  hardPin,
                );
                const decision = decideThrottleRecovery({
                  status,
                  retryIntent: true,
                  lastExhaustResetAt: ladderResetAt,
                  poolRecoveryAt,
                  state: {
                    transientWaitedMs: recovery.transientWaitedMs,
                    retryDeadlineAt: recovery.retryDeadlineAt,
                    absorbDeadlineAt: recovery.absorbDeadlineAt,
                    headersSent: res.headersSent,
                  },
                  budgets: {
                    waitCapMs: ALL_THROTTLED_RECOVERY_WAIT_CAP_MS,
                    transientTotalWaitBudgetMs: TRANSIENT_TOTAL_WAIT_BUDGET_MS,
                    overloadBackoffMs: OVERLOAD_529_BACKOFF_MS,
                  },
                  now,
                });
                if (decision.action === 'wait') {
                  interception.taken = {
                    action: 'wait',
                    waitMs: decision.waitMs,
                    backoffMs: 0,
                    resetAt: parsed.resetAt,
                    poolRecoveryAt,
                    accountId: metadata.accountId,
                  };
                  throw INTERCEPT_BEARER_THROTTLE;
                }
                if (decision.action === 'absorb') {
                  interception.taken = {
                    action: 'absorb',
                    waitMs: 0,
                    backoffMs: decision.backoffMs,
                    resetAt: parsed.resetAt,
                    poolRecoveryAt,
                    accountId: metadata.accountId,
                  };
                  throw INTERCEPT_BEARER_THROTTLE;
                }
                if (wantOwner) {
                  recordStall(wantOwner, metadata.accountId, codexStallSoonestAt(poolRecoveryAt, parsed.resetAt, now));
                }
                const shaped = shapeTerminalThrottle({
                  attempts: attemptsSeen,
                  retriesExhaustedHeader: RETRIES_EXHAUSTED_HEADER,
                  retryAfter: {
                    resetAt: parsed.resetAt,
                    fallbackSec: LOADSHED_RETRY_AFTER_SEC,
                    capS: BEE_RETRY_AFTER_CAP_S,
                  },
                });
                Object.assign(outHeaders, shaped.headers);
                const poolRecovery = describePoolRecovery(poolRecoveryAt, now);
                outHeaders[POOL_RECOVERY_AT_HEADER] = poolRecovery;
                log(
                  'warn',
                  `inference-gateway: Codex bearer upstream 429 not rescued after ${attemptsSeen} attempt(s) on '${metadata.accountId}' — forwarding terminal 429 (retry-after ${shaped.retryAfterSec}s${wantOwner ? `; stall recorded for '${wantOwner}'` : ''}; pool recovery ${poolRecovery})`,
                );
              }
              recordRoute(wantOwner, metadata.accountId, 'codex');
              recordOwnerOutcome(wantOwner, status < 400 ? 'ok' : status === 429 ? 'upstream_429' : 'upstream_error', {
                account: metadata.accountId,
                status,
              });
              if (acceptedOperation && status >= 200 && status < 300) {
                acceptedRelay = acceptedCodexResponse(
                  acceptedOperation, metadata.headers['content-type'] ?? '', true,
                );
                pendingAcceptedHead = { status, headers: outHeaders };
                // Upstream progress is bounded by the kernel's request/body
                // deadlines while the success head is intentionally withheld.
                res.setTimeout(0);
              } else {
                res.writeHead(status, outHeaders);
              }
              cacheProbe = new PassThrough();
              // Keep the tee in flowing mode for the stream's whole life: the observer
              // detaches its own 'data' listener once it has read the usage record, and
              // without a second listener the PassThrough would stop draining and buffer
              // the rest of a long agent stream in memory.
              cacheProbe.on('data', () => undefined);
              cacheProbe.on('error', () => undefined);
              observeOpenAiCacheUsage(cacheProbe, metadata.accountId, attemptsSeen > 1 || pinYieldedFrom !== null, stageSpan);
            },
            write: async (chunk) => {
              cacheProbe?.write(chunk);
              if (acceptedRelay) {
                acceptedRelay.push(chunk);
                return;
              }
              // Honour downstream backpressure exactly as the old `nodeStream.pipe(res)`
              // did. The kernel wraps this call in the downstream-idle deadline, so a
              // client that never drains is torn down by that guard rather than hanging.
              if (!res.write(chunk)) {
                await new Promise<void>((resolve) => {
                  const settle = () => {
                    res.off('drain', settle);
                    res.off('close', settle);
                    res.off('error', settle);
                    resolve();
                  };
                  res.once('drain', settle);
                  res.once('close', settle);
                  res.once('error', settle);
                });
              }
            },
            end: async () => {
              endCacheProbe();
              if (acceptedRelay && pendingAcceptedHead) {
                const chunks = await acceptedRelay.finish();
                res.setTimeout(downstreamIdleMs);
                res.writeHead(pendingAcceptedHead.status, pendingAcceptedHead.headers);
                await flushAcceptedCodexChunks(res, chunks);
              }
              res.end();
            },
          },
        });
      } catch (error) {
        const taken = takeBearerIntercept();
        // The kernel normalizes a thrown downstream.start error before it reaches
        // this catch, so identity is not stable. The dedicated flag is written
        // only by our interception seam and is the authoritative discriminator.
        if (taken) {
          attemptsUsed += attemptsThisPass;
          continuationActive = true;
          if (taken.action === 'wait') {
            recovery.transientWaitedMs += taken.waitMs;
            log(
              'warn',
              `inference-gateway: Codex bearer pool transiently throttled → wait ${taken.waitMs}ms + retry (wait-budget ${recovery.transientWaitedMs}/${TRANSIENT_TOTAL_WAIT_BUDGET_MS}ms)`,
            );
            await waitForCodexRecovery(res, taken.waitMs, reqAbort.signal);
            return runBearerRecovery();
          }
          if (!kernelAdmission.park) {
            throw new Error('inference-gateway: codex bearer absorb requires cooperative lane admission');
          }
          const now = Date.now();
          const remainingMs = Math.max(0, recovery.absorbDeadlineAt - now);
          // Sleep toward the POOL's horizon, not the failed account's reset (P-003; see the OAuth twin).
          const capacityWaitMs =
            Number.isFinite(taken.poolRecoveryAt) && taken.poolRecoveryAt > now
              ? taken.poolRecoveryAt - now
              : Math.max(1, taken.backoffMs || bare429FailoverBackoffMs);
          const waitMs = Math.min(remainingMs, capacityWaitMs);
          recovery.transientWaitedMs = 0;
          log(
            'warn',
            `inference-gateway: Codex bearer absorb on '${taken.accountId}' → release provider slot, wait ${waitMs}ms (pool recovery ${describePoolRecovery(taken.poolRecoveryAt, now)}), then re-enter (${remainingMs}ms budget left)`,
          );
          return kernelAdmission.park(async () => {
            await waitForCodexRecovery(res, waitMs, reqAbort.signal);
            recovery.retryDeadlineAt = Date.now() + internalRetryDeadlineMs;
          }, runBearerRecovery);
        }
        endCacheProbe();
        const failure =
          error instanceof GatewayRequestKernelError
            ? error
            : new GatewayRequestKernelError(error instanceof Error ? error.message : String(error), {
                code: 'gateway-error',
                outcome: 'gateway-error',
                status: 500,
                cause: error,
              });

        if (failure.code === 'request-ceiling') {
          log(
            'error',
            `inference-gateway: Codex request hit the ${requestCeilingMs}ms hard ceiling on '${lastAccountId}' — force-terminating`,
          );
          try {
            req.destroy();
          } catch {
            /* already torn down */
          }
          try {
            res.destroy();
          } catch {
            /* already torn down */
          }
          return;
        }

        if (failure.code === 'body-read-timeout' || failure.code === 'body-too-large') {
          try {
            req.destroy();
          } catch {
            /* already torn down */
          }
          if (!reqAbort.signal.aborted && !res.headersSent) {
            sendJson(res, 503, {
              type: 'error',
              error: {
                type: 'overloaded_error',
                message: 'inference-gateway: Codex request body read stalled; retry shortly',
              },
              gateway: true,
            });
          }
          return;
        }

        if (res.headersSent) {
          // Committed to a response already — the only honest signal left is a teardown.
          res.destroy();
          return;
        }

        if (failure.code === 'upstream-error' && failure.status === 503) {
          // Token resolution never produced a usable bearer on any account.
          sendJson(
            res,
            503,
            { type: 'error', error: { type: 'overloaded_error', message: failure.message }, gateway: true },
            { 'retry-after': '5', [ROUTED_ACCOUNT_HEADER]: lastAccountId },
          );
          return;
        }
        if (failure.code === 'invalid-route' || failure.code === 'invalid-pin') {
          sendJson(
            res,
            failure.status ?? 503,
            { type: 'error', error: { type: 'api_error', message: failure.message }, gateway: true },
            { [ROUTED_ACCOUNT_HEADER]: lastAccountId, ...(failure.status === 403 ? { 'x-should-retry': 'false' } : {}) },
          );
          return;
        }
        // Everything else — a dead socket, a TTFB stall, a mid-stream idle, a
        // cancellation — surfaced through the old transport catch as this envelope.
        sendJson(
          res,
          502,
          {
            type: 'error',
            error: {
              type: 'api_error',
              message: failure.message.startsWith('inference-gateway:')
                ? failure.message
                : `inference-gateway: Codex upstream failed: ${failure.message}`,
            },
            gateway: true,
          },
          { [ROUTED_ACCOUNT_HEADER]: lastAccountId },
        );
      } finally {
        if (!continuationActive) {
          endCacheProbe();
          req.off('aborted', onReqAborted);
          res.off('close', onResClose);
        }
      }
    };
    await runBearerRecovery();
  }

  /**
   * P-011 / D-023 / D-027: a lane's admission controller — ONE slot per request, taken by the
   * lane's entry handler around everything it does, and forwarded to that handler's kernel
   * call(s) as a pass-through so exactly one of the two admits.
   *
   * D-027 corrected where this is invoked. It was introduced expecting to live at the kernel's
   * own `admission.run`, but that seam is INSIDE `executeGatewayRequestKernel`
   * (request-kernel.ts:887) and is therefore per-KERNEL-CALL — right only for a handler that
   * calls the kernel once and does nothing admission-relevant first. Hence the name: a LANE
   * admission, not a kernel one.
   *
   * `context` is deliberately `unknown`. Each kernel site parameterises the controller over
   * its OWN route type, and a lane controller closes over `pri`/`tier`/`stageSpan` rather
   * than reading kernel route internals; typing it `unknown` states that honestly and keeps
   * one shared seam usable at every site instead of one bespoke type per transport.
   */
  class GatewayLanePark extends Error {
    constructor(
      readonly wait: () => Promise<void>,
      readonly resume: () => Promise<unknown>,
    ) {
      super('inference-gateway: provider lane parked for recovery');
      this.name = 'GatewayLanePark';
    }
  }

  type GatewayLaneAdmission = {
    run<TResult>(context: unknown, task: () => Promise<TResult>): Promise<TResult>;
    /**
     * Cooperatively settle the current lane task (releasing its queue slot), do
     * bounded work while holding no slot, then re-enter with a continuation that
     * captures the request's already-parsed state. Only the real provider-lane
     * controller implements this; the kernel-facing `run` remains pass-through.
     */
    park?<TResult>(wait: () => Promise<void>, resume: () => Promise<TResult>): Promise<TResult>;
  };

  /**
   * The pass-through a handler hands its kernel call(s) once the lane's slot is already held
   * by that handler's entry. Named rather than inlined so it reads as a STATEMENT — "this
   * lane is admitted above, admitting again here would deadlock on its own slot" — at every
   * site, rather than as an anonymous no-op someone later mistakes for an oversight.
   *
   * The `admission` parameter on every entry handler stays REQUIRED, never optional. An
   * optional one would let a lane silently fall back to pass-through and run UNQUEUED while
   * every suite stayed green — the exact "green while testing nothing" failure P-011 hit three
   * separate times (WI-1213880 breakages a/b/c). Required means a lane that forgets to pass
   * its controller fails to COMPILE.
   */
  const passThroughLaneAdmission: GatewayLaneAdmission = {
    run: (_context, task) => task(),
  };

  /**
   * P-011 / D-027 — the two remaining lanes' ENTRY seams. Each takes its lane's real
   * admission slot ONCE, around everything the handler does, and hands the admitted body a
   * pass-through kernel admission.
   *
   * A lane's admission belongs at its outermost PER-REQUEST boundary. The kernel's
   * `admission.run` seam is per-KERNEL-CALL (request-kernel.ts:887), so it coincides with
   * that boundary only for a handler that calls the kernel exactly once and does nothing
   * admission-relevant first — measured, `proxyLocal` alone. `proxyAdmitted` loops over the
   * kernel; `proxyOpenAiAdmitted` resolves accounts and can commit a response head before
   * reaching one. Both therefore admit here.
   *
   * `undefined` is the context because a lane controller closes over `pri`/`tier`/`stageSpan`
   * and reads no kernel route internals — the reason the seam types `context` as `unknown`.
   */
  async function proxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    laneAdmission: GatewayLaneAdmission,
  ): Promise<void> {
    return laneAdmission.run(undefined, () => proxyAdmitted(req, res, url, passThroughLaneAdmission));
  }

  async function proxyOpenAi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    laneAdmission: GatewayLaneAdmission,
  ): Promise<void> {
    const admittedLaneControl: GatewayLaneAdmission = laneAdmission.park
      ? {
          run: passThroughLaneAdmission.run,
          park: laneAdmission.park,
        }
      : passThroughLaneAdmission;
    return laneAdmission.run(undefined, () => proxyOpenAiAdmitted(req, res, url, admittedLaneControl));
  }

  const legacyAdmissionSignal = new AbortController().signal;
  let legacyAdmissionRequestSeq = 0;

  /**
   * The gateway's DURABLE admission crossing — D-004's pre-acceptance body spool, the
   * `gatewayAdmissionGovernor` slot, the request deadline, and the payload pin that spans
   * the admission + execution window.
   *
   * ⛔ D-022: THIS LAYER IS NOT STRANGLER SCAFFOLDING AND DOES NOT DIE WITH IT.
   * `executeLegacyLaneTask` used to be these two layers fused into one function, which is
   * why P-008's deletion list names it. Only the LANE bridge below is removable; deleting
   * this layer alongside it would delete D-004 durability (the property that lets a receipt
   * outlive its socket) from every lane. Measured at the split: two of the three entry sites
   * cross this governor, and for `localOpenAiChat` it is the ONLY real admission it has.
   *
   * `async` because the spool must persist the body BEFORE the durable admission decision is taken.
   * Callers already treat the result as a promise, so this is not a contract change — the
   * bypass path below still returns without awaiting anything.
   */
  async function withDurableGatewayAdmission<TResult>(opts: {
    req: http.IncomingMessage;
    lane: GatewayLaneDescriptor;
    task(context: GatewayKernelContext): Promise<TResult>;
  }): Promise<TResult> {
    const span = requestSpan(opts.req);
    const requestId = span?.requestId ?? ++legacyAdmissionRequestSeq;
    const ownerId = span?.ownerId ?? (opts.req.headers[OWNER_HEADER] as string | undefined)?.trim() ?? null;
    const accountId = (opts.req.headers[ACCOUNT_HEADER] as string | undefined)?.trim() || null;
    const pinMode = accountId
      ? (opts.req.headers[ACCOUNT_PIN_HEADER] as string | undefined)?.trim().toLowerCase() === 'hard'
        ? 'hard'
        : 'soft'
      : 'none';
    const context: GatewayKernelContext = {
      requestId,
      correlationId: `legacy-${requestId}`,
      lane: opts.lane,
      ownerId,
      pin: null,
      signal: legacyAdmissionSignal,
      startedAt: span?.startedAt ?? Date.now(),
    };
    const execute = () => opts.task(context);
    // `/v1/models` and the admin/health surfaces are explicitly registered
    // non-resident bypasses; their outer request wrapper owns the bypass
    // admission. Every other lane crosses Governor.admit before its legacy
    // executor can start provider/local work.
    //
    // D-022(3): this bypass-key check — NOT the no-op admission controller a caller
    // happens to pass — is what implements the deliberate UNQUEUED path for codex
    // `/v1/models`, so metadata is never starved behind an Anthropic storm.
    if (gatewayAdmissionBypassKeyForRequest(opts.req.method, opts.req.url)) return execute();
    // D-004: after the goal-budget preflight, the body is persisted BEFORE durable admission,
    // so queue depth stops scaling
    // resident memory and the receipt can be executed after this socket is gone. A client that
    // already spooled its own payload passes the ref explicitly and is left alone.
    if (ownerId && deps.checkGoalInferenceAdmission) {
      let decision: GatewayGoalBudgetDecision;
      try {
        decision = await deps.checkGoalInferenceAdmission(ownerId);
      } catch {
        throw new GoalInferenceAdmissionRefusal(
          503,
          'goal_budget_admission_unavailable',
          'goal budget could not be verified; inference is refused before provider dispatch',
        );
      }
      if (!decision.allowed) {
        throw new GoalInferenceAdmissionRefusal(decision.status, decision.code, decision.message);
      }
    }
    const clientPayloadRef = (opts.req.headers['x-papercusp-payload-ref'] as string | undefined)?.trim() || undefined;
    let spooledPayloadRef = clientPayloadRef;
    if (!clientPayloadRef) {
      span?.admissionQueued('payloadSpool');
      try {
        spooledPayloadRef = await spoolRequestBodyForAdmission(opts.req);
      } finally {
        // A failed spool still has a diagnostically useful duration. The
        // surrounding catch classifies the request failure; this segment only
        // attributes the pre-admission wall time.
        span?.admissionAdmitted('payloadSpool');
      }
    }
    const request = gatewayAdmissionInputForLane({
      lane: opts.lane,
      idempotencyKey:
        (opts.req.headers['x-papercusp-request-id'] as string | undefined)?.trim() ||
        `gateway:${opts.lane.id}:${gatewayProcessInstanceId}:${requestId}`,
      ownerId,
      accountId,
      streaming: null,
      pinMode,
      priority: priorityFromLabel((opts.req.headers[PRIORITY_HEADER] as string | undefined)?.trim()),
      deadlineAtMs: Date.now() + requestCeilingMs,
      payloadRef: spooledPayloadRef,
      parent: gatewayAdmissionParent,
    });
    // Pin the payload across the admission + execution window. `release` is NOT a delete (the spool
    // sweeps lazily on a TTL), so a retry landing between settle and sweep still resolves — that is
    // what stops the dedupe path racing its own GC.
    //
    // SCOPE LIMIT, deliberate: execution is still synchronous inside this request, so the pin's
    // lifetime is this request's. When a receipt is allowed to outlive its connection (the async
    // detach in the later plan items), this retain/release must MOVE onto the receipt lifecycle —
    // releasing here would then unpin a payload whose execution has not started. The TTL backstop
    // in migration 1022 bounds the damage in the interim; it is not a substitute for that move.
    if (spooledPayloadRef && spooledPayloadRef !== clientPayloadRef) {
      await payloadSpool?.retain(spooledPayloadRef).catch(() => undefined);
    }
    const durableAdmissionObservation = { priority: request.priority ?? null };
    span?.admissionQueued('durable', durableAdmissionObservation);
    try {
      return await withGatewayAdmission(gatewayAdmissionGovernor, request, async () => {
        span?.admissionAdmitted('durable', durableAdmissionObservation);
        return execute();
      });
    } finally {
      if (spooledPayloadRef && spooledPayloadRef !== clientPayloadRef) {
        void payloadSpool?.release(spooledPayloadRef).catch(() => undefined);
      }
    }
  }

  // P-008 / D-028: the STRANGLER BRIDGE that used to sit here — `executeLegacyLaneTask`, the
  // `legacyGatewayEntryExecutors` string-keyed dispatch map and `unqueuedLegacyAdmission` — is
  // DELETED. Every lane now takes its admission at its own entry (P-011 / D-027), so there is
  // no bridge left to route through. The DURABLE crossing above (`withDurableGatewayAdmission`)
  // is a different layer and deliberately stays: D-022 measured that fusing the two into one
  // function is what made P-008's original deletion list wrong.

  /**
   * Keep a server-level admission lease around control/metadata handlers. Most
   * `/v1/*` requests are admitted by their lane's own entry, but the cheap
   * handlers below return before a lane executor is selected. They still need a
   * typed, auditable admission decision (an explicit registered bypass), and the
   * lease must remain live until any promise-backed handler has settled.
   */
  function waitForResponseSettlement(res: http.ServerResponse, timeoutMs: number): Promise<void> {
    if (res.writableEnded || res.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer) clearTimeout(timer);
        res.off('finish', finish);
        res.off('close', finish);
        res.off('error', finish);
        resolve();
      };
      res.once('finish', finish);
      res.once('close', finish);
      res.once('error', finish);
      // A malformed control handler must not pin a canonical admission lease
      // forever. This is only a backstop; normal handlers finish on the events.
      timer = setTimeout(
        () => {
          if (!res.writableEnded && !res.destroyed) {
            try {
              res.destroy();
            } catch {
              /* already torn down */
            }
          }
          finish();
        },
        Math.max(1, timeoutMs),
      );
      timer.unref?.();
      if (res.writableEnded || res.destroyed) finish();
    });
  }

  function requestHeader(req: http.IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    const text = Array.isArray(value) ? value[0] : value;
    const trimmed = typeof text === 'string' ? text.trim() : '';
    return trimmed || undefined;
  }

  function gatewayAdmissionInputForRequest(
    req: http.IncomingMessage,
    kind: GatewayAdmissionKind,
    bypassKey?: GatewayAdmissionBypassKey,
    options: { readonly deadlineAtMs?: number } = {},
  ): GatewayAdmissionRequestInput {
    const path = (req.url ?? '/').split('?', 1)[0] || '/';
    const sequence = ++gatewayAdmissionRequestSeq;
    const idempotencyKey =
      requestHeader(req, 'x-papercusp-request-id') ?? `gateway:${kind}:${gatewayProcessInstanceId}:${sequence}:${path}`;
    const accountId = requestHeader(req, ACCOUNT_HEADER);
    const pinMode = accountId
      ? requestHeader(req, ACCOUNT_PIN_HEADER)?.toLowerCase() === 'hard'
        ? ('hard' as const)
        : ('soft' as const)
      : ('none' as const);
    const provider =
      kind === 'codex'
        ? ('codex' as const)
        : kind === 'local' || kind === 'local-backend'
          ? ('local' as const)
          : ('claude' as const);
    return {
      kind,
      provider,
      lane: path,
      accountId,
      model: requestHeader(req, 'x-papercusp-model') ?? null,
      ownerId: requestHeader(req, OWNER_HEADER) ?? null,
      streaming: null,
      pinMode,
      transport: null,
      priority: priorityFromLabel(effectivePriorityLabel(req.headers as Record<string, unknown>)),
      deadlineAtMs: options.deadlineAtMs ?? Date.now() + requestCeilingMs,
      idempotencyKey,
      payloadRef: requestHeader(req, 'x-papercusp-payload-ref'),
      parent: gatewayAdmissionParent,
      ...(bypassKey ? { bypassKey } : {}),
    };
  }

  async function runServerAdmission(
    res: http.ServerResponse,
    input: GatewayAdmissionRequestInput,
    dispatch: () => void,
  ): Promise<void> {
    await withGatewayAdmission(gatewayAdmissionGovernor, input, async () => {
      dispatch();
      await waitForResponseSettlement(res, requestCeilingMs);
    });
  }

  const dispatchRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? '/';
    const requestPath = url.split('?', 1)[0] || '/';
    if (carryTrial) {
      const token = /^Bearer ([^\s]+)$/.exec(requestHeader(req, 'authorization') ?? '')?.[1];
      const authenticated = token && timingSafeEqual(createHash('sha256').update(token).digest(),
        Buffer.from(carryTrial.requestTokenSha256, 'hex'));
      const openaiAllowed = carryTrial.protocols.includes('openai-responses');
      const anthropicAllowed = carryTrial.protocols.includes('anthropic-messages');
      const supported = (openaiAllowed && req.method === 'POST' && requestPath === '/v1/responses') ||
        (openaiAllowed && req.method === 'GET' && requestPath === '/v1/models') ||
        (anthropicAllowed && req.method === 'POST' && requestPath === '/v1/messages');
      if (!authenticated || !supported) {
        req.resume();
        sendJson(res, 403, { error: { message: 'carry trial request not authorized' } },
          { 'x-should-retry': 'false' });
        return;
      }
      carryTrialRequests.add(req);
    }
    if (req.method === 'GET' && requestPath === GATEWAY_FLAG_ATTEST_PATH) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const key = requestUrl.searchParams.get('key')?.trim() ?? '';
      if (!key) {
        sendJson(res, 400, { ok: false, error: 'missing key' });
        return;
      }
      try {
        assertKnownFlagKey(key);
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const address = server.address();
      const servingPort = typeof address === 'object' && address ? address.port : null;
      void buildProcessFlagAttestation(key, requestUrl.searchParams.get('distinctId')?.trim() || 'flags-attest', {
        role: 'inference-gateway',
        label: 'inference-gateway:' + (servingPort ?? 'unknown'),
        port: servingPort,
      })
        .then((attestation) => sendJson(res, 200, attestation))
        .catch((error) => {
          sendJson(res, 200, {
            ok: false,
            process: {
              role: 'inference-gateway',
              label: 'inference-gateway:' + (servingPort ?? 'unknown'),
              port: servingPort,
              pid: process.pid,
            },
            key,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    if (req.method === 'GET' && requestPath === '/healthz') {
      const s = stats();
      // EI-19303809952284205: `ok` used to be a HARDCODED literal `true` — it described only whether
      // the process was answering, so a gateway whose Postgres had been unreachable for hours (account
      // pool unloadable, every usage-window write dropped, healthyAccounts: 0) still reported green to
      // every prober. A sustained durable-path failure is a REAL not-ready condition: report it as one,
      // and 503 so the existing load-balancer/watchdog semantics apply with no new plumbing.
      const dbDown = s.db?.ok === false;
      sendJson(res, s.pausedUntil > Date.now() || dbDown ? 503 : 200, { ok: !dbDown, ...s });
      return;
    }
    if (req.method === 'GET' && (requestPath === '/stats' || requestPath === '/admin/stats')) {
      sendJson(res, 200, stats());
      return;
    }
    if (req.method === 'GET' && requestPath === '/admin/stalls') {
      // P-002: recent rate-limit stall candidates for the stall-waker (gateway-rate-limit-stall-autowake).
      // `?since=<epochMs>` returns only events after that watermark (the waker passes its last-seen `now`).
      // WI-4994: also drop anything past STALL_MAX_AGE_MS regardless of `since` — a `since=0` read
      // (a fresh waker instance, or a diagnostic curl) must not replay hours-old stalls for owners
      // long gone (recordStall's own opportunistic prune only runs on the NEXT write, which never
      // comes on a quiet box).
      const since = Number(url.match(/[?&]since=(\d+)/)?.[1] ?? 0);
      const ageCutoff = Date.now() - STALL_MAX_AGE_MS;
      sendJson(res, 200, {
        ok: true,
        now: Date.now(),
        stalls: recentStalls.filter((s) => s.at > since && s.at > ageCutoff),
      });
      return;
    }
    if (req.method === 'GET' && requestPath === '/admin/route') {
      // routed-account-visibility (2026-06-22): the account that served `?owner=<id>`'s most-recent turn, so a
      // session's statusline can show "my turn → <account>". `{account:null}` when that owner hasn't been seen.
      const owner = decodeURIComponent(url.match(/[?&]owner=([^&]+)/)?.[1] ?? '');
      const e = owner ? lastRouteByOwner.get(owner) : undefined;
      // WI-2140943 lane 2: the SERVED route is also the compaction watchdog's source for the effective
      // window (`model` + `context1m`) and the exact context size (`usage`) — both bound to
      // `nativeSessionId` so a successor session never inherits a predecessor's reading.
      sendJson(res, 200, {
        ok: true,
        now: Date.now(),
        owner: owner || null,
        account: e?.account ?? null,
        model: e?.model ?? null,
        context1m: e?.context1m ?? null,
        nativeSessionId: e?.nativeSessionId ?? null,
        usage: e?.usage ?? null,
        at: e?.at ?? null,
      });
      return;
    }
    if (req.method === 'GET' && requestPath === '/admin/owner-report') {
      // P-008 (gateway-rayobyte-hardening): the per-owner outcome ledger. `?owner=<id>` → that owner's
      // counters + recent events + last-routed account + live pin; no owner → the TOP erroring owners
      // (by non-ok outcomes) so "who is having a bad time right now" is one call.
      const owner = decodeURIComponent(url.match(/[?&]owner=([^&]+)/)?.[1] ?? '');
      if (owner) {
        const e = ownerLedger.get(owner) ?? null;
        const route = lastRouteByOwner.get(owner) ?? null;
        const pin = ownerPinMap.get(owner) ?? null;
        sendJson(res, 200, {
          ok: true,
          now: Date.now(),
          owner,
          ledger: e,
          lastRoute: route,
          pin,
          stageTelemetry: requestStageTelemetry.snapshotForOwner(owner),
          routingQuality: routingQualitySnapshot(owner),
        });
        return;
      }
      const top = [...ownerLedger.entries()]
        .map(([id, e]) => ({
          owner: id,
          bad: e.upstream429 + e.upstreamErrors + e.sheds + e.stalls,
          ...e,
          recent: e.recent.slice(-3),
        }))
        .sort((a, b) => b.bad - a.bad || b.lastAt - a.lastAt)
        .slice(0, 25);
      sendJson(res, 200, { ok: true, now: Date.now(), owners: top, routingQuality: routingQualitySnapshot() });
      return;
    }
    if (req.method === 'GET' && requestPath === '/admin/config') {
      // B-HOT-2: the LIVE config snapshot — pool version + account ids + the admission/AIMD state — so an
      // operator / gateway:status tool can read what the gateway is actually running, no restart.
      const s = stats();
      sendJson(res, 200, {
        ...(deps.adminConfig ? deps.adminConfig() : { hotReload: false }),
        providers: gatewayProviderStatuses(providerAdapters),
        admission: s.admission,
        codexAdmission: s.codexAdmission,
        concurrencyCap: s.concurrencyCap,
        aimd: s.aimd,
        codexAimd: s.codexAimd,
        codexHealthyAccounts: s.codexHealthyAccounts,
        codexModelRefusals: s.codexModelRefusals,
        // THE CONTRADICTION THIS ENDPOINT USED TO WITHHOLD. `admission.maxConcurrent` and `aimd.effective`
        // were both forwarded while `clamp` — the only field that explains a gap between them — was not, so
        // gateway:status showed `maxConcurrent: 4` beside `effective: 24` with nothing connecting the two.
        // An agent read that as an unexplained AIMD defect and carried the wrong diagnosis for a day, while
        // the real cause (a serviceable-account clamp recommending 4 from ONE serviceable account) sat one
        // line away in stats(). The surface is the only thing that can see both terms, so it states which
        // one binds rather than leaving the reader to infer it.
        clamp: s.clamp,
        admissionCeiling: describeAdmissionCeiling({
          applied: s.admission.maxConcurrent,
          aimdEffective: s.aimd?.effective ?? s.admission.maxConcurrent,
          configuredCap: s.concurrencyCap,
          clamp: s.clamp,
        }),
        // P-013: the CANONICAL admission state. Every field above is a legacy
        // per-provider read kept for compatibility; `admissionState` is the single
        // model that `gateway:status`, `fleet:capacity`, health panels and alerts all
        // project from, so those surfaces cannot disagree about which term binds a
        // lane or omit the generation/freshness needed to interpret a number.
        // Built here from the gateway's own live writers — the provider lifecycle for
        // windows, each lane's queue snapshot for in-flight/queued.
        admissionState: describeGatewayLiveAdmissionState({
          lanes: providerAdmission.snapshot().lanes.map((lane) => {
            const laneQueue = lane.lane === 'codex' ? codexQueue : queue;
            const q = laneQueue?.snapshot?.() ?? { running: 0, queued: 0 };
            return {
              lane: lane.lane,
              window: lane.window,
              observedPeak: lane.observedPeak,
              minimumWindow: lane.minimumWindow,
              inFlight: q.running ?? 0,
              queued: q.queued ?? 0,
            };
          }),
          // The lifecycle has no generation counter of its own; the most recent lane
          // change is the honest "when did this state last move" stamp, and 0 says
          // "never moved" rather than implying a generation that does not exist.
          generation: providerAdmission.snapshot().lanes.reduce((acc, l) => Math.max(acc, l.lastChangeAtMs ?? 0), 0),
          evaluatedAtMs: Date.now(),
          healthState: s.aimd ? 'healthy' : 'unknown',
        }),
        upstreamBase,
      });
      return;
    }
    if (req.method === 'POST' && requestPath === '/admin/readmit') {
      // EI-8797 residual: accounts:reset-rate clears the PERSISTED account-pool store, but this
      // process's failover pool keeps its own in-memory pause map (exhaustedUntil) — a split-brain
      // that left /stats reporting healthyAccounts=0 after a confirmed reset. This endpoint is the
      // live-process dual of the store reset: readmit the named account (`?account=<id>`) — or EVERY
      // pool account when no id is given — into rotation NOW, and report the fresh healthyAccounts
      // so the caller can verify the split actually cleared instead of assuming.
      req.resume(); // drain any request body so the socket releases cleanly
      const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const params = new URLSearchParams(q);
      const account = params.get('account')?.trim() ?? '';
      const provider = params.get('provider')?.trim().toLowerCase() === 'codex' ? 'codex' : 'claude';
      const targetPools =
        provider === 'codex' ? [deps.codexPool, codexCliPool].filter((p): p is AccountPool => !!p) : [pool];
      if (!targetPools.some((p) => !!p.readmit)) {
        sendJson(res, 503, {
          type: 'error',
          error: { type: 'api_error', message: `inference-gateway: ${provider} pool has no readmit` },
          gateway: true,
        });
        return;
      }
      const ids = account
        ? [account]
        : [...new Set(targetPools.flatMap((p) => (p.entries?.() ?? []).map((e) => e.accountId)))];
      for (const targetPool of targetPools) {
        for (const id of ids) targetPool.readmit?.(id, { reason: 'admin' });
      }
      const at = Date.now();
      const healthyAccounts =
        provider === 'codex'
          ? codexServiceableCount(deps.codexPool, at) +
            codexServiceableCount(codexCliPool, at, codexCliPool ? [] : codexCliHealthEntries())
          : (pool.healthyCount?.() ?? 1);
      sendJson(res, 200, { ok: true, provider, readmitted: ids, healthyAccounts });
      return;
    }
    if (req.method === 'POST' && requestPath === '/admin/clamp-mode') {
      // Legacy advisory-clamp readback. `mode` remains accepted for clients that
      // still send the old endpoint request, but P-007 makes both values
      // diagnostic-only: neither can reintroduce a serviceability-derived cap.
      req.resume(); // drain the body so the socket releases cleanly
      const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const raw = new URLSearchParams(q).get('mode')?.trim();
      if (raw !== undefined && raw !== 'auto' && raw !== 'off') {
        sendJson(res, 400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `inference-gateway: mode must be 'auto' or 'off' (got '${raw}')`,
          },
          gateway: true,
        });
        return;
      }
      if (raw) {
        const prev = clampMode;
        clampMode = raw;
        refreshServiceableDiagnostics(); // readback only; admission stays lifecycle-driven
        if (prev !== clampMode) {
          log(
            'warn',
            `inference-gateway: serviceable-admission clamp mode ${prev} → ${clampMode} (recommendation=${Number.isFinite(lastServiceableRecommendation) ? lastServiceableRecommendation : 'n/a'}, live admission=${providerAdmission.windowFor('claude')})`,
          );
        }
      }
      sendJson(res, 200, {
        ok: true,
        mode: clampMode,
        recommendation: Number.isFinite(lastServiceableRecommendation) ? lastServiceableRecommendation : null,
        applied: providerAdmission.windowFor('claude'),
        aimdEffective: providerAdmission.windowFor('claude'),
        // Compatibility field. There is no configured cap any more; this reports
        // the lane's own high-water mark (P-010).
        concurrencyCap: providerAdmission.snapshotFor('claude').observedPeak,
      });
      return;
    }
    if (req.method === 'POST' && requestPath === '/admin/reload') {
      // B-HOT-2: on-demand HOT-RELOAD — re-resolve the DB account pool + swap it live NOW (vs the 60s poll).
      if (!deps.onAdminReload) {
        sendJson(res, 503, {
          type: 'error',
          error: { type: 'api_error', message: 'inference-gateway: hot-reload not wired on this gateway' },
          gateway: true,
        });
        return;
      }
      req.resume(); // drain any request body so the socket releases cleanly
      void Promise.all([
        deps.onAdminReload(),
        // Local-backend registry hot-reload rides the SAME endpoint (parity with the account pool) —
        // an independent axis, so its absence/failure never blocks the account-pool reload above.
        deps.onAdminReloadLocalBackends
          ? deps.onAdminReloadLocalBackends().catch((e) => ({ changed: false, count: 0, error: (e as Error).message }))
          : Promise.resolve(undefined),
      ])
        .then(([r, localBackends]) =>
          sendJson(res, 200, { ok: true, ...r, ...(localBackends ? { localBackends } : {}) }),
        )
        .catch((e) =>
          sendJson(res, 500, {
            type: 'error',
            error: { type: 'api_error', message: `inference-gateway: reload failed: ${(e as Error).message}` },
            gateway: true,
          }),
        );
      return;
    }
    if (req.method === 'GET' && requestPath === '/admin/local-backends') {
      // Admin visibility (D-002): the live local-backend registry + health + in-flight, so
      // gateway:status / an operator can see what's registered and whether it's actually healthy.
      if (!deps.localBackends) {
        sendJson(res, 200, { ok: true, configured: false, backends: [] });
        return;
      }
      const pool = deps.localBackends;
      const health = pool.health();
      const now = Date.now();
      sendJson(res, 200, {
        ok: true,
        configured: true,
        now,
        backends: pool.entries().map((b) => ({
          ...b,
          inFlight: pool.inFlight(b.id),
          health: health.get(b.id) ?? null,
          engineCapacity: pool.engineCapacity(b.id),
        })),
        // P-028 slot-affinity visibility: switches/(hits+switches) is the eviction rate — how
        // often a session's warm backend had to be abandoned (→ full KV re-prefill).
        affinity: pool.affinityStats(),
      });
      return;
    }
    if ((req.method === 'POST' || req.method === 'GET') && requestPath === '/admin/egress-mode') {
      // Dynamic egress kill-switch (egress-proxy-toggle-2026-06-30): `?proxy=off` ⇒ box-IP-only (drop the
      // datacenter proxy egress, route all upstream through the box's own IP); `?proxy=on` ⇒ restore each
      // account's proxy pool; no arg ⇒ just read the current mode. LIVE — no restart. The BOOT default is
      // PAPERCUSP_GATEWAY_DISABLE_PROXY_EGRESS, so set that (gateway service env) to make a flip survive a restart.
      req.resume(); // drain any body so the socket releases cleanly
      const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const proxy = new URLSearchParams(q).get('proxy');
      if (proxy === 'off') proxyEgressDisabled = true;
      else if (proxy === 'on') proxyEgressDisabled = false;
      sendJson(res, 200, { ok: true, proxyEgressDisabled, mode: proxyEgressDisabled ? 'box-ip-only' : 'proxy-pool' });
      return;
    }
    if (req.method === 'POST' && requestPath === '/admin/owner-pin') {
      // DYNAMIC OWNER PIN set/clear (accounts:pin / accounts:unpin). Body: {ownerId, account, hard?, clear?}.
      // Sets the in-memory owner→account pin the routing above honors per-request (overriding the static
      // x-papercusp-account header). NOT persisted — re-applied by the caller if the gateway restarts.
      // Promise-chained (this admin-dispatch scope is sync, like /admin/reload — no await here).
      void readBody(req)
        .then((buf) => {
          let body: { ownerId?: string; account?: string; hard?: boolean; clear?: boolean };
          try {
            body = JSON.parse(buf.toString('utf8') || '{}');
          } catch {
            sendJson(res, 400, {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'owner-pin: body must be JSON' },
              gateway: true,
            });
            return;
          }
          const ownerId = body.ownerId?.trim();
          if (!ownerId) {
            sendJson(res, 400, {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'owner-pin: ownerId required' },
              gateway: true,
            });
            return;
          }
          if (body.clear) {
            const cleared = ownerPinMap.delete(ownerId);
            sendJson(res, 200, { ok: true, ownerId, cleared, pin: null, count: ownerPinMap.size });
            return;
          }
          const account = body.account?.trim();
          if (!account) {
            sendJson(res, 400, {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'owner-pin: account required (or clear:true)' },
              gateway: true,
            });
            return;
          }
          ownerPinMap.set(ownerId, { accountId: account, hard: !!body.hard, setAt: Date.now() });
          sendJson(res, 200, { ok: true, ownerId, pin: ownerPinMap.get(ownerId), count: ownerPinMap.size });
        })
        .catch((e) =>
          sendJson(res, 500, {
            type: 'error',
            error: { type: 'api_error', message: `owner-pin: ${(e as Error).message}` },
            gateway: true,
          }),
        );
      return;
    }
    if (req.method === 'GET' && requestPath === '/admin/owner-pins') {
      sendJson(res, 200, {
        ok: true,
        now: Date.now(),
        pins: [...ownerPinMap.entries()].map(([ownerId, p]) => ({ ownerId, ...p })),
      });
      return;
    }
    if (req.method === 'POST' && requestPath === MAINTENANCE_SUMMARIZE_PATH) {
      // MAINTENANCE SUMMARIZE (deterministic-context-carry P-002, ornith-overflow brief fixes 2–3).
      // Speaks omp's remote-compaction wire: POST {systemPrompt?, prompt} → {summary}. The summary is
      // generated on a CHEAP HOSTED model via a LOOPBACK /v1/messages call into this gateway's OWN
      // admission path, tagged `x-papercusp-priority: maintenance` (tier 1: reserved floor, never
      // AIMD-shed, longest absorb hold) — so a compaction summary NEVER runs on the requesting agent's
      // own (possibly saturated) backend and CANNOT be starved by fleet worker traffic. Account-pin
      // headers are deliberately NOT forwarded: a pinned/exhausted account must not gate maintenance —
      // the pool auto-selects. The loopback uses the REAL server socket (global fetch, not deps.fetchImpl)
      // so the inner request pays admission like any other; only its upstream leg rides deps.fetchImpl.
      void readBody(req)
        .then(async (buf) => {
          let body: { systemPrompt?: unknown; prompt?: unknown; model?: unknown; maxTokens?: unknown };
          try {
            body = JSON.parse(buf.toString('utf8') || '{}') as typeof body;
          } catch {
            sendJson(res, 400, {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'maintenance/summarize: body must be JSON' },
              gateway: true,
            });
            return;
          }
          const prompt = typeof body.prompt === 'string' ? body.prompt : '';
          if (!prompt.trim()) {
            sendJson(res, 400, {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'maintenance/summarize: string `prompt` required' },
              gateway: true,
            });
            return;
          }
          maintenanceRequests++;
          // DETERMINISTIC CARRY (deterministic-context-carry P-017, WI-4845): an opted-in
          // psu-launcher appends ?carryOwner=<coord ownerId>[&carryWs=<ws>][&carryWindow=<tokens>]
          // to omp's compaction.remoteEndpoint URL. When the launch layer injected the builder
          // (FLAGS.GATEWAY_MAINTENANCE_CARRY ON), answer from the deterministic carry doc instead
          // of the LLM oneshot; ANY miss — no builder, blank owner, null build, throw — falls
          // through to the LLM lane below, so a carry fault never strands a live compaction.
          // Without the injected builder the params are ignored entirely (byte-identical).
          if (deps.maintenanceCarry) {
            const carryParams = new URL(url, 'http://localhost').searchParams;
            const carryOwner = carryParams.get('carryOwner')?.trim();
            if (carryOwner) {
              const carryWindow = Number(carryParams.get('carryWindow'));
              const carryWs = carryParams.get('carryWs')?.trim();
              try {
                const carried = await deps.maintenanceCarry(carryOwner, {
                  ...(Number.isFinite(carryWindow) && carryWindow > 0 ? { effectiveWindowTokens: carryWindow } : {}),
                  ...(carryWs ? { workspaceId: carryWs } : {}),
                });
                if (carried?.summary) {
                  maintenanceCarried++;
                  sendJson(res, 200, {
                    ok: true,
                    summary: carried.summary,
                    deterministic: true,
                    budgetChars: carried.budgetChars,
                  });
                  // P-019 residual sampler (D-010 live leg 2): this is a REAL compaction
                  // boundary with both pass inputs in hand — the served stage-1 doc and
                  // the raw material it replaces. Strictly fire-and-forget AFTER the
                  // response; a sampler fault can never affect the served compaction.
                  if (deps.residualSampler) {
                    try {
                      deps.residualSampler({
                        carryOwner,
                        stage1Doc: carried.summary,
                        droppedContext: prompt,
                        interactive: carryParams.get('carryInteractive') === '1',
                        ...(carryWs ? { workspaceId: carryWs } : {}),
                      });
                    } catch {
                      /* observational only */
                    }
                  }
                  return;
                }
              } catch {
                /* fall through to the LLM lane */
              }
            }
          }
          const model = (typeof body.model === 'string' && body.model.trim()) || maintenanceModel;
          const requestedMax = Math.floor(Number(body.maxTokens));
          const maxTokens = Math.min(
            MAINTENANCE_MAX_TOKENS_CEILING,
            Number.isFinite(requestedMax) && requestedMax > 0 ? requestedMax : maintenanceMaxTokens,
          );
          const inner: Record<string, unknown> = {
            model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
          };
          if (typeof body.systemPrompt === 'string' && body.systemPrompt.trim()) inner.system = body.systemPrompt;
          const addr = server.address();
          const selfPort = typeof addr === 'object' && addr ? addr.port : 0;
          try {
            const headers: Record<string, string> = {
              'content-type': 'application/json',
              [PRIORITY_HEADER]: MAINTENANCE_PRIORITY_LABEL,
            };
            // Owner attribution carries through (ledger/stall-wake), pins do not (see above).
            const owner = (req.headers[OWNER_HEADER] as string | undefined)?.trim();
            if (owner) headers[OWNER_HEADER] = owner;
            // GATEWAY-NON-UPSTREAM: self-loopback, not an upstream open. This re-enters this
            // gateway's OWN /v1/messages front door on 127.0.0.1, so the request still crosses
            // admission and `executeGatewayRequestKernel` exactly like any client's — going
            // through the front door is what keeps the ladder in one place instead of
            // re-implementing it here. Asserted by gateway-handlers-reach-kernel.test.ts.
            const r = await fetch(`http://127.0.0.1:${selfPort}/v1/messages`, {
              method: 'POST',
              headers,
              body: JSON.stringify(inner),
              signal: AbortSignal.timeout(maintenanceTimeoutMs),
            });
            if (!r.ok) {
              maintenanceErrors++;
              const text = await r.text().catch(() => '');
              sendJson(res, r.status, {
                type: 'error',
                error: {
                  type: 'api_error',
                  message: `maintenance/summarize: model call failed (${r.status}): ${text.slice(0, 400)}`,
                },
                gateway: true,
              });
              return;
            }
            const j = (await r.json()) as { content?: Array<{ type?: string; text?: string }> };
            const summary = (j.content ?? [])
              .filter((c) => c?.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text)
              .join('\n');
            if (!summary) {
              maintenanceErrors++;
              sendJson(res, 502, {
                type: 'error',
                error: { type: 'api_error', message: 'maintenance/summarize: model returned no text content' },
                gateway: true,
              });
              return;
            }
            sendJson(res, 200, { ok: true, summary, model });
          } catch (e) {
            maintenanceErrors++;
            sendJson(res, 502, {
              type: 'error',
              error: { type: 'api_error', message: `maintenance/summarize: ${(e as Error).message}` },
              gateway: true,
            });
          }
        })
        .catch((e) =>
          sendJson(res, 500, {
            type: 'error',
            error: { type: 'api_error', message: `maintenance/summarize: ${(e as Error).message}` },
            gateway: true,
          }),
        );
      return;
    }
    if (req.method === 'GET' && requestPath === MAINTENANCE_BACKEND_CONTEXT_PATH) {
      // BACKEND CONTEXT PROBE (deterministic-context-carry P-005): report the LIVE per-slot
      // context window of the local backend serving `model`, from the backend's own /props —
      // the ground truth a hand-set registry contextWindow drifts away from (the 2026-07-13
      // three-way conflict: models.yml 200000 vs llama-server 204800 vs stale models.json 57344).
      // Read-only against the pool snapshot (no select(): no load-balance cursor advance, no
      // in-flight accounting) — an eligibility read, not a request placement.
      void (async () => {
        const model = new URL(url, 'http://localhost').searchParams.get('model')?.trim() ?? '';
        if (!model) {
          sendJson(res, 400, {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'maintenance/backend-context: `model` query param required',
            },
            gateway: true,
          });
          return;
        }
        const backend = deps.localBackends?.entries().find((b) => b.enabled && b.models.includes(model)) ?? null;
        if (!backend) {
          sendJson(res, 404, {
            type: 'error',
            error: {
              type: 'not_found_error',
              message: `maintenance/backend-context: no local backend serves model "${model}"`,
            },
            gateway: true,
          });
          return;
        }
        try {
          const doFetch = deps.fetchImpl ?? fetch;
          const upstream = await doFetch(`${backend.baseUrl}/props`, {
            signal: AbortSignal.timeout(BACKEND_CONTEXT_PROBE_TIMEOUT_MS),
          } as RequestInit);
          if (!upstream.ok) {
            sendJson(res, 502, {
              type: 'error',
              error: {
                type: 'api_error',
                message: `maintenance/backend-context: backend /props returned ${upstream.status}`,
              },
              gateway: true,
            });
            return;
          }
          const props = (await upstream.json()) as {
            default_generation_settings?: { n_ctx?: unknown };
            total_slots?: unknown;
          };
          const nCtx = Number(props?.default_generation_settings?.n_ctx);
          if (!Number.isFinite(nCtx) || nCtx <= 0) {
            sendJson(res, 502, {
              type: 'error',
              error: {
                type: 'api_error',
                message: 'maintenance/backend-context: backend /props carried no usable n_ctx',
              },
              gateway: true,
            });
            return;
          }
          const totalSlots = Number(props?.total_slots);
          sendJson(res, 200, {
            ok: true,
            model,
            backendId: backend.id,
            nCtx,
            totalSlots: Number.isFinite(totalSlots) && totalSlots > 0 ? totalSlots : null,
          });
        } catch (e) {
          sendJson(res, 502, {
            type: 'error',
            error: {
              type: 'api_error',
              message: `maintenance/backend-context: backend /props probe failed: ${(e as Error).message}`,
            },
            gateway: true,
          });
        }
      })().catch((e) =>
        sendJson(res, 500, {
          type: 'error',
          error: { type: 'api_error', message: `maintenance/backend-context: ${(e as Error).message}` },
          gateway: true,
        }),
      );
      return;
    }
    if (!url.startsWith('/v1/')) {
      sendJson(res, 404, {
        type: 'error',
        error: { type: 'not_found_error', message: 'inference-gateway only proxies /v1/*' },
        gateway: true,
      });
      return;
    }
    // LOCAL backend pool (D-002): llama-server/vllm/ollama's OpenAI-compatible surface is
    // `/v1/chat/completions` + `/v1/completions` — DISTINCT from `/v1/messages` (Anthropic) and
    // `/v1/responses` (Codex), so this never shadows the existing routes. Only intercepted when a
    // local-backend pool is actually wired; otherwise falls through unchanged (byte-identical to today).
    if (
      req.method === 'POST' &&
      deps.localBackends &&
      (url.startsWith('/v1/chat/completions') || url.startsWith('/v1/completions'))
    ) {
      const span = beginRequestTelemetry(req, res, 'local', 'openai-chat', 'local-http');
      span.setCacheRouting('not-applicable');
      span.routeSelected();
      const localUrl = url.startsWith('/v1/chat/completions') ? '/v1/chat/completions' : '/v1/completions';
      // P-011 / D-022: the FIRST lane off the strangler bridge, entered directly.
      //
      // `withDurableGatewayAdmission` still crosses the canonical durable governor before this
      // task runs, and that remains this lane's ONLY real admission — it has no queue of its
      // own — so `proxyLocal`'s PASS-THROUGH kernel admission is still correct, not scaffolding.
      //
      // The outer `span.admitted()` is deliberately GONE rather than lost: `proxyLocal` adopts
      // this very span (`requestSpan(req)`) and the kernel fires `span.admitted()` itself at its
      // admission boundary, so calling it here as well was double-marking one request.
      void withDurableGatewayAdmission({
        req,
        lane: gatewayLaneRegistry.localOpenAiChat,
        task: () => proxyLocal(req, res, localUrl),
      }).catch((e) => {
        if (respondGoalInferenceAdmissionRefusal(e, req, res, sendJson)) return;
        markRequestGatewayError(req);
        log('error', `inference-gateway: local-backend handler crashed: ${(e as Error).message}`);
        if (!res.headersSent)
          sendJson(res, 500, {
            type: 'error',
            error: { type: 'api_error', message: 'inference-gateway local-backend error' },
            gateway: true,
          });
        else res.destroy();
      });
      return;
    }
    // Codex CLI probes `/v1/models` before its first turn. The Codex response is
    // synthesized locally in proxyOpenAi, so it must not wait behind the shared
    // LLM admission queue; an Anthropic storm can otherwise starve metadata and
    // make healthy Codex agents fail before their first token.
    if (
      req.method === 'GET' &&
      requestPath === '/v1/models' &&
      providerForGatewayRequest(url, req.headers, providerAdapters, isCodexCliAccountId).id === 'codex'
    ) {
      // P-011 / D-027: entered directly. The /v1/models bypass is UNQUEUED by design (see the
      // comment above) and now SAYS SO in the one place that decides it: it hands
      // `proxyOpenAi` a PASS-THROUGH lane admission, so the entry takes no queue slot at all.
      // `withDurableGatewayAdmission` still runs, and its registered bypass key for
      // `GET /v1/models` is what keeps the durable governor out of a metadata probe's way.
      void withDurableGatewayAdmission({
        req,
        lane: providerAdapters.codex.lane,
        task: () => proxyOpenAi(req, res, url, passThroughLaneAdmission),
      }).catch((e) => {
        if (respondGoalInferenceAdmissionRefusal(e, req, res, sendJson)) return;
        codexUpstreamErrors++;
        log('error', `codex models handler crashed: ${(e as Error).message}`);
        if (!res.headersSent)
          sendJson(res, 500, {
            type: 'error',
            error: { type: 'api_error', message: 'inference-gateway Codex models error' },
            gateway: true,
          });
        else res.destroy();
      });
      return;
    }
    const priLabel = effectivePriorityLabel(req.headers);
    const pri = priorityFromLabel(priLabel);
    // Tier the request from its `x-papercusp-priority` role (only when the tier layer is on — `tierMap`
    // present). Passed to queue.run as `opts.tier`; it is IGNORED by the queue when the tier layer is off,
    // so this is a safe no-op under flag-OFF.
    // Route OpenAI-compatible Codex traffic to the Codex pool. `/v1/responses`
    // is unambiguously Codex; `/v1/models` is shared, so the request-aware
    // router uses a Codex account pin to keep Codex model discovery off the
    // Anthropic proxy while preserving Claude model probes.
    const inferredProvider: GatewayTelemetryProvider = url.startsWith('/v1/responses') ? 'codex' : 'claude';
    const stageSpan =
      req.method === 'POST'
        ? beginRequestTelemetry(
            req,
            res,
            inferredProvider,
            inferredProvider === 'codex' ? 'openai-responses' : 'anthropic-messages',
          )
        : undefined;
    stageSpan?.setCacheRouting(cachePolicyEnabled ? 'unchanged' : 'disabled');
    const providerAdapter = providerForGatewayRequest(url, req.headers, providerAdapters, isCodexCliAccountId);
    const providerId = providerAdapter.id;
    stageSpan?.routeSelected();
    const requestTierMap = providerId === 'codex' ? codexTierMap : tierMap;
    const tier = requestTierMap ? tierOf(priLabel, requestTierMap) : undefined;
    const admissionQueue = providerId === 'codex' ? codexQueue : queue;
    const providerAdmissionObservation = () => ({
      priority: pri,
      tier: tier ?? null,
      queue: admissionQueue.snapshot(),
    });
    const markProviderAdmitted = () => {
      // D-023: `stageSpan?.admitted()` is deliberately NOT called here. The kernel fires
      // `span.admitted()` itself as the first statement inside `admission.run`'s callback
      // (request-kernel.ts:888) on THIS span, which every handler adopts via `requestSpan(req)`
      // (D-008) — so marking it here as well double-marked one request. The identical duplicate
      // was already removed on the local lane. `admissionAdmitted('provider', ...)` has no
      // kernel equivalent and MUST stay.
      stageSpan?.admissionAdmitted('provider', providerAdmissionObservation());
    };
    /**
     * P-011 / D-023 / D-027 — the lane's REAL admission controller. It is handed to the entry
     * handler, which invokes it ONCE around everything it does.
     *
     * The CONTROLLER, not the call site, owns what happens inside the slot: after re-homing
     * the call site is OUTSIDE it. So `admissionQueued` is recorded before the queue is
     * entered, and everything that must be true only of an ADMITTED request happens within
     * `admissionQueue.run`.
     *
     * Claude registers itself in `inFlightReg` after parsing its request and acquiring its
     * per-account governor. Codex has no equivalent inner registration point, so the whole
     * admitted handler is wrapped here — which is what lets the shared self-heal valve reclaim
     * a wedged ChatGPT OAuth/bearer/CLI request instead of seeing an untracked held slot.
     * Registering OUTSIDE the slot would be worse than not registering at all: the valve reads
     * `inFlightReg` for `oldestHeldSlotAgeMs` and for reclaim targeting, so a merely-QUEUED
     * request there could be destroyed while holding no slot.
     */
    const runProviderLaneTask = <TResult>(task: () => Promise<TResult>): Promise<TResult> => {
      stageSpan?.admissionQueued('provider', providerAdmissionObservation());
      // TELL THE QUEUE WHEN THE CALLER IS GONE (WI-2140943). Without this the admission queue has no
      // way to learn that a request it is holding has no client left, so an abandoned waiter ages in
      // place, outranks live traffic, and eventually spends a real slot on nobody — the ratchet that
      // put 1,206 dead entries in front of the owner's desktop sessions on 2026-09-02.
      //
      // `res.on('close')` also fires on NORMAL completion, which is safe here for two independent
      // reasons: by then the waiter has been admitted, and the queue's abort handler no-ops for any
      // waiter it can no longer find; plus the `writableEnded` guard skips a cleanly finished
      // response. Aborting is only ever meaningful while the request is still WAITING.
      const abandoned = new AbortController();
      const onCallerGone = () => {
        if (!res.writableEnded) abandoned.abort();
      };
      req.on('aborted', onCallerGone);
      res.on('close', onCallerGone);
      const detach = () => {
        req.off('aborted', onCallerGone);
        res.off('close', onCallerGone);
      };
      return admissionQueue
        .run(
          pri,
          async () => {
            markProviderAdmitted();
            if (providerId !== 'codex') return task();
            const reqId = ++reqSeq;
            inFlightReg.set(reqId, {
              id: reqId,
              provider: 'codex',
              startedAt: Date.now(),
              isStream: url.startsWith('/v1/responses'),
              reclaimed: false,
              abort: () => {
                // Destroying either side triggers proxyOpenAi's existing request-aborted/response-close
                // listeners, which abort the current upstream fetch. Do not attach an Error here: an
                // IncomingMessage with no error listener would turn a recovery action into an uncaught event.
                try {
                  req.destroy();
                } catch {
                  /* already torn down */
                }
                try {
                  res.destroy();
                } catch {
                  /* already torn down */
                }
              },
            });
            try {
              return await task();
            } finally {
              const entry = inFlightReg.get(reqId);
              if (entry) {
                inFlightReg.delete(reqId);
                if (!entry.reclaimed) lastDrainAt.codex = Date.now();
              }
            }
          },
          { signal: abandoned.signal, ...(tier !== undefined ? { tier } : {}) },
        )
        .finally(detach);
    };
    const providerLaneAdmission: GatewayLaneAdmission = {
      run: async (_context, initialTask) => {
        let task = initialTask;
        for (;;) {
          try {
            return await runProviderLaneTask(task);
          } catch (error) {
            if (!(error instanceof GatewayLanePark)) throw error;
            await error.wait();
            task = error.resume as typeof task;
          }
        }
      },
      park: async (wait, resume) => {
        throw new GatewayLanePark(wait, resume);
      },
    };
    // P-011 / D-027: the last two lanes left the strangler bridge together. They share one
    // lane descriptor (`providerAdapters.codex.lane` IS `lanes.openaiResponses`), so re-homing
    // covered the provider path and the `/v1/models` bypass in one atomic step (D-023); they
    // were not independently shippable.
    // Entered directly, exactly as `local-openai-chat` already is: `withDurableGatewayAdmission`
    // still crosses the canonical durable governor (D-004's spool, deadline and payload pin),
    // and the LANE-level slot is taken by `providerLaneAdmission` at the handler's own entry.
    withDurableGatewayAdmission({
      req,
      lane: providerAdapter.lane,
      task: () =>
        providerId === 'codex'
          ? proxyOpenAi(req, res, url, providerLaneAdmission)
          : proxy(req, res, url, providerLaneAdmission),
    }).catch((e) => {
      if (respondGoalInferenceAdmissionRefusal(e, req, res, sendJson)) return;
      // D-003 permits a request to fail for invalid input or an inability to persist truthfully —
      // and for nothing else. These two branches are those cases; both happen BEFORE admission, so
      // no receipt exists and no upstream work has started.
      if (e instanceof PayloadTooLargeError) {
        req.resume(); // the body was over the cap: drain the socket rather than leak it
        if (!res.headersSent) {
          sendJson(
            res,
            413,
            {
              type: 'error',
              error: { type: 'invalid_request_error', message: e.message },
              gateway: true,
            },
            { connection: 'close' },
          );
        }
        return;
      }
      if (e instanceof PayloadSpoolPersistenceError) {
        // Truthful refusal: the body could not be persisted, so an accepted receipt would be a lie.
        // This is the ONE capacity-shaped failure D-003 still allows, and it is deliberately a 503
        // (the durable path is unavailable) rather than the 429 backlog signal below.
        log('warn', `inference-gateway: refusing request — payload spool unavailable: ${e.message}`);
        req.resume();
        if (!res.headersSent) {
          sendJson(
            res,
            503,
            {
              type: 'error',
              error: {
                type: 'overloaded_error',
                message: 'inference-gateway: request body could not be persisted; retry shortly',
              },
              gateway: true,
            },
            { 'retry-after': String(LOADSHED_RETRY_AFTER_SEC), connection: 'close' },
          );
        }
        return;
      }
      // EI-22708683358025859: the durable admission ledger is the second
      // pre-upstream persistence boundary, after the payload spool. A bounded
      // PG transaction or connection-acquire timeout here used to miss the
      // spool-specific branch above and fall into the generic crash backstop
      // below, producing an opaque, terminal 500 with x-should-retry:false.
      // No upstream work has started when admission cannot be recorded, so
      // report the same truthful persistence-unavailable contract as a spool
      // failure and let the client retry once the control store recovers.
      if (
        e instanceof AdmissionPersistenceError ||
        e instanceof OrgTxnTimeoutError ||
        e instanceof DbCallDeadlineError
      ) {
        log('warn', `inference-gateway: refusing request — durable admission persistence unavailable: ${e.message}`);
        req.resume();
        if (!res.headersSent) {
          sendJson(
            res,
            503,
            {
              type: 'error',
              error: {
                type: 'overloaded_error',
                message: 'inference-gateway: durable admission persistence unavailable; retry shortly',
              },
              gateway: true,
            },
            {
              'retry-after': String(LOADSHED_RETRY_AFTER_SEC),
              'x-should-retry': 'true',
              connection: 'close',
            },
          );
        } else if (!res.destroyed) {
          res.destroy();
        }
        return;
      }
      // Load-shed (queue at maxQueued): a retryable 429 + retry-after, NOT a crash — this is the
      // backpressure that keeps the gateway responsive + self-recovering under a sustained throttle
      // instead of growing an unbounded backlog until it wedges.
      // D-003: once a payload spool is configured this is the PERSISTENCE-UNAVAILABLE fallback, not
      // the primary backpressure — accepted capacity pressure becomes a durable receipt instead.
      if (e instanceof QueueFullError) {
        shed429++;
        markRequestShed(req);
        recordOwnerOutcome((req.headers[OWNER_HEADER] as string | undefined)?.trim() || undefined, 'shed', {
          detail: 'queue full (backlog cap)',
        }); // P-008 ledger
        // proxy() never ran, so the request body was never consumed — drain it (and close the
        // connection) or the unread socket stays busy and can't be released cleanly (leaks sockets;
        // hangs a graceful server.close()).
        req.resume();
        if (!res.headersSent) {
          sendJson(
            res,
            429,
            {
              type: 'error',
              error: {
                type: 'rate_limit_error',
                message: `inference-gateway: backlog full (${admissionQueue.snapshot().queued} waiting); shedding load, retry shortly`,
              },
              gateway: true,
            },
            { 'retry-after': String(LOADSHED_RETRY_AFTER_SEC), connection: 'close' },
          );
        }
        return;
      }
      // P-005: a CLIENT abort (bee interrupted / connection dropped mid-request, OR a caller that
      // gave up while still QUEUED) is not a gateway crash — see classifyProxyHandlerError. The old
      // unconditional `proxy handler crashed: aborted` error-spam made every starved/interrupted
      // caller read as a gateway fault in the journal (8-at-a-time bursts during the 2026-07-01
      // tier-5 starvation were exactly this). A later `&& res.headersSent` gate fixed only the
      // POST-headers case and still misread a PRE-headers abort as a crash → `upstreamErrors++` +
      // an HTTP 500 "inference-gateway internal error" (the storm + agent-visible 500s under
      // fan-out — the "gateway fails at a few agents" report). Now benign whether or not headers
      // were sent. Keep the loud error for REAL handler/upstream faults.
      const msg = (e as Error).message ?? '';
      if (classifyProxyHandlerError(msg, res) === 'client-abort') {
        log('info', `proxy request ended early (client abort / stream torn down): ${msg}`);
        if (!res.destroyed) res.destroy();
        return;
      }
      upstreamErrors++;
      markRequestGatewayError(req);
      log('error', `proxy handler crashed: ${msg}`);
      if (!res.headersSent)
        // EI-21922950476359370: this is the THIRD exhaustion exit that the EI-21921571654476580
        // fix (see the two `x-should-retry:'false'` overrides above, at the 429/529 forwarding
        // sites) didn't reach — a genuinely unclassified crash in the request handler, with no
        // upstream response to forward at all. It carried NO retry-signaling header, so a
        // downstream SDK's own default (500 is one of the Anthropic SDK's retryable statuses)
        // silently retried it — indistinguishable, from the caller's side, from "throttled,
        // retrying" (the exact "Working..." forever symptom this whole class of bug produces).
        // Unlike the 429/529 exits this has no `attemptsUsed` to report (it is the OUTERMOST
        // backstop, reached before or outside any per-attempt retry ladder), but the same
        // principle applies: a bare gateway-internal crash will almost certainly reproduce
        // identically on a blind retry of the SAME request, so telling the SDK not to retry it
        // automatically — and surfacing the failure to the caller instead of silently absorbing
        // it — is strictly more informative than silence.
        sendJson(
          res,
          500,
          {
            type: 'error',
            error: { type: 'api_error', message: 'inference-gateway internal error' },
            gateway: true,
          },
          { 'x-should-retry': 'false' },
        );
      else res.destroy();
    });
  };

  const loopbackPeerGate = deps.loopbackPeerGate ?? ((socket: NetSocket) => foreignLoopbackPeerForSocket(socket));
  const server = http.createServer((req, res) => {
    // WI-10003621: loopback is shared with the customer account on a hosted workspace host, so
    // the bind address is not a boundary there. Refuse a non-service uid before any route runs.
    const foreignPeer = loopbackPeerGate(req.socket);
    if (foreignPeer) {
      sendJson(res, 403, {
        type: 'error',
        error: {
          type: 'permission_error',
          message: 'inference-gateway: loopback callers other than the operator service account are refused on this host',
        },
        reason: foreignPeer.reason,
        gateway: true,
      });
      return;
    }
    const bypassKey = gatewayAdmissionBypassKeyForRequest(req.method, req.url);
    const requestPath = (req.url ?? '/').split('?', 1)[0] || '/';
    const isMaintenanceSummarize = req.method === 'POST' && requestPath === MAINTENANCE_SUMMARIZE_PATH;
    if (!bypassKey && !isMaintenanceSummarize) {
      dispatchRequest(req, res);
      return;
    }

    // Maintenance is a real control operation (and may launch a hosted model
    // request), so it gets a normal canonical admission.  Cheap health,
    // metadata, and admin surfaces carry an explicitly registered bypass key;
    // the Governor, rather than the router, is the authority that authorizes it.
    const kind = bypassKey ? gatewayAdmissionKindForBypassKey(bypassKey) : 'maintenance';
    const input = gatewayAdmissionInputForRequest(
      req,
      kind,
      bypassKey ?? undefined,
      isMaintenanceSummarize ? { deadlineAtMs: Date.now() + maintenanceTimeoutMs } : undefined,
    );
    void runServerAdmission(res, input, () => dispatchRequest(req, res)).catch((e) => {
      if (res.headersSent || res.writableEnded || res.destroyed) {
        if (!res.destroyed) res.destroy();
        return;
      }
      const code = (e as { code?: string } | undefined)?.code;
      const status = code === 'ADMISSION_INVALID_REQUEST' ? 400 : code === 'ADMISSION_BYPASS_UNAUTHORIZED' ? 500 : 503;
      sendJson(res, status, {
        type: 'error',
        error: {
          type: status === 400 ? 'invalid_request_error' : 'api_error',
          message: `inference-gateway admission failed: ${(e as Error)?.message ?? 'unknown error'}`,
        },
        gateway: true,
      });
    });
  });

  // Self-heal release-valve sweeper (EI-2086): tick the pure decider against live admission metrics +
  // the in-flight registry and reclaim the oldest stuck slot to pre-empt the watchdog's full restart.
  // unref'd so it never keeps the process alive; cleared on close().
  let selfHealTimer: ManagedHandle | undefined;
  if (selfHealEnabled) {
    selfHealTimer = managedSetInterval(
      EXTERNAL_SCHEDULES.gatewaySelfHeal.name,
      selfHealPollMs,
      () => {
        try {
          // Read both queue snapshots directly (NOT stats(), which performs broader health work).
          const claudeAdmission = queue.snapshot();
          const codexAdmission = codexQueue.snapshot();
          const now = Date.now();
          const providerStates = [
            { provider: 'claude' as const, admission: claudeAdmission },
            { provider: 'codex' as const, admission: codexAdmission },
          ];
          // Evaluate each provider against its OWN cap and drain clock. Aggregating caps would hide a wedged
          // four-slot Codex queue behind a healthy 24-slot Claude queue; sharing one drain clock would let
          // active Claude completions indefinitely mask a frozen ChatGPT stream.
          const reclaimable = providerStates
            .map((state) => ({
              ...state,
              decision: evaluateSelfHeal(
                {
                  inFlight: state.admission.running,
                  queueDepth: state.admission.queued,
                  maxConcurrent: state.admission.maxConcurrent,
                  msSinceLastDrain: now - lastDrainAt[state.provider],
                },
                selfHealFreezeMs,
              ),
            }))
            .filter((state) => state.decision.reclaim)
            .sort((a, b) => b.admission.queued - a.admission.queued);
          const running = claudeAdmission.running + codexAdmission.running;
          const maxConcurrent = claudeAdmission.maxConcurrent + codexAdmission.maxConcurrent;
          const tracked = inFlightReg.size; // requests registered live in the self-heal registry
          const selected = reclaimable[0];
          const target = selected
            ? pickReclaimTarget([...inFlightReg.values()].filter((entry) => entry.provider === selected.provider))
            : null;

          // ── P-005/W3 slot-leak RECURRENCE GUARD (D-001) ─────────────────────────────────────────────
          // Cross-check the two INDEPENDENT in-flight accountings that must move together: the queue's held-
          // slot counter (`running`) and the self-heal registry (`tracked`). The pure classifier flags only
          // the two shapes that cannot be a healthy transient (see classifySlotReconcile). This is telemetry
          // only — it NEVER throws (a guard must not crash the gateway); the de-bounce + counter + log below
          // are the stateful half the pure classifier deliberately leaves to the sweeper.
          const reconcileViolation = classifySlotReconcile({
            running,
            tracked,
            wantsReclaim: reclaimable.length > 0,
            hasReclaimTarget: !!target,
          });
          if (reconcileViolation) {
            slotReconcileConsecutive++;
            // De-bounce: only a violation SUSTAINED across ≥2 sweeps counts — skips the documented 1-tick
            // delete/admit race where the registry is momentarily empty while a slot is between requests.
            if (slotReconcileConsecutive >= 2) {
              slotReconcileMismatch++;
              if (!slotReconcileLogged) {
                slotReconcileLogged = true; // log ONCE per contiguous streak (never a log storm)
                log(
                  'error',
                  `inference-gateway: SLOT-RECONCILE mismatch (${reconcileViolation}) — held=${running} tracked=${tracked} maxConcurrent=${maxConcurrent} maxMsSinceDrain=${Math.round(Math.max(now - lastDrainAt.claude, now - lastDrainAt.codex) / 1000)}s: a leaked admission slot the self-heal valve cannot reclaim (mismatch #${slotReconcileMismatch})`,
                );
              }
            }
          } else {
            slotReconcileConsecutive = 0;
            slotReconcileLogged = false; // reset so the next distinct streak logs afresh
          }
          // ────────────────────────────────────────────────────────────────────────────────────────────

          if (!selected) return;
          if (!target) return; // saturated per the counters but the registry is momentarily empty — skip
          target.reclaimed = true;
          selfHealReclaims++;
          log(
            'error',
            `inference-gateway: SELF-HEAL release valve — ${selected.provider}: ${selected.decision.reason} (slot #${target.id}, held ${Math.round((Date.now() - target.startedAt) / 1000)}s, stream=${target.isStream}; reclaim #${selfHealReclaims})`,
          );
          target.abort('inference-gateway self-heal: reclaiming wedged slot to pre-empt watchdog restart');
        } catch (e) {
          log('warn', `inference-gateway: self-heal sweep error: ${(e as Error).message}`);
        }
      },
      {
        category: EXTERNAL_SCHEDULES.gatewaySelfHeal.category,
        classification: EXTERNAL_SCHEDULES.gatewaySelfHeal.classification,
        allowInTest: true,
      },
    );
  }

  return {
    server,
    stats,
    // DYNAMIC OWNER PIN seeding (account-dynamic-pin-2026-06-29): replace the in-memory owner→account pin map
    // from the durable DB store. Called by the launch layer at startup + on its pool-reload poll so pins
    // SURVIVE a gateway restart. The /admin/owner-pin endpoint still applies single-pin changes immediately.
    setOwnerPins(pins: ReadonlyArray<{ ownerId: string; account: string; hard?: boolean }>): void {
      ownerPinMap.clear();
      for (const p of pins) {
        if (p?.ownerId && p?.account) {
          ownerPinMap.set(p.ownerId, { accountId: p.account, hard: p.hard === true, setAt: Date.now() });
        }
      }
    },
    // COLD-START RATE SEED (account-cold-start-seed-2026-06-29): replace the durable per-account rate hint
    // keyOf consults right after a restart (before the live governor has learned each account's state).
    setAccountRateHints(
      hints: ReadonlyArray<{
        accountId: string;
        pausedUntil?: number;
        utilization?: number;
        utilization7d?: number;
        windowResetAt?: number;
        windowResetAt7d?: number;
        burnAction?: AccountBurnAction;
        /** When the store took the reading (`utilizationAt`); gates the store↔pool park reconciliation. */
        readingAt?: number;
        usageCreditsAvailable?: boolean;
      }>,
    ): void {
      accountRateHints.clear();
      for (const h of hints) {
        if (h?.accountId) {
          accountRateHints.set(h.accountId, {
            pausedUntil: h.pausedUntil,
            utilization: h.utilization,
            utilization7d: h.utilization7d,
            windowResetAt: h.windowResetAt,
            windowResetAt7d: h.windowResetAt7d,
            burnAction: h.burnAction,
            readingAt: h.readingAt,
            usageCreditsAvailable: h.usageCreditsAvailable,
          });
        }
      }
      // P-008: the store just spoke — let any park it contradicts (with a NEWER reading) clear now,
      // so routing looks at the same system that knows which accounts are available.
      reconcileParksWithStore();
    },
    listen(port = 0): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          const p = typeof addr === 'object' && addr ? addr.port : port;
          log(
            'info',
            `inference-gateway listening on 127.0.0.1:${p} → ${upstreamBase} (account ${(pool.peek ? pool.peek() : pool.active()).accountId})`,
          );
          resolve(p);
        });
      });
    },
    port(): number {
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : 0;
    },
    close(): Promise<void> {
      selfHealTimer?.stop();
      if (serviceableClampTimer) clearInterval(serviceableClampTimer);
      proactiveProbeHandle?.stop();
      // Tear down any per-account egress dispatchers (best-effort; they hold sockets).
      for (const d of dispatcherCache.values()) void (d as { close?: () => Promise<void> }).close?.();
      dispatcherCache.clear();
      // PROMPT shutdown (2026-06-22 audit): server.close() alone waits for EVERY in-flight connection — but
      // Claude responses are long-lived SSE streams, so it hung past systemd's TimeoutStopSec and got
      // force-killed (orphaned node in the cgroup, slow restarts). Stop accepting + drop idle keep-alives
      // now, then after GRACEFUL_SHUTDOWN_MS destroy any still-streaming connection so we exit promptly.
      const srv = server as http.Server & { closeIdleConnections?: () => void; closeAllConnections?: () => void };
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        srv.close(() => finish());
        try {
          srv.closeIdleConnections?.();
        } catch {
          /* older node / already closing */
        }
        const t = setTimeout(() => {
          try {
            srv.closeAllConnections?.();
          } catch {
            /* older node */
          }
          finish();
        }, GRACEFUL_SHUTDOWN_MS);
        t.unref?.();
      });
    },
  };
}

export type InferenceGateway = ReturnType<typeof createInferenceGateway>;
