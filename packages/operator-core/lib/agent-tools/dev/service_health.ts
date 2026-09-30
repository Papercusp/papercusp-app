/**
 * dev:service_health — probe the dev endpoints right now (fleet-coordination-
 * painpoints Phase 3b, P-018 status surface). Up/down + latency per service.
 * The DBOS service-health workflow additionally broadcasts a coord message on
 * each up/down transition; this tool is the on-demand snapshot.
 */

import { z } from "zod";
import { defineTool } from "@papercusp/agent-mcp";
import {
  probeAll,
  probeMcpHandshake,
  supervisedProcesses,
  PORTLESS_PROBE_NAMES,
  type ProbeResult,
} from "../../service-health";
import { getTelemetryHealth } from "../../projected-tool-deps";
import {
  supervisionSnapshot,
  isActiveStateDown,
  isAdministrativelyPaused,
  type SupervisionStatusEntry,
  type SupervisionFlapState,
} from "../../supervision/unit-reconciler";
import { substrateSidecarSupervisionStatus, type SidecarSupervisionStatus } from "../../sync/hyperbee/substrate-sidecar-spawn";
import { spawnerSidecarSupervisionStatus } from "../../fleet/spawner-sidecar-spawn";
import { runtimeDiagnostic, type RuntimeDiagnostic } from "../../runtime-diagnostic";
import { probeServiceStart, probeUnitStates, type ServiceStartInfo } from "./systemd-service-probe";
import { isSidecarEnabledFromEnv } from "../../process-supervision/sidecar-spawn-shared";
import {
  readMcpProxyFailureTail,
  summarizeMcpProxyHealth,
  type McpProxyFailureRecord,
} from "../../system-health/mcp-proxy-health";

function sidecarFlapState(s: SidecarSupervisionStatus): SupervisionFlapState {
  return s.gaveUp ? "gave-up" : s.respawnAttemptsInWindow > 0 ? "damping" : "ok";
}

/**
 * P-006 (critical-process-supervisor-2026-07-04): overlay the two node-child
 * sidecars' OWN respawn-with-backoff state (owned by their respective spawn
 * modules, not the systemd-user reconciler) onto `supervisionSnapshot()`'s
 * registry-shaped entries. PURE (both status reads are sync/in-memory) — every
 * OTHER entry (systemd-user, desktop-shell) passes through untouched.
 */
export function overlayNodeChildSupervision(
  entries: SupervisionStatusEntry[],
  substrate: SidecarSupervisionStatus,
  spawner: SidecarSupervisionStatus,
  env: NodeJS.ProcessEnv = process.env,
): SupervisionStatusEntry[] {
  // The node-child status modules are process-local. A request-only operator can
  // import them without owning the sidecar and retain a stale give-up latch from
  // an earlier local spawn, so only project the spawner state when this host's
  // explicit per-host opt-in says the sidecar is active. Without this guard,
  // dev:service_health mistakes local history for host-wide liveness (EI-21311396847110230).
  const spawnerEnabled = isSidecarEnabledFromEnv(
    {
      enableVar: "PAPERCUSP_SPAWNER_SIDECAR",
      modeVar: "PAPERCUSP_SPAWNER_SIDECAR_MODE",
    },
    env,
  );
  return entries.map((entry) => {
    const status =
      entry.name === "substrate-sidecar" ? substrate : entry.name === "spawner-sidecar" && spawnerEnabled ? spawner : null;
    if (!status) return entry;
    return {
      ...entry,
      consecutiveProbeFailures: status.running ? 0 : entry.consecutiveProbeFailures,
      lastRestartAt: status.lastRespawnScheduledAt,
      restartsLast10m: status.respawnAttemptsInWindow,
      flapState: sidecarFlapState(status),
    };
  });
}

/**
 * EI-13221: how recently a systemd-user unit's MainPID came up, before this
 * probe was seen as "down for real". A unit like `staging-api` (:3170) can be
 * cycled by automation the reconciler's own flap-count never observes — the
 * papercup-staging-sync.timer restarts it independently (~every 5min, whenever
 * `staging` has advanced) via a raw `systemctl --user restart`, outside the
 * HEALTH_ENDPOINTS HTTP-probe rotation this file drives, so `flapState` stays
 * 'ok' throughout even though the unit hard-cycles (SIGKILL, ~10-13s down)
 * every few minutes. A caller who hits a connection-refused against :3170 and
 * then reaches for `dev:service_health` deserves a real answer, not a blind
 * spot — so surface it directly from the OS (`probeServiceStart`, the same
 * ground-truth primitive `dev:restart`'s coalesce check already trusts),
 * independent of the reconciler's own bookkeeping.
 */
export const RECENT_RESTART_WINDOW_SEC = 20;

