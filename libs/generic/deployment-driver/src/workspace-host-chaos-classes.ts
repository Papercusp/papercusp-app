import {
  workspaceHostRecoveryAction,
  type WorkspaceHostRecoveryAction,
  type WorkspaceHostResourceCheckpoint,
  type WorkspaceHostRetryClass,
} from "./workspace-host-workflow";

/**
 * Classify a thrown provider call so the controller knows whether retrying can ever help.
 *
 * Default to `ambiguous` — an error with no HTTP status may be a lost response, and the mutation
 * may already have been accepted, so the next pass must reconcile rather than assume anything.
 * A 4xx is the exception: the provider parsed the request and REFUSED it, so the identical body
 * will be refused identically forever and `terminal` (which the controller turns into `halt`) is
 * the only classification that does not loop. 408 and 429 are the two 4xx codes that explicitly
 * invite a retry, and 409 stays ambiguous because an idempotent replay can legitimately conflict
 * with the caller's own earlier accepted write.
 *
 * This lives here, beside the retry-class taxonomy and `workspaceHostRecoveryAction`, because
 * EVERY controller that turns a thrown provider call into a checkpoint owes the same answer.
 * It was previously private to one runner, and the runner that lacked it recorded every failure
 * as `ambiguous` — which `workspaceHostRecoveryAction` resolves to `reconcile` with no attempt
 * ceiling, so a deterministic refusal presented as a permanent hang instead of a failure.
 */
export function workspaceHostProviderRetryClass(
  error: unknown,
): WorkspaceHostRetryClass {
  const signals = error as
    | { status?: unknown; throttled?: unknown }
    | null
    | undefined;
  // An explicit throttle statement OUTRANKS the status code, and must be read before the 4xx rule
  // below. Not every provider throttles with 429: Google answers Compute rate limiting with 403,
  // which the 4xx rule would settle as `terminal` -> `halt`, stopping a durable workflow forever
  // on a fault that a bounded backoff clears. Adapters set this only for reasons a retry can fix
  // (never a spent quota), so honouring it here cannot turn a real refusal into an infinite loop.
  if (signals?.throttled === true) return "throttled";
  const status = signals?.status;
  if (typeof status !== "number") return "ambiguous";
  if (status === 408 || status === 429) return "throttled";
  if (status === 409) return "ambiguous";
  return status >= 400 && status < 500 ? "terminal" : "ambiguous";
}

/**
 * The failure and recovery classes a workspace-host controller must survive deterministically.
 *
 * Each class pins one observable contract: given this fault, the controller reaches this recovery
 * action. Two probe shapes appear, because the classes are not all the same kind of event —
 * conflating them is what lets a "chaos suite" assert only the easy half:
 *
 * - `thrown-error` — the provider call threw. The contract runs
 *   error → {@link workspaceHostProviderRetryClass} → {@link workspaceHostRecoveryAction}.
 * - `checkpoint-state` — nothing threw; the controller lost its own continuity (a crash between
 *   the provider mutation and the durable record, a half-finished teardown, an orphan with no
 *   receipt). The contract runs checkpoint → {@link workspaceHostRecoveryAction} directly.
 */
export type WorkspaceHostChaosProbe =
  | {
      kind: "thrown-error";
      /** The provider error to inject. `status` absent models a lost response. */
      error: { status?: number; code?: string; message: string };
      expectedRetryClass: WorkspaceHostRetryClass;
    }
  | {
      kind: "checkpoint-state";
      /** The durable row a resumed controller finds. */
      checkpoint: WorkspaceHostResourceCheckpoint;
    };

export interface WorkspaceHostChaosClass {
  id: string;
  /** The failure as P-024 names it, so the registry is auditable against the plan item. */
  label: string;
  probe: WorkspaceHostChaosProbe;
  expectedRecovery: WorkspaceHostRecoveryAction;
  /** Why this recovery is the safe one — the reason a future edit must not casually invert. */
  rationale: string;
}

