/**
 * deploy-pot.ts — deploy a Hive (grouping of harnesses) to a Swarm (cloud fleet of frames).
 * Mirrors the deploy:pot MCP tool, with the swarm config carrying our chosen account's deploy token
 * so every member frame runs on THAT account's rate budget. Queen placement = local (no extra frame).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import '../packages/operator-core/lib/deployment/configure'; // registers latitude+hetzner drivers
import { deployHive, defaultHiveDeployDeps } from '../packages/operator-core/lib/deployment/hive-deploy';

async function main() {
  const account = process.argv[2] || 'ownerhandle10';
  const ws = process.argv[3] || 'papercusp-workspace';
  const members = (process.argv[4] || 'frame-work-smoke').split(',').map((s) => s.trim()).filter(Boolean);

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
  log('info', `deploying Hive 'demo-swarm' members=[${members.join(', ')}] → Hetzner Swarm on account '${account}' (queen=local)…`);
  const r = await deployHive(spec as never, ws, defaultHiveDeployDeps(log));
  console.log('RESULT: ' + JSON.stringify(r, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('HIVE DEPLOY FAILED: ' + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
    process.exit(1);
  });
