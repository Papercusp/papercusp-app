/**
 * db:txn-timeouts — read/set/reset the per-workspace transaction timeouts at runtime
 * (live-configurability-audit-2026-06-20 P-020).
 *
 * Every state-mutating tool runs through @papercusp/locks' inWorkspaceTxn, which SETs a per-txn
 * lock_timeout (pg_advisory_xact_lock wait cap) + statement_timeout — baked at 5s/5s. Those decide
 * whether a same-workspace contention wait or a slow statement is killed (PG 55P03 / 57014 →
 * WorkspaceContendedError). This makes them settable live: mid-incident, raise lockTimeoutMs to ride
 * out same-workspace contention, or raise statementTimeoutMs to let a legitimately-slow mutation
 * finish — without a deploy through the very txn path you're tuning. Merged over the baked defaults;
 * an empty override (or the kill-switch flag OFF) is byte-identical. Audited + one-call-revertible.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import { pgbouncerEnabled, buildConnectionOptions, getOrgPg } from '@papercusp/db-org';
import { withBoundedTimeout } from '../../bounded-timeout';
import {
  TXN_TIMEOUTS_DEFAULTS,
  txnTimeoutsConfig,
  adminPoolStatementTimeoutMs,
  readTxnTimeoutsOverride,
  setTxnTimeoutsOverride,
  setTxnTimeoutsOverrideFull,
  resetTxnTimeoutsOverride,
  type TxnTimeoutsOverride,
} from '../../txn-timeouts-config';

// Canonical `{ data }` ToolResponse — the framework owns wire encoding (tool-data-shape-ratchet).
function json(obj: unknown) {
  return { data: obj };
}

/**
 * EI-21866253550551759 — applied-vs-stored for the WI-832 admin-pool cap.
 *
 * `adminPoolStatementTimeoutMs` is a CONNECT-TIME GUC, so a stored value is NOT
 * evidence that anything is bounded. Two independent gates can swallow it silently:
 *   1. the papercusp-txn-timeouts-config kill-switch — OFF ⇒ the resolver returns 0
 *      however large the stored value is;
 *   2. PgBouncer — under transaction pooling the pooler rejects `statement_timeout`
 *      as an unsupported startup parameter, so buildConnectionOptions omits it and
 *      the cap survives ONLY inside boundedOrgTxn / inWorkspaceTxn (per-tx SET
 *      LOCAL). A bare `await sql` on a pool checkout then runs UNBOUNDED — which is
 *      the class measured at >=180s (a 161s DELETE, a 112s corpus read) while op:get
 *      reported a reassuring 30000.
 *
 * The applied answer is DERIVED by asking buildConnectionOptions what it would send,
 * never by restating its `!pooled` branch here: that duplicate is exactly what let
 * this tool's own description claim the cap bound the class "at the source"
 * (derived-truth ladder, rung 1 — a second copy of a truth the code owns drifts).
 *
 * ---------------------------------------------------------------------------
 * WI-1194246 — that derivation alone is NOT ENOUGH, and would go dishonest again
 * the moment the cap is enforced by the one mechanism that survives PgBouncer.
 *
 * A role- or database-level default (`ALTER ROLE harness_admin SET statement_timeout
 * = …`) is applied by the SERVER at session start, not sent by the client, so
 * buildConnectionOptions is structurally blind to it: it would keep answering
 * "nothing sent" while every bare pool query was in fact being cancelled at the cap.
 * That is the same applied-vs-stored dishonesty EI-21866253550551759 was filed to
 * remove, re-introduced from the opposite direction — a report that under-states
 * enforcement instead of over-stating it. So the report must also OBSERVE.
 *
 * The observation is `pg_settings.reset_val`, which is the value a session RESETs
 * to. It therefore sees THROUGH whatever per-call `SET` / `SET LOCAL` the observing
 * query itself is running under, and reports what a BARE pool checkout actually
 * gets. Measured on the live pooled org-admin pool 2026-08-30:
 *
 *     statement_timeout  setting=5000   reset_val=0      source=session  <- a per-call SET
 *     lock_timeout       setting=15000  reset_val=15000  source=user     <- a real role default
 *
 * i.e. the column discriminates a role default from a session SET, which is exactly
 * the distinction the derived answer cannot make. It also covers BOTH enforcement
 * mechanisms with one reading: a connect-time startup parameter lands in reset_val
 * as source=client, a role default as source=user.
 */

