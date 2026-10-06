/**
 * Operator-core integration provider registry (generalized-integrations-
 * google-migration-cupboard-workflows-2026-10-05, D-006 / P-001).
 *
 * Holds every loaded provider (first-party `js` and, later, sandboxed daemon
 * providers) keyed by descriptor id. Registration refuses duplicate ids,
 * unsupported contract versions and invalid descriptors with named errors;
 * unregistration is part of the plugin load/unload lifecycle.
 *
 * The registry is module state shared by every loader seam, so it is pinned
 * through `pinModuleState` (CLAUDE.md "Shared-lib singletons").
 */
import { pinModuleState } from '@papercusp/module-singleton';
import {
  isProviderAdapter,
  validateProviderDescriptor,
  type ProviderAdapter,
  type ProviderDescriptor,
} from '@papercusp/plugin-sdk';

export type ProviderRuntime = 'js' | 'daemon';

export interface RegisteredProvider {
  descriptor: ProviderDescriptor;
  adapter: ProviderAdapter;
  /** Plugin that owns this provider; used to unregister on unload. */
  pluginName: string;
  runtime: ProviderRuntime;
  registeredAt: number;
}

export type ProviderRegistrationErrorCode =
  | 'duplicate-provider'
  | 'unsupported-contract-version'
  | 'invalid-descriptor'
  | 'invalid-adapter'
  | 'descriptor-mismatch';

export class ProviderRegistrationError extends Error {
  constructor(
    readonly code: ProviderRegistrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRegistrationError';
  }
}

export interface ProviderRegistry {
  register(input: {
    descriptor: ProviderDescriptor;
    adapter: unknown;
    pluginName: string;
    runtime?: ProviderRuntime;
  }): Promise<RegisteredProvider>;
  unregister(providerId: string): boolean;
  unregisterPlugin(pluginName: string): string[];
  get(providerId: string): RegisteredProvider | undefined;
  list(): RegisteredProvider[];
  /** Providers producing `datatype` (optionally also offering `capability`). */
  forDatatype(datatype: string, capability?: string): RegisteredProvider[];
  clear(): void;
}

export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, RegisteredProvider>();
  return {
    async register({ descriptor, adapter, pluginName, runtime = 'js' }) {
      const issues = validateProviderDescriptor(descriptor);
      const versionIssue = issues.find((issue) => issue.startsWith('provider.contractVersion'));
      if (versionIssue) throw new ProviderRegistrationError('unsupported-contract-version', versionIssue);
      if (issues.length > 0) {
        throw new ProviderRegistrationError('invalid-descriptor', `provider descriptor invalid: ${issues.join('; ')}`);
      }
      if (!isProviderAdapter(adapter)) {
        throw new ProviderRegistrationError(
          'invalid-adapter',
          `provider "${descriptor.id}" adapter must implement describe(), syncPage() and invoke()`,
        );
      }
      const existing = providers.get(descriptor.id);
      if (existing) {
        throw new ProviderRegistrationError(
          'duplicate-provider',
          `provider "${descriptor.id}" is already registered by plugin "${existing.pluginName}"`,
        );
      }
      const described = await adapter.describe();
      if (described.id !== descriptor.id || described.contractVersion !== descriptor.contractVersion) {
        throw new ProviderRegistrationError(
          'descriptor-mismatch',
          `provider "${descriptor.id}" adapter describes "${described.id}" v${described.contractVersion}, manifest declares v${descriptor.contractVersion}`,
        );
      }
      const entry: RegisteredProvider = { descriptor, adapter, pluginName, runtime, registeredAt: Date.now() };
      providers.set(descriptor.id, entry);
      return entry;
    },
    unregister(providerId) {
      return providers.delete(providerId);
    },
    unregisterPlugin(pluginName) {
      const removed: string[] = [];
      for (const [id, entry] of providers) {
        if (entry.pluginName === pluginName) {
          providers.delete(id);
          removed.push(id);
        }
      }
      return removed;
    },
    get(providerId) {
      return providers.get(providerId);
    },
    list() {
      return [...providers.values()];
    },
    forDatatype(datatype, capability) {
      return [...providers.values()].filter(
        (entry) =>
          entry.descriptor.datatypes.includes(datatype) &&
          (capability === undefined || entry.descriptor.capabilities.includes(capability)),
      );
    },
    clear() {
      providers.clear();
    },
  };
}

const state = pinModuleState('@papercusp/operator-core.integrations.provider-registry', () => ({
  registry: createProviderRegistry(),
}));

/** The process-wide provider registry used by the plugin host and the connector driver. */
export function providerRegistry(): ProviderRegistry {
  return state.registry;
}
