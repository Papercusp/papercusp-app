/**
 * The cloud-neutral half of the workspace-host soak seams (P-007 of aws-byoc-gcp-parity-2026-10-01).
 *
 * Both supported clouds reach a host the same way once the transport is chosen: an SSH invocation
 * over a provider tunnel (GCP IAP, AWS Session Manager) bound to the PINNED incarnation's host-key
 * alias. So the reach probe, the agent-login read and the transport-retry discipline of the
 * instance read live here once, and `soak-gcp.ts` / `soak-aws.ts` supply only what differs: how
 * the instance is read and which SSH profile names it. Nothing here enrolls a host key, so a
 * machine recreated mid-soak fails StrictHostKeyChecking instead of being quietly re-trusted.
 */
import { describeFetchError } from '../loopback-fetch';
import {
  buildWorkspaceHostAgentCredentialExpiryProbe,
  parseWorkspaceHostAgentCredentialExpiryOutput,
  type WorkspaceHostAgentCredentialExpiryReading,
} from './agent-credential-expiry';
import {
  GcpIapWorkspaceHostBootstrapNotReadyError,
  GcpIapWorkspaceHostInitializationOperations,
  NodeGcpIapWorkspaceHostInitializationCommandRunner,
  formatGcpIapDiagnosticTail,
  type GcpIapWorkspaceHostInitializationCommandRunner,
  type WorkspaceHostSshInitializationProfile,
} from './gcp-iap-initialization-operations';
import type {
  WorkspaceHostSoakInstanceReading,
  WorkspaceHostSoakProbe,
  WorkspaceHostSoakReachOutcome,
  WorkspaceHostSoakSubject,
} from './soak';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';

/** Bound on one ssh attempt; a hung tunnel must not eat the sample interval. */
export const WORKSPACE_HOST_SOAK_REACH_ATTEMPT_TIMEOUT_MS = 45_000;
/** Budget for one sample's reach check: up to ~3 attempts, absorbing a single dropped tunnel. */
export const WORKSPACE_HOST_SOAK_REACH_BUDGET_MS = 45_000;
export const WORKSPACE_HOST_SOAK_REACH_RETRY_MS = 15_000;
/**
 * Attempts for one sample's instance read. A transport failure (`fetch failed`) leaves all three
 * strict checks unmeasured, and the evaluator needs 95% of samples measured: the r39 soak lost 15
 * samples to single dropped requests with zero host failures, and could not pass (WI-10002796).
 */
export const WORKSPACE_HOST_SOAK_READ_ATTEMPTS = 3;
export const WORKSPACE_HOST_SOAK_READ_RETRY_MS = 5_000;

export type WorkspaceHostSoakTiming = { now?: () => number; sleep?: (ms: number) => Promise<void> };

/** The soak probe plus the standing-health-only agent-login read (WI-10003720). */
export interface WorkspaceHostSshSoakProbe extends WorkspaceHostSoakProbe {
  readAgentCredentialExpiry(): Promise<WorkspaceHostAgentCredentialExpiryReading>;
}

/** What every cloud's soak seams resolve to; the soak and standing-health runtimes take this. */
export interface WorkspaceHostSoakSeams {
  desired: WorkspaceHostDesiredSpec;
  readInstance(): Promise<WorkspaceHostSoakInstanceReading>;
  probeFor(subject: WorkspaceHostSoakSubject): WorkspaceHostSshSoakProbe;
}