export type SupervisionStatusEntryWithRecency = SupervisionStatusEntry & {
  /** Seconds since the unit's current MainPID started (systemd ground truth).
   *  Omitted when not a systemd-user unit, or the probe couldn't determine it. */
  secondsSinceStart?: number;
  /** Present only when secondsSinceStart < RECENT_RESTART_WINDOW_SEC — a plain-
   *  English pointer so "connection refused right now" reads as "known restart
   *  window, retry" instead of "the service is down / under load". */
  recentRestartNote?: string;
  /**
   * EI-20093902925801178: systemd's OWN monotonic restart count for this unit
   * (`NRestarts`), read straight from the OS. THE trustworthy restart signal in
   * this payload — `restartsLast10m` beside it is written by the reconciler
   * routine inside `papercusp-bg-host` and read here in the OPERATOR process,
   * where that Map is always empty, so it reads 0 no matter what happened.
   * Measured 2026-08-10: this field was 4 while `restartsLast10m` said 0.
   *
   * Lifetime-cumulative, not windowed — a nonzero value is not by itself an
   * incident. Read it WITH `secondsSinceStart`: a high count plus a very short
   * uptime is a live crash-loop. Omitted when systemd did not report it.
   */
  nRestarts?: number;
  /**
   * EI-20093902925801178: present exactly when this entry's reconciler-derived
   * counters (`restartsLast10m`, `lastRestartAt`, `consecutiveProbeFailures`,
   * `flapState`) measured NOTHING in this process and are therefore
   * zero-defaults. Plain-language, because the failure mode is a reader
   * treating those zeros as evidence of health.
   */
  flapCountersNote?: string;
  /**
   * EI-18700974567040702: ground-truth liveness for a systemd-user unit, read
   * directly from `probeServiceStart`'s `ActiveState`. `true` = systemd reports
   * `active`; `false` = systemd reports something else; omitted = not a
   * systemd-user unit, OR the probe itself could not determine an answer
   * (non-linux, no systemd, transient exec error) — an honest "unknown" that
   * must never be conflated with `false`. Deliberately keyed on `ActiveState`
   * rather than `MainPID`: a `.timer` unit has NO MainPID concept at all (it
   * runs no process itself), so a MainPID-only signal falsely read a healthy,
   * `active`/`waiting` timer as down. `ActiveState` is reported for every
   * systemd unit TYPE, so it is the one signal that generalizes. Previously
   * "down" and "probe failed" were BYTE-IDENTICAL in this payload (both just
   * left the entry untouched), so a caller could not tell one from the other
   * — this field is the fix.
   *
   * ⚠ WI-6149: `active: false` is NOT the same as "this unit is broken", and it
   * used to be documented as exactly that. It is the LITERAL systemd read, so it
   * is also false for a unit that is mid-start (`activating`) and for an
   * `episodic` timer-driven unit that is simply idle between runs. Read
   * `healthy` for the verdict; read `activeState` for the raw state.
   */
  active?: boolean;
  /**
   * WI-6149: systemd's `ActiveState` VERBATIM (active/activating/inactive/
   * deactivating/reloading/failed). The boolean above is a lossy projection of
   * this — it cannot distinguish "mid-restart" from "crashed" from "idle
   * oneshot", which are three very different situations for a caller deciding
   * whether to retry, page, or do nothing. Omitted exactly when `active` is.
   */
  activeState?: string;
  /**
   * WI-6149: the VERDICT — is this unit OK? Computed by the SAME oracle the
   * reconciler acts on (`isUnitDown`, which owns the definition of down),
   * rather than a second definition maintained here: `activating`/`reloading`/
   * `deactivating` are not down (a transitional state is not a fault), and for
   * an `episodic` unit only `failed` is. This is the field that answers both
   * `systemctl is-active` and `systemctl is-failed`. Omitted when the probe
   * could not determine a state at all.
   */
  healthy?: boolean;
  /**
   * WI-6149: this unit is timer-driven (`SupervisionEntry.episodic`) — being
   * `inactive` is its NORMAL state between scheduled runs, so `active: false`
   * here carries no alarm. Present only when true.
   */
  episodic?: boolean;
  /**
   * WI-20039196108947848: systemd's persisted enablement state. `disabled` or
   * `masked` distinguishes an administratively disabled unit from an enabled
   * unit that stopped. It does not prove who disabled it or that the pause is
   * authorized, so `healthy` remains the liveness verdict.
   */
  unitFileState?: string;
  /** Explicit companion to `unitFileState`; this is a systemd state marker, not
   * proof that the pause is intended or safe to ignore. */
  administrativelyPaused?: boolean;
};

/**
 * Overlay live systemd restart-recency onto supervision entries (EI-13221).
 * Additive + best-effort: a probe failure (no systemd, unit never started,
 * non-linux) leaves the entry untouched — this must never turn a healthy
 * snapshot into a failure. `probeFn` is injectable for tests.
 */
