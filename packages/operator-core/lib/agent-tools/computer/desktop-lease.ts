/**
 * desktop-lease.ts — sandbox-desktop lifecycle: the integration seam between the
 * desktop provisioner and capability:computer.
 *
 * Two kinds of lease share one map (agent-multi-desktops-grid-2026-10-06 P-002):
 *
 *  - a POT lease — one shared desktop per hive. The bee spawn env points
 *    capability:computer at it via `desktopEnvForHive()` (the operator merges that into
 *    the child env, the same way the frame path sets `DISPLAY` from
 *    `acquireAgentDisplay`). Teardown rides pot:dissolve.
 *  - an AGENT lease — a desktop an agent started for itself. An agent may hold MANY,
 *    each with an agent-chosen name (D-003); teardown is computer:release_desktop or the
 *    lifecycle governor.
 *
 * Every lease is keyed by its SCOPE KEY (`pot:<slug>` | `agent:<ownerId>:<name>`, see
 * desktop-names.ts), not by its registry session id: the registry row is best-effort
 * (below), so a live lease may have no id yet, and keying by one would make that
 * desktop unaddressable (D-012). Session ids resolve through the `sessionIds` reverse
 * map.
 *
 * In-process state (a desktop is a live child of THIS operator loop — if the loop
 * dies its Xvfb dies with it), mirroring `display-allocator`'s rationale: a
 * per-process resource lease is legitimately non-PG.
 *
 * The provisioner is an injectable seam so the lifecycle unit-tests without
 * spawning a real Xvfb.
 */
import {
  provisionSandboxDesktop as realProvision,
  type ProvisionOptions,
  type SandboxDesktop,
} from './desktop-provisioner';
import { activeWorkspaceId } from '../../workspace-registry';
import { resetLedger } from './action-ledger';
import { stopRecording } from './trajectory-recorder';
import {
  registerDesktopSession,
  markDesktopReady,
  closeDesktopSession,
  resolveDesktopForScope,
  getDesktopSession,
  type DesktopCapabilities,
  type DesktopSessionRecord,
} from '../../desktop/desktop-session-registry';
import { killTask } from '../../task-manager/control';
import { existsSync } from 'node:fs';
import { provisionWorkspaceDesktop, WORKSPACE_DESKTOP_SOCKET } from '../../desktop/workspace-desktop-session';
import { agentLeaseKey, potLeaseKey } from './desktop-names';

type Provisioner = (opts?: ProvisionOptions) => Promise<SandboxDesktop>;

/** Which desktop a lease operation addresses. */
export type DesktopLeaseTarget =
  | { scope: 'pot'; pot: string }
  | {
      scope: 'agent';
      /** The owning agent's coordination ownerId (resolveAgentIdentity(ctx).ownerId). */
      ownerId: string;
      /** Agent-chosen, unique per live (workspace, agent) — see desktop-names.ts. */
      name: string;
      /** The agent's harness, recorded on the row for tenant-scoped listing. */
      harnessSlug?: string | null;
    };

/** A lease as an observer sees it — the shape list/grid code reads. */
export interface DesktopLeaseInfo {
  key: string;
  scope: 'pot' | 'agent';
  /** Pot slug for a pot lease; the owning ownerId for an agent lease. */
  scopeRef: string;
  name: string | null;
  harnessSlug: string | null;
  desktop: SandboxDesktop;
  /** The registry row backing this lease, or undefined while that best-effort write has not landed. */
  sessionId: string | undefined;
}

interface LeaseEntry {
  target: DesktopLeaseTarget;
  desktop: SandboxDesktop;
}

export function desktopLeaseKey(target: DesktopLeaseTarget): string {
  return target.scope === 'pot' ? potLeaseKey(target.pot) : agentLeaseKey(target.ownerId, target.name);
}

/**
 * The journal label for a lease. Deliberately NOT the lease key: pot leases keep the
 * `pot=<slug>` form operators already grep host journals for, and an agent lease
 * names both its owner and its desktop name rather than an opaque compound key.
 */
function leaseLogLabel(target: DesktopLeaseTarget): string {
  return target.scope === 'pot' ? `pot=${target.pot}` : `agent=${target.ownerId} name=${target.name}`;
}

