/**
 * Codex CLI-exec lane adapter for the provider-neutral request kernel.
 *
 * Plan `gateway-kernel-adoption-2026-08-29`, P-005 — the THIRD
 * `GatewayKernelAdapter`, expressing the transport-owned half of
 * `serveCodexCliBridge` (`openai-responses` lane, `cli-exec` transport):
 * account selection, the nested `codex exec` run, credential-death
 * quarantine, and retryability normalization.
 *
 * Everything else belongs to `executeGatewayRequestKernel` and is deliberately
 * absent here: abort wiring, the request ceiling, attempt counting, failover
 * bookkeeping, admission, and in-flight registration.
 *
 * THREE THINGS THIS LANE DOES THAT THE OAUTH LANE (P-004) DOES NOT:
 *
 *  1. IT HAS NO SAME-ACCOUNT RE-ATTEMPT, so it implements no `selectReattempt`
 *     (D-011). The OAuth lane refreshes a token or moves to a sibling egress IP
 *     on the SAME account; a `codex exec` run has neither — the credential lives
 *     in the CODEX_HOME and there is no egress binding to swap. Every retry on
 *     this lane is therefore an ACCOUNT change, which is why a hard pin reduces
 *     it to exactly one attempt.
 *
 *  2. ITS QUARANTINE IS UNCONDITIONAL AND OUTLIVES THE REQUEST. A quota wall
 *     parks the account for `failoverBackoffMs`; credential death parks it for
 *     `authQuarantineMs` EVEN ON THE LAST ATTEMPT, when no retry remains
 *     (EI-21618978789879488 — before that fix `available` only ever described
 *     quota, so an auth-dead home was re-chosen on the very next request,
 *     forever). "Even on the last attempt" is exactly the case the kernel does
 *     NOT consult `selectFailover` for, so this cannot live in `selectFailover`:
 *     it runs from `noteAttemptFailure`, which the caller drives from
 *     `admission.observeAttempt` — the one hook the kernel guarantees fires once
 *     per attempt regardless of retryability or pin.
 *
 *  3. IT NEVER CALLS `pool.active()` (D-010). `proxyOpenAi` has already spent
 *     this request's one `codexCliPool.active()` call to resolve the account
 *     before the handler is entered, and `active()` ADVANCES the round-robin.
 *     Like the OAuth adapter, this one takes the resolved account as
 *     `initialAccount` and never selects an initial account at all.
 *
 * SCOPE BOUNDARY: this adapter runs a BUFFERED subprocess and returns its
 * completed result. Opening the SSE stream BEFORE the run — the behaviour that
 * keeps a multi-minute turn's socket alive — is a DOWNSTREAM concern and stays
 * with the caller, which owns `downstream`. That is what lets this lane keep its
 * stream-open-then-retry-underneath shape without the kernel having to commit a
 * response before an attempt has been chosen.
 */
import type { GatewayTransportId } from './provider-adapters';
import type { AccountPool } from './provider-contracts';
import type { CodexCliAccount, CodexCliRunOpts, CodexCliRunResult } from './codex-cli-bridge';
import {
  GatewayRequestKernelError,
  type GatewayKernelAdapter,
  type GatewayKernelAttemptContext,
  type GatewayKernelRoute,
  type GatewayKernelRouteContext,
  type GatewayKernelUpstreamResponse,
} from './request-kernel';

const CLI_TRANSPORT: GatewayTransportId = 'cli-exec';

/** Why a route exists. Keeps every route key distinct, which is what the
 *  kernel's route-cycle guard reads. */
export type CodexCliRouteReason = 'initial' | 'rotate';

export interface CodexCliRouteValue {
  account: CodexCliAccount;
  reason: CodexCliRouteReason;
}

export type CodexCliChunk = Uint8Array;

export interface CodexCliResponseMetadata {
  /** Account that actually served the attempt (`x-papercusp-routed-account`). */
  accountId: string;
  /** The completed run — the caller adapts it to JSON or to the SSE wire. */
  result: CodexCliRunResult;
  /** Set when a SOFT pin was yielded to a different account. */
  pinYieldedFrom: string | null;
}

/** What one failed attempt did to selection. Returned so the caller can log and
 *  count exactly what the live catch block logged and counted. */
