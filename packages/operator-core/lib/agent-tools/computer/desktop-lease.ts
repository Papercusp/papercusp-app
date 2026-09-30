/**
 * desktop-lease.ts — per-hive sandbox-desktop lifecycle: the integration seam
 * between the desktop provisioner and capability:computer.
 *
 * A hive whose bees should operate a GUI gets ONE leased sandbox desktop. The
 * bee spawn env then points capability:computer at it via `desktopEnvForHive()`
 * (the operator merges that into the child env — the same way the frame path
 * sets `DISPLAY` from `acquireAgentDisplay`). Teardown rides pot:dissolve.
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
  type DesktopCapabilities,
} from '../../desktop/desktop-session-registry';
import { killTask } from '../../task-manager/control';
import { existsSync } from 'node:fs';
import { provisionWorkspaceDesktop, WORKSPACE_DESKTOP_SOCKET } from '../../desktop/workspace-desktop-session';

type Provisioner = (opts?: ProvisionOptions) => Promise<SandboxDesktop>;

/**
 * P-003 (D-004): the registry mirror. `leases` above stays the AUTHORITY for
 * liveness — it holds the actual child process — and this map only remembers which
 * PG row describes it, so teardown can close the record.
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

const leases = new Map<string, SandboxDesktop>();
/** Coalesce concurrent ensure() calls for the same hive onto one provision. */
const inflight = new Map<string, Promise<SandboxDesktop>>();

/** Provision (or return the existing) sandbox desktop for a hive. Idempotent + race-safe. */
export async function ensureHiveDesktop(potSlug: string, opts?: ProvisionOptions): Promise<SandboxDesktop> {
  const existing = leases.get(potSlug);
  if (existing && existing.isAlive?.() !== false) {
    // A lease whose row write failed stays nameless for the life of this process
    // unless the next ensure retries it (WI-10002797): the hosted relay cannot
    // offer a desktop the registry does not name.
    if (!sessionIds.has(potSlug)) await recordLeaseInRegistry(potSlug, existing);
    return existing;
  }
  if (existing) await releaseHiveDesktop(potSlug);
  const pending = inflight.get(potSlug);
  if (pending) return pending;

  const p = (async () => {
    const desktop = await provisionImpl(opts);
    leases.set(potSlug, desktop);
    await recordLeaseInRegistry(potSlug, desktop);
    return desktop;
  })().finally(() => inflight.delete(potSlug));
  inflight.set(potSlug, p);
  return p;
}

/** The leased desktop for a hive, or undefined. */
export function hiveDesktop(potSlug: string): SandboxDesktop | undefined {
  return leases.get(potSlug);
}

/**
 * The leased X display string for a hive (e.g. ":110"), or undefined. For wiring
 * `DISPLAY` into a capability:bash exec (computer-tool-plan Gap C) so a bee can LAUNCH
 * GUI apps on its leased desktop (`firefox &`); capability:computer then drives them.
 * Never `:0` — a lease is always a sandbox display.
 */
export function displayForHive(potSlug: string): string | undefined {
  return leases.get(potSlug)?.display;
}

/**
 * The env vars capability:computer reads — merge into a bee's spawn env so the
 * tool resolves the hive's leased display (and never the host :0). Empty object
 * when the hive has no desktop (→ the tool errors "no desktop leased", which is
 * the correct deny-by-default).
 */