/**
 * What a BARE checkout on the org-admin pool actually resets to. `unknown` is a
 * first-class answer and is NEVER collapsed into "not enforced": an unreadable
 * pool is the one state most likely to be misreported as a reassuring absence.
 */
export type AdminPoolDefaultObservation =
  | { status: 'observed'; poolDefaultMs: number; source: string; roleName: string }
  | { status: 'unknown'; reason: string };

async function observeAdminPoolDefault(): Promise<AdminPoolDefaultObservation> {
  // The read itself is a non-blocking catalog scan, so the only way it fails to
  // return is a wedged pool or a hung connection ACQUIRE — neither of which a
  // server-side statement_timeout could bound anyway. withBoundedTimeout bounds
  // only THIS caller (the statement, if any, runs to completion server-side); that
  // is proportionate here precisely because the abandoned statement is a read of
  // an in-memory catalog, and the degraded answer is `unknown` rather than a guess.
  const outcome = await withBoundedTimeout(
    async () => {
      const { sql } = getOrgPg();
      return (await sql`
        SELECT reset_val, source, current_user::text AS role_name
          FROM pg_settings
         WHERE name = 'statement_timeout'
      `) as unknown as Array<{ reset_val: string; source: string; role_name: string }>;
    },
    { fallback: null, timeoutMs: 3_000, label: 'adminPoolTimeoutReport:observe' },
  );

  if (outcome.degraded) {
    return {
      status: 'unknown',
      reason:
        outcome.reason === 'timeout'
          ? `could not read pg_settings within ${outcome.elapsedMs}ms (pool wedged or connection acquire hung)`
          : `pg_settings read failed: ${outcome.errorMessage ?? 'unknown error'}`,
    };
  }
  const row = outcome.value?.[0];
  if (!row) return { status: 'unknown', reason: 'pg_settings returned no statement_timeout row' };
  const poolDefaultMs = Number(row.reset_val);
  if (!Number.isFinite(poolDefaultMs)) {
    return { status: 'unknown', reason: `unparseable pg_settings.reset_val ${JSON.stringify(row.reset_val)}` };
  }
  return {
    status: 'observed',
    poolDefaultMs,
    source: String(row.source),
    roleName: String(row.role_name),
  };
}

