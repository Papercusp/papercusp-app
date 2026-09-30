import type {
  WorkspaceHostTransportFallback,
  WorkspaceHostTransportFeature,
  WorkspaceHostTransportProfile,
  WorkspaceHostTransportRequirement,
  WorkspaceHostTransportTrafficClass,
} from './workspace-host-types';

export interface WorkspaceHostTransportRequirementObservation {
  status: 'satisfied' | 'missing' | 'unknown';
  version?: string;
}

export interface WorkspaceHostTransportClientEnvironment {
  platform: string;
  requirements: Readonly<Record<string, WorkspaceHostTransportRequirementObservation | undefined>>;
  corporateProxy: {
    enabled: boolean;
    allowedDomains?: readonly string[];
  };
  hostKey: 'verified' | 'missing' | 'changed' | 'unknown' | 'not-applicable';
}

export interface WorkspaceHostTransportCompatibilityRequest {
  feature: WorkspaceHostTransportFeature;
  trafficClass: WorkspaceHostTransportTrafficClass;
  client: WorkspaceHostTransportClientEnvironment;
}

export type WorkspaceHostTransportCompatibilityIssueCode =
  | 'invalid-profile'
  | 'unsupported-platform'
  | 'unsupported-feature'
  | 'traffic-feature-mismatch'
  | 'traffic-class-discouraged'
  | 'traffic-class-unsupported'
  | 'missing-requirement-evidence'
  | 'unsatisfied-requirement'
  | 'unverifiable-version'
  | 'minimum-version-not-met'
  | 'corporate-proxy-unsupported'
  | 'corporate-proxy-unverified'
  | 'corporate-proxy-domain-blocked'
  | 'host-key-unverified';

export interface WorkspaceHostTransportCompatibilityIssue {
  code: WorkspaceHostTransportCompatibilityIssueCode;
  message: string;
  requirementId?: string;
}

export interface WorkspaceHostTransportCompatibilityResult {
  compatible: boolean;
  errors: readonly WorkspaceHostTransportCompatibilityIssue[];
  warnings: readonly WorkspaceHostTransportCompatibilityIssue[];
  fallback?: WorkspaceHostTransportFallback;
}

function dottedVersion(value: string): readonly number[] | undefined {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)*$/.test(normalized)) return undefined;
  return normalized.split('.').map(Number);
}

