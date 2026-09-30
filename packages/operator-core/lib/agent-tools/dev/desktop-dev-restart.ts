/**
 * The guarded restart primitive for the desktop-owned dev operator (:3270).
 *
 * `dev:restart` normally delegates to systemd. The desktop dev operator is
 * different: `papercusp-desktop/bin/dev-operator-ifneeded.sh` supervises a
 * process tree started by Tauri, so there is no systemd unit to restart. The
 * safe operation is to kill only the verified `hono-host.ts` listener child;
 * the wrapper observes the non-zero exit and starts a fresh child.
 *
 * This module deliberately does not signal a process group or any ancestor.
 * Every identity check is repeated immediately before the signal to protect
 * against a listener exiting and its PID being recycled between the port
 * lookup and the kill.
 */

import { promises as fsp } from 'node:fs';
import {
  inspectProcessEnvironment,
  parseNulSeparatedEnvironment,
} from '@papercusp/host-platform/process-environment';
import {
  listListeningSockets,
  type ListeningSocket,
  type ListeningSocketsResult,
} from '../../listening-sockets';

export const DESKTOP_DEV_PORT = 3270;
export const DESKTOP_DEV_RESOURCE = 'desktop-dev-server';
export const DESKTOP_DEV_WRAPPER = 'dev-operator-ifneeded.sh';

const REQUIRED_ENV: Readonly<Record<string, string>> = {
  PAPERCUSP_HONO_PORT: String(DESKTOP_DEV_PORT),
  // These are HOST-process markers authored by dev-operator-ifneeded.sh's
  // DEFAULT_DEV_CMD. PAPERCUSP_DEV_API_TARGET deliberately is not one: it tells
  // a desktop/webview which operator to call and is never exported into the Hono
  // child. Requiring it made the guarded restart reject the canonical launcher
  // it was written to protect (WI-41422).
  PAPERCUSP_PTY_WS_PORT: String(DESKTOP_DEV_PORT + 4),
  PAPERCUSP_BACKGROUND_WORKERS: '0',
  PAPERCUSP_CLUSTER: '0',
  PAPERCUSP_CLUSTER_WORKERS: '0',
  DBOS__VMID: `desktop-dev-${DESKTOP_DEV_PORT}`,
};

const MAX_PARENT_DEPTH = 24;
const RESPAWN_POLL_MS = 500;
// 8s bounded Hono drain + 3s wrapper backoff + a measured ~22s cold tsx boot
// under gate load still fits below the ~55s MCP transport ceiling (WI-41422).
const RESPAWN_MAX_POLLS = 90;

export interface DesktopDevProcessMeta {
  pid: number;
  ppid: number;
  processGroup: number;
  session: number;
  cmdline: string;
}

export interface DesktopDevListener {
  pid: number;
  cmdline: string;
  env: Readonly<Record<string, string>>;
  parentChain: readonly DesktopDevProcessMeta[];
}

