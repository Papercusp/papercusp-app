/**
 * p2p/sandbox/network-egress.ts — P-105 §3.3: the third X1 loopback leg
 * (DESIGN-p2p-P105-…md §3) — "the actual mechanism that makes (1) [gateway
 * attribution] and (2) [PG isolation] non-bypassable rather than advisory."
 *
 * Decision (C11, restated): per-fleet EGRESS ALLOWLIST + logging — explicitly
 * NOT an origin-proxying design (proxying foreign egress through the host
 * would make foreign traffic indistinguishable from the host's own, defeating
 * attribution).
 *
 * This module splits into:
 *  - PURE decision logic (`decideEgressAllowed`) + nft rule-text generation
 *    (`renderNftRuleset`) — unit-testable with no root/Linux dependency.
 *  - `applyNetnsPortFilter` — the REAL mechanism (network namespace + nft),
 *    which shells out and requires root + Linux; only the drill (run
 *    manually with privilege) exercises it. It is NOT called from any
 *    production spawn path — WI-1937 wiring is explicitly out of this
 *    item's scope.
 */
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface EgressAllowlistEntry {
  host: string;
  port: number;
}

/** The loopback services every foreign session must NOT reach directly
 *  (economic controls + admin surfaces live behind these). A future build
 *  lane may add a scoped, attributed path to :8788 via (1)+(2) above — this
 *  denylist governs the RAW loopback boundary, independent of that. */
export const DEFAULT_LOOPBACK_DENYLIST: readonly EgressAllowlistEntry[] = [
  { host: '127.0.0.1', port: 8788 }, // inference gateway
  { host: '127.0.0.1', port: 5432 }, // Postgres
  { host: '127.0.0.1', port: 3070 }, // operator API (release)
  { host: '127.0.0.1', port: 3170 }, // operator API (staging)
];

export type EgressDecision = { allow: true } | { allow: false; reason: 'denylisted' | 'not_allowlisted' };

function matches(a: EgressAllowlistEntry, b: EgressAllowlistEntry): boolean {
  return a.host === b.host && a.port === b.port;
}

/**
 * Pure admission decision for one egress attempt: denylist wins over
 * allowlist (defense in depth — an accidental allowlist entry can never
 * re-open a denylisted loopback service); otherwise an attempt must be
 * explicitly allowlisted. Fail-closed: an empty allowlist denies everything.
 */
export function decideEgressAllowed(
  attempt: EgressAllowlistEntry,
  allowlist: readonly EgressAllowlistEntry[],
  denylist: readonly EgressAllowlistEntry[] = DEFAULT_LOOPBACK_DENYLIST,
): EgressDecision {
  if (denylist.some((d) => matches(d, attempt))) return { allow: false, reason: 'denylisted' };
  if (allowlist.some((a) => matches(a, attempt))) return { allow: true };
  return { allow: false, reason: 'not_allowlisted' };
}

/**
 * Render an nftables ruleset (text) enforcing: default-drop egress from the
 * foreign netns, plus one ACCEPT rule per allowlist entry, plus an explicit
 * DROP+log rule per denylist entry (so a denied attempt is loud in the
 * kernel log, not silently swallowed — matches the C11 "allowlist + logging"
 * decision). Pure string generation — no shelling out, fully unit-testable.
 */
export function renderNftRuleset(input: {
  netnsName: string;
  allowlist: readonly EgressAllowlistEntry[];
  denylist?: readonly EgressAllowlistEntry[];
}): string {
  const denylist = input.denylist ?? DEFAULT_LOOPBACK_DENYLIST;
  const lines: string[] = [];
  lines.push(`table inet p105_${input.netnsName} {`);
  lines.push(`  chain egress {`);
  lines.push(`    type filter hook output priority 0; policy drop;`);
  for (const d of denylist) {
    lines.push(`    ip daddr ${d.host} tcp dport ${d.port} log prefix "p105-deny-${input.netnsName}: " drop`);
  }
  for (const a of input.allowlist) {
    lines.push(`    ip daddr ${a.host} tcp dport ${a.port} accept`);
  }
  lines.push(`  }`);
  lines.push(`}`);
  return lines.join('\n');
}

export interface ApplyNetnsPortFilterDeps {
  /** Injectable so tests never actually shell out; production default runs
   *  real commands via child_process. */
  run?: (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;
}

const defaultRun: NonNullable<ApplyNetnsPortFilterDeps['run']> = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
    child.on('error', (e) => resolve({ code: 1, stderr: e.message }));
  });

export type ApplyNetnsResult =
  | { ok: true }
  | { ok: false; refusal: { code: 'netns-create-failed' | 'nft-apply-failed'; detail: string } };

/**
 * REAL mechanism: create (or reuse) a network namespace and load the
 * rendered nft ruleset into it. Requires root + Linux + nftables — never
 * called from a production spawn path today (drill-only). Every failure is
 * a typed refusal, never a thrown exception, matching the module's style
 * elsewhere in p2p/.
 */
export async function applyNetnsPortFilter(
  input: { netnsName: string; allowlist: readonly EgressAllowlistEntry[] },
  deps: ApplyNetnsPortFilterDeps = {},
): Promise<ApplyNetnsResult> {
  const run = deps.run ?? defaultRun;
  const create = await run('ip', ['netns', 'add', input.netnsName]);
  // exit 1 with "File exists" = already present; treat as success (idempotent).
  if (create.code !== 0 && !/exists/i.test(create.stderr)) {
    return { ok: false, refusal: { code: 'netns-create-failed', detail: create.stderr.trim() || `exit ${create.code}` } };
  }
  const ruleset = renderNftRuleset({ netnsName: input.netnsName, allowlist: input.allowlist });
  const rulesetPath = join(tmpdir(), `p105-nft-${input.netnsName}.rules`);
  await writeFile(rulesetPath, ruleset, 'utf8');
  try {
    const apply = await run('ip', ['netns', 'exec', input.netnsName, 'nft', '-f', rulesetPath]);
    if (apply.code !== 0) {
      return { ok: false, refusal: { code: 'nft-apply-failed', detail: apply.stderr.trim() || `exit ${apply.code}` } };
    }
    return { ok: true };
  } finally {
    await unlink(rulesetPath).catch(() => {});
  }
}
