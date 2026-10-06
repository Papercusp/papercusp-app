/**
 * P-516/F5: the host-owned trust boundary for delegated agent seats.
 *
 * Delegated seats are trusted host-agent delegation. They are not an
 * untrusted public compute sandbox: the host's normal agent envelope remains
 * authoritative, and public foreign work must use the separate OS sandbox
 * path. This module is pure policy so the honor path and its tests share the
 * exact contract.
 */

import type { RefusalContract } from '../capability-envelope/refusal-contract-types';

export type DelegatedSeatTrustMode = 'trusted-host-agent' | 'untrusted-public';
export type DelegatedCredentialRoute = 'default' | 'auto' | 'pinned';

export interface DelegatedSeatPolicy {
  trustMode: DelegatedSeatTrustMode;
  allowedWorkspaceIds: readonly string[] | null;
  allowedRepoIds: readonly string[] | null;
  allowedTools: readonly string[] | null;
  allowedCredentialRoutes: readonly DelegatedCredentialRoute[];
  maxConcurrentSeats: number;
  /** Maximum age of a signed request accepted by this host. */
  maxDurationMs: number;
  /** null deliberately preserves the approved unmetered-seat v1 scope. */
  maxSpendMicros: number | null;
}

export const DEFAULT_DELEGATED_SEAT_POLICY: DelegatedSeatPolicy = Object.freeze({
  trustMode: 'trusted-host-agent',
  allowedWorkspaceIds: null,
  allowedRepoIds: null,
  allowedTools: null,
  allowedCredentialRoutes: ['default', 'auto', 'pinned'] as const,
  maxConcurrentSeats: 12,
  maxDurationMs: 60 * 60_000,
  maxSpendMicros: null,
});

type PolicyLoad = { ok: true; policy: DelegatedSeatPolicy } | { ok: false; code: 'delegated_seat_policy_invalid'; detail: string };

function stringList(value: unknown, field: string): readonly string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`${field} must be null or a non-empty string array`);
  }
  return [...new Set(value.map((entry) => entry.trim()))].sort();
}

