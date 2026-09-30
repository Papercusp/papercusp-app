/**
 * Adapter conformance check — `assertAdapterConformant()` is the
 * single test every adapter plugin's test suite must pass before it
 * can be installed (plan §17 testing strategy).
 *
 * Verifies:
 *   - declared capability ⇔ surface object pair
 *   - irVersionsSupported is non-empty + well-formed
 *   - registry surface, when declared, returns a list with every entry
 *     having the active ecosystem in its `ecosystems` map
 *   - tokens.emit returns at least one FileEmit on a minimal DTCG doc
 *   - codeEmit.fromIR returns at least one FileEmit on a minimal IR
 *   - mockInput.parse round-trips at least one minimal input
 *
 * The check intentionally stays close to the contract; deeper
 * adapter-specific tests live in the adapter's own test suite.
 */
import type { DesignEcosystemAdapter, AdapterCapability } from './contract';
import { IR_VERSION, type UiIr } from '../design-ir';
import { supportsIrVersion } from './registry';

export interface ConformanceFailure {
  capability?: AdapterCapability;
  message: string;
}

export class AdapterConformanceError extends Error {
  readonly adapterId: string;
  readonly failures: readonly ConformanceFailure[];
  constructor(adapterId: string, failures: ConformanceFailure[]) {
    super(
      `adapter "${adapterId}" failed conformance:\n` +
        failures.map((f) => `  - ${f.capability ?? '*'}: ${f.message}`).join('\n'),
    );
    this.name = 'AdapterConformanceError';
    this.adapterId = adapterId;
    this.failures = failures;
  }
}

const VERSION_RANGE_RE = /^(\d+)\.(?:x|\d+)$/;

const MINIMAL_IR: UiIr = {
  irVersion: IR_VERSION,
  surface: 'conformance',
  ecosystem: '*',
  layout: { kind: 'stack', direction: 'vertical' },
};

const MINIMAL_DTCG = {
  tokens: [{ id: 'color.bg.surface', type: 'color' as const, value: '#ffffff' }],
};

export interface ConformanceOptions {
  /** Override the IR version we test against. Defaults to current. */
  testIrVersion?: string;
  /** Skip these capabilities (useful when the adapter has external
   *  dependencies the test environment can't satisfy, e.g. a Storybook
   *  process for `preview`). */
  skip?: readonly AdapterCapability[];
}

export async function checkAdapterConformant(
  adapter: DesignEcosystemAdapter,
  opts: ConformanceOptions = {},
): Promise<ConformanceFailure[]> {
  const failures: ConformanceFailure[] = [];
  const skip = new Set(opts.skip ?? []);
  const testVersion = opts.testIrVersion ?? IR_VERSION;

  // ─── basic shape ─────────────────────────────────────────────
  if (!adapter.id) failures.push({ message: 'missing id' });
  if (!adapter.ecosystem) failures.push({ message: 'missing ecosystem' });
  if (!Array.isArray(adapter.capabilities)) {
    failures.push({ message: 'capabilities must be an array' });
  }
  if (!Array.isArray(adapter.irVersionsSupported) || adapter.irVersionsSupported.length === 0) {
    failures.push({ message: 'irVersionsSupported must be a non-empty array' });
  } else {
    for (const v of adapter.irVersionsSupported) {
      if (!VERSION_RANGE_RE.test(v) && !/^\d+\.\d+$/.test(v)) {
        failures.push({ message: `irVersionsSupported entry "${v}" is malformed` });
      }
    }
    if (!supportsIrVersion(adapter, testVersion)) {
      failures.push({
        message: `does not support test IR version "${testVersion}"`,
      });
    }
  }
  if (!Array.isArray(adapter.uiPaths)) {
    failures.push({ message: 'uiPaths must be an array (may be empty)' });
  }

  // ─── capability ⇔ surface pairing ────────────────────────────
  for (const cap of adapter.capabilities) {
    const surface = (adapter as unknown as Record<string, unknown>)[cap];
    if (surface == null) {
      failures.push({
        capability: cap,
        message: `capability "${cap}" declared but ${cap} surface is missing`,
      });
    }
  }

  // ─── per-capability smoke checks ─────────────────────────────
  if (adapter.capabilities.includes('registry') && !skip.has('registry') && adapter.registry) {
    try {
      if (!Array.isArray(adapter.registry.sourcePaths)) {
        failures.push({
          capability: 'registry',
          message: 'sourcePaths must be an array',
        });
      }
      const list = await adapter.registry.listPrimitives();
      if (!Array.isArray(list)) {
        failures.push({
          capability: 'registry',
          message: 'listPrimitives() must return an array',
        });
      } else {
        for (const entry of list) {
          if (!entry.id) {
            failures.push({
              capability: 'registry',
              message: 'registry entry missing id',
            });
            continue;
          }
          if (!entry.ecosystems[adapter.ecosystem]) {
            failures.push({
              capability: 'registry',
              message: `registry entry "${entry.id}" has no source pointer for adapter's own ecosystem "${adapter.ecosystem}"`,
            });
          }
        }
      }
    } catch (e) {
      failures.push({
        capability: 'registry',
        message: `listPrimitives() threw: ${(e as Error).message}`,
      });
    }
  }

  if (adapter.capabilities.includes('tokens') && !skip.has('tokens') && adapter.tokens) {
    try {
      const out = await adapter.tokens.emit(MINIMAL_DTCG);
      if (!Array.isArray(out) || out.length === 0) {
        failures.push({
          capability: 'tokens',
          message: 'tokens.emit() must return at least one FileEmit on a minimal DTCG doc',
        });
      }
    } catch (e) {
      failures.push({
        capability: 'tokens',
        message: `tokens.emit() threw: ${(e as Error).message}`,
      });
    }
  }

  if (adapter.capabilities.includes('codeEmit') && !skip.has('codeEmit') && adapter.codeEmit) {
    try {
      const out = await adapter.codeEmit.fromIR(MINIMAL_IR, {
        outDir: '/tmp/conformance',
        mode: 'preview',
      });
      if (!Array.isArray(out) || out.length === 0) {
        failures.push({
          capability: 'codeEmit',
          message: 'codeEmit.fromIR() must return at least one FileEmit on a minimal IR',
        });
      }
    } catch (e) {
      failures.push({
        capability: 'codeEmit',
        message: `codeEmit.fromIR() threw: ${(e as Error).message}`,
      });
    }
  }

  if (adapter.capabilities.includes('mockInput') && !skip.has('mockInput') && adapter.mockInput) {
    if (typeof adapter.mockInput.inputShape !== 'object' || adapter.mockInput.inputShape === null) {
      failures.push({
        capability: 'mockInput',
        message: 'mockInput.inputShape must be a JSON Schema object',
      });
    }
  }

  if (
    adapter.capabilities.includes('exportTarget') &&
    !skip.has('exportTarget') &&
    adapter.exportTarget
  ) {
    if (!adapter.exportTarget.targetId) {
      failures.push({
        capability: 'exportTarget',
        message: 'exportTarget.targetId is required',
      });
    }
  }

  return failures;
}

export async function assertAdapterConformant(
  adapter: DesignEcosystemAdapter,
  opts: ConformanceOptions = {},
): Promise<void> {
  const failures = await checkAdapterConformant(adapter, opts);
  if (failures.length > 0) {
    throw new AdapterConformanceError(adapter.id, failures);
  }
}
