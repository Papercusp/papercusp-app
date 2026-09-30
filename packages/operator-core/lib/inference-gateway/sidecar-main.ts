/**
 * The inference-gateway process MAIN, as an exported function (P-006,
 * cross-platform-hardening-and-agent-ergonomics-2026-07-05).
 *
 * Extracted VERBATIM from bin.ts so the same gateway process can be entered two ways:
 *   1. DEV / systemd:  `npx tsx bin.ts` (the `papercup-inference-gateway` --user unit) —
 *      bin.ts is now a thin wrapper that calls this.
 *   2. PACKAGED desktop: the bundled serve.mjs re-execs ITSELF with
 *      `PAPERCUSP_GATEWAY_SIDECAR_MODE=1` and serve.ts diverts here — the same re-exec
 *      divert pattern as the substrate + spawner sidecars (a bundle has no tsx and no
 *      .ts on disk, so `npx tsx bin.ts` cannot work there).
 *
 * No top-level side effects: safe to import from the serve.mjs bundle entry.
 *
 * Env (unchanged from bin.ts):
 *   PAPERCUSP_GATEWAY_PORT         localhost port to listen on (default 8788)
 *   (PAPERCUSP_GATEWAY_CONCURRENCY was RETIRED by capless-inference-gateway P-010:
 *    admission concurrency is learned per provider lane, never configured.)
 *   PAPERCUSP_WORKSPACE            workspace id for account-pool resolution (default: active)
 *   PAPERCUSP_ACCOUNT_ID           pin a specific pool account (else sole-account / local fallback)
 *   ANTHROPIC_BASE_URL_UPSTREAM    override the upstream (default https://api.anthropic.com)
 *   PAPERCUSP_GATEWAY_HARD_STOP_MS hard drain ceiling before force-exit (default 12000, < TimeoutStopSec)
 *   PAPERCUSP_GATEWAY_LOG          durable lifecycle log path (default ~/.papercusp/gateway.log)
 *   PAPERCUSP_GATEWAY_LOG_MAX_BYTES rotate the lifecycle log at this size (default 8 MiB)
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { installFlagOverrideStore } from '../flag-override-store';
import { ensureFlagChangeListener } from '../flag-change-listener';
import { startGatewayService, DEFAULT_GATEWAY_PORT } from './launch';
import { reportRuntimeVintageOnBoot } from '../runtime-vintage';
import { installStdioPeerGuard } from '../process-supervision/stdio-peer-guard';

/** Hard ceiling on the SIGTERM drain before we force-exit — DEFENSE-IN-DEPTH behind gateway.close()'s
 *  own GRACEFUL_SHUTDOWN_MS (~5s) grace. MUST stay below the supervisor's stop budget (systemd
 *  TimeoutStopSec=30s / gateway-sidecar-spawn's SIGKILL fallback) so WE exit first, rather than the
 *  supervisor escalating to SIGKILL (which orphans the tsx children + drops every in-flight
 *  bee/queen spawn — the EI-2421 crash-loop mechanism). Env-tunable. Read lazily (inside the
 *  function) so importing this module has no env-dependent state. */
function hardStopMs(): number {
  return Number(process.env.PAPERCUSP_GATEWAY_HARD_STOP_MS) || 12_000;
}
/** Durable, journald-INDEPENDENT lifecycle log. journald's stdout-socket capture
 *  (/run/systemd/journal/stdout) was observed wedged host-wide (2026-06-22, EI-2421), making the
 *  gateway's up/shutdown lines invisible — which is why a restart's timing + reason couldn't be seen.
 *  Mirror them to a file (synchronous append, immediately readable) so they survive regardless of
 *  journald. Env-tunable. */
function logFilePath(): string {
  return process.env.PAPERCUSP_GATEWAY_LOG || join(homedir(), '.papercusp', 'gateway.log');
}

const DEFAULT_GATEWAY_LOG_MAX_BYTES = 8 * 1024 * 1024;