export async function overlaySystemdRestartRecency(
  entries: SupervisionStatusEntry[],
  probeFn: (unit: string) => Promise<ServiceStartInfo> = probeServiceStart,
  // Injectable for tests; defaults to the real registry. `SupervisionStatusEntry`
  // (the snapshot shape) drops `unit` — only the source `SupervisionEntry`
  // registry carries it — so we look it up by name rather than widening the
  // reconciler's own snapshot type.
  // WI-6149: the whole registry ROW is needed now, not just `unit` — `episodic`
  // changes what "down" means for the entry (see `isActiveStateDown`).
  registry: { name: string; unit?: string; episodic?: boolean }[] = supervisedProcesses(),
): Promise<SupervisionStatusEntryWithRecency[]> {
  const rowByName = new Map(registry.map((r) => [r.name, r]));
  return Promise.all(
    entries.map(async (entry) => {
      const row = entry.layer === "systemd-user" ? rowByName.get(entry.name) : undefined;
      const unit = row?.unit;
      if (!unit) return entry;
      const info = await probeFn(unit).catch(() => ({ ok: false }) as ServiceStartInfo);
      if (!info.ok) return entry; // probe genuinely couldn't determine an answer — honest "unknown", untouched
      // EI-210532: systemd reports a missing unit as ActiveState=inactive. That
      // default is not a liveness measurement, so preserve the untouched row
      // rather than turning an absent service into a confirmed outage.
      if (info.known === false || info.loadState === "not-found") return entry;
      // EI-18700974567040702: `ActiveState` is a DETERMINATE liveness answer from systemd
      // itself, not a probe failure — it must not be dropped alongside the `!info.ok` case
      // above (that was the bug: a stopped unit and a failed probe were byte-identical).
      // `undefined` here means even ActiveState couldn't be read (a probe edge case) — leave
      // the entry untouched rather than guess. Keyed on ActiveState, NOT MainPID, because a
      // `.timer` unit has no MainPID concept at all — see the field's own doc comment above.
      if (info.activeState === undefined) return entry;
      const active = info.activeState === "active";
      // WI-6149: the VERDICT, from the reconciler's own oracle — never a second
      // definition of "down" maintained here.
      const episodic = row?.episodic === true;
      // WI-20039196108947848: `ActiveState=inactive` is also the expected read
      // after `systemctl --user disable --now`. Preserve the persisted
      // enablement state so callers can distinguish that condition from an
      // enabled unit that stopped, but do not infer authorization or intent
      // from `disabled`/`masked`; an unattributed pause must remain visible as
      // unhealthy. The timer remains non-episodic: an ENABLED inactive timer is
      // still genuinely unhealthy too.
      const administrativelyPaused = isAdministrativelyPaused(info.unitFileState);
      const healthy = !isActiveStateDown(info.activeState, { episodic });
      const stated: SupervisionStatusEntryWithRecency = {
        ...entry,
        active,
        activeState: info.activeState,
        healthy,
        ...(episodic ? { episodic: true } : {}),
        ...(info.unitFileState !== undefined ? { unitFileState: info.unitFileState } : {}),
        ...(administrativelyPaused ? { administrativelyPaused: true } : {}),
        // EI-20093902925801178: systemd's own restart counter, from the same
        // `systemctl show` this probe already made. The one restart number in
        // this payload that is not hostage to which process is answering.
        ...(info.nRestarts !== undefined ? { nRestarts: info.nRestarts } : {}),
        // ...and say so out loud when the reconciler counters are zero-defaults
        // rather than measurements. Scoped to systemd-user: a node-child entry
        // is legitimately un-tracked by this reconciler and gets its real
        // respawn state from its own spawn module's overlay, so flagging those
        // would be noise that trains readers to ignore the flag.
        ...(entry.flapObserved || entry.layer !== "systemd-user"
          ? {}
          : {
              flapCountersNote:
                `restartsLast10m/lastRestartAt/flapState for ${entry.name} measured NOTHING in this ` +
                `process and are zero-defaults — the supervision reconciler populates them only ` +
                `inside papercusp-bg-host. Do NOT read flapState:'ok' here as healthy. Use ` +
                `nRestarts (systemd ground truth) with secondsSinceStart instead.`,
            }),
      };
      if (!active || info.secondsSinceStart === undefined) return stated;
      const withRecency: SupervisionStatusEntryWithRecency = {
        ...stated,
        secondsSinceStart: info.secondsSinceStart,
      };
      if (info.secondsSinceStart < RECENT_RESTART_WINDOW_SEC) {
        withRecency.recentRestartNote =
          `${entry.name} restarted ${info.secondsSinceStart}s ago — a connection-refused seen ` +
          `in roughly that window is most likely this restart cycling the listener (e.g. ` +
          `papercup-staging-sync's auto-track for staging-api), not an outage or load signal. Retry.`;
      }
      return withRecency;
    }),
  );
}

/**
 * EI-19934795546523351: the bg-host-ticker probe (`probeBgHostTicker`, in
 * ../../service-health) can see ONLY the newest routine `last_fired_at` — it has no
 * visibility into whether the process just restarted. During the ~50s a fresh
 * `papercusp-bg-host` takes to boot (swarm joins, epoch gates, wire-presence), no
 * routine has fired yet, so the ticker probe reads FROZEN even though the process is
 * healthy and mid-boot. The `supervision[]` block computed in the SAME response
 * already carries the ground truth (systemd `secondsSinceStart` for the `bg-host`
 * entry, via `overlaySystemdRestartRecency`) — reconcile with it BEFORE reporting a
 * rootCause/nextVerb that the response's own supervision block contradicts.
 *
 * Measured live 2026-08-09 00:50-00:52Z: a payload simultaneously said
 * `services[bg-host-ticker].up:false` + `nextVerb:'dev:restart{target:"bg-host"}'`
 * while `supervision[bg-host].secondsSinceStart:7` — i.e. the process was 7s into a
 * healthy boot and the recommended action was to kill that boot and re-freeze the
 * ticker for another ~50s, reproducing the identical false reading. A restart storm
 * with a stable false justification.
 */
