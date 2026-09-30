/** Separate registry for durable workspace-host providers. */
import { pinModuleState } from '@papercusp/module-singleton';
import type { WorkspaceHostProvider, WorkspaceHostProviderConnection, WorkspaceHostProviderTarget } from './workspace-host-types';

const STATE_KEY = '@papercusp/deployment-driver:workspace-host-registry';
export type WorkspaceHostProviderFactory = (
  connection: WorkspaceHostProviderConnection,
) => WorkspaceHostProvider;

type WorkspaceHostProviderRegistration =
  | { kind: 'provider'; provider: WorkspaceHostProvider }
  | { kind: 'factory'; factory: WorkspaceHostProviderFactory };

const state = pinModuleState<{
  registry: Map<WorkspaceHostProviderTarget, WorkspaceHostProviderRegistration>;
}>(STATE_KEY, () => ({
  registry: new Map(),
}));

export function registerWorkspaceHostProvider(provider: WorkspaceHostProvider): void {
  state.registry.set(provider.target, { kind: 'provider', provider });
}

/** Register connection-aware composition without teaching the generic controller about a backend. */
export function registerWorkspaceHostProviderFactory(
  target: WorkspaceHostProviderTarget,
  factory: WorkspaceHostProviderFactory,
): void {
  state.registry.set(target, { kind: 'factory', factory });
}

export function configureWorkspaceHostProviders(options: { providers: readonly WorkspaceHostProvider[] }): void {
  for (const provider of options.providers) registerWorkspaceHostProvider(provider);
}

/** Resolve by open target or connection. There is intentionally no implicit local default. */
export function resolveWorkspaceHostProvider(
  selector: WorkspaceHostProviderTarget | WorkspaceHostProviderConnection,
): WorkspaceHostProvider {
  const target = typeof selector === 'string' ? selector : selector.target;
  const registration = state.registry.get(target);
  if (!registration) {
    throw new Error(
      `No workspace-host provider registered for target '${target}'. ` +
        `Registered: [${[...state.registry.keys()].join(', ')}]. ` +
        `A backend registers via configureWorkspaceHostProviders({ providers }) at host bootstrap.`,
    );
  }
  if (registration.kind === 'provider') return registration.provider;
  if (typeof selector === 'string') {
    throw new Error(`Workspace-host provider target '${target}' requires a connection-aware registry lookup`);
  }
  const provider = registration.factory(selector);
  if (provider.target !== target) {
    throw new Error(`Workspace-host provider factory for '${target}' returned target '${provider.target}'`);
  }
  return provider;
}

export function registeredWorkspaceHostProviderTargets(): WorkspaceHostProviderTarget[] {
  return [...state.registry.keys()];
}

/** Test-only reset. Every real workspace host must select an explicit provider. */
export function _resetWorkspaceHostProvidersForTests(): void {
  state.registry.clear();
}
