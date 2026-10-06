export declare const SIDECAR_CREDENTIAL_ENV: readonly string[];
export declare const DEFAULT_SIDECAR_PORTS: readonly number[];

export declare function isProviderCredentialEnvName(name: string): boolean;

export declare function scrubProviderCredentials<T extends Record<string, string | undefined>>(
  env: T,
): { env: T; removed: string[] };

export interface ProviderEgressRule {
  id: string;
  kind: string;
  re: RegExp;
  sample: string;
}

export declare const PROVIDER_EGRESS_RULES: readonly ProviderEgressRule[];

export declare function providerEgressRules(ports?: readonly number[]): ProviderEgressRule[];

export interface ProviderEgressTarget {
  rule: string;
  kind: string;
  match: string;
}

export declare function findProviderEgressTargets(
  texts: string | readonly string[],
  options?: { sidecarPorts?: readonly number[] },
): ProviderEgressTarget[];