export const BG_HOST_BOOT_GRACE_SEC = 90;

/**
 * Reconcile the bg-host-ticker `ProbeResult` against the bg-host supervision entry's
 * `secondsSinceStart`. PURE — no I/O, both inputs already computed by the caller.
 * A no-op unless the ticker is currently reporting DOWN and the supervision entry
 * shows a restart younger than `BG_HOST_BOOT_GRACE_SEC` — the exact contradiction
 * above. When it fires, the ticker entry is rewritten to `up:true, present:false`
 * (liveness UNKNOWN/booting, matching the `lastFiredMs == null` convention
 * `evaluateBgHostTicker` already uses elsewhere) so it can never again drive a
 * `dev:restart` nextVerb or count toward `effective.down`.
 */
export function reconcileBgHostTicker(
  services: ProbeResult[],
  supervision: SupervisionStatusEntryWithRecency[],
): ProbeResult[] {
  const tickerIdx = services.findIndex((s) => s.name === PORTLESS_PROBE_NAMES.bgHostTicker);
  if (tickerIdx === -1) return services;
  const ticker = services[tickerIdx]!;
  if (ticker.up) return services; // nothing to reconcile — already healthy
  // Supervision names the process 'bg-host' (SUPERVISED_PROCESSES); the ticker
  // probe names itself 'bg-host-ticker' — the two are deliberately different
  // identifiers for the same underlying `papercusp-bg-host` service, so join by
  // the registry-declared name rather than assuming they match.
  const bgHost = supervision.find((s) => s.name === "bg-host");
  if (!bgHost || bgHost.secondsSinceStart === undefined) return services; // no ground truth to reconcile against
  if (bgHost.secondsSinceStart >= BG_HOST_BOOT_GRACE_SEC) return services; // restart is old enough that a freeze reading is trustworthy
  const reconciled: ProbeResult = {
    ...ticker,
    up: true,
    present: false,
    note:
      `bg-host restarted ${bgHost.secondsSinceStart}s ago (within the ${BG_HOST_BOOT_GRACE_SEC}s boot grace) — ` +
      `ticker liveness UNKNOWN/booting, NOT frozen: no routine has fired yet because the process just ` +
      `started, not because it stalled. Do not dev:restart on this signal alone; re-probe after the ` +
      `boot grace if it is still stale. (raw ticker probe: ${ticker.note ?? "no note"})`,
  };
  const next = services.slice();
  next[tickerIdx] = reconciled;
  return next;
}

/**
 * Reconcile an HTTP probe with the systemd state of the same service.
 *
 * A persistent service can be `ActiveState=activating` while its ExecStartPre
 * is still building the runtime bundle, before systemd has assigned a MainPID
 * or the application has opened its listener. The HTTP probe then reports
 * connection refused even though the service manager has a healthy transition
 * in progress. Treat that response as UNKNOWN while systemd is in one of its
 * non-fault transitional states; once systemd reaches `active` (or a faulted
 * terminal state), the HTTP result is authoritative again.
 *
 * This is bounded by systemd's own transition: a stuck start eventually leaves
 * `activating` for its configured failure state, so this cannot hide a listener
 * outage indefinitely or trigger a second restart into the same ExecStartPre.
 * PURE — both inputs are already computed by the caller.
 */
export function reconcileBootingHttpServices(
  services: ProbeResult[],
  supervision: SupervisionStatusEntryWithRecency[],
): ProbeResult[] {
  const byName = new Map(supervision.map((entry) => [entry.name, entry]));
  let out = services;
  for (let i = 0; i < services.length; i++) {
    const service = services[i]!;
    if (service.up || service.present === false || service.url === undefined) continue;
    const entry = byName.get(service.name);
    if (
      !entry ||
      entry.healthy !== true ||
      !['activating', 'reloading', 'deactivating'].includes(entry.activeState ?? '')
    ) {
      continue;
    }
    if (out === services) out = services.slice();
    out[i] = {
      ...service,
      up: true,
      present: false,
      note:
        `systemd state ${entry.activeState} is still transitioning — HTTP listener liveness is ` +
        `UNKNOWN, not a confirmed outage. Do not dev:restart while this transition is in ` +
        `progress; re-probe after systemd reaches a terminal state. (raw HTTP probe: ${service.note ?? "no detail"})`,
    };
  }
  return out;
}

type ServiceRootCause = { component: string; reason: string };

function restartVerbForService(name: string): string {
  if (name.includes("bg-host")) return 'dev:restart { target:"bg-host" }';
  if (name === "operator") return 'dev:restart { target:"dev" }';
  if (name === "staging-api") return 'dev:restart { target:"staging" }';
  if (name.includes("gateway")) return 'dev:restart { target:"gateway" }';
  if (name.includes("embed")) return 'dev:restart { target:"embed-sidecar" }';
  return "dev:processes";
}