export function desktopEnvForHive(potSlug: string): Record<string, string> {
  const d = leases.get(potSlug);
  if (!d) return {};
  return {
    PAPERCUSP_COMPUTER_DISPLAY: d.display,
    PAPERCUSP_COMPUTER_WIDTH: String(d.width),
    PAPERCUSP_COMPUTER_HEIGHT: String(d.height),
  };
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
 * Mirror a freshly-provisioned hive lease into the registry (scope='pot' per
 * D-005, kind='xvfb-local'). Best-effort: see `sessionIds`' comment for why a
 * failure here must never fail the provision.
 *
 * The verdicts measured during provisioning are stamped as capabilities so
 * downstream consumers read them instead of re-probing the display — see
 * `leaseCapabilities` for what "measured" has to mean here.
 */
async function recordLeaseInRegistry(potSlug: string, desktop: SandboxDesktop): Promise<void> {
  const workspaceId = activeWorkspaceId();
  try {
    const session = await registerDesktopSession({
      workspaceId,
      harnessSlug: potSlug,
      kind: desktop.xServer === 'kasmvnc' ? 'kasmvnc' : 'xvfb-local',
      scope: 'pot',
      scopeRef: potSlug,
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
    sessionIds.set(potSlug, session.id);
    await markDesktopReady(session.id, { capabilities: leaseCapabilities(desktop) }, undefined);
  } catch (err) {
    // Still best-effort — a desktop without its row still works — but never silent.
    // On a workspace host the row IS the product: the hosted relay offers only the
    // desktops the registry names, so a swallowed unique-index conflict read as
    // `desktop_unavailable` with nothing in the journal to say why (D-439).
    const pg = err as { code?: string; constraint_name?: string; message?: string };
    console.warn(
      `[desktop-lease] registry write failed for pot=${potSlug} display=${desktop.display} workspace=${workspaceId}` +
        ` code=${pg.code ?? '-'} constraint=${pg.constraint_name ?? '-'}: ${pg.message ?? String(err)}`,
    );
  }
}

/** Close a hive's registry row, if it has one. Best-effort + idempotent. */
async function closeLeaseInRegistry(potSlug: string): Promise<void> {
  const id = sessionIds.get(potSlug);
  if (!id) return;
  sessionIds.delete(potSlug);
  try {
    await closeDesktopSession(id, 'released');
  } catch {
    /* inventory only */
  }
}

/** Outcome of {@link releaseHiveDesktop}: what, if anything, was actually torn down. */
export interface ReleaseHiveDesktopResult {
  released: boolean;
  /** 'local' = this process held the lease. 'registry' = EI-21881587666157000 —
   *  a SIBLING operator process provisioned it; this process has no in-memory
   *  handle, so the registry row (cross-process by design) is the only way to
   *  find and kill it. 'none' = genuinely nothing leased anywhere. */
  via: 'local' | 'registry' | 'none';
}

/** Tear down a hive's desktop (call from pot:dissolve). Idempotent. */
export async function releaseHiveDesktop(potSlug: string): Promise<ReleaseHiveDesktopResult> {
  const d = leases.get(potSlug);
  if (!d) {
    // EI-21881587666157000: `leases` only knows what THIS process provisioned.
    // A desktop provisioned by a sibling operator process is invisible here even
    // though it is very much alive — the registry, unlike `leases`, is
    // deliberately cross-process. Fall back to it: resolve the row for this
    // pot, kill its task via the SAME cross-process handle the idle-desktop
    // governor already uses for this exact reason (P-005 in
    // recordLeaseInRegistry above), then close the row. A miss here means
    // there is genuinely nothing leased for this pot, anywhere.
    const row = await resolveDesktopForScope({
      workspaceId: activeWorkspaceId(),
      scope: 'pot',
      scopeRef: potSlug,
    }).catch(() => undefined);
    if (!row) return { released: false, via: 'none' };
    if (row.taskId) {
      // Best-effort: a kill failure still gets the row closed below so the
      // registry (and computer:list_desktops) stop lying about it being ready,
      // even if the orphaned Xvfb itself needs a human/processes:kill follow-up.
      await killTask(row.taskId, { includeSubtree: true }).catch(() => {});
    }
    await closeDesktopSession(row.id, 'released').catch(() => {});
    return { released: true, via: 'registry' };
  }
  leases.delete(potSlug);
  // P-008: display numbers are recycled, so the next lease on `:110` would inherit
  // this one's step numbers and diagnostics history if the ledger were not dropped.
  resetLedger(d.display);
  // P-009: same reason, one level up — an open recording left on a recycled display
  // would keep appending the NEXT lease's frames to the previous lease's trajectory.
  stopRecording(d.display, 'desktop-released');
  await closeLeaseInRegistry(potSlug);
  await d.release();
  return { released: true, via: 'local' };
}

/** Hive slugs that currently hold a desktop lease (observability). */
export function leasedHiveDesktops(): string[] {
  return [...leases.keys()];
}

/** Tear down EVERY leased desktop (operator shutdown). */
export async function releaseAllHiveDesktops(): Promise<void> {
  const all = [...leases.values()];
  const slugs = [...leases.keys()];
  leases.clear();
  await Promise.all(slugs.map((s) => closeLeaseInRegistry(s)));
  await Promise.all(all.map((d) => d.release().catch(() => {})));
}

/** The registry session id backing a hive's lease (observability / tests). */
export function hiveDesktopSessionId(potSlug: string): string | undefined {
  return sessionIds.get(potSlug);
}

/**
 * The LIVE desktop behind a registry session id, or undefined.
 *
 * The inverse of `hiveDesktopSessionId`, and the seam the hosted relay's desktop
 * backend resolves through (P-013 / WI-1064431). It reads `leases` on purpose:
 * this module's header records that `leases` is the AUTHORITY for liveness and the
 * PG row is a best-effort mirror, and a viewer needs the two things only the live
 * handle has — the loopback `endpoint` and this session's KasmVNC `credentials`.
 * Both are per-process values that were never persisted (the credential file holds
 * hashes, not secrets), so a registry read cannot answer this and re-minting would
 * rotate the secrets out from under an already-connected viewer.
 *
 * Linear over `sessionIds` deliberately: a host holds one desktop per hive, so this
 * is a handful of entries, and a second reverse index would be one more thing that
 * can disagree with the map it indexes.
 */
export function leasedDesktopBySessionId(desktopSessionId: string): SandboxDesktop | undefined {
  for (const [potSlug, sessionId] of sessionIds) {
    if (sessionId === desktopSessionId) {
      const desktop = leases.get(potSlug);
      return desktop?.isAlive?.() === false ? undefined : desktop;
    }
  }
  return undefined;
}
