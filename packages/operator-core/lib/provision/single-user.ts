/**
 * Single-user host detection.
 *
 * V1 explicitly targets single-user dev/desktop. This module detects
 * shared-host configurations and surfaces a one-time acknowledgement.
 *
 * Detection (per spec):
 *   - PRIMARY: `who | awk '{print $1}' | sort -u | wc -l > 1`
 *     active sessions — most reliable signal
 *   - SECONDARY: /etc/passwd entries with UID >= 1000 + valid /home/<name>
 *     + valid login shell
 *
 * Acknowledgement persists at `~/.papercusp/single-user-acknowledged`.
 *
 * Spec: /docs/snapshots/build-scripts#single-user-host-detection.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { papercuspPath } from '../papercusp-root';

const VALID_LOGIN_SHELLS = new Set([
  '/bin/sh',
  '/bin/bash',
  '/bin/zsh',
  '/usr/bin/zsh',
  '/usr/bin/bash',
  '/usr/bin/fish',
  '/bin/fish',
]);

export interface DetectionSignals {
  activeUsers: string[];
  configuredUsers: string[];
  /** True if either signal indicates multi-user. */
  isShared: boolean;
}

function execFileP(bin: string, args: string[], timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}

/**
 * PRIMARY signal: count of currently logged-in distinct users.
 * Returns empty array if `who` isn't available.
 */
async function activeUsersFromWho(): Promise<string[]> {
  try {
    const out = await execFileP('who', []);
    const users = new Set<string>();
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const user = trimmed.split(/\s+/)[0];
      if (user) users.add(user);
    }
    return [...users];
  } catch {
    return [];
  }
}

/**
 * SECONDARY signal: /etc/passwd users with UID >= 1000, valid /home/<name>,
 * and a valid login shell.
 */
async function configuredUsersFromPasswd(): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile('/etc/passwd', 'utf8');
  } catch {
    return [];
  }
  const users: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length < 7) continue;
    const [name, , uidStr, , , home, shell] = parts;
    const uid = parseInt(uidStr, 10);
    if (!Number.isFinite(uid) || uid < 1000 || uid > 60000) continue;
    if (!home.startsWith('/home/')) continue;
    if (!VALID_LOGIN_SHELLS.has(shell.trim())) continue;
    users.push(name);
  }
  return users;
}

export async function detectSharedHost(): Promise<DetectionSignals> {
  const [activeUsers, configuredUsers] = await Promise.all([
    activeUsersFromWho(),
    configuredUsersFromPasswd(),
  ]);
  const isShared = activeUsers.length > 1 || configuredUsers.length > 1;
  return { activeUsers, configuredUsers, isShared };
}

interface AckRecord {
  acknowledgedAt: string;
  signature: string;
}

function signatureOf(signals: DetectionSignals): string {
  // The signature changes when the host's user-count signature changes,
  // so users on a shared host that adds a new account see the prompt
  // again. Stable across reorderings.
  const a = [...signals.activeUsers].sort().join(',');
  const c = [...signals.configuredUsers].sort().join(',');
  return `a:${a}|c:${c}`;
}

function ACK_PATH() { return papercuspPath('single-user-acknowledged'); }

export async function readAcknowledgement(): Promise<AckRecord | null> {
  try {
    const raw = await fs.readFile(ACK_PATH(), 'utf8');
    return JSON.parse(raw) as AckRecord;
  } catch {
    return null;
  }
}

export async function writeAcknowledgement(signals: DetectionSignals): Promise<void> {
  await fs.mkdir(join(ACK_PATH(), '..'), { recursive: true });
  const record: AckRecord = {
    acknowledgedAt: new Date().toISOString(),
    signature: signatureOf(signals),
  };
  await fs.writeFile(ACK_PATH(), JSON.stringify(record, null, 2));
}

/**
 * Decide whether to gate provision on a one-time prompt.
 * Returns:
 *   - 'allow'        not shared, no gate needed
 *   - 'allow-acked'  shared but user previously acknowledged for this signature
 *   - 'gate'         shared and not yet acknowledged (or signature changed)
 */
export type GateDecision = 'allow' | 'allow-acked' | 'gate';

export async function decideGate(): Promise<{ decision: GateDecision; signals: DetectionSignals }> {
  const signals = await detectSharedHost();
  if (!signals.isShared) return { decision: 'allow', signals };
  const ack = await readAcknowledgement();
  if (ack && ack.signature === signatureOf(signals)) {
    return { decision: 'allow-acked', signals };
  }
  return { decision: 'gate', signals };
}

/** Test-only helpers. */
export const __testInternals = { signatureOf, configuredUsersFromPasswd };