function compareDottedVersions(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function requirementApplies(
  requirement: WorkspaceHostTransportRequirement,
  request: WorkspaceHostTransportCompatibilityRequest,
): boolean {
  return (
    requirement.requiredFor.includes(request.feature) &&
    (!requirement.platforms || requirement.platforms.includes(request.client.platform))
  );
}

function findFallback(
  profile: WorkspaceHostTransportProfile,
  request: WorkspaceHostTransportCompatibilityRequest,
): WorkspaceHostTransportFallback | undefined {
  return profile.compatibility.fallbacks.find(
    (fallback) =>
      fallback.feature === request.feature &&
      (fallback.trafficClass === undefined || fallback.trafficClass === request.trafficClass),
  );
}

/**
 * Evaluate a provider profile against fresh preflight observations. Missing or
 * unverifiable evidence is incompatible by design; callers must never infer
 * parity from a transport kind or a free-text prerequisite.
 */
export function evaluateWorkspaceHostTransportCompatibility(
  profile: WorkspaceHostTransportProfile,
  request: WorkspaceHostTransportCompatibilityRequest,
): WorkspaceHostTransportCompatibilityResult {
  if (!profile.compatibility) {
    return {
      compatible: false,
      errors: [
        {
          code: 'invalid-profile',
          message: `Transport '${profile.kind}' has no structured compatibility contract`,
        },
      ],
      warnings: [],
    };
  }
  const errors: WorkspaceHostTransportCompatibilityIssue[] = [];
  const warnings: WorkspaceHostTransportCompatibilityIssue[] = [];
  const addError = (issue: WorkspaceHostTransportCompatibilityIssue) => errors.push(issue);

  if (!profile.supportedClientPlatforms.includes(request.client.platform)) {
    addError({
      code: 'unsupported-platform',
      message: `Transport '${profile.kind}' does not support client platform '${request.client.platform}'`,
    });
  }

  if (profile.features[request.feature] !== true) {
    addError({
      code: 'unsupported-feature',
      message: `Transport '${profile.kind}' does not support feature '${request.feature}'`,
    });
  }

  if (request.trafficClass === 'bulk-transfer' && request.feature !== 'fileTransfer') {
    addError({
      code: 'traffic-feature-mismatch',
      message: "Bulk-transfer evaluation requires the 'fileTransfer' feature",
    });
  }

  const suitability = profile.compatibility.traffic[request.trafficClass];
  if (suitability === 'unsupported') {
    addError({
      code: 'traffic-class-unsupported',
      message: `Transport '${profile.kind}' does not support ${request.trafficClass} traffic`,
    });
  } else if (suitability === 'discouraged') {
    warnings.push({
      code: 'traffic-class-discouraged',
      message: `Transport '${profile.kind}' discourages ${request.trafficClass} traffic; use the declared fallback for large payloads`,
    });
  }

  const requirementIds = new Set<string>();
  for (const requirement of profile.compatibility.requirements) {
    if (requirementIds.has(requirement.id)) {
      addError({
        code: 'missing-requirement-evidence',
        requirementId: requirement.id,
        message: `Transport profile contains duplicate requirement id '${requirement.id}'`,
      });
      continue;
    }
    requirementIds.add(requirement.id);
    if (!requirementApplies(requirement, request)) continue;
    const observation = request.client.requirements[requirement.id];
    if (!observation || observation.status === 'unknown') {
      addError({
        code: 'missing-requirement-evidence',
        requirementId: requirement.id,
        message: `No conclusive preflight evidence for '${requirement.label}'`,
      });
      continue;
    }
    if (observation.status === 'missing') {
      addError({
        code: 'unsatisfied-requirement',
        requirementId: requirement.id,
        message: `Required ${requirement.kind} '${requirement.label}' is not available`,
      });
      continue;
    }
    if (!requirement.minimumVersion) continue;
    const observedVersion = observation.version ? dottedVersion(observation.version) : undefined;
    const minimumVersion = dottedVersion(requirement.minimumVersion);
    if (!observedVersion || !minimumVersion) {
      addError({
        code: 'unverifiable-version',
        requirementId: requirement.id,
        message: `Could not verify '${requirement.label}' against minimum version ${requirement.minimumVersion}`,
      });
      continue;
    }
    if (compareDottedVersions(observedVersion, minimumVersion) < 0) {
      addError({
        code: 'minimum-version-not-met',
        requirementId: requirement.id,
        message: `'${requirement.label}' version ${observation.version} is below required ${requirement.minimumVersion}`,
      });
    }
  }

  const proxy = profile.compatibility.proxy;
  if (request.client.corporateProxy.enabled) {
    if (proxy.mode === 'unsupported') {
      addError({
        code: 'corporate-proxy-unsupported',
        message: `Transport '${profile.kind}' cannot run through a corporate proxy`,
      });
    } else if (proxy.mode === 'provider-dependent') {
      addError({
        code: 'corporate-proxy-unverified',
        message: `Transport '${profile.kind}' requires provider-specific corporate-proxy verification`,
      });
    } else if (proxy.mode === 'allowlist-required') {
      const allowed = new Set((request.client.corporateProxy.allowedDomains ?? []).map((value) => value.toLowerCase()));
      for (const domain of proxy.requiredDomains ?? []) {
        if (!allowed.has(domain.toLowerCase())) {
          addError({
            code: 'corporate-proxy-domain-blocked',
            message: `Corporate proxy must allow '${domain}' for transport '${profile.kind}'`,
          });
        }
      }
    }
  }

  const hostKey = profile.compatibility.hostKey;
  if (hostKey.initialEnrollment === 'verify-before-connect' && request.client.hostKey !== 'verified') {
    addError({
      code: 'host-key-unverified',
      message:
        request.client.hostKey === 'changed'
          ? `SSH host key changed for transport '${profile.kind}'; block and re-verify before reconnecting`
          : `SSH host key must be verified before using transport '${profile.kind}'`,
    });
  }

  const fallback = findFallback(profile, request);
  return {
    compatible: errors.length === 0,
    errors,
    warnings,
    ...(fallback ? { fallback } : {}),
  };
}
