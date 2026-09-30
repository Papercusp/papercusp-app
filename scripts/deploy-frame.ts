/**
 * deploy-frame.ts — deploy ONE harness to a remote cloud frame (task #18 on a remote frame).
 * Usage: tsx scripts/deploy-frame.ts [slug=cloud-e2e-smoke] [workspace=papercusp-workspace] [account=ownerhandle10]
 *
 * Calls the same deployHarness the deploy:harness MCP tool uses, but overrides the harness's pinned
 * credentialRef to the chosen account's deploy token so the frame runs on THAT account's rate budget.
 * The frame is persisted before install, so `deploy:teardown` / teardownHarness can always reclaim it.
 */
import '../packages/operator-core/lib/deployment/configure'; // side-effect: registers latitude+hetzner drivers
import { homedir } from 'node:os';
import { join } from 'node:path';

import { deployHarness, defaultDeployDeps } from '../packages/operator-core/lib/deployment/deploy';

async function main() {
  const slug = process.argv[2] || 'cloud-e2e-smoke';
  const ws = process.argv[3] || 'papercusp-workspace';
  const account = process.argv[4] || 'ownerhandle10';
  const credentialRef = `token:${join(homedir(), '.papercusp/deploy-credentials', account)}`;

  const log = (lvl: string, msg: string) =>
    console.log(`[${new Date().toISOString().slice(11, 19)}][${lvl}] ${msg}`);
  const base = defaultDeployDeps(log);
  const deps = {
    ...base,
    async getDeploymentConfig(s: string, w: string) {
      const cfg = await base.getDeploymentConfig(s, w);
      if (!cfg) return cfg;
      // Run the frame on OUR chosen account's clean rate budget.
      return { ...cfg, credentialRef, accountId: account };
    },
  };

  log('info', `deploying harness '${slug}' (ws=${ws}) on account '${account}' → Hetzner frame…`);
  const r = await deployHarness(slug, ws, deps);
  console.log('RESULT: ' + JSON.stringify(r, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('DEPLOY FAILED: ' + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
    process.exit(1);
  });
