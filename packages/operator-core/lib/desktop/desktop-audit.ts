/**
 * desktop-audit.ts — the ONE audit sink and the ONE action namespace shared by
 * every desktop viewer lane: frame, local, and hosted.
 *
 * ## Why one namespace (and why it is a module, not a convention)
 *
 * `frame-vnc.ts` already carries the reasoning, stated at the site that mints a
 * ticket: "ONE audit namespace across both targets, on purpose: an operator asking
 * 'who took over a desktop' writes one filter and finds every session. Two
 * namespaces would silently answer for only half the population."
 *
 * P-013 adds a THIRD target. A hosted takeover filed under its own namespace would
 * reintroduce exactly the split that comment forbids — and it would do so silently,
 * because the failure is an under-count in a security query, which looks identical
 * to a quiet week. So the namespace is a shared constant and the writer is a shared
 * function: a new lane joins the population by construction rather than by
 * remembering.
 *
 * The `target` field is what distinguishes the lanes, and it is carried in BOTH the
 * subject (so a bare `audit:list` read is unambiguous) and `details.target` (so a
 * query can filter on it without parsing a string).
 */
import { randomBytes } from 'node:crypto';

/**
 * Which viewer lane an event came from.
 *
 *   frame  — a desktop on a remote frame, reached over the D-003 SSH hop.
 *   local  — a desktop on THIS machine, reached over the loopback VNC bridge.
 *   hosted — a desktop in a customer VM, reached over the outbound relay (D-023).
 */
export type DesktopAuditTarget = 'frame' | 'local' | 'hosted';

/**
 * The shared action prefix.
 *
 * Historically named for the frame lane because that lane came first. It is kept
 * verbatim rather than renamed to something lane-neutral: renaming it would orphan
 * every audit row already written under it, which is the same population split this
 * module exists to prevent — just achieved by a migration instead of by a new lane.
 */
export const DESKTOP_AUDIT_ACTION_PREFIX = 'frame-vnc';

export type DesktopAuditMode = 'watch' | 'takeover';
export type DesktopAuditPhase = 'requested' | 'started' | 'ended' | 'denied';

/** `frame-vnc.takeover-started` and friends — the one filter an auditor writes. */
export function desktopAuditAction(mode: DesktopAuditMode, phase: DesktopAuditPhase): string {
  return `${DESKTOP_AUDIT_ACTION_PREFIX}.${mode}-${phase}`;
}

/**
 * The subject line, prefixed by lane so two targets can never be confused.
 *
 * The `frame` lane keeps its historical unprefixed `slug:display` shape; every
 * other lane is prefixed. That asymmetry is deliberate and load-bearing — changing
 * it would make existing rows unmatchable by a query written for the new shape.
 */
export function desktopAuditSubject(target: DesktopAuditTarget, scope: string, ref: string | number): string {
  return target === 'frame' ? `${scope}:${ref}` : `${target}:${scope}:${ref}`;
}

export interface DesktopAuditEvent {
  action: string;
  actor: string;
  subject: string;
  details: Record<string, unknown>;
}

export interface DesktopAuditDeps {
  /** Row-id prefix, so a reader can tell which lane wrote a row without parsing details. */
  idPrefix?: string;
  now?: () => number;
  /** Injected by tests; the default writes `harness_shared.audit_log`. */
  write?: (event: DesktopAuditEvent & { id: string; ts: number; workspaceId: string }) => Promise<void>;
  workspaceId?: () => string;
  onError?: (error: unknown) => void;
}

/**
 * Append one desktop-viewer audit row.
 *
 * FIRE-AND-FORGET on purpose, matching the local lane it replaces: a viewer attach
 * must not wait on Postgres, and an audit write that failed must not tear down a
 * live session. The failure is surfaced through `onError` (a console warning by
 * default) rather than swallowed silently.
 */
export function recordDesktopAudit(event: DesktopAuditEvent, deps: DesktopAuditDeps = {}): void {
  const now = deps.now ?? Date.now;
  const onError = deps.onError ?? ((error: unknown) => console.warn('[desktop-audit] write failed:', error));
  void (async () => {
    try {
      const id = `${deps.idPrefix ?? 'vnc'}-${now().toString(36)}-${randomBytes(4).toString('hex')}`;
      const workspaceId = deps.workspaceId
        ? deps.workspaceId()
        : (await import('../workspace-registry')).activeWorkspaceId();
      const row = { ...event, id, ts: now(), workspaceId };
      if (deps.write) {
        await deps.write(row);
        return;
      }
      const { withWorkspace, generated } = await import('@papercusp/db-org');
      const { drizzle } = await import('drizzle-orm/postgres-js');
      const table = generated.auditLogInHarnessShared;
      await withWorkspace(workspaceId, async (tx) => {
        await drizzle(tx as never)
          .insert(table)
          .values({
            id: row.id,
            ts: row.ts,
            actor: row.actor,
            action: row.action,
            subject: row.subject,
            details: row.details as never,
            workspaceId: row.workspaceId,
          });
      });
    } catch (error) {
      onError(error);
    }
  })();
}
