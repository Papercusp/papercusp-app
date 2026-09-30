import type { MemoryBackend, RememberOptions } from '@papercusp/memory';
import type { PackageResourceDriver } from './package-resource-receipts';

/** Concrete driver for the existing package ownership journal. Never emulate
 * atomic cleanup with get/forget, or fall back to unfenced remember. */
export function packageMemoryDriver(
  backend: MemoryBackend, text: string, opts: RememberOptions,
): PackageResourceDriver {
  const writes = backend.managedWrites;
  if (!writes) throw new Error(`memory backend ${backend.name} does not support fenced package resources`);
  return {
    create: (key) => writes.create(key, text, { ...opts, verbatim: true, shareable: false }),
    recover: (key) => writes.recover(key, opts.scope),
    cancel: (key) => writes.cancel(key, opts.scope),
    removeIfUnchanged: (resource) => writes.removeIfUnchanged({ id: resource.id, fingerprint: resource.fingerprint }, opts.scope),
  };
}
