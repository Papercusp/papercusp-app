/** teardown-frame.ts — DESTROY a deployed harness's frame (ends billing) + de-register it.
 * Usage: tsx scripts/teardown-frame.ts <slug> [workspace=papercusp-workspace] */
import '../packages/operator-core/lib/deployment/configure';
import { teardownHarness, defaultDeployDeps } from '../packages/operator-core/lib/deployment/deploy';

async function main() {
  const slug = process.argv[2];
  const ws = process.argv[3] || 'papercusp-workspace';
  if (!slug) {
    console.error('usage: tsx scripts/teardown-frame.ts <slug> [workspace]');
    process.exit(1);
  }
  const log = (lvl: string, m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}][${lvl}] ${m}`);
  const r = await teardownHarness(slug, ws, defaultDeployDeps(log));
  console.log('RESULT: ' + JSON.stringify(r));
}
main().then(() => process.exit(0)).catch((e) => { console.error('TEARDOWN FAILED: ' + (e instanceof Error ? e.message : String(e))); process.exit(1); });