/**
 * The registry mirror: lease key → the PG row describing it. `leases` stays the
 * AUTHORITY for liveness — it holds the actual child process — and this map only
 * remembers which row describes it, so teardown can close the record.
 *
 * Every registry write here is BEST-EFFORT and deliberately so. A desktop works
 * perfectly well without its inventory row; failing a provision because Postgres
 * hiccupped would trade a working feature for bookkeeping. The degraded outcome is
 * that `computer:list_desktops` under-reports, which is visible and recoverable —
 * the reconciler and the next provision both repair it.
 */
const sessionIds = new Map<string, string>();

const defaultProvision: Provisioner = (opts) => existsSync(WORKSPACE_DESKTOP_SOCKET)
  ? provisionWorkspaceDesktop(opts)
  : realProvision(opts);
let provisionImpl: Provisioner = defaultProvision;
/** Test seam — swap the provisioner so the lifecycle tests need no live X. */
export function __setProvisionerForTests(next: Provisioner): void {
  provisionImpl = next;
}
export function __resetProvisioner(): void {
  provisionImpl = defaultProvision;
}

const leases = new Map<string, LeaseEntry>();
/** Coalesce concurrent ensure() calls for the same lease key onto one provision. */
const inflight = new Map<string, Promise<SandboxDesktop>>();

/**
 * Provision (or return the existing) desktop for a target. Idempotent per key and
 * race-safe: concurrent calls for one key share one provision, while different keys
 * — two names of one agent, or two pots — provision independently.
 */