/**
 * EI-19465075959589134: a WEDGED service and a DOWN one want different next
 * moves, and the restart verb is only correct for one of them. Down = the
 * process is gone, so starting it IS the fix. Wedged = a live process with a
 * blocked event loop, so the restart is a MITIGATION that also destroys the
 * evidence — and :3170 wedged twice in four hours precisely because each
 * incident was closed by restarting it.
 */
function nextVerbForService(name: string, wedged?: boolean): string {
  const restart = restartVerbForService(name);
  if (!wedged) return restart;
  return `${restart} RECOVERS it — but this is a WEDGE (listening, not accepting), so capture evidence FIRST or the cause survives the restart: logs:read { unit, since:"-10m" } + dev:pg_active_queries`;
}

/** The out-of-process supervisor that OWNS bg-host restarts (`apps/operator/scripts/bghost-watchdog.mjs`). */
export const BG_HOST_WATCHDOG_UNIT = "papercusp-bg-host-watchdog";

/**
 * EI-20065717746825416: a `nextVerb` prescribing an action that an AUTONOMOUS SUPERVISOR already
 * owns must disclose that owner, or it is instructing agents to race it.
 *
 * `papercusp-bg-host-watchdog` is active on this box, out-of-process, and restarts bg-host on
 * exactly the condition the ticker probe reports (routine fires AND routinesTick both >240s
 * stale). Nothing on this AGENT-FACING surface said so. The watchdog is referenced ~15 times
 * across the tree — but every one of those is an internal doc comment in a subsystem that
 * interacts with it (`dbos/pool-pressure`, `routines-workflow`, `hyperbee/boot`, …). The
 * knowledge existed everywhere EXCEPT the one place an agent reads when deciding what to do.
 *
 * Measured cost of that gap, 2026-08-10 (an agent following this tool's own instruction):
 *   10:36:59Z  the watchdog detected the freeze and restarted bg-host
 *   10:50:29Z  second freeze — watchdog DELIBERATELY SUPPRESSED the restart: the process tree
 *              was burning ~503 CPU ticks/5s, so it judged "saturated, not dead" and held off
 *   11:00:30Z  suppression hit its 900s hard bound — watchdog restarted bg-host
 *   11:01:50Z  the agent, having read `nextVerb: dev:restart{bg-host}`, restarted it BY HAND
 *              ~80s later — inside `dev:restart`'s ~120s phantom-coalesce window (EI-11137),
 *              so the call almost certainly did nothing while the watchdog's recovery made it
 *              look like it had worked. The agent then reported to the owner that bg-host had
 *              "no auto-recovery" and that its restart was the fix. Both were false.
 *
 * Two traps this text exists to kill, because BOTH read as the opposite of the truth:
 *  - a still-frozen bg-host is NOT evidence the watchdog is absent — it may be mid-suppression
 *    BY DESIGN, and killing that process is the exact outcome the suppression prevents;
 *  - verifying a hand restart BY OUTCOME cannot attribute the recovery, because the watchdog's
 *    restart produces an identical outcome. Only its journal separates the two.
 *
 * PURE. `watchdogActive === undefined` is an honest UNKNOWN and says so rather than asserting
 * either an owner or an absence — the same in-band-unknown convention as `isActiveStateDown`
 * and the probes above (an absent check and a passed check must never look alike).
 */
export function bgHostWatchdogOwnership(watchdogActive: boolean | undefined): string {
  const read = `logs:read { unit:"${BG_HOST_WATCHDOG_UNIT}", since:"-20m" }`;
  if (watchdogActive === false) {
    return (
      ` ⚠ AND \`${BG_HOST_WATCHDOG_UNIT}\` — the out-of-process supervisor that normally recovers this —` +
      ` is NOT ACTIVE. That is a finding in its own right: bg-host currently has NO automatic recovery.` +
      ` Restart bg-host, then revive the watchdog (\`systemctl --user start ${BG_HOST_WATCHDOG_UNIT}\`).`
    );
  }
  const owner =
    watchdogActive === true
      ? `\`${BG_HOST_WATCHDOG_UNIT}\` is RUNNING and OWNS this restart`
      : `\`${BG_HOST_WATCHDOG_UNIT}\` normally OWNS this restart (could NOT determine whether it is running —` +
        ` check \`systemctl --user is-active ${BG_HOST_WATCHDOG_UNIT}\`)`;
  return (
    ` ⚠ DO NOT restart by hand as a first move: ${owner} — it restarts bg-host once routine fires AND` +
    ` routinesTick are both >240s stale. It also DELIBERATELY SUPPRESSES a restart while the process tree` +
    ` is CPU-saturated (>=50 ticks/5s) for up to 900s, so a still-frozen bg-host is NOT evidence it is` +
    ` absent or broken. Read its verdict FIRST: ${read}. A hand restart within ~120s of one of its restarts` +
    ` PHANTOM-COALESCES (EI-11137) and does nothing — while the watchdog's own recovery makes it look like` +
    ` yours worked, so verifying by outcome CANNOT tell you who fixed it.`
  );
}

