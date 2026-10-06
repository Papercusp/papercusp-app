import { fileURLToPath } from 'node:url';
import { readPinnedModuleState } from '@papercusp/module-singleton';

// Reuse the existing Node load observer. It records source before evaluation;
// reading a file during evaluation can already see self-restored/replaced bytes.

/** Read one originally loaded module's receipt, without a disk fallback.
 * Missing/unsupported/conflicting loads stay unknown. This is a per-module
 * diagnostic, not proof of the complete evaluator/transport runtime closure. */
export function captureSourceHash(moduleUrl: string): string | null {
  try {
    const state = readPinnedModuleState<{ capture: { sources?: unknown; reasons?: unknown } | null }>(
      '@papercusp/test-config.original-config-loads')?.capture;
    if (!(state?.sources instanceof Map) || !(state.reasons instanceof Set) ||
        state.reasons.has('config-node-load-capture-failed') ||
        state.reasons.has('config-node-load-hook-unavailable')) return null;
    const observed = state.sources.get(fileURLToPath(moduleUrl));
    if (!(observed instanceof Set) || observed.size !== 1) return null;
    const [sha256] = observed;
    return typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256) ? sha256 : null;
  } catch {
    return null;
  }
}

export const SOURCE_IDENTITY_HASH = captureSourceHash(import.meta.url);