export interface DesktopDevRestartDeps {
  listSockets?: (options: { port?: number; limit?: number }) => Promise<ListeningSocketsResult>;
  readCmdline?: (pid: number) => Promise<string>;
  readEnviron?: (pid: number) => Promise<string>;
  readStat?: (pid: number) => Promise<string>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface DesktopDevListenerResult {
  ok: boolean;
  pid?: number;
  listener?: DesktopDevListener;
  reason?:
    | 'desktop_dev_listener_not_found'
    | 'desktop_dev_listener_owner_hidden'
    | 'desktop_dev_listener_ambiguous'
    | 'desktop_dev_listener_unreadable'
    | 'desktop_dev_identity_mismatch'
    | 'desktop_dev_supervisor_missing'
    | 'desktop_dev_listener_changed';
  note: string;
}

export interface DesktopDevRestartResult {
  ok: boolean;
  pid?: number;
  replacementPid?: number;
  reason?: DesktopDevListenerResult['reason'] | 'desktop_dev_signal_failed' | 'desktop_dev_respawn_timeout';
  note: string;
}

function defaultReadCmdline(pid: number): Promise<string> {
  return fsp.readFile(`/proc/${pid}/cmdline`, 'utf8');
}

function defaultReadStat(pid: number): Promise<string> {
  return fsp.readFile(`/proc/${pid}/stat`, 'utf8');
}

/** Parse the state/PPID/PGRP/session fields from Linux `/proc/<pid>/stat`. */
export function parseProcStat(stat: string): Omit<DesktopDevProcessMeta, 'pid' | 'cmdline'> | null {
  // The comm field may contain ')', so use the final close paren rather than
  // splitting the whole line naively.
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const processGroup = Number(fields[2]);
  const session = Number(fields[3]);
  if (![ppid, processGroup, session].every((n) => Number.isInteger(n) && n > 0)) return null;
  return { ppid, processGroup, session };
}

function normalizeCmdline(raw: string): string {
  return raw.replaceAll('\0', ' ').trim();
}

/** Compatibility export for the focused restart tests and existing callers. */
export const parseProcessEnvironment = parseNulSeparatedEnvironment;

function isHonoHostCommand(cmdline: string): boolean {
  return /(?:^|[\s/])hono-host\.ts(?:$|[\s])/.test(cmdline);
}

function hasDesktopDevEnvironment(env: Readonly<Record<string, string>>): boolean {
  return Object.entries(REQUIRED_ENV).every(([key, expected]) => env[key] === expected);
}

function isDesktopDevWrapperCommand(cmdline: string): boolean {
  return new RegExp(`(?:^|[\\s/])${DESKTOP_DEV_WRAPPER.replace('.', '\\.')}(?:$|[\\s])`).test(cmdline);
}

async function readMeta(
  pid: number,
  deps: Required<Pick<DesktopDevRestartDeps, 'readCmdline' | 'readStat'>>,
): Promise<DesktopDevProcessMeta | null> {
  try {
    const [rawCmdline, rawStat] = await Promise.all([deps.readCmdline(pid), deps.readStat(pid)]);
    const stat = parseProcStat(rawStat);
    if (!stat) return null;
    return { pid, cmdline: normalizeCmdline(rawCmdline), ...stat };
  } catch {
    return null;
  }
}

async function readParentChain(
  listener: DesktopDevProcessMeta,
  deps: Required<Pick<DesktopDevRestartDeps, 'readCmdline' | 'readStat'>>,
): Promise<DesktopDevProcessMeta[]> {
  const chain: DesktopDevProcessMeta[] = [listener];
  const seen = new Set([listener.pid]);
  let parentPid = listener.ppid;
  for (let depth = 1; depth < MAX_PARENT_DEPTH && parentPid > 1; depth += 1) {
    if (seen.has(parentPid)) break;
    seen.add(parentPid);
    const parent = await readMeta(parentPid, deps);
    if (!parent) break;
    chain.push(parent);
    parentPid = parent.ppid;
  }
  return chain;
}

function findVisiblePids(sockets: readonly ListeningSocket[]): number[] {
  return [...new Set(sockets.filter((socket) => socket.ownerVisible).flatMap((socket) => socket.pids))].filter(
    (pid) => Number.isInteger(pid) && pid > 1,
  );
}

function listenerFailure(
  reason: DesktopDevListenerResult['reason'],
  note: string,
  pid?: number,
): DesktopDevListenerResult {
  return { ok: false, reason, note, ...(pid === undefined ? {} : { pid }) };
}

/** Resolve the one owner-visible, wrapper-supervised desktop listener. */
export async function resolveDesktopDevListener(deps: DesktopDevRestartDeps = {}): Promise<DesktopDevListenerResult> {
  const listSockets = deps.listSockets ?? listListeningSockets;
  const readCmdline = deps.readCmdline ?? defaultReadCmdline;
  const readStat = deps.readStat ?? defaultReadStat;
  const readEnvironment = deps.readEnviron
    ? async (pid: number): Promise<Readonly<Record<string, string>>> =>
        parseProcessEnvironment(await deps.readEnviron!(pid))
    : async (pid: number): Promise<Readonly<Record<string, string>>> => {
        const inspected = await inspectProcessEnvironment(pid);
        if (!inspected.ok) throw new Error(inspected.detail);
        return inspected.environment;
      };

  let sockets: ListeningSocket[];
  try {
    sockets = (await listSockets({ port: DESKTOP_DEV_PORT, limit: 32 })).sockets;
  } catch (error) {
    return listenerFailure(
      'desktop_dev_listener_unreadable',
      `Could not read the :${DESKTOP_DEV_PORT} listener table: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (sockets.length === 0) {
    return listenerFailure('desktop_dev_listener_not_found', `No TCP listener is present on :${DESKTOP_DEV_PORT}.`);
  }

  const visiblePids = findVisiblePids(sockets);
  if (visiblePids.length === 0) {
    return listenerFailure(
      'desktop_dev_listener_owner_hidden',
      `:${DESKTOP_DEV_PORT} is bound, but its owner is not visible to this user; refusing to signal an unidentified process.`,
    );
  }
  if (visiblePids.length !== 1) {
    return listenerFailure(
      'desktop_dev_listener_ambiguous',
      `:${DESKTOP_DEV_PORT} has multiple owner-visible listener pids (${visiblePids.join(', ')}); refusing an ambiguous restart.`,
    );
  }

  const pid = visiblePids[0]!;
  let rawCmdline: string;
  let env: Readonly<Record<string, string>>;
  let rawStat: string;
  try {
    [rawCmdline, env, rawStat] = await Promise.all([readCmdline(pid), readEnvironment(pid), readStat(pid)]);
  } catch {
    return listenerFailure('desktop_dev_listener_unreadable', `Could not read the process identity for listener pid ${pid}.`, pid);
  }

  const cmdline = normalizeCmdline(rawCmdline);
  const stat = parseProcStat(rawStat);
  if (!stat) {
    return listenerFailure('desktop_dev_listener_unreadable', `Could not parse the process identity for listener pid ${pid}.`, pid);
  }
  if (!isHonoHostCommand(cmdline) || !hasDesktopDevEnvironment(env)) {
    return listenerFailure(
      'desktop_dev_identity_mismatch',
      `Listener pid ${pid} is not the expected desktop-dev hono-host process; refusing to signal it.`,
      pid,
    );
  }

  const parentChain = await readParentChain({ pid, cmdline, ...stat }, { readCmdline, readStat });
  if (!parentChain.some((parent) => isDesktopDevWrapperCommand(parent.cmdline))) {
    return listenerFailure(
      'desktop_dev_supervisor_missing',
      `Listener pid ${pid} is not descended from ${DESKTOP_DEV_WRAPPER}; refusing to signal an unsupervised process.`,
      pid,
    );
  }

  return { ok: true, pid, listener: { pid, cmdline, env, parentChain }, note: `Verified ${DESKTOP_DEV_WRAPPER}-supervised hono-host listener pid ${pid} on :${DESKTOP_DEV_PORT}.` };
}

/**
 * Resolve, re-resolve, and request a bounded recycle from only the verified
 * desktop listener child. The Hono entrypoint owns SIGUSR2, drains HTTP, then
 * hard-exits without Node's native-addon teardown; dev-operator-ifneeded.sh
 * restarts after every child-only exit. Success means a DIFFERENT verified
 * listener appeared — a delivered signal alone is not a restart verdict.
 */
export async function restartDesktopDev(deps: DesktopDevRestartDeps = {}): Promise<DesktopDevRestartResult> {
  const first = await resolveDesktopDevListener(deps);
  if (!first.ok || first.pid === undefined) return { ok: false, reason: first.reason, note: first.note };

  const second = await resolveDesktopDevListener(deps);
  if (!second.ok || second.pid !== first.pid) {
    return {
      ok: false,
      pid: first.pid,
      reason: 'desktop_dev_listener_changed',
      note: `The :${DESKTOP_DEV_PORT} listener changed after validation; refusing to signal the original pid ${first.pid}.`,
    };
  }

  try {
    (deps.signal ?? ((pid, signal) => process.kill(pid, signal)))(second.pid, 'SIGUSR2');
  } catch (error) {
    return {
      ok: false,
      pid: second.pid,
      reason: 'desktop_dev_signal_failed',
      note: `Could not signal verified desktop-dev listener pid ${second.pid}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let poll = 0; poll < RESPAWN_MAX_POLLS; poll += 1) {
    await sleep(RESPAWN_POLL_MS);
    const replacement = await resolveDesktopDevListener(deps);
    if (replacement.ok && replacement.pid !== undefined && replacement.pid !== second.pid) {
      return {
        ok: true,
        pid: second.pid,
        replacementPid: replacement.pid,
        note: `SIGUSR2 recycled verified desktop-dev listener pid ${second.pid}; ${DESKTOP_DEV_WRAPPER} respawned verified listener pid ${replacement.pid}.`,
      };
    }
  }

  return {
    ok: false,
    pid: second.pid,
    reason: 'desktop_dev_respawn_timeout',
    note: `SIGUSR2 reached verified desktop-dev listener pid ${second.pid}, but no different verified :${DESKTOP_DEV_PORT} listener appeared within ${Math.round((RESPAWN_POLL_MS * RESPAWN_MAX_POLLS) / 1000)}s.`,
  };
}