export async function ensureDesktop(target: DesktopLeaseTarget, opts?: ProvisionOptions): Promise<SandboxDesktop> {
  const key = desktopLeaseKey(target);
  const existing = leases.get(key);
  if (existing && existing.desktop.isAlive?.() !== false) {
    // A lease whose row write failed stays nameless for the life of this process
    // unless the next ensure retries it (WI-10002797): the hosted relay cannot
    // offer a desktop the registry does not name.
    if (!sessionIds.has(key)) await recordLeaseInRegistry(key, existing);
    return existing.desktop;
  }
  if (existing) await releaseDesktop(target);
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    const desktop = await provisionImpl(opts);
    const entry: LeaseEntry = { target, desktop };
    leases.set(key, entry);
    await recordLeaseInRegistry(key, entry);
    return desktop;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The leased desktop for a target, or undefined. */
export function leasedDesktop(target: DesktopLeaseTarget): SandboxDesktop | undefined {
  return leases.get(desktopLeaseKey(target))?.desktop;
}

/** The registry session id backing a target's lease, or undefined. */
export function desktopSessionIdFor(target: DesktopLeaseTarget): string | undefined {
  return sessionIds.get(desktopLeaseKey(target));
}

function infoFor(key: string, entry: LeaseEntry): DesktopLeaseInfo {
  const t = entry.target;
  return {
    key,
    scope: t.scope,
    scopeRef: t.scope === 'pot' ? t.pot : t.ownerId,
    name: t.scope === 'agent' ? t.name : null,
    harnessSlug: t.scope === 'pot' ? t.pot : (t.harnessSlug ?? null),
    desktop: entry.desktop,
    sessionId: sessionIds.get(key),
  };
}

/** Every lease this process holds, pot and agent alike (observability / the grid). */
export function listDesktopLeases(): DesktopLeaseInfo[] {
  return [...leases].map(([key, entry]) => infoFor(key, entry));
}

/** The registry ids of every live lease — what a sole-owner reconcile must vouch for. */
export function leasedDesktopSessionIds(): string[] {
  return [...leases.keys()].map((k) => sessionIds.get(k)).filter((id): id is string => Boolean(id));
}

/**
 * The capabilities a fresh lease actually MEASURED, in the registry's shape.
 *
 * Pure and exported so the derivation is unit-testable without a Postgres row —
 * the mirror below is best-effort and swallows its own failures, which is exactly
 * the shape in which a wrong capability goes unnoticed.
 *
 * ⚠ BOTH fields are stamped from a MEASUREMENT, never from the presence of the
 * object that carries it (D-004: capabilities are MEASURED, never assumed). That
 * distinction is not pedantic — it is the bug this function was extracted to fix:
 *
 *  - `gl` was stamped as `Boolean(desktop.gl)`. `desktop.gl` is a GlStrategy
 *    OBJECT and the ladder's negative verdict is `NO_GL_STRATEGY`, a frozen object
 *    — so that expression is `true` for every lease ever recorded, including the
 *    desktops the ladder positively concluded have no GL. A constant wearing a
 *    measurement's name is worse than an absent field: `computer:list_desktops`
 *    reports it under "measured capabilities" and a consumer believes it. The tier
 *    is what the ladder actually decided, so read the tier.
 *  - `a11y` was declared on `DesktopCapabilities` and never written at all, so the
 *    provisioner's accessibility verdict died at this process boundary. The cost
 *    lands on a DIFFERENT process much later: `computer:observe` is the first thing
 *    that can tell you a desktop has no a11y bus, and it can only do so by
 *    REFUSING (EI-22074168424155872). Recording it here is what lets a caller ask
 *    before it drives, instead of discovering it from an error.
 */
export function leaseCapabilities(desktop: SandboxDesktop): DesktopCapabilities {
  return {
    // P-002's ladder verdict, not the presence of its result object.
    gl: desktop.gl.tier !== 'none',
    // P-007 — absent `a11y` is a legal screenshot-only desktop, not an error; it is
    // still a fact a consumer must be able to read rather than infer from a refusal.
    a11y: Boolean(desktop.a11y),
  };
}

/**
 * Mirror a freshly-provisioned lease into the registry (pot leases: scope='pot' per
 * D-005; agent leases: scope='agent' + name per D-003). Best-effort: see
 * `sessionIds`' comment for why a failure here must never fail the provision.
 *
 * The verdicts measured during provisioning are stamped as capabilities so
 * downstream consumers read them instead of re-probing the display — see
 * `leaseCapabilities` for what "measured" has to mean here.
 */
async function recordLeaseInRegistry(key: string, entry: LeaseEntry): Promise<void> {
  const workspaceId = activeWorkspaceId();
  const { target, desktop } = entry;
  const scopeFields =
    target.scope === 'pot'
      ? { harnessSlug: target.pot, scope: 'pot' as const, scopeRef: target.pot }
      : {
          harnessSlug: target.harnessSlug ?? null,
          scope: 'agent' as const,
          scopeRef: target.ownerId,
          name: target.name,
          leaseHolder: target.ownerId,
        };
  try {
    const session = await registerDesktopSession({
      workspaceId,
      ...scopeFields,
      kind: desktop.xServer === 'kasmvnc' ? 'kasmvnc' : 'xvfb-local',
      display: desktop.display,
      displayGeometry: { width: desktop.width, height: desktop.height },
      // D-006: only sent when the caller REQUESTED a box. Omitted lets the registry
      // apply DEFAULT_CAPTURE_GEOMETRY, so the default lives in exactly one place.
      ...(desktop.capture ? { captureGeometry: desktop.capture } : {}),
      // P-005 — the cross-process freeze/kill handle. Without it the lifecycle
      // governor can see this desktop go idle and cannot do anything about it,
      // because `release()` above is a closure in THIS loop.
      taskId: desktop.taskId,
    });
    sessionIds.set(key, session.id);
    await markDesktopReady(session.id, { capabilities: leaseCapabilities(desktop) }, undefined);
  } catch (err) {
    // Still best-effort — a desktop without its row still works — but never silent.
    // On a workspace host the row IS the product: the hosted relay offers only the
    // desktops the registry names, so a swallowed unique-index conflict read as
    // `desktop_unavailable` with nothing in the journal to say why (D-439).
    const pg = err as { code?: string; constraint_name?: string; message?: string };
    console.warn(
      `[desktop-lease] registry write failed for ${leaseLogLabel(target)} display=${desktop.display} workspace=${workspaceId}` +
        ` code=${pg.code ?? '-'} constraint=${pg.constraint_name ?? '-'}: ${pg.message ?? String(err)}`,
    );
  }
}

/** Close a lease's registry row, if it has one. Best-effort + idempotent. */
async function closeLeaseInRegistry(key: string): Promise<void> {
  const id = sessionIds.get(key);
  if (!id) return;
  sessionIds.delete(key);
  try {
    await closeDesktopSession(id, 'released');
  } catch {
    /* inventory only */
  }
}

/** Outcome of a release: what, if anything, was actually torn down. */
export interface ReleaseHiveDesktopResult {
  released: boolean;
  /** 'local' = this process held the lease. 'registry' = EI-21881587666157000 —
   *  a SIBLING operator process provisioned it; this process has no in-memory
   *  handle, so the registry row (cross-process by design) is the only way to
   *  find and kill it. 'none' = genuinely nothing leased anywhere. */
  via: 'local' | 'registry' | 'none';
}

/** Tear down a local lease: drop it, reset its per-display state, close its row, kill it. */
async function releaseLocal(key: string, entry: LeaseEntry): Promise<ReleaseHiveDesktopResult> {
  leases.delete(key);
  // P-008: display numbers are recycled, so the next lease on `:110` would inherit
  // this one's step numbers and diagnostics history if the ledger were not dropped.
  resetLedger(entry.desktop.display);
  // P-009: same reason, one level up — an open recording left on a recycled display
  // would keep appending the NEXT lease's frames to the previous lease's trajectory.
  stopRecording(entry.desktop.display, 'desktop-released');
  await closeLeaseInRegistry(key);
  await entry.desktop.release();
  return { released: true, via: 'local' };
}

/**
 * EI-21881587666157000: kill a desktop this process never held, through the registry
 * row — the SAME cross-process handle the idle-desktop governor uses (P-005 in
 * recordLeaseInRegistry above) — then close the row.
 */
async function releaseViaRegistryRow(row: DesktopSessionRecord): Promise<ReleaseHiveDesktopResult> {
  if (row.taskId) {
    // Best-effort: a kill failure still gets the row closed below so the
    // registry (and computer:list_desktops) stop lying about it being ready,
    // even if the orphaned Xvfb itself needs a human/processes:kill follow-up.
    await killTask(row.taskId, { includeSubtree: true }).catch(() => {});
  }
  await closeDesktopSession(row.id, 'released').catch(() => {});
  return { released: true, via: 'registry' };
}

/** Tear down one target's desktop. Idempotent. */
export async function releaseDesktop(target: DesktopLeaseTarget): Promise<ReleaseHiveDesktopResult> {
  const key = desktopLeaseKey(target);
  const entry = leases.get(key);
  if (entry) return releaseLocal(key, entry);
  // `leases` only knows what THIS process provisioned; a sibling operator's desktop is
  // invisible here though very much alive, so fall back to the registry row. A miss
  // means there is genuinely nothing leased for this target, anywhere.
  const row = await resolveDesktopForScope(
    target.scope === 'pot'
      ? { workspaceId: activeWorkspaceId(), scope: 'pot', scopeRef: target.pot }
      : { workspaceId: activeWorkspaceId(), scope: 'agent', scopeRef: target.ownerId, name: target.name },
  ).catch(() => undefined);
  if (!row) return { released: false, via: 'none' };
  return releaseViaRegistryRow(row);
}

/**
 * Tear down a desktop by its registry session id. Ownership is the CALLER's check
 * (computer:release_desktop applies D-005's rule before calling this).
 */
export async function releaseDesktopBySessionId(desktopSessionId: string): Promise<ReleaseHiveDesktopResult> {
  for (const [key, sessionId] of sessionIds) {
    if (sessionId !== desktopSessionId) continue;
    const entry = leases.get(key);
    if (entry) return releaseLocal(key, entry);
  }
  const row = await getDesktopSession({ workspaceId: activeWorkspaceId(), id: desktopSessionId }).catch(() => undefined);
  if (!row) return { released: false, via: 'none' };
  return releaseViaRegistryRow(row);
}

/**
 * WI-10004206 — release every lease (pot and agent) whose desktop is gone, and
 * return their keys.
 *
 * A dead lease otherwise sits in `leases` (and its row stays `ready`) until something
 * happens to call `ensureDesktop` for that key, so every reader in between is offered
 * a desktop nothing serves. The identity check keeps a lease that was replaced while
 * an earlier release was awaited from being torn down in its predecessor's place.
 */
export async function reapDeadDesktops(): Promise<string[]> {
  const reaped: string[] = [];
  for (const [key, entry] of [...leases]) {
    if (entry.desktop.isAlive?.() !== false || leases.get(key) !== entry) continue;
    const label = leaseLogLabel(entry.target);
    console.warn(`[desktop-lease] ${label} display=${entry.desktop.display}: the desktop is gone — releasing its lease`);
    await releaseDesktop(entry.target).catch((err) => {
      console.warn(`[desktop-lease] releasing dead desktop ${label} failed: ${String(err)}`);
    });
    reaped.push(key);
  }
  return reaped;
}

/** Tear down EVERY leased desktop, pot and agent (operator shutdown). */
export async function releaseAllDesktops(): Promise<void> {
  const all = [...leases.values()].map((e) => e.desktop);
  const keys = [...leases.keys()];
  leases.clear();
  await Promise.all(keys.map((k) => closeLeaseInRegistry(k)));
  await Promise.all(all.map((d) => d.release().catch(() => {})));
}

/**
 * The LIVE desktop behind a registry session id, or undefined.
 *
 * The inverse of `desktopSessionIdFor`, and the seam the hosted relay's desktop
 * backend resolves through (P-013 / WI-1064431). It reads `leases` on purpose:
 * this module's header records that `leases` is the AUTHORITY for liveness and the
 * PG row is a best-effort mirror, and a viewer needs the two things only the live
 * handle has — the loopback `endpoint` and this session's KasmVNC `credentials`.
 * Both are per-process values that were never persisted (the credential file holds
 * hashes, not secrets), so a registry read cannot answer this and re-minting would
 * rotate the secrets out from under an already-connected viewer.
 *
 * Linear over `sessionIds` deliberately: a host holds tens of desktops at most, and a
 * second reverse index would be one more thing that can disagree with the map it
 * indexes.
 */
export function leasedDesktopBySessionId(desktopSessionId: string): SandboxDesktop | undefined {
  for (const [key, sessionId] of sessionIds) {
    if (sessionId === desktopSessionId) {
      const desktop = leases.get(key)?.desktop;
      return desktop?.isAlive?.() === false ? undefined : desktop;
    }
  }
  return undefined;
}

// ── Pot-lease API: the original per-hive surface, kept as wrappers (D-004/D-012) ──

const potTarget = (potSlug: string): DesktopLeaseTarget => ({ scope: 'pot', pot: potSlug });

/** Provision (or return the existing) sandbox desktop for a hive. Idempotent + race-safe. */
export function ensureHiveDesktop(potSlug: string, opts?: ProvisionOptions): Promise<SandboxDesktop> {
  return ensureDesktop(potTarget(potSlug), opts);
}

/** The leased desktop for a hive, or undefined. */
export function hiveDesktop(potSlug: string): SandboxDesktop | undefined {
  return leasedDesktop(potTarget(potSlug));
}

/**
 * The leased X display string for a hive (e.g. ":110"), or undefined. For wiring
 * `DISPLAY` into a capability:bash exec (computer-tool-plan Gap C) so a bee can LAUNCH
 * GUI apps on its leased desktop (`firefox &`); capability:computer then drives them.
 * Never `:0` — a lease is always a sandbox display.
 */
export function displayForHive(potSlug: string): string | undefined {
  return hiveDesktop(potSlug)?.display;
}

/**
 * The env vars capability:computer reads — merge into a bee's spawn env so the
 * tool resolves the hive's leased display (and never the host :0). Empty object
 * when the hive has no desktop (→ the tool errors "no desktop leased", which is
 * the correct deny-by-default).
 */
export function desktopEnvForHive(potSlug: string): Record<string, string> {
  const d = hiveDesktop(potSlug);
  if (!d) return {};
  return {
    PAPERCUSP_COMPUTER_DISPLAY: d.display,
    PAPERCUSP_COMPUTER_WIDTH: String(d.width),
    PAPERCUSP_COMPUTER_HEIGHT: String(d.height),
  };
}

/** Tear down a hive's desktop (call from pot:dissolve). Idempotent. */
export function releaseHiveDesktop(potSlug: string): Promise<ReleaseHiveDesktopResult> {
  return releaseDesktop(potTarget(potSlug));
}

/** Hive slugs that currently hold a POT desktop lease (observability). Agent leases: `listDesktopLeases`. */
export function leasedHiveDesktops(): string[] {
  return listDesktopLeases()
    .filter((l) => l.scope === 'pot')
    .map((l) => l.scopeRef);
}

/**
 * Reap every dead lease (pot AND agent — see `reapDeadDesktops`) and return the pot
 * slugs among them, the shape the per-hive callers expect.
 */
export async function reapDeadHiveDesktops(): Promise<string[]> {
  const prefix = potLeaseKey('');
  return (await reapDeadDesktops()).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** Tear down EVERY leased desktop (operator shutdown). Same as `releaseAllDesktops`. */
export function releaseAllHiveDesktops(): Promise<void> {
  return releaseAllDesktops();
}

/** The registry session id backing a hive's lease (observability / tests). */
export function hiveDesktopSessionId(potSlug: string): string | undefined {
  return desktopSessionIdFor(potTarget(potSlug));
}