export interface CodexCliAttemptFailureOutcome {
  /** The failure was credential death, not a quota wall. */
  authClass: boolean;
  /** The account this failure parked, if any. */
  parkedAccountId: string | null;
  /** The account a retry would move to, if one is available and permitted. */
  nextAccountId: string | null;
}

export interface CodexCliKernelAdapterDeps {
  /** The account the CALLER already resolved (D-010). */
  initialAccount: CodexCliAccount;
  /** Re-read per rotation, exactly as the live handler re-reads `codexCliAccounts()`. */
  accounts: () => readonly CodexCliAccount[];
  pool: Pick<AccountPool, 'onExhausted'> | null;
  run: (opts: CodexCliRunOpts) => Promise<CodexCliRunResult>;
  model: string;
  effort: string;
  /** Full prompt text, instructions already prepended by the caller. */
  prompt: string;
  /** Hard wall-clock cap handed to the run; the kernel owns the request ceiling. */
  timeoutMs: number;
  /** Credential death parks an account for this long — deliberately longer than a rate wall. */
  authQuarantineMs: number;
  /** A quota wall parks an account for this long. */
  failoverBackoffMs: number;
  isAuthFailure: (detail: string) => boolean;
  /** A hard pin forbids leaving the account — and, matching the live handler,
   *  also suppresses the quarantine, because parking the only permitted account
   *  would strand the pin rather than route around it. */
  hardPin: boolean;
  pinnedAccountId: string | null;
  /**
   * Whether the downstream response has ALREADY been committed (the SSE head is
   * open). When it has, a terminal failure is a GATEWAY error, not merely an
   * upstream one: the client was told 200 and then not served, so finalizing the
   * span as `upstream-error` would record it beside honest upstream failures and
   * `ok` would be worse still. The kernel finalizes the span from the terminal
   * error's own `outcome` (`request-kernel.ts:1036`, in a `finally` that runs
   * before the caller's catch), so this has to be decided HERE — marking the
   * request afterwards is a no-op against an already-finished span.
   *
   * Only ever read on the terminal failure; a mid-ladder failure that a later
   * attempt recovers takes its outcome from the successful response instead.
   */
  responseCommitted?: () => boolean;
  now?: () => number;
}

export interface CodexCliKernelAdapter
  extends GatewayKernelAdapter<CodexCliRouteValue, CodexCliRouteValue, CodexCliChunk, CodexCliResponseMetadata> {
  /**
   * The live catch block's selection side-effects, run ONCE per failed attempt.
   *
   * Drive this from `admission.observeAttempt`, NOT from `selectFailover`: the
   * kernel skips `selectFailover` on the final attempt and under a hard pin,
   * and the auth quarantine has to happen in both of those cases. Calling it
   * twice for one attempt would double-park an account, so it memoizes the
   * next-account decision that `selectFailover` then consumes.
   */
  noteAttemptFailure(input: {
    accountId: string;
    attempt: number;
    maxAttempts: number;
    message: string;
    aborted: boolean;
  }): CodexCliAttemptFailureOutcome;
}

const routeKey = (accountId: string, reason: CodexCliRouteReason, attempt: number): string =>
  reason === 'initial' ? `cli:${accountId}` : `cli:${accountId}#${reason}${attempt}`;

const toRoute = (value: CodexCliRouteValue, attempt: number): GatewayKernelRoute<CodexCliRouteValue> => ({
  key: routeKey(value.account.accountId, value.reason, attempt),
  accountId: value.account.accountId,
  transport: CLI_TRANSPORT,
  value,
});

