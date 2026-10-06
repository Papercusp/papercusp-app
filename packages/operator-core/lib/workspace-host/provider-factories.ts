/**
 * aws-byoc-gcp-parity-2026-10-01 P-003: the ONE place the operator registers its workspace-host
 * provider factories.
 *
 * Startup (`lib/dbos/bootstrap.ts`) calls `registerWorkspaceHostProviderFactories` instead of
 * registering each cloud inline. That makes "after operator startup a connection with target
 * 'aws' resolves to the AWS provider, not an unsupported-provider refusal" a property a unit test
 * can exercise through the very function the operator runs, rather than a claim about the body
 * of the much larger `startDbos()`.
 *
 * Both clouds share the same teardown-obligation observers (WI-10001672 producing half,
 * EI-23459044188861686 consuming half), so a billable GCP disk and a billable EBS volume are
 * tracked identically from creation to provider-confirmed absence.
 */
import { registerWorkspaceHostProviderFactory } from '@papercusp/deployment-driver';
import { createConfiguredAwsWorkspaceHostProvider } from './aws-configured-provider';
import { createConfiguredGcpWorkspaceHostProvider } from './gcp-provider';
import { resolveOrganizationExternalIdRef } from './hosted-aws-identity';

type GcpFactoryOptions = NonNullable<Parameters<typeof createConfiguredGcpWorkspaceHostProvider>[1]>;
type AwsFactoryOptions = NonNullable<Parameters<typeof createConfiguredAwsWorkspaceHostProvider>[1]>;

/** The obligation observers every cloud factory receives. */
export type WorkspaceHostObligationObservers = Pick<GcpFactoryOptions, 'onResourceCreated' | 'onResourceDestroyed'> &
  Pick<AwsFactoryOptions, 'onResourceCreated' | 'onResourceDestroyed'>;

export interface WorkspaceHostProviderFactoryDeps {
  /** Hosted GCP credential resolution (D-397 role chain). */
  resolveHostedGcpAuth: GcpFactoryOptions['resolveHostedAuth'];
  /** Builds the teardown-obligation observers for one provider. */
  obligationObservers: (provider: 'gcp' | 'aws') => WorkspaceHostObligationObservers;
  /**
   * Transport seams for the AWS SDK v3 client set. Production omits this, so the factory builds
   * the real SDK clients; a test substitutes a structural EC2 fake beneath the same
   * `AwsWorkspaceHostSdkClient` the operator runs.
   */
  awsTransport?: Pick<AwsFactoryOptions, 'createClients' | 'waiter' | 'now'>;
}

/** Register the 'gcp' and 'aws' workspace-host provider factories with the deployment driver. */
export function registerWorkspaceHostProviderFactories(deps: WorkspaceHostProviderFactoryDeps): void {
  registerWorkspaceHostProviderFactory('gcp', (connection) =>
    createConfiguredGcpWorkspaceHostProvider(connection, {
      resolveHostedAuth: deps.resolveHostedGcpAuth,
      ...deps.obligationObservers('gcp'),
    }),
  );
  // A hosted customer role resolves its ExternalId from the organization (P-008, D-007) and
  // composes only behind a verified delegation; the hosted OIDC minter is not bound, so that
  // method still refuses with a named error at resolve time instead of failing mid-operation.
  registerWorkspaceHostProviderFactory('aws', (connection) =>
    createConfiguredAwsWorkspaceHostProvider(connection, {
      resolveExternalId: resolveOrganizationExternalIdRef,
      ...deps.awsTransport,
      ...deps.obligationObservers('aws'),
    }),
  );
}