export async function adminPoolTimeoutReport(
  storedMs: number | undefined,
  // Injectable ONLY so the guard test can drive every branch while still exercising
  // the real buildConnectionOptions below — mocking that away would test the mock,
  // not the omission this whole report exists to expose. Production passes none.
  deps: {
    resolvedMs?: number;
    pooled?: boolean;
    observe?: () => Promise<AdminPoolDefaultObservation>;
  } = {},
) {
  const resolvedMs = deps.resolvedMs ?? adminPoolStatementTimeoutMs();
  const behindPgBouncer = deps.pooled ?? pgbouncerEnabled();
  const sent = buildConnectionOptions({
    searchPath: '',
    applicationName: '',
    idleInTxMs: 0,
    stmtTimeoutMs: resolvedMs,
    pooled: behindPgBouncer,
  }).statement_timeout;
  const appliedAtConnect = sent !== undefined;
  const stored = storedMs ?? 0;

  const observed = await (deps.observe ?? observeAdminPoolDefault)();
  const observedMs = observed.status === 'observed' ? observed.poolDefaultMs : null;

  // TRUE / FALSE only when actually observed. `null` means UNKNOWN and must stay
  // distinguishable from `false` — collapsing them is the whole defect class here.
  const enforcedOnBarePoolQueries = observedMs === null ? null : observedMs > 0;

  const bounds =
    observedMs === null
      ? 'UNVERIFIED — the pool default could not be read, so enforcement is UNKNOWN (this is not evidence that it is absent).'
      : observedMs > 0
        ? `every statement on an org-admin pool connection (session default ${observedMs}ms, source=${observed.status === 'observed' ? observed.source : '?'})`
        : appliedAtConnect
          ? `CONTRADICTION: a ${resolvedMs}ms connect-time cap is reported as sent, but the live pool resets to 0. The running pool predates the config change, or the parameter was dropped in transit. Trust the observation, not the derivation.`
          : 'per-tx SET LOCAL only (boundedOrgTxn / inWorkspaceTxn) — a bare pool query is UNBOUNDED';

  // The OBSERVED verdict leads; the configuration explanation follows it. Order
  // matters: after an ALTER ROLE rollout `resolvedMs` is still 0 (the role default
  // is set outside this config surface), so a config-first answer would open with
  // "OFF" about a pool that is in fact bounded.
  const observedVerdict =
    observedMs === null
      ? `UNVERIFIED: could not observe the pool's session default (${observed.status === 'unknown' ? observed.reason : ''}) — treat enforcement as UNKNOWN, not as absent.`
      : observedMs > 0
        ? `ENFORCED: a bare org-admin pool query resets to ${observedMs}ms (pg_settings.reset_val, source=${observed.status === 'observed' ? observed.source : '?'}), which survives PgBouncer.`
        : 'NOT ENFORCED: a bare org-admin pool query resets to 0, so it runs unbounded.';

  const configWhy =
    resolvedMs === 0 && stored > 0
      ? 'STORED BUT INERT: the papercusp-txn-timeouts-config kill-switch is OFF, so the resolver returns 0 and no connect-time cap is configured at all.'
      : resolvedMs === 0
        ? 'OFF: no connect-time admin-pool cap configured (adminPoolStatementTimeoutMs = 0).'
        : appliedAtConnect
          ? 'APPLIED: sent as a startup parameter on each new org pool connection.'
          : 'CONFIGURED BUT NOT APPLIED AT CONNECT: PgBouncer rejects statement_timeout as an unsupported startup parameter, so it is omitted. Only queries already inside boundedOrgTxn / inWorkspaceTxn are bounded by it.';

  return {
    storedMs: stored,
    resolvedMs,
    behindPgBouncer,
    appliedAtConnect,
    appliedStatementTimeoutMs: sent === undefined ? null : Number(sent),
    observed,
    enforcedOnBarePoolQueries,
    bounds,
    why: `${observedVerdict} ${configWhy}`,
  };
}