/**
 * D-005 (outage-must-not-be-silent-2026-08-02) — surface the mcp-proxy TRANSPORT ledger to the
 * AGENT-facing health tool.
 *
 * The ledger already had a reader: the system-health collector (`compute.ts` →
 * `InfraHealth.mcpProxy` → the Infra panel → operator_degraded). So this DELEGATES to that same
 * summarizer rather than re-reading the file. An earlier revision shipped a parallel reader and,
 * by omitting `isNonInstanceRecord` (listenPort:0 — ~18% of live records, written by test and
 * desktop-sidecar proxies no client is routed through) and `isBenignProbe`, over-counted failures.
 * One summarizer, one classification: a second opinion here is a second BUG.
 *
 * What this adds is the missing AUDIENCE. The panel is a HUMAN surface, and the agent whose tool
 * plane is degrading cannot see it — it is the party least able to ask and most affected.
 *
 * Read `recovered`/`handshakeStalls` as faults that HAPPENED and were survived, never as health:
 * WI-6740 lost three weeks because 269 stalls each logged `recovered` and read as self-healing.
 *
 * Bounded (256KB tail) and OMITTED ENTIRELY when nothing is notable — a reassuring zero on every
 * call trains the reader to skip the field, which is how the next real signal gets missed. An
 * absent check and a passed check must never look alike.
 *
 * `read` is injectable ONLY so tests are hermetic: the default reader hits the real
 * `~/.papercusp/mcp-proxy-failures.jsonl`, and a test that exercised it would both depend on live
 * machine state and read production telemetry (see EI-19388683897769817).
 */
export function buildMcpProxyTransportBlock(
  read: () => McpProxyFailureRecord[] | null = readMcpProxyFailureTail,
  nowMs: number = Date.now(),
): Record<string, unknown> {
  const recs = read();
  if (recs === null) return {}; // unreadable ledger — stay silent rather than assert an all-clear
  const h = summarizeMcpProxyHealth(recs, nowMs);
  // `recovered` is deliberately NOT in this sum: on its own it means the proxy absorbed a deploy
  // blip, which is the resilience working. The notable set is what an agent should act on.
  const notable = h.hardFailures + h.handshakeStalls + h.shed + h.otherNon2xx;
  if (notable === 0) return {};
  return {
    mcpProxyTransport: {
      windowMs: h.windowMs,
      hardFailures: h.hardFailures,
      handshakeStalls: h.handshakeStalls,
      shed: h.shed,
      otherNon2xx: h.otherNon2xx,
      recovered: h.recovered,
      byKind: h.byKind,
      newestAt: h.newestAt,
      note:
        h.handshakeStalls > 0
          ? `${h.handshakeStalls} upstream-silence stall(s) on the MCP handshake (WI-6740). Each was RETRIED and survived — but this is the class that leaves a session tool-dark for its entire life if the retry ever runs out. Not benign.`
          : `${h.hardFailures} hard tool-transport failure(s) the proxy could not hide from callers.`,
    },
  };
}

/** Additive stable scan path over the existing service/supervision payload. */
export function buildServiceHealthDiagnostic(
  services: ProbeResult[],
  supervision: SupervisionStatusEntryWithRecency[],
  /** EI-20065717746825416: live `ActiveState` of `papercusp-bg-host-watchdog`, when the caller
   *  could read it. Drives the ownership disclosure on a bg-host `nextVerb`; `undefined` is an
   *  honest unknown that discloses ownership WITHOUT asserting the watchdog is up. */
  watchdogActive?: boolean,
): RuntimeDiagnostic<
  { services: string[]; supervised: string[] },
  { up: number; down: number; wedged: number; absent: number; supervisionUnhealthy: number },
  { checked: number; failures: ProbeResult[]; unhealthySupervision: SupervisionStatusEntry[] },
  ServiceRootCause
> {
  const absent = services.filter((s) => s.present === false);
  const failures = services.filter((s) => s.present !== false && !s.up);
  // `flapState` is only measured by the reconciler process. The operator-side
  // snapshot legitimately carries zero-default `flapState:"ok"` with
  // `flapObserved:false`, so an explicit systemd verdict must also drive this
  // rollup or a failed unit can read as healthy (EI-20440455610518184).
  const unhealthySupervision = supervision.filter((s) => s.flapState !== "ok" || s.healthy === false);
  // EI-19465075959589134: a wedge is the more actionable finding of the two, so
  // it leads the root cause even when an ordinary down probe sorted first — the
  // whole point is that a wedge never announces itself in the other signals.
  const wedgedFailures = failures.filter((s) => s.wedged === true);
  const first = wedgedFailures[0] ?? failures[0];
  const supervisor = unhealthySupervision[0];
  const rootCause: ServiceRootCause | null = first
    ? { component: first.name, reason: first.note ?? `probe failed (status ${first.status ?? "none"})` }
    : supervisor
      ? {
          component: supervisor.name,
          reason:
            supervisor.healthy === false
              ? `systemd state ${supervisor.activeState ?? "unhealthy"}`
              : `supervisor state ${supervisor.flapState}`,
        }
      : null;
  return runtimeDiagnostic({
    configured: {
      services: services.map((s) => s.name),
      supervised: supervision.map((s) => s.name),
    },
    effective: {
      up: services.length - absent.length - failures.length,
      // `down` stays the whole failure count (nothing is answering, whatever the
      // cause); `wedged` is the SUBSET that is still listening. Reported side by
      // side rather than partitioned, so an existing reader of `down` keeps its
      // meaning and a new one can ask the sharper question.
      down: failures.length,
      wedged: wedgedFailures.length,
      absent: absent.length,
      supervisionUnhealthy: unhealthySupervision.length,
    },
    evidence: { checked: services.length, failures, unhealthySupervision },
    rootCause,
    // EI-20065717746825416: a bg-host restart is OWNED by an out-of-process watchdog, so the
    // verb must name that owner. Same `includes("bg-host")` predicate `restartVerbForService`
    // uses, so every component routed to the bg-host restart carries the disclosure with it —
    // a name that earns the verb but not the caveat is exactly how this gap reappears.
    nextVerb: rootCause
      ? nextVerbForService(rootCause.component, first?.wedged) +
        (rootCause.component.includes("bg-host") ? bgHostWatchdogOwnership(watchdogActive) : "")
      : null,
  });
}