export function soakErrorDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export function defaultSoakSleep(timing?: WorkspaceHostSoakTiming): (ms: number) => Promise<void> {
  return timing?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

/**
 * Wrap one provider read with the soak's retry discipline. Only a TRANSPORT failure is asked
 * again: an absent or observed instance is an answer, and a non-transient error (auth, quota)
 * would fail the same way on every attempt.
 */
export function retryingWorkspaceHostSoakInstanceRead(
  readOnce: () => Promise<WorkspaceHostSoakInstanceReading>,
  options: { isTransient(error: unknown): boolean; sleep(ms: number): Promise<void> },
): () => Promise<WorkspaceHostSoakInstanceReading> {
  return async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await readOnce();
      } catch (error) {
        if (attempt >= WORKSPACE_HOST_SOAK_READ_ATTEMPTS || !options.isTransient(error)) {
          // describeFetchError keeps undici's hidden cause code: r39 persisted a blind "fetch failed".
          const tries = attempt > 1 ? ` (after ${attempt} attempts)` : '';
          return { kind: 'unreadable', detail: `${describeFetchError(error).slice(0, 500)}${tries}` };
        }
        await options.sleep(WORKSPACE_HOST_SOAK_READ_RETRY_MS);
      }
    }
  };
}

export interface WorkspaceHostSshSoakProbeInput {
  subject: WorkspaceHostSoakSubject;
  /** The pinned incarnation's SSH profile — the same alias initialization enrolled. */
  profile: WorkspaceHostSshInitializationProfile;
  readInstance(): Promise<WorkspaceHostSoakInstanceReading>;
  now(): Date;
  runner?: GcpIapWorkspaceHostInitializationCommandRunner;
  timing?: WorkspaceHostSoakTiming;
}

export function buildWorkspaceHostSshSoakProbe(input: WorkspaceHostSshSoakProbeInput): WorkspaceHostSshSoakProbe {
  const runner = () =>
    input.runner ??
    new NodeGcpIapWorkspaceHostInitializationCommandRunner({
      timeoutMs: WORKSPACE_HOST_SOAK_REACH_ATTEMPT_TIMEOUT_MS,
    });
  return {
    readInstance: input.readInstance,
    now: input.now,
    // Same pinned profile (incarnation host-key alias) and runner as the reach probe, so a
    // recreated machine fails StrictHostKeyChecking here too instead of being re-trusted.
    async readAgentCredentialExpiry(): Promise<WorkspaceHostAgentCredentialExpiryReading> {
      try {
        const result = await runner().run(buildWorkspaceHostAgentCredentialExpiryProbe(input.profile));
        if (result.exitCode !== 0) {
          return {
            kind: 'transport-failure',
            detail: `agent-login read exited ${result.exitCode}${formatGcpIapDiagnosticTail(result.stderr)}`.slice(0, 500),
          };
        }
        return { kind: 'read', slots: parseWorkspaceHostAgentCredentialExpiryOutput(result.stdout) };
      } catch (error) {
        return { kind: 'transport-failure', detail: soakErrorDetail(error) };
      }
    },
    async probeReach(): Promise<WorkspaceHostSoakReachOutcome> {
      const operations = new GcpIapWorkspaceHostInitializationOperations(input.profile, runner(), input.timing ?? {});
      try {
        await operations.awaitBootstrapReady({
          timeoutMs: WORKSPACE_HOST_SOAK_REACH_BUDGET_MS,
          pollIntervalMs: WORKSPACE_HOST_SOAK_REACH_RETRY_MS,
        });
        return { kind: 'reached' };
      } catch (error) {
        // Matched by name as well as prototype: DBOS serialization erases prototypes elsewhere
        // in this subsystem, and a misclassified outcome here would blur the two failure kinds.
        if (
          error instanceof GcpIapWorkspaceHostBootstrapNotReadyError ||
          (error instanceof Error && error.name === 'GcpIapWorkspaceHostBootstrapNotReadyError')
        ) {
          const typed = error as GcpIapWorkspaceHostBootstrapNotReadyError;
          return typed.answered
            ? { kind: 'conduit-missing', detail: soakErrorDetail(error) }
            : { kind: 'transport-failure', detail: soakErrorDetail(error) };
        }
        return { kind: 'transport-failure', detail: soakErrorDetail(error) };
      }
    },
  };
}