/** Load a host-owned override. Invalid policy is a loud fail-closed refusal. */
export function loadDelegatedSeatPolicy(env: Record<string, string | undefined> = process.env): PolicyLoad {
  const raw = env.PAPERCUSP_DELEGATED_SEAT_POLICY?.trim();
  if (!raw) return { ok: true, policy: DEFAULT_DELEGATED_SEAT_POLICY };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const trustMode = value.trustMode ?? DEFAULT_DELEGATED_SEAT_POLICY.trustMode;
    if (trustMode !== 'trusted-host-agent' && trustMode !== 'untrusted-public') {
      throw new Error("trustMode must be 'trusted-host-agent' or 'untrusted-public'");
    }
    const routes = value.allowedCredentialRoutes ?? DEFAULT_DELEGATED_SEAT_POLICY.allowedCredentialRoutes;
    if (!Array.isArray(routes) || routes.some((route) => !['default', 'auto', 'pinned'].includes(String(route)))) {
      throw new Error('allowedCredentialRoutes must contain only default, auto, or pinned');
    }
    const maxConcurrentSeats = (value.maxConcurrentSeats ?? DEFAULT_DELEGATED_SEAT_POLICY.maxConcurrentSeats) as unknown;
    const maxDurationMs = (value.maxDurationMs ?? DEFAULT_DELEGATED_SEAT_POLICY.maxDurationMs) as unknown;
    const maxSpendMicros = (value.maxSpendMicros ?? DEFAULT_DELEGATED_SEAT_POLICY.maxSpendMicros) as unknown;
    if (typeof maxConcurrentSeats !== 'number' || !Number.isSafeInteger(maxConcurrentSeats) || maxConcurrentSeats < 1 || maxConcurrentSeats > 1000) {
      throw new Error('maxConcurrentSeats must be an integer from 1 through 1000');
    }
    if (typeof maxDurationMs !== 'number' || !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 7 * 24 * 60 * 60_000) {
      throw new Error('maxDurationMs must be a positive integer no longer than seven days');
    }
    if (maxSpendMicros !== null && (typeof maxSpendMicros !== 'number' || !Number.isSafeInteger(maxSpendMicros) || maxSpendMicros < 0)) {
      throw new Error('maxSpendMicros must be null or a non-negative integer');
    }
    return {
      ok: true,
      policy: {
        trustMode,
        allowedWorkspaceIds: stringList(value.allowedWorkspaceIds, 'allowedWorkspaceIds'),
        allowedRepoIds: stringList(value.allowedRepoIds, 'allowedRepoIds'),
        allowedTools: stringList(value.allowedTools, 'allowedTools'),
        allowedCredentialRoutes: [...new Set(routes as DelegatedCredentialRoute[])].sort(),
        maxConcurrentSeats: maxConcurrentSeats as number,
        maxDurationMs: maxDurationMs as number,
        maxSpendMicros: maxSpendMicros as number | null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: 'delegated_seat_policy_invalid',
      detail: `PAPERCUSP_DELEGATED_SEAT_POLICY is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type DelegatedSeatPolicyEvaluation =
  | {
      ok: true;
      audit: {
        trustLabel: 'trusted-host-agent-delegation';
        sandbox: 'host-agent-envelope';
        spendVisibility: 'unmetered-v1' | 'bounded-micros';
        stopControl: 'resource:delegate remove + fleet stop';
      };
    }
  | {
      ok: false;
      code: string;
      detail: string;
      /**
       * WI-10005197: what would LIFT this refusal. Present on the allowlist refusals — the ones
       * a host operator can lift by editing PAPERCUSP_DELEGATED_SEAT_POLICY. The caps and shape
       * errors lift on the request side and carry no host lever, so they stay un-contracted.
       */
      refusal?: RefusalContract;
    };

export function evaluateDelegatedSeatPolicy(input: {
  policy: DelegatedSeatPolicy;
  workspaceId: string;
  repoId?: string | null;
  requestedTools?: readonly string[] | null;
  credentialRoute: DelegatedCredentialRoute;
  requestedSeats: number;
  activeSeats: number;
  requestedAtMs: number;
  nowMs: number;
  estimatedSpendMicros?: number | null;
}): DelegatedSeatPolicyEvaluation {
  const { policy } = input;
  if (policy.trustMode !== 'trusted-host-agent') {
    return {
      ok: false,
      code: 'untrusted_public_requires_os_sandbox',
      detail: 'Delegated seats are trusted host-agent delegation only; untrusted public execution requires the OS-enforced sandbox path.',
    };
  }
  if (policy.allowedWorkspaceIds && !policy.allowedWorkspaceIds.includes(input.workspaceId)) {
    return {
      ok: false,
      code: 'workspace_not_allowed',
      detail: `workspace '${input.workspaceId}' is outside the host delegated-seat allowlist`,
      refusal: {
        observed: { workspaceId: input.workspaceId, allowlistSize: String(policy.allowedWorkspaceIds.length) },
        liftsWhen:
          'the requesting workspace is in this host\'s allowedWorkspaceIds, or the allowlist is cleared. ' +
          'Retrying the same request cannot lift it: the HOST operator edits PAPERCUSP_DELEGATED_SEAT_POLICY ' +
          'and restarts the operator, or the requester delegates from an already-allowed workspace',
        whoCanMakeItTrue: ['host', 'owner'],
      },
    };
  }
  if (policy.allowedRepoIds) {
    if (!input.repoId) return { ok: false, code: 'repo_scope_unavailable', detail: 'the host policy requires a repository identity, but this delegated request carries none' };
    if (!policy.allowedRepoIds.includes(input.repoId)) {
      return {
        ok: false,
        code: 'repo_not_allowed',
        detail: `repository '${input.repoId}' is outside the host delegated-seat allowlist`,
        refusal: {
          observed: { repoId: input.repoId, allowlistSize: String(policy.allowedRepoIds.length) },
          liftsWhen:
            'the delegated request\'s repository is in this host\'s allowedRepoIds, or the allowlist is cleared. ' +
            'Retrying cannot lift it: the HOST operator edits PAPERCUSP_DELEGATED_SEAT_POLICY and restarts ' +
            'the operator, or the requester delegates work on an already-allowed repository',
          whoCanMakeItTrue: ['host', 'owner'],
        },
      };
    }
  }
  if (policy.allowedTools && (input.requestedTools == null || input.requestedTools.some((tool) => !policy.allowedTools!.includes(tool)))) {
    const outside = (input.requestedTools ?? []).filter((tool) => !policy.allowedTools!.includes(tool));
    return {
      ok: false,
      code: 'tools_not_allowed',
      detail: 'the host policy requires an allowed tool set, but the delegated request does not prove it',
      refusal: {
        observed: {
          requestedTools: input.requestedTools == null ? null : String(input.requestedTools.length),
          toolsOutsideAllowlist: input.requestedTools == null ? null : outside.join(','),
          allowlistSize: String(policy.allowedTools.length),
        },
        liftsWhen:
          'the request declares its tool set AND every declared tool is in this host\'s allowedTools. ' +
          'A request that declares no tool set is refused under an allowlist: the requester re-sends with an ' +
          'explicit requestedTools subset, or the HOST operator widens allowedTools in PAPERCUSP_DELEGATED_SEAT_POLICY',
        whoCanMakeItTrue: ['another-agent', 'host', 'owner'],
      },
    };
  }
  if (!policy.allowedCredentialRoutes.includes(input.credentialRoute)) {
    return {
      ok: false,
      code: 'credential_route_not_allowed',
      detail: `credential route '${input.credentialRoute}' is not allowed by the host delegated-seat policy`,
      refusal: {
        observed: { credentialRoute: input.credentialRoute, allowedRoutes: policy.allowedCredentialRoutes.join(',') },
        liftsWhen:
          'the request\'s credential route (default, auto or pinned) is among this host\'s ' +
          'allowedCredentialRoutes. Retrying cannot lift it: the requester re-launches on an allowed route, ' +
          'or the HOST operator adds the route in PAPERCUSP_DELEGATED_SEAT_POLICY',
        whoCanMakeItTrue: ['another-agent', 'host', 'owner'],
      },
    };
  }
  if (!Number.isSafeInteger(input.requestedSeats) || input.requestedSeats < 1) {
    return { ok: false, code: 'invalid_seat_count', detail: 'requested delegated seat count must be a positive integer' };
  }
  if (input.activeSeats + input.requestedSeats > policy.maxConcurrentSeats) {
    return { ok: false, code: 'delegated_concurrency_cap', detail: `host delegated-seat concurrency cap is ${policy.maxConcurrentSeats}; active=${input.activeSeats}, requested=${input.requestedSeats}` };
  }
  const ageMs = input.nowMs - input.requestedAtMs;
  if (ageMs > policy.maxDurationMs) {
    return { ok: false, code: 'delegated_duration_cap', detail: `signed delegated request age ${ageMs}ms exceeds host cap ${policy.maxDurationMs}ms` };
  }
  if (policy.maxSpendMicros !== null) {
    if (input.estimatedSpendMicros == null) return { ok: false, code: 'spend_estimate_unavailable', detail: 'host spend ceiling is set but this v1 seat request has no trusted spend estimate' };
    if (input.estimatedSpendMicros > policy.maxSpendMicros) return { ok: false, code: 'delegated_spend_cap', detail: `estimated spend ${input.estimatedSpendMicros} exceeds host cap ${policy.maxSpendMicros}` };
  }
  return {
    ok: true,
    audit: {
      trustLabel: 'trusted-host-agent-delegation',
      sandbox: 'host-agent-envelope',
      spendVisibility: policy.maxSpendMicros === null ? 'unmetered-v1' : 'bounded-micros',
      stopControl: 'resource:delegate remove + fleet stop',
    },
  };
}
