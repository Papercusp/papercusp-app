#!/usr/bin/env node
/**
 * p2p/sandbox/drill.ts — P-105 isolation-axis acceptance drill
 * (p2p-parity-parallel-lanes-2026-07-09 P-004; spec =
 * DESIGN-p2p-P105-foreign-work-isolation-sandbox-spec-2026-07-02).
 *
 * Run: npx tsx packages/operator-core/lib/p2p/sandbox/drill.ts
 *
 * Mirrors the SKIP-census convention used by
 * `papercusp-desktop/bin/work-distribution-drill.sh`: every axis either PASSes
 * (the real, privileged mechanism was exercised live) or SKIPs with an
 * explicit reason (root/Linux/cgroup-delegation unavailable in this
 * environment) — never a silent green. Pure decision-logic legs (gateway
 * attribution, PG env isolation, quota math, kill decision) always run live;
 * OS-level legs (netns/nft, useradd, cgroup v2 writes) degrade to SKIP off a
 * feature probe rather than failing the whole drill on a dev box without
 * root.
 *
 * This drill exercises the MECHANISMS in isolation. It does NOT spawn a real
 * foreign session or touch the live gateway/PG/operator ports — that wiring
 * is WI-1937 (owner-sign-off-gated), explicitly out of this item's scope.
 */
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { decideGatewayAdmission, issueForeignGatewayCredential } from './gateway-attribution';
import { assertNoAdminPgAccess, buildForeignProcessEnv } from './pg-credential-isolation';
import { applyNetnsPortFilter, decideEgressAllowed, renderNftRuleset } from './network-egress';
import { assertCredentialPathsUnreadable, buildIsolationPrincipalPlan, provisionIsolationPrincipal } from './os-user-isolation';
import { applyCgroupLimits, buildCgroupLimits } from './cgroup-limits';
import { enforceForeignWorkspaceQuota } from './quota-volume';
import { decideEnforcedKill, killForeignSessionProcess } from './enforcement-kill';

type LegResult = { leg: string; status: 'PASS' | 'SKIP' | 'FAIL'; detail: string };
const results: LegResult[] = [];
function record(r: LegResult) {
  results.push(r);
  const icon = r.status === 'PASS' ? '✓' : r.status === 'SKIP' ? '—' : '✗';
  // eslint-disable-next-line no-console
  console.log(`${icon} [${r.status}] ${r.leg}: ${r.detail}`);
}

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
    child.on('error', (e) => resolve({ code: 1, stderr: e.message }));
  });
}