export default defineTool({
  name: "dev:service_health",
  description:
    'Probe fixed dev endpoints (:3070 operator, :3170 staging, :3055 vite, :46229 oddsmith, desktop, bg-host ticker) plus optional systemd units. Services report URL/status/latency; `mcpHandshake` independently validates JSON-RPC initialize, so a green operator GET does not prove MCP health. bg-host-ticker is separate from :3070, and an absent desktop is absent rather than failed. In `supervision[]`, read `healthy` as the verdict and `activeState` as raw systemd state: episodic inactive may be healthy, while enabled/static inactive is not; omitted is unknown. `units` + `scope` query arbitrary user/system units and return `unitStates` + `unitsUnknown`; read unknowns first because nonexistent and stopped units can both appear inactive.',
  guidance: {
    when: 'Check dev services before testing; VERIFY A STAGING EDIT after `dev:restart { target:"staging" }` with `dev:service_health { units:["papercusp-staging-api"], scope:"user" }` (read unitsUnknown before unitStates, then probe :3170); diagnose connection-refused/stale-server or a git-sync/routine-engine stall via bg-host-ticker.',
    notWhen:
      "File/lock contention — that is locks:queue. Migration drift — db:check_drift.",
    // EI-21678459404022074: `target` is dev:restart's argument, not this tool's — and
    // this tool's own `when` above puts `dev:restart { target:"staging" }` in the clause
    // immediately before the verify call, so a caller reading it straight through carries
    // `target` onto the wrong verb. The bare unrecognized-key rejection ("accepts ONLY:
    // units, scope") never named where `target` actually lives. Same shape, and same fix,
    // as coord:inbox's `since`/`q` redirects: zero prompt weight (never rendered into the
    // description), paid only on the failure path.
    argRedirects: {
      target: {
        tool: 'dev:restart',
        // WI-2142574: this generated call is VALIDATED against dev:restart's own schema by
        // assertProjectedToolGuidanceConformance(), and `target` there is a z.enum. A
        // descriptive placeholder (`'<the service to restart>'`) reads fine to a human but
        // can never validate, and the failure is not local: the conformance assert THROWS,
        // _guidance-adapter's loadToolGuidancePages() catches and returns [], and all ~835
        // tool-guidance pages vanish at once — which red-pins the green-checkpoint gate.
        // Placeholders remain correct for FREE-FORM args (work_items:tag uses
        // "<work-item-id>"); an enum arg must carry a real member. 'staging' matches this
        // tool's own `when` clause and the papercusp-staging-api example in `note` below.
        args: { target: 'staging' },
        note: 'dev:service_health probes a FIXED endpoint set and takes only `units` + `scope` — there is no `target` to aim it at. Restarting a named service is dev:restart { target }; to VERIFY that restart, call this tool with units:["papercusp-staging-api"], scope:"user" and read unitsUnknown before unitStates',
      },
    },
    returns:
      "{ configured, effective, evidence, rootCause, nextVerb, services, telemetry, supervision }. On a failed service, `wedged:true` plus `acceptQueue` means a listener exists but its event loop is blocked; `down` means no listener. PID/port/TCP liveness cannot overrule a failed probe. Missing `wedged` is unknown. Capture logs before restarting a wedged service, because restart destroys the evidence.",
    seeAlso: [
      "dev:restart (restart a down service)",
      "dev:pg_health (Postgres health specifically)",
      "dev:build_status (build / smoke status)",
    ],
  },
  capability: "intel:read",
  // This handler probes HTTP/systemd/in-memory state and never reads ctx.tx.
  // Keeping the ambient workspace transaction open while those probes run pins
  // an org-app pool slot and lets concurrent health checks saturate the pool.
  skipWorkspaceTx: true,
  // EI-20244125997858314: ptool consumes this response as JSON. The complete
  // service/supervision snapshot can exceed the generic result door, whose
  // truncation footer would turn the machine-readable body into invalid JSON.
  skipResultDoor: "programmatic-caller",
  requirePrincipal: false,
  agentRoles: [
    "scoper",
    "architect",
    "worker",
    "validator",
    "reviewer",
    "debugger",
    "operator",
    "documenter",
    "curator",
    "cup",
  ],
  args: z.object({
    /**
     * P-014: the arbitrary-unit escape hatch. Everything above answers "is it
     * up" for a FIXED registry; this answers it for any unit systemd knows —
     * which is what `systemctl is-active` is actually asked about (50 of 114
     * such atoms in the 7d corpus name a unit no registry can reach).
     */
    units: z
      .array(z.string().min(1).max(200))
      .max(20)
      .optional()
      .describe(
        "systemd units to report state for — the tool form of `systemctl is-active|is-failed <unit>...`. Bare names get `.service` appended; `.timer`/`.socket`/`.scope` etc are used as given. Returns unitStates[] with LoadState + ActiveState + SubState, and unitsUnknown[] for units NO queried scope has heard of — read that first, because systemd prints `inactive` for a unit that does not exist, which is byte-identical to a stopped one.",
      ),
    /**
     * Three-valued for the `logs:read` reason: --user and --system are separate
     * managers, and a boolean forces a caller asking about a system unit to
     * query a manager that cannot hold the answer.
     */
    scope: z
      .enum(["user", "system", "all"])
      .optional()
      .describe(
        "Which systemd manager `units` is looked up in: 'user' (default — every papercup-* unit), 'system' (auditd, ufw, pgbouncer), or 'all' to query both and merge. Only meaningful with `units`.",
      ),
  }),
  // Keep the complete diagnostic snapshot available as structured MCP content.
  // The text projection remains human-oriented, while this schema makes the
  // authored return shape machine-verifiable (EI-211111).
  result: z
    .object({
      configured: z.unknown().optional(),
      effective: z.unknown().optional(),
      evidence: z.unknown().optional(),
      rootCause: z.unknown().nullable().optional(),
      nextVerb: z.string().nullable().optional(),
      services: z.unknown().optional(),
      telemetry: z.unknown().optional(),
      supervision: z.unknown().optional(),
    })
    .passthrough(),
  async handler({ units, scope }) {
    // The unit query is ADDITIVE and independent of the fixed probe set: a
    // caller passing `units` still gets the full snapshot, because "is this one
    // unit up" and "what is the state of everything" are usually asked in the
    // same breath and a second round-trip for the other half is the cost this
    // whole plan exists to remove.
    // These reads do not depend on one another. A slow systemd/spawner-sidecar
    // request must not serialize two more probe phases past the MCP deadline.
    const unitStatesPromise = units?.length ? probeUnitStates(units, scope ?? "user") : Promise.resolve(null);
    const supervisionPromise = overlaySystemdRestartRecency(
      overlayNodeChildSupervision(
        supervisionSnapshot(),
        substrateSidecarSupervisionStatus(),
        spawnerSidecarSupervisionStatus(),
      ),
    );
    const [unitStates, rawServices, mcpHandshake, supervision] = await Promise.all([
      unitStatesPromise,
      probeAll(),
      probeMcpHandshake(),
      supervisionPromise,
    ]);
    // EI-19934795546523351: reconcile the bg-host-ticker verdict against this SAME
    // response's supervision block BEFORE it can drive a contradictory rootCause/
    // nextVerb — see reconcileBgHostTicker's doc comment.
    const services = reconcileBootingHttpServices(reconcileBgHostTicker(rawServices, supervision), supervision);
    // EI-20065717746825416: when a bg-host component is the failure we are about to prescribe a
    // restart for, read whether its out-of-process supervisor is actually running — so the verb
    // names a LIVE owner, reports a DEAD one as the critical finding it is, and says "unknown"
    // when the probe could not tell. Conditional on purpose: a systemctl call on every healthy
    // call would be pure cost, and this is the only branch whose advice depends on the answer.
    const bgHostFailing = services.some((s) => s.present !== false && !s.up && s.name.includes("bg-host"));
    let watchdogActive: boolean | undefined;
    if (bgHostFailing) {
      const probed = await probeUnitStates([BG_HOST_WATCHDOG_UNIT], "user").catch(() => null);
      const row = probed?.states?.[0];
      // `not-found` (never installed) is a determinate NO supervisor, not an unknown. A missing
      // row / failed probe stays undefined — an unreadable probe must never read as an absence.
      watchdogActive = row ? row.loadState !== "not-found" && row.activeState === "active" : undefined;
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            services,
            mcpHandshake,
            telemetry: getTelemetryHealth(),
            ...buildMcpProxyTransportBlock(),
            // P-004/P-006 (critical-process-supervisor-2026-07-04): additive block, existing
            // fields above are UNCHANGED — the systemd-user layer is sourced from the P-002
            // reconciler's own flap state, the node-child sidecars from THEIR OWN respawn
            // modules (P-006) — no second probe pass, everything here is sync/in-memory.
            supervision,
            // P-014: only present when `units` was asked for — an empty key on
            // every other call would train callers to ignore it.
            ...(unitStates
              ? {
                  unitStates: unitStates.states,
                  unitsUnknown: unitStates.unitsUnknown,
                  ...(unitStates.scopesUnavailable.length
                    ? { scopesUnavailable: unitStates.scopesUnavailable }
                    : {}),
                }
              : {}),
            ...buildServiceHealthDiagnostic(services, supervision),
          }),
        },
      ],
    };
  },
});