function logMaxBytes(): number {
  const configured = Number(process.env.PAPERCUSP_GATEWAY_LOG_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(1024, Math.floor(configured))
    : DEFAULT_GATEWAY_LOG_MAX_BYTES;
}

let logDirEnsuredFor: string | undefined;

/** Keep the journald-independent fallback bounded. A normal rotation retains one
 * previous segment; a pre-existing oversized file is discarded instead of being
 * renamed into an equally unbounded backup. All failures remain fail-soft in the
 * caller because durable logging must never take down the gateway. */
function rotateGatewayLogIfNeeded(path: string, incomingBytes: number): void {
  let currentBytes: number;
  try {
    currentBytes = statSync(path).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }

  const maxBytes = logMaxBytes();
  if (currentBytes + incomingBytes <= maxBytes) return;

  const rotatedPath = `${path}.1`;
  rmSync(rotatedPath, { force: true });
  if (currentBytes > maxBytes) {
    // Upgrade/self-heal path: never preserve a legacy runaway file as the backup.
    rmSync(path, { force: true });
    return;
  }
  renameSync(path, rotatedPath);
}

/** Durable lifecycle log line (console + append-file). Exported so bin.ts's fatal catch reuses it. */
export function gatewayLogLine(m: string): void {
  const line = `[inference-gateway ${new Date().toISOString()}] ${m}`;
  console.log(line);
  try {
    const path = logFilePath();
    if (logDirEnsuredFor !== path) {
      mkdirSync(dirname(path), { recursive: true });
      logDirEnsuredFor = path;
    }
    const record = line + '\n';
    rotateGatewayLogIfNeeded(path, Buffer.byteLength(record));
    appendFileSync(path, record);
  } catch {
    /* durable log unavailable (perm/disk) — console.log remains the fallback; never let logging crash boot/shutdown */
  }
}

/**
 * Run the gateway process main: start the service, install crash-proofing + signal-drain
 * handlers, and serve until SIGTERM/SIGINT. Resolves after a successful start (the HTTP
 * server keeps the process alive); REJECTS on a startup failure — the caller decides the
 * fatal policy (both entries exit(1) so the supervisor restarts us, fail-closed).
 */
export async function runGatewaySidecarMain(): Promise<void> {
  // (WI-39599) Break the broken-stdio amplification loop BEFORE anything can write.
  // This process reports every fault — including the `uncaughtException` backstop
  // below — through gatewayLogLine, whose `console.log` half is deliberately
  // OUTSIDE its try/catch. Once our stdio peer dies (the operator that spawned us
  // is SIGKILLed, so both pipe read ends close), that write fails, the stream
  // emits an unhandled 'error', Node throws it as an uncaughtException, and the
  // handler reports it by writing again — unbounded, ~1.00 core for as long as the
  // orphan lives. A fault handler must not report through a channel that can raise
  // the same fault class, so absorb the stream error rather than policing the
  // reporter. The file half of gatewayLogLine is unaffected and stays readable.
  //
  // serve.ts installs this at module scope, which already covered the PACKAGED
  // re-exec divert; installing it here covers the two entries that never load
  // serve.ts (bin.ts and the `papercup-inference-gateway` systemd unit). The guard
  // is idempotent, so the packaged path keeps the single install it already had.
  installStdioPeerGuard();

  const HARD_STOP_MS = hardStopMs();
  // Runtime flag overrides (codex-gateway-chatgpt-live-2026-07-09): `getFlag()` consults the
  // PG override store ONLY in a process that installed it. That call used to live exclusively in
  // flag-bus.ts, which this standalone process deliberately does NOT import (it drags in SSE +
  // lexicon config). So the gateway silently ignored EVERY `flags:set` / `POST /api/flags/set`
  // override and fell through to FLAG_DEFAULTS — a dark flag could never be turned on for the
  // gateway by the documented mechanism, and the flip reported success while changing nothing.
  // MUST run BEFORE startGatewayService(), which resolves its flags (e.g. CODEX_GATEWAY_OAUTH_PROXY)
  // at boot. Fail-soft: a store fault degrades to defaults exactly as before, never blocks boot.
  installFlagOverrideStore();
  // WI-6793: also LISTEN for peer processes' flags:set writes — the store above
  // makes overrides READABLE here, but without this a flip only converges via the
  // ~5s cache TTL, and any sticky onFlagChange subscriber would hold the pre-flip
  // value until restart. Fire-and-forget; bounded retry + fail-soft inside.
  void ensureFlagChangeListener();
  const svc = await startGatewayService({
    port: Number(process.env.PAPERCUSP_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT,
    workspace: process.env.PAPERCUSP_WORKSPACE || undefined,
    // P-006: production gateway requests are durably admitted through the
    // canonical work-item queue before provider execution. Unit/load callers
    // that invoke startGatewayService directly retain the compatibility path.
    durableAdmission: true,
    // P-010: no configured admission concurrency. The gateway's single capless
    // lifecycle learns each provider lane's window from that lane's own outcomes,
    // so the production sidecar deliberately passes no seed at all.
    upstreamBase: process.env.ANTHROPIC_BASE_URL_UPSTREAM || undefined,
    // Local inference-backend pool (local-concurrent-inference-2026-07-02 P-004, D-002): the ONLY
    // production entrypoint that opts in to the DB-backed registry (launch.ts defaults to empty/no-PG
    // for every other caller, incl. all tests). The registry starts empty — inert until a backend is
    // registered (gateway:local_backend_register) — so this is safe to wire unconditionally.
    resolveLocalBackends: (ws) => import('./local-backend-store').then(({ listLocalBackends }) => listLocalBackends({ workspaceId: ws })),
  });
  gatewayLogLine(`up on 127.0.0.1:${svc.port} → account '${svc.account.accountId}' (${svc.account.source})`);

  // [fleet-reliability-verification-2026-07-10 P-008] Self-report into the
  // deploys:vintage ledger — best-effort, never blocks/affects boot (the gateway
  // must keep serving even if this runtime happens to have no DB reachable).
  try {
    reportRuntimeVintageOnBoot('gateway', { port: svc.port });
  } catch (e) {
    gatewayLogLine(`[runtime-vintage] boot self-report wiring failed (non-fatal): ${(e as Error)?.message ?? e}`);
  }

  // CRASH-PROOFING (backend-reliability-100pct-2026-07-03 W2) — process-level BACKSTOP.
  // A single request's unhandled stream 'error' (e.g. an AbortSignal.timeout firing on a
  // piped upstream body) is thrown by Node as an uncaughtException → the WHOLE shared
  // multi-tenant gateway dies (status=1/FAILURE → supervisor restart), dropping EVERY in-flight
  // bee/queen request. Observed ≥2× on 2026-07-02 (21:49, 22:10: "Unhandled 'error' event …
  // TimeoutError"). The per-pipe '.on(error)' handlers at the stream sites are the primary fix;
  // THIS is defense-in-depth for any unforeseen source: log durably and KEEP SERVING. For a
  // shared proxy, surviving one poisoned request is strictly better than a mass outage.
  // Registered AFTER a successful boot so genuine STARTUP failures still propagate to
  // the caller's catch → exit(1) → clean supervisor restart (we don't want to swallow those).
  process.on('uncaughtException', (err, origin) => {
    gatewayLogLine(`uncaughtException (${origin}) — logged, NOT exiting (crash-proofing W2): ${(err as Error)?.stack || String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    gatewayLogLine(`unhandledRejection — logged, NOT exiting (crash-proofing W2): ${reason instanceof Error ? reason.stack : String(reason)}`);
  });

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    const t0 = Date.now();
    gatewayLogLine(`${sig} → draining + stopping (hard ceiling ${HARD_STOP_MS}ms)`);
    // DEFENSE-IN-DEPTH: race the (already-bounded) drain against a hard ceiling so a wedged close()
    // can never let the supervisor's stop budget expire → SIGKILL → orphan leak. We exit no matter what.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hardStop = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), HARD_STOP_MS);
      timer.unref?.();
    });
    const drain = svc
      .stop()
      .then(() => 'drained' as const)
      .catch((e) => {
        gatewayLogLine(`stop() error (continuing to exit): ${(e as Error).message}`);
        return 'drained' as const;
      });
    const outcome = await Promise.race([drain, hardStop]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      gatewayLogLine(`drain exceeded ${HARD_STOP_MS}ms — FORCE-exiting before the supervisor SIGKILLs (close() grace wedged? investigate)`);
    } else {
      gatewayLogLine(`drained cleanly in ${Date.now() - t0}ms → exit`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
