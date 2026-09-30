/**
 * teardown-pot.ts — tear down a Hive's Swarm through the PRODUCT path
 * (`teardownHive` → per-member `teardownHarness` → driver confirm-destroy →
 * registry handle cleared). Mirrors the deploy:teardown_pot MCP tool, and is
 * the counterpart of scripts/deploy-pot.ts.
 *
 * Usage: tsx scripts/teardown-pot.ts [account=ownerhandle10] [workspace=papercusp-workspace] [members=frame-work-smoke]
 *
 * Prefer this over raw Hetzner-API sweeps: the API sweep destroys the machines
 * but leaves stale `deploymentFrame` handles in the registry (deploy:status and
 * the Frames tab then report ghosts — observed 2026-06-09).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import '../packages/operator-core/lib/deployment/configure'; // side-effect: registers latitude+hetzner drivers
import { teardownHive, defaultHiveDeployDeps } from '../packages/operator-core/lib/deployment/hive-deploy';

async function main() {
  const account = process.argv[2] || 'ownerhandle10';
  const ws = process.argv[3] || 'papercusp-workspace';
  const members = (process.argv[4] || 'frame-work-smoke').split(',').map((s) => s.trim()).filter(Boolean);

  // Same spec shape as deploy-pot.ts — teardown resolves each member's recorded
  // frame from the registry, so the swarm block only needs the target/creds.
  const swarm = {
    target: 'hetzner',
    kind: 'vm',
    size: 'cpx31',
    region: 'ash',
    provider: {
      sshKeys: ['papercusp-frame-deploy'],
      runtimeTarball: join(homedir(), '.papercusp/frame-runtime.tgz'),
      sshIdentityFile: join(homedir(), '.ssh/papercusp-latitude-frame'),
    },
    credentialRef: `token:${join(homedir(), '.papercusp/deploy-credentials', account)}`,
    accountId: account,
  } as const;

  const spec = { potId: 'demo-swarm', members, swarm, queen: { placement: 'local' as const } };
  const log = (lvl: string, m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}][${lvl}] ${m}`);
  log('info', `tearing down Hive 'demo-swarm' members=[${members.join(', ')}] (DESTROY ends billing; registry handles cleared)…`);
  const r = await teardownHive(spec as never, ws, defaultHiveDeployDeps(log));
  console.log('RESULT: ' + JSON.stringify(r, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('HIVE TEARDOWN FAILED: ' + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
    process.exit(1);
  });
