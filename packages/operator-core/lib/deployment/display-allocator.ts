/**
 * Per-agent DISPLAY leasing on a desktop-enabled frame
 * (`hive-frame-desktops-live-view-2026-06-06` P-002/D-001).
 *
 * The frame bootstrap (P-001) stands up one Xvfb display per agent slot and
 * advertises the pool to the orchestrator loop via env:
 *   PAPERCUSP_DESKTOP_DISPLAYS      — pool size (unset/0 = no desktop)
 *   PAPERCUSP_DESKTOP_DISPLAY_BASE  — first display number (default 99)
 *
 * The allocator is deliberately IN-PROCESS state, not PG: a lease is ephemera
 * tied to a live child process of THIS orchestrator loop — if the loop dies its
 * children die with it, and the pool resets with the process. (Per the storage
 * policy's acceptable-uses list: per-process resource leases, like O_EXCL
 * locks, are legitimately non-PG.)
 *
 * Pool exhausted → the spawn proceeds HEADLESS (`undefined`; the caller logs
 * it) rather than queueing — a GUI display is an enhancement to a spawn, not a
 * precondition (D-001: isolation matters more than universal coverage).
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { activeWorkspaceId } from '../workspace-registry';
import { registerDesktopSession, closeDesktopSession } from '../desktop/desktop-session-registry';

export interface DisplayLeaseMeta {
  /** The role of the agent the display was leased for (worker/validator/…). */
  role?: string;
  /** The agent this display is leased to — becomes the registry row's scope_ref
   *  under scope='agent' (D-005), which is what makes the lease EXCLUSIVE by
   *  construction rather than by every caller remembering to check. */
  ownerId?: string;
}

/**
 * P-003 (D-004): mirror a slot lease into the DesktopSession registry so a frame
 * display is visible to `computer:list_desktops`, which previously could only see
 * one operator process's Map.
 *
 * FIRE-AND-FORGET, and that is a design constraint rather than laziness: `acquire`
 * is SYNCHRONOUS and sits on the agent-spawn path. Making it async to await a PG
 * write would ripple through every caller and put a database round-trip in front of
 * every spawn — to maintain an INVENTORY. The pool (in-process) stays the authority
 * for what is leased; the row is bookkeeping, so it is written beside the lease and
 * never in front of it.
 *
 * On a frame with no operator database this simply no-ops, which is the correct
 * degrade: the display still leases and the spawn still proceeds.
 */
function mirrorSlotLease(n: number, meta: DisplayLeaseMeta | undefined, onId: (id: string) => void): void {
  void (async () => {
    try {
      const session = await registerDesktopSession({
        workspaceId: activeWorkspaceId(),
        kind: 'frame-slot',
        scope: 'agent',
        scopeRef: meta?.ownerId ?? `display-${n}`,
        leaseHolder: meta?.ownerId ?? null,
        display: `:${n}`,
        // A frame runs at the full 1920x1080 because the HUMAN live view wants the
        // real thing; capture geometry defaults to 1024x768 so the agent is not
        // silently billed ~2.6x per observation for it (D-006).
        displayGeometry: { width: 1920, height: 1080 },
      });
      onId(session.id);
    } catch {
      /* inventory only — never block or fail a spawn on bookkeeping */
    }
  })();
}

function unmirrorSlotLease(id: string | undefined): void {
  if (!id) return;
  void closeDesktopSession(id, 'released').catch(() => {});
}

export interface DisplayLease {
  /** The X display string for the agent's env (e.g. `:99`). */
  display: string;
  /** The display number (99, 100, …). */
  number: number;
  /** Return the display to the pool. Idempotent. */
  release(): void;
}

export interface DisplayLeaseInfo extends DisplayLeaseMeta {
  number: number;
  sinceMs: number;
}

export interface DisplayPool {
  /** Lease the lowest free display, or `undefined` when the pool is exhausted. */
  acquire(meta?: DisplayLeaseMeta): DisplayLease | undefined;
  /** Currently-leased display numbers (ascending) — observability for the live view. */
  leased(): number[];
  /** Full lease metadata (number/role/since) — what the lease snapshot ships. */
  leases(): DisplayLeaseInfo[];
  readonly size: number;
  readonly base: number;
}