/** Attempt ceiling these classes are evaluated against; matches both runners' `maxApplyAttempts`. */
export const WORKSPACE_HOST_CHAOS_MAX_APPLY_ATTEMPTS = 3;

export const WORKSPACE_HOST_CHAOS_CLASSES: readonly WorkspaceHostChaosClass[] = [
  {
    id: "api-throttled",
    label: "API 429",
    probe: {
      kind: "thrown-error",
      error: { status: 429, code: "RATE_LIMIT_EXCEEDED", message: "Too Many Requests" },
      expectedRetryClass: "throttled",
    },
    expectedRecovery: "retry",
    rationale:
      "A throttle is an explicit invitation to retry the identical body after a delay; the request was never evaluated.",
  },
  {
    id: "api-server-error",
    label: "API 5xx",
    probe: {
      kind: "thrown-error",
      error: { status: 503, code: "BACKEND_ERROR", message: "Service Unavailable" },
      expectedRetryClass: "ambiguous",
    },
    expectedRecovery: "reconcile",
    rationale:
      "A 5xx may be raised after the mutation was accepted, so provider truth must be read before any fresh create.",
  },
  {
    id: "expired-credential",
    label: "expired credential",
    probe: {
      kind: "thrown-error",
      error: { status: 401, code: "UNAUTHENTICATED", message: "Credential has expired" },
      expectedRetryClass: "terminal",
    },
    expectedRecovery: "halt",
    rationale:
      "The provider authenticated the request and refused it; replaying the identical body with the identical dead credential is refused identically forever, so it must fail closed rather than reconcile.",
  },
  {
    id: "quota-denial",
    label: "quota denial",
    probe: {
      kind: "thrown-error",
      error: { status: 403, code: "QUOTA_EXCEEDED", message: "Quota 'CPUS' exceeded" },
      expectedRetryClass: "terminal",
    },
    expectedRecovery: "halt",
    rationale:
      "A quota refusal is deterministic for this request shape; surfacing it lets an operator raise the quota instead of the controller spinning silently.",
  },
  {
    id: "regional-capacity-miss",
    label: "regional capacity miss",
    probe: {
      kind: "thrown-error",
      error: {
        status: 503,
        code: "ZONE_RESOURCE_POOL_EXHAUSTED",
        message: "The zone does not have enough resources",
      },
      expectedRetryClass: "ambiguous",
    },
    expectedRecovery: "reconcile",
    rationale:
      "Capacity is transient, but the 503 arrives from the same path as a lost response, so the controller reads provider truth before re-applying rather than assuming nothing was created.",
  },
  {
    id: "operation-timeout-after-success",
    label: "operation timeout after success",
    probe: {
      kind: "thrown-error",
      error: { message: "socket hang up before the response was read" },
      expectedRetryClass: "ambiguous",
    },
    expectedRecovery: "reconcile",
    rationale:
      "The defining chaos case: the side effect landed and the response did not. A fresh create here duplicates a live billed resource, so reconcile is the only safe move.",
  },
  {
    id: "controller-crash-between-create-and-record",
    label: "controller crash between create and record",
    probe: {
      kind: "checkpoint-state",
      checkpoint: { logicalKey: "vm", state: "applying", attempts: 1 },
    },
    expectedRecovery: "reconcile",
    rationale:
      "An `applying` row is exactly the crash window: the provider may hold a resource the controller never recorded, so it must be discovered, never re-created.",
  },
  {
    id: "bootstrap-failure",
    label: "bootstrap failure",
    probe: {
      kind: "thrown-error",
      error: { status: 422, code: "BOOTSTRAP_REJECTED", message: "Guest bootstrap contract rejected" },
      expectedRetryClass: "terminal",
    },
    expectedRecovery: "halt",
    rationale:
      "A rejected bootstrap payload is a deterministic content failure; retrying the same payload cannot change the verdict.",
  },
  {
    id: "unhealthy-operator",
    label: "unhealthy operator",
    probe: {
      kind: "thrown-error",
      error: { status: 502, code: "OPERATOR_UNHEALTHY", message: "Operator health probe failed" },
      expectedRetryClass: "ambiguous",
    },
    expectedRecovery: "reconcile",
    rationale:
      "An unhealthy operator may still have actioned the request; its own report is not provider truth, so the controller re-reads rather than trusting the probe.",
  },
  {
    id: "lost-tunnel",
    label: "lost tunnel",
    probe: {
      kind: "thrown-error",
      error: { code: "ECONNRESET", message: "IAP tunnel closed mid-request" },
      expectedRetryClass: "ambiguous",
    },
    expectedRecovery: "reconcile",
    rationale:
      "A dropped transport carries no verdict at all. WI-1743793 was exactly this fault mislabelled as a credential failure; it must classify by transport, not by the message it happened to carry.",
  },
  {
    id: "stale-image",
    label: "stale image",
    probe: {
      kind: "thrown-error",
      error: { status: 404, code: "IMAGE_NOT_FOUND", message: "The referenced image no longer exists" },
      expectedRetryClass: "terminal",
    },
    expectedRecovery: "halt",
    rationale:
      "A retired image id cannot become valid by retrying; the operation must fail so the caller re-resolves the active image family.",
  },
  {
    id: "partial-destroy",
    label: "partial destroy",
    probe: {
      kind: "checkpoint-state",
      checkpoint: {
        logicalKey: "network",
        state: "failed",
        attempts: 1,
        retryClass: "ambiguous",
        error: "network delete returned no confirmation",
      },
    },
    expectedRecovery: "reconcile",
    rationale:
      "A teardown that deleted some resources and lost the answer on one must re-read that resource, never report success. The inverse of this — a settled census read as failure — was WI-1762411.",
  },
  {
    id: "snapshot-failure",
    label: "snapshot failure",
    probe: {
      kind: "thrown-error",
      error: { status: 500, code: "SNAPSHOT_FAILED", message: "Snapshot creation failed" },
      expectedRetryClass: "ambiguous",
    },
    expectedRecovery: "reconcile",
    rationale:
      "A failed snapshot may still have produced a billable partial artifact, so it is reconciled and accounted rather than abandoned.",
  },
  {
    id: "orphan-reaper-recovery",
    label: "orphan reaper recovery",
    probe: {
      kind: "checkpoint-state",
      checkpoint: {
        logicalKey: "disk",
        state: "compensating",
        attempts: 1,
      },
    },
    expectedRecovery: "compensate",
    rationale:
      "A row left mid-compensation is the orphan the reaper exists to collect; resuming compensation is what keeps the zero-orphan guarantee true across a controller restart.",
  },
];

/**
 * Resolve the recovery a class must reach, through the SAME functions the controllers use.
 *
 * This deliberately calls the real {@link workspaceHostProviderRetryClass} and
 * {@link workspaceHostRecoveryAction} rather than re-deriving the answer, so the registry cannot
 * drift into asserting a contract the shipped code does not implement.
 */
export function resolveWorkspaceHostChaosRecovery(
  chaosClass: WorkspaceHostChaosClass,
  maxApplyAttempts: number = WORKSPACE_HOST_CHAOS_MAX_APPLY_ATTEMPTS,
): { retryClass?: WorkspaceHostRetryClass; recovery: WorkspaceHostRecoveryAction } {
  if (chaosClass.probe.kind === "checkpoint-state") {
    return {
      recovery: workspaceHostRecoveryAction(chaosClass.probe.checkpoint, maxApplyAttempts),
    };
  }
  const retryClass = workspaceHostProviderRetryClass(chaosClass.probe.error);
  const checkpoint: WorkspaceHostResourceCheckpoint = {
    logicalKey: "vm",
    state: "failed",
    attempts: 1,
    retryClass,
  };
  return { retryClass, recovery: workspaceHostRecoveryAction(checkpoint, maxApplyAttempts) };
}