export function createCodexCliKernelAdapter(deps: CodexCliKernelAdapterDeps): CodexCliKernelAdapter {
  const now = deps.now ?? Date.now;
  /** Set by `noteAttemptFailure`, consumed by the `selectFailover` that follows it. */
  let pendingNext: CodexCliAccount | null = null;
  let pendingForAttempt = -1;

  return {
    selectInitial() {
      return toRoute({ account: deps.initialAccount, reason: 'initial' }, 1);
    },

    selectFailover(context: GatewayKernelRouteContext<CodexCliRouteValue, CodexCliChunk, CodexCliResponseMetadata>) {
      // The kernel already returned null for a hard pin before reaching here
      // (D-006 invariant 1), so this never needs to re-check `hardPin`.
      //
      // Selection was decided by `noteAttemptFailure` at the moment of failure —
      // re-deciding it here would call `onExhausted` a second time for one
      // attempt, parking an extra account per retry.
      if (pendingForAttempt !== context.attempt) return null;
      const next = pendingNext;
      pendingNext = null;
      if (!next) return null;
      if (next.accountId === context.currentRoute?.accountId) return null;
      return toRoute({ account: next, reason: 'rotate' }, context.attempt + 1);
    },

    prepareAttempt(context: GatewayKernelAttemptContext<CodexCliRouteValue>) {
      // The CLI home encapsulates its own credential: there is no token to
      // resolve, no header to build and no URL to construct. The live handler
      // marks the auth stage as a zero-width seam for exactly this reason, and
      // that stage marking belongs to the caller's span, not to the adapter.
      return context.route.value;
    },

    async executeAttempt(
      prepared: CodexCliRouteValue,
      context: GatewayKernelAttemptContext<CodexCliRouteValue>,
    ): Promise<GatewayKernelUpstreamResponse<CodexCliChunk, CodexCliResponseMetadata>> {
      let result: CodexCliRunResult;
      try {
        result = await deps.run({
          home: prepared.account.home,
          model: deps.model,
          effort: deps.effort,
          prompt: deps.prompt,
          timeoutMs: deps.timeoutMs,
          signal: context.signal,
        });
      } catch (error) {
        // Normalized at the transport boundary, as the kernel contract requires.
        // `retryable` states only that a RETRY IS PERMISSIBLE; whether one is
        // available is `selectFailover`'s answer, and whether one is attempted
        // at all is the kernel's. A hard pin is not consulted here for that
        // reason — the kernel suppresses the failover itself.
        const committed = deps.responseCommitted?.() ?? false;
        throw new GatewayRequestKernelError(
          `inference-gateway: codex-cli bridge failed: ${(error as Error).message}`,
          {
            code: 'upstream-error',
            // `retryable` is unaffected by commitment — the ladder still runs
            // underneath an open stream, exactly as the hand-rolled loop did.
            outcome: committed ? 'gateway-error' : 'upstream-error',
            status: 502,
            retryable: true,
            cause: error,
          },
        );
      }

      const accountId = prepared.account.accountId;
      const pinYieldedFrom =
        deps.pinnedAccountId && !deps.hardPin && deps.pinnedAccountId !== accountId ? deps.pinnedAccountId : null;

      return {
        status: 200,
        // The nested run is buffered. Whether the WIRE streams is the caller's
        // contract with its client, not this transport's with the CLI, so the
        // caller sets it on the span and adapts the payload; the kernel is told
        // the truth about the upstream.
        streaming: false,
        transport: CLI_TRANSPORT,
        metadata: { accountId, result, pinYieldedFrom },
        // The caller owns serialization (JSON body vs Responses SSE frames), so
        // the payload travels as metadata and the relay carries no chunks.
        body: null,
      };
    },

    noteAttemptFailure({ accountId, attempt, maxAttempts, message, aborted }): CodexCliAttemptFailureOutcome {
      const authClass = deps.isAuthFailure(message);
      // Live parity: a retry is permissible while attempts remain, the pin is not
      // hard, and the downstream has not hung up.
      const canRetry = attempt < maxAttempts && !deps.hardPin && !aborted;

      // Credential death is parked UNCONDITIONALLY — that is the whole point of
      // EI-21618978789879488. A quota wall is parked only when a retry is
      // actually going to consume the rotation.
      const parkUntil = authClass ? now() + deps.authQuarantineMs : canRetry ? now() + deps.failoverBackoffMs : null;
      const park = authClass ? !deps.hardPin : canRetry;

      const exhausted = park && parkUntil !== null ? (deps.pool?.onExhausted(accountId, parkUntil) ?? null) : null;
      const next = canRetry ? exhausted : null;
      const nextAccount = next ? (deps.accounts().find((a) => a.accountId === next.accountId) ?? null) : null;

      pendingNext = nextAccount && nextAccount.accountId !== accountId ? nextAccount : null;
      pendingForAttempt = attempt;

      return {
        authClass,
        parkedAccountId: park ? accountId : null,
        nextAccountId: pendingNext?.accountId ?? null,
      };
    },
  };
}
