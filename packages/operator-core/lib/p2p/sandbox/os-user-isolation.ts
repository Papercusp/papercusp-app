/**
 * p2p/sandbox/os-user-isolation.ts — P-105 §4: the CREDENTIAL axis
 * (DESIGN-p2p-P105-…md §4, added by the leader during D-015's
 * audit-of-audit pass). Network filtering (§3) protects the wire; it does
 * NOT stop a foreign session running as the same host OS user from reading
 * `~/.papercusp/superuser-token`, `embedded-pg.json`, or gateway key
 * material directly off disk. This module is the on-disk half.
 *
 * Decision: a dedicated OS user or user namespace (userns) for the sandbox
 * tier. This file provides (a) the PURE plan-builder + credential-path
 * readability check (unit-testable, no root), and (b) the REAL provisioning
 * call (`provisionIsolationPrincipal`, shells to `useradd`/`unshare`) used
 * only by the drill — never wired into a production spawn path (WI-1937 is
 * out of scope for this item).
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

export type IsolationPrincipalKind = 'dedicated-os-user' | 'user-namespace';

export interface IsolationPrincipalPlan {
  kind: IsolationPrincipalKind;
  /** The OS username (dedicated-user mode) or the label used in the unshare
   *  invocation (userns mode) — session-derived, never reused across
   *  sessions so a departed session's principal can be torn down cleanly. */
  principalName: string;
  /** The concrete command + args that provisions this principal. Pure data
   *  — `provisionIsolationPrincipal` is what actually runs it. */
  provisionCommand: { cmd: string; args: string[] };
}

/**
 * Build the isolation-principal plan for a foreign session. `preferUserns`
 * picks the userns path (no root required to CREATE the namespace, though
 * cgroup/netns attachment still needs privileged cooperation from the host)
 * over a dedicated `useradd` account (simpler, but requires root once, up
 * front, per session — and accumulates OS users over the session's
 * lifetime unless reaped). Pure — no I/O.
 */
export function buildIsolationPrincipalPlan(input: {
  sessionId: string;
  preferUserns?: boolean;
}): IsolationPrincipalPlan {
  const sessionId = input.sessionId?.trim();
  if (!sessionId) throw new Error('buildIsolationPrincipalPlan: sessionId is required');
  const principalName = `p105-${sessionId}`.slice(0, 32); // useradd/netns name-length safe
  if (input.preferUserns) {
    return {
      kind: 'user-namespace',
      principalName,
      provisionCommand: { cmd: 'unshare', args: ['--user', '--map-root-user', '--', 'true'] },
    };
  }
  return {
    kind: 'dedicated-os-user',
    principalName,
    provisionCommand: { cmd: 'useradd', args: ['--no-create-home', '--shell', '/usr/sbin/nologin', principalName] },
  };
}

export interface CredentialPathCheckDeps {
  /** Injectable stat seam (tests fake permission bits without touching a
   *  real filesystem or needing a second OS user to exist). */
  statPath?: (path: string) => Promise<{ mode: number; uid: number }>;
}

const defaultStatPath: NonNullable<CredentialPathCheckDeps['statPath']> = async (path) => {
  const s = await stat(path);
  return { mode: s.mode, uid: s.uid };
};

/** The credential paths this axis exists to protect (§4's own examples). */
export const HOST_CREDENTIAL_PATHS: readonly string[] = [
  '~/.papercusp/superuser-token',
  '~/.papercusp/embedded-pg.json',
];

export interface CredentialPathViolation {
  path: string;
  detail: string;
}

/**
 * Fail-closed check: a path is a violation if it is world- or group-
 * readable (mode bits) UNLESS it is owned by the isolation principal's own
 * uid (irrelevant here — the principal must never own or read the HOST's
 * credential files). `principalUid` lets a real drill pass the provisioned
 * principal's uid so the check also catches "same-uid" escapes.
 */
export async function assertCredentialPathsUnreadable(
  paths: readonly string[],
  principalUid: number,
  deps: CredentialPathCheckDeps = {},
): Promise<{ ok: true } | { ok: false; violations: CredentialPathViolation[] }> {
  const statPath = deps.statPath ?? defaultStatPath;
  const violations: CredentialPathViolation[] = [];
  for (const path of paths) {
    let info: { mode: number; uid: number };
    try {
      info = await statPath(path);
    } catch {
      continue; // missing path = nothing to leak
    }
    const groupReadable = (info.mode & 0o040) !== 0;
    const otherReadable = (info.mode & 0o004) !== 0;
    const sameUid = info.uid === principalUid;
    if (sameUid) {
      violations.push({ path, detail: `owned by the sandbox principal (uid ${principalUid}) — same-uid escape` });
    } else if (otherReadable) {
      violations.push({ path, detail: 'world-readable (mode has o+r) — any principal can read it' });
    } else if (groupReadable) {
      violations.push({ path, detail: 'group-readable (mode has g+r) — a shared-group principal can read it' });
    }
  }
  return violations.length > 0 ? { ok: false, violations } : { ok: true };
}

export interface ProvisionDeps {
  run?: (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;
}

const defaultRun: NonNullable<ProvisionDeps['run']> = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
    child.on('error', (e) => resolve({ code: 1, stderr: e.message }));
  });

export type ProvisionOutcome = { ok: true } | { ok: false; refusal: { code: 'provision-failed'; detail: string } };

/** REAL provisioning — requires root (dedicated-user mode) or an
 *  unprivileged-userns-capable kernel (userns mode). Drill-only. */
export async function provisionIsolationPrincipal(
  plan: IsolationPrincipalPlan,
  deps: ProvisionDeps = {},
): Promise<ProvisionOutcome> {
  const run = deps.run ?? defaultRun;
  const r = await run(plan.provisionCommand.cmd, plan.provisionCommand.args);
  if (r.code !== 0) {
    return { ok: false, refusal: { code: 'provision-failed', detail: r.stderr.trim() || `exit ${r.code}` } };
  }
  return { ok: true };
}