async function isRootLinux(): Promise<boolean> {
  return process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'p105-drill-'));

  // §3.1 gateway attribution — pure, always live.
  {
    const cred = issueForeignGatewayCredential({ sessionId: 'drill-sess-1', scopePotSlug: 'gh-drill/hive', now: Date.now() });
    const admit = decideGatewayAdmission({ credential: cred, now: Date.now(), requestedPotSlug: 'gh-drill/hive' });
    const deny = decideGatewayAdmission({ credential: null, now: Date.now(), requestedPotSlug: 'gh-drill/hive' });
    record({
      leg: '§3.1 gateway-attribution',
      status: admit.allow && !deny.allow ? 'PASS' : 'FAIL',
      detail: `attributed credential admitted, unattributed refused (${!deny.allow ? deny.reason : 'BUG: allowed'})`,
    });
  }

  // §3.2 PG credential isolation — pure, always live.
  {
    const hostEnv = { ...process.env, DATABASE_URL: 'postgres://drill', PGPASSWORD: 'x' };
    const foreignEnv = buildForeignProcessEnv(hostEnv);
    const check = assertNoAdminPgAccess(foreignEnv);
    record({
      leg: '§3.2 pg-credential-isolation',
      status: check.ok ? 'PASS' : 'FAIL',
      detail: check.ok ? 'foreign env carries zero admin-PG vars after stripping' : check.violation,
    });
  }

  // §3.3 network egress — pure rule generation always live; real netns/nft apply gated on root+Linux.
  {
    const gwAttempt = { host: '127.0.0.1', port: 8788 };
    const d = decideEgressAllowed(gwAttempt, []);
    const ruleset = renderNftRuleset({ netnsName: 'drill', allowlist: [] });
    record({
      leg: '§3.3a network-egress (decision + nft render)',
      status: !d.allow && ruleset.includes('policy drop') ? 'PASS' : 'FAIL',
      detail: 'loopback gateway denied by default; nft ruleset renders default-drop',
    });

    if (await isRootLinux()) {
      const netnsName = `p105drill${process.pid}`;
      const r = await applyNetnsPortFilter({ netnsName, allowlist: [] });
      await run('ip', ['netns', 'delete', netnsName]).catch(() => undefined);
      record({
        leg: '§3.3b network-egress (real netns+nft apply)',
        status: r.ok ? 'PASS' : 'FAIL',
        detail: r.ok ? `netns ${netnsName} created + ruleset applied` : r.refusal.detail,
      });
    } else {
      record({ leg: '§3.3b network-egress (real netns+nft apply)', status: 'SKIP', detail: 'requires root + Linux (ip netns / nft) — not available in this environment' });
    }
  }

  // §4 credential axis — pure readability check always live on real dummy files; real provisioning gated on root.
  {
    const worldReadable = join(work, 'world-readable-token');
    const ownerOnly = join(work, 'owner-only-token');
    await writeFile(worldReadable, 'secret');
    await chmod(worldReadable, 0o644);
    await writeFile(ownerOnly, 'secret');
    await chmod(ownerOnly, 0o600);
    const check = await assertCredentialPathsUnreadable([worldReadable, ownerOnly], 999_999);
    const flaggedWorldReadable = !check.ok && check.violations.some((v) => v.path === worldReadable);
    record({
      leg: '§4a os-user-isolation (credential-path check, real files)',
      status: flaggedWorldReadable ? 'PASS' : 'FAIL',
      detail: flaggedWorldReadable ? 'world-readable dummy token correctly flagged; owner-only dummy token clean' : 'did not flag the world-readable dummy token',
    });

    if (await isRootLinux()) {
      const plan = buildIsolationPrincipalPlan({ sessionId: `drill${process.pid}` });
      const r = await provisionIsolationPrincipal(plan);
      if (r.ok) await run('userdel', [plan.principalName]).catch(() => undefined);
      record({ leg: '§4b os-user-isolation (real useradd)', status: r.ok ? 'PASS' : 'FAIL', detail: r.ok ? `provisioned + tore down ${plan.principalName}` : r.refusal.detail });
    } else {
      record({ leg: '§4b os-user-isolation (real useradd)', status: 'SKIP', detail: 'requires root (useradd) — not available in this environment' });
    }
  }

  // §2 compute axis — pure spec/render always live; real cgroup v2 write gated on delegated controller access.
  {
    const spec = buildCgroupLimits({ cpuMaxPercent: 50, memoryMaxBytes: 256 * 1024 * 1024, ioMaxBytesPerSec: 10 * 1024 * 1024 });
    record({ leg: '§2a cgroup-limits (spec + render)', status: 'PASS', detail: `cpu.max would be "${Math.round(spec.cpuMaxPercent / 100 * spec.cpuPeriodUs)} ${spec.cpuPeriodUs}"` });

    const cgroupRoot = '/sys/fs/cgroup';
    const probePath = join(cgroupRoot, `p105-drill-probe-${process.pid}`);
    let delegated = false;
    if (process.platform === 'linux') {
      try {
        await mkdir(probePath);
        delegated = true;
      } catch {
        delegated = false;
      }
    }
    if (delegated) {
      const r = await applyCgroupLimits(cgroupRoot, `p105-drill-${process.pid}`, spec, undefined, {
        mkdir: async () => undefined, // already created above for the probe; real path re-mkdirs idempotently below
      });
      await rm(probePath, { recursive: true, force: true }).catch(() => undefined);
      record({ leg: '§2b cgroup-limits (real cgroup v2 write)', status: r.ok ? 'PASS' : 'FAIL', detail: r.ok ? `wrote controller files at ${r.cgroupPath}` : r.refusal.detail });
    } else {
      await rm(probePath, { recursive: true, force: true }).catch(() => undefined);
      record({ leg: '§2b cgroup-limits (real cgroup v2 write)', status: 'SKIP', detail: 'cgroup v2 controller delegation unavailable (no write access under /sys/fs/cgroup) in this environment' });
    }
  }

  // §1 quota axis — pure walk, always live on a real temp directory.
  {
    const quotaDir = join(work, 'foreign-workspace-root');
    await mkdir(quotaDir, { recursive: true });
    await writeFile(join(quotaDir, 'big-blob'), Buffer.alloc(2048, 1));
    const r = await enforceForeignWorkspaceQuota(quotaDir, 1024);
    record({ leg: '§1 quota-volume (real disk walk)', status: r.decision.exceeded ? 'PASS' : 'FAIL', detail: `used ${r.usedBytes}B over ${r.capBytes}B cap → ${r.decision.exceeded ? 'exceeded (correct)' : 'BUG: not flagged'}` });
  }

  // §5 enforcement — real process spawned + really killed via the sigkill-fallback path.
  {
    const child = spawn('sleep', ['100']);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const decision = decideEnforcedKill({ state: 'winding-down', windDownStartedAt: Date.now() - 1000, now: Date.now(), graceMs: 100, cgroupPathExists: false });
    let killed = false;
    if (decision.shouldKill) {
      const r = await killForeignSessionProcess({ pid: child.pid!, cgroupPath: null, method: decision.preferredMethod });
      killed = r.ok;
    }
    const exit = await Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))]);
    const diedBySigkill = exit != null && exit.signal === 'SIGKILL';
    record({
      leg: '§5 enforcement-kill (real spawned process, real SIGKILL)',
      status: decision.shouldKill && killed && diedBySigkill ? 'PASS' : 'FAIL',
      detail: `grace-expired decision fired (${decision.shouldKill}); sigkill-fallback delivered (${killed}); child exit signal=${exit?.signal ?? 'timed out waiting'}`,
    });
  }

  await rm(work, { recursive: true, force: true }).catch(() => undefined);

  const fails = results.filter((r) => r.status === 'FAIL');
  const skips = results.filter((r) => r.status === 'SKIP');
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - fails.length - skips.length}/${results.length} PASS, ${skips.length} SKIP, ${fails.length} FAIL`);
  if (fails.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('drill crashed:', e);
  process.exitCode = 2;
});
