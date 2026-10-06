/**
 * Host side of keychain.ts's secret-tool executor seam (WI-10004975).
 *
 * keychain.ts must NEVER import the spawner-sidecar module, not even lazily: it is reached
 * from esbuild-bundled runtime workers (`snapshot-fold.worker.ts`), and esbuild inlines a
 * literal dynamic `import()`, which once dragged task-manager → DBOS → testcontainers into
 * the worker bundle and kept bg-host from starting (see `configureKeychainSecretToolExec`).
 * So the HOST installs the sidecar route from here — a module only host boot paths load
 * (`hive-epoch-boot-deps`, immediately before the keychain probe).
 *
 * Idempotent: re-installing replaces the executor with an equivalent one.
 */
import { configureKeychainSecretToolExec } from '../identity/keychain';
import { execFileViaSidecar } from './git-via-sidecar';

export function installKeychainSidecarExec(): void {
  configureKeychainSecretToolExec((args, opts) => execFileViaSidecar('secret-tool', args, opts));
}