export default defineTool({
  name: 'db:txn-timeouts',
  profile: 'engineer',
  description:
    "Read/set/reset runtime PG timeouts. The required op discriminator selects the operation: use { op: 'get' } to read, { op: 'set', ... } to write, or { op: 'reset' } to clear. (1) per-workspace inWorkspaceTxn lockTimeoutMs / statementTimeoutMs over the baked 5s/5s defaults — mid-incident raise lockTimeoutMs to ride out same-workspace contention or statementTimeoutMs to let a slow mutation finish. (2) adminPoolStatementTimeoutMs (WI-832) — a DEFAULT statement_timeout for NEW org pool connections applied at connect ONLY when not behind PgBouncer; 0 = OFF. op:get adminPool OBSERVES real enforcement. Empty override / kill-switch off (papercusp-txn-timeouts-config) = byte-identical (5s/5s + no pool default). set/reset audited + one-call-revertible.",
  capability: 'operator:write',
  guidance: {
    when: 'To inspect the effective timeouts + override, call db:txn-timeouts with { op: "get" } — op is required; do not call it with {}. For state-mutating tools failing with workspace_contended (PG lock_timeout 55P03 / statement_timeout 57014) under same-workspace contention, widen the incident window by raising lockTimeoutMs and/or statementTimeoutMs.',
    notWhen: 'Not for the DEPLOY-migration lock_timeout (db:migrate-policy), nor for the BOOT migration timeout (env/code). This only sizes the per-workspace inWorkspaceTxn lock_timeout/statement_timeout.',
    chaining: 'config:list-overrides shows the active txn-timeouts override; config:reset-overrides reverts it. The kill-switch papercusp-txn-timeouts-config (default ON) forces the baked 5s/5s defaults when OFF.',
    seeAlso: [
      'db:migrate-policy (deploy-migration lock_timeout)',
      'dev:pg_active_queries (queries hitting the timeout)',
      'config:list-overrides (active txn-timeouts override)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      // z.coerce so a numeric arg that arrives JSON-stringified ("30000") from an MCP
      // client with a stale/loosely-typed schema still validates (proven real for the
      // WI-832 field during a rolling deploy when the advertised schema lagged the handler).
      lockTimeoutMs: z.coerce.number().int().min(1000).max(120_000).optional(),
      statementTimeoutMs: z.coerce.number().int().min(1000).max(600_000).optional(),
      // WI-832: default statement_timeout (ms) for NEW org POOL connections. EI-21866253550551759:
      // this is a CONNECT-TIME GUC, and buildConnectionOptions omits it whenever the pool is
      // behind PgBouncer (the pooler rejects it as an unsupported startup parameter), so under
      // pooling it bounds ONLY what already runs inside boundedOrgTxn / inWorkspaceTxn — a bare
      // pool checkout stays unbounded. Read op:get's `adminPool` block for applied-vs-stored
      // rather than assuming a stored value is in force. 0 = OFF (unset GUC = the
      // admin pool stays deliberately unbounded). OWNER-GATED to a non-zero value live:
      // migrations share this pool and opt out per-txn (SET LOCAL statement_timeout=0); a
      // too-small value would kill long migrations. Distinct from statementTimeoutMs (the
      // per-workspace inWorkspaceTxn cap).
      adminPoolStatementTimeoutMs: z.coerce.number().int().min(0).max(600_000).optional(),
      dryRun: z.boolean().optional(),
    }),
    z.object({ op: z.literal('reset'), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const override = await readTxnTimeoutsOverride();
      return json({
        effective: txnTimeoutsConfig(),
        defaults: TXN_TIMEOUTS_DEFAULTS,
        override,
        // EI-21866253550551759: `effective` covers only the per-workspace pair, so
        // without this block the admin-pool cap appeared solely as a stored override
        // value with nothing to contradict it.
        // WI-1194246: awaited because the report now OBSERVES the live pool default
        // (pg_settings.reset_val) as well as deriving the connect-time answer — a
        // role-level `ALTER ROLE … SET statement_timeout` is invisible to the
        // derivation and would otherwise be reported as "not applied" while enforced.
        adminPool: await adminPoolTimeoutReport(override.adminPoolStatementTimeoutMs),
      });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('db:txn-timeouts requires operator, architect, or mug role');
    }

    const patch: TxnTimeoutsOverride =
      args.op === 'set'
        ? {
            ...(args.lockTimeoutMs !== undefined ? { lockTimeoutMs: args.lockTimeoutMs } : {}),
            ...(args.statementTimeoutMs !== undefined ? { statementTimeoutMs: args.statementTimeoutMs } : {}),
            ...(args.adminPoolStatementTimeoutMs !== undefined ? { adminPoolStatementTimeoutMs: args.adminPoolStatementTimeoutMs } : {}),
          }
        : {};
    if (args.op === 'set' && Object.keys(patch).length === 0) {
      throw new Error('set requires at least one of lockTimeoutMs / statementTimeoutMs / adminPoolStatementTimeoutMs (or use op:reset)');
    }

    const outcome = await runControlMutation<TxnTimeoutsOverride>(
      {
        action: 'db:txn-timeouts',
        subject: 'txn-timeouts',
        actor: `role:${ctx.role}`,
        capturePrev: () => readTxnTimeoutsOverride(),
        apply: async () => {
          if (args.op === 'reset') {
            await resetTxnTimeoutsOverride();
            return {};
          }
          return setTxnTimeoutsOverride(patch);
        },
        revertTo: (prev) => setTxnTimeoutsOverrideFull(prev),
        verify: async () => {
          const cur = await readTxnTimeoutsOverride();
          if (args.op === 'reset') {
            const ok = Object.keys(cur).length === 0;
            return { ok, detail: ok ? undefined : 'override not cleared' };
          }
          const ok = (Object.keys(patch) as (keyof TxnTimeoutsOverride)[]).every((k) => cur[k] === patch[k]);
          return { ok, detail: ok ? undefined : 'override did not persist' };
        },
        describe: (prev) => ({ op: args.op, proposed: patch, had: prev }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, op: args.op, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId,
      effective: txnTimeoutsConfig(),
    });
  },
});