export function createDisplayPool(
  base: number,
  count: number,
  onChange?: (leases: DisplayLeaseInfo[]) => void,
): DisplayPool {
  const inUse = new Map<number, DisplayLeaseInfo>();
  const leases = () => [...inUse.values()].sort((a, b) => a.number - b.number);
  const changed = () => onChange?.(leases());
  return {
    size: count,
    base,
    leased: () => [...inUse.keys()].sort((a, b) => a - b),
    leases,
    acquire(meta?: DisplayLeaseMeta) {
      for (let n = base; n < base + count; n++) {
        if (inUse.has(n)) continue;
        inUse.set(n, { number: n, role: meta?.role, sinceMs: Date.now() });
        changed();
        let released = false;
        let sessionId: string | undefined;
        // Beside the lease, never in front of it — see mirrorSlotLease.
        mirrorSlotLease(n, meta, (id) => {
          // If release() already ran, the row arrived after teardown; close it
          // immediately rather than leaking a live row for a returned display.
          if (released) void closeDesktopSession(id, 'released').catch(() => {});
          else sessionId = id;
        });
        return {
          display: `:${n}`,
          number: n,
          release() {
            if (released) return;
            released = true;
            inUse.delete(n);
            unmirrorSlotLease(sessionId);
            changed();
          },
        };
      }
      return undefined;
    },
  };
}

/** Build a pool from the bootstrap-advertised env, or `undefined` off-frame. */
export function displayPoolFromEnv(env: NodeJS.ProcessEnv = process.env): DisplayPool | undefined {
  const count = Number.parseInt(env.PAPERCUSP_DESKTOP_DISPLAYS ?? '', 10);
  if (!Number.isInteger(count) || count <= 0) return undefined;
  const baseRaw = Number.parseInt(env.PAPERCUSP_DESKTOP_DISPLAY_BASE ?? '', 10);
  const base = Number.isInteger(baseRaw) && baseRaw >= 0 ? baseRaw : 99;
  return createDisplayPool(base, count);
}

/** Build a pool from env, wiring the lease snapshot the capture pull ships. */
function poolWithSnapshot(env: NodeJS.ProcessEnv = process.env): DisplayPool | undefined {
  const count = Number.parseInt(env.PAPERCUSP_DESKTOP_DISPLAYS ?? '', 10);
  if (!Number.isInteger(count) || count <= 0) return undefined;
  const baseRaw = Number.parseInt(env.PAPERCUSP_DESKTOP_DISPLAY_BASE ?? '', 10);
  const base = Number.isInteger(baseRaw) && baseRaw >= 0 ? baseRaw : 99;
  const stateDir = env.PAPERCUSP_DESKTOP_STATE_DIR ?? '/run/papercusp/desktop';
  return createDisplayPool(base, count, (leases) => writeLeaseSnapshot(stateDir, leases));
}

/**
 * Best-effort lease snapshot at `<stateDir>/leases.json` — picked up by the
 * operator's SSH pull alongside the JPEGs so the live view can label a tile
 * with the role driving it. Ephemera in /run (gone on reboot, like the pool):
 * deliberately a file, not PG — it's the frame-local contract surface the
 * capture transport reads.
 */
function writeLeaseSnapshot(stateDir: string, leases: DisplayLeaseInfo[]): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const tmp = `${stateDir}/leases.json.tmp`;
    writeFileSync(tmp, JSON.stringify({ leases }, null, 2));
    renameSync(tmp, `${stateDir}/leases.json`);
  } catch {
    /* off-frame or unwritable — observability only, never block a spawn */
  }
}

let singleton: DisplayPool | null | undefined;

/** The process-wide pool (memoized from env). `undefined` = not a desktop frame. */
export function agentDisplayPool(): DisplayPool | undefined {
  if (singleton === undefined) singleton = poolWithSnapshot() ?? null;
  return singleton ?? undefined;
}

/** Lease a DISPLAY for one agent spawn; `release()` when the child exits. */
export function acquireAgentDisplay(meta?: DisplayLeaseMeta): DisplayLease | undefined {
  return agentDisplayPool()?.acquire(meta);
}

export function _resetDisplayPoolForTests(): void {
  singleton = undefined;
}
