/**
 * register-deploy-account.ts — register a minted deploy credential into the account-pool.
 * Usage: tsx scripts/register-deploy-account.ts <id> <credentialRef> [label]
 *   e.g. tsx scripts/register-deploy-account.ts ownerhandle10 token:/abs/path "ownerhandle10 (test)"
 * Reuses the same registerAccount/updateAccountPool the Deploy Accounts UI route uses.
 */
import { registerAccount } from '../packages/operator-core/lib/deployment/account-pool';
import { updateAccountPool, accountStatus } from '../packages/operator-core/lib/deployment/account-pool-store';
import { activeWorkspaceId } from '../packages/operator-core/lib/workspace-registry';

async function main() {
  const [, , id, credentialRef, label] = process.argv;
  if (!id || !credentialRef) {
    console.error('usage: tsx scripts/register-deploy-account.ts <id> <credentialRef> [label]');
    process.exit(1);
  }
  const ws = activeWorkspaceId();
  await updateAccountPool((p) => registerAccount(p, { id, credentialRef, label: label || undefined }, Date.now()));
  const rows = await accountStatus();
  console.log(`registered in workspace: ${ws}`);
  console.log(JSON.stringify(rows.map((r) => ({ id: r.id, label: r.label, credentialRef: r.credentialRef, available: r.available })), null, 2));
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
