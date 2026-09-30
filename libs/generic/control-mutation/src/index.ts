/**
 * @papercusp/control-mutation — the D-005 CONTROL-MUTATION harness.
 *
 * The shared cross-cutting wrapper every mutating control tool composes so that
 * UNSUPERVISED self-correction is safe: four guarantees on every mutation —
 *   1. a **dryRun preview** (what WOULD change, without applying),
 *   2. a **post-apply verify** (auto-revert on failure when `verifyMustPass`),
 *   3. an **audit record** (who / what / prev / next — via an INJECTED writer), and
 *   4. a **one-call revert** (re-apply the captured prior value).
 *
 * GENERIC BY DESIGN: the harness knows nothing about accounts, egress, money, or
 * AIMD — the consumer describes its mutation as a `ControlMutationSpec` (capturePrev
 * / apply / revertTo / verify / describe callbacks) and the audit WRITE is an
 * injected `writeAudit` port. So a papercusp gateway-control tool wires `writeAudit`
 * to the `harness_shared.audit_log` DB write; an oddsmith treasury control wires it
 * to its own audit surface — the same orchestration, zero domain or DB coupling.
 *
 * Pure logic + injected port → fully unit-testable with no I/O. Extracted from
 * papercusp's `gateway-control/control-harness.ts` so both papercusp and oddsmith
 * consume ONE implementation instead of diverging hand-copies.
 */

/** The result of a control mutation's post-apply verification. */
export interface ControlVerify {
  ok: boolean;
  detail?: string;
}

/**
 * A control mutation, described by its consumer. `T` is the consumer's value type
 * (the thing captured / applied / reverted — e.g. an account's egress config).
 */
export interface ControlMutationSpec<T> {
  /** Stable action name — the audit action + the dryRun/result label, e.g. 'gateway:set-aimd'. */
  action: string;
  /** Audit subject — what the mutation targets (an accountId, 'pool', a venue). */
  subject: string;
  /** Who is making the change (audit actor). Defaults to 'system:control'. */
  actor?: string;
  /** Read the CURRENT value — captured before apply, and the value `revert` replays. */
  capturePrev: () => Promise<T> | T;
  /** Perform the mutation (DB write + version-bump/reload). Returns the new effective value. */
  apply: () => Promise<T>;
  /** Re-apply a previously-captured value (the revert primitive). */
  revertTo: (prev: T) => Promise<void>;
  /** Existing audit id this mutation is reverting, when the consumer is a durable revert verb. */
  revertOf?: string;
  /** Post-apply proof the change took effect. Omit for a mutation with no external check. */
  verify?: (next: T) => Promise<ControlVerify> | ControlVerify;
  /** dryRun preview: describe what WOULD change, given the current value, WITHOUT applying. */
  describe?: (prev: T) => unknown;
}

export interface ControlOutcome<T> {
  action: string;
  subject: string;
  dryRun: boolean;
  /** Whether the mutation is in effect now (false on dryRun, or if an auto-revert undid it). */
  applied: boolean;
  /** The value before the mutation (and, on a successful apply, the revert target). */
  prev: T;
  /** The new effective value (absent on dryRun). */
  next?: T;
  /** Post-apply verification result (absent on dryRun or when the spec has no verify). */
  verify?: ControlVerify;
  /** The audit id this mutation wrote (absent on dryRun / when the audit write returned none). */
  auditId?: string;
  /** True when a failed verify (with verifyMustPass) auto-reverted the change. */
  reverted?: boolean;
  /** dryRun only: the consumer's `describe(prev)` output — what would change. */
  preview?: unknown;
  /** One-call revert of THIS mutation (re-applies prev + writes a `<action>:revert` audit row).
   *  Absent on dryRun or when the apply was auto-reverted. */
  revert?: () => Promise<ControlOutcome<T>>;
}

export interface RunControlOpts {
  /** Preview only — capture + describe, never apply/audit. */
  dryRun?: boolean;
  /** When the spec has a verify and it FAILS, auto-revert the change (fail-safe). Default true. */
  verifyMustPass?: boolean;
}

/** One audit record the harness emits to the injected `writeAudit` port. */
export interface ControlAuditRecord {
  action: string;
  subject: string;
  actor: string;
  prev: unknown;
  next: unknown;
  verify?: ControlVerify;
  reverted?: boolean;
  /** Set on a revert's own audit row — the audit id of the mutation being reverted. */
  revertOf?: string;
}

/**
 * The injected audit WRITE seam. Returns the new audit row id (or '' when the write
 * was best-effort-skipped). The consumer owns where it writes (a DB audit_log, an
 * MCP tool, an in-memory log). Best-effort by contract: a write failure must not
 * fail the control action — return '' rather than throwing.
 */
export type WriteControlAudit = (rec: ControlAuditRecord) => Promise<string> | string;

export interface ControlHarnessDeps {
  /** Injected audit writer. Absent ⇒ a local id is generated and no external row is written. */
  writeAudit?: WriteControlAudit;
  /** Injectable id generator for the no-writeAudit path (tests pin it). */
  newId?: () => string;
}

const DEFAULT_ACTOR = 'system:control';

function localAuditId(): string {
  return `ctl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Run a control mutation with the four D-005 guarantees: dryRun preview · apply ·
 * post-apply verify (auto-revert on failure when verifyMustPass) · audit · one-call revert.
 *
 * - dryRun: capture the current value + `describe(prev)`; never apply, never audit.
 * - apply:  capturePrev → apply → verify → (auto-revert on failed verify if verifyMustPass) →
 *           audit (prev+next) → return an outcome carrying a `revert()` that replays prev.
 *
 * Never silently swallows an `apply` throw — the consumer's apply owns its own atomicity;
 * a throw propagates so the tool reports the failure. The audit write is best-effort.
 */
export async function runControlMutation<T>(
  spec: ControlMutationSpec<T>,
  opts: RunControlOpts = {},
  deps: ControlHarnessDeps = {},
): Promise<ControlOutcome<T>> {
  const actor = spec.actor || DEFAULT_ACTOR;
  const newId = deps.newId ?? localAuditId;
  // No audit port wired (a paper/test rig) → record a local id, no external write.
  const writeAudit: WriteControlAudit = deps.writeAudit ?? (() => newId());
  const verifyMustPass = opts.verifyMustPass ?? true;

  const prev = await spec.capturePrev();

  if (opts.dryRun) {
    return {
      action: spec.action,
      subject: spec.subject,
      dryRun: true,
      applied: false,
      prev,
      preview: spec.describe ? spec.describe(prev) : undefined,
    };
  }

  const next = await spec.apply();
  const verify = spec.verify ? await spec.verify(next) : undefined;

  // Fail-safe: a mutation whose post-apply verify fails is auto-reverted when
  // verifyMustPass — a live change that didn't demonstrably take effect never lingers.
  let reverted = false;
  if (verify && !verify.ok && verifyMustPass) {
    await spec.revertTo(prev);
    reverted = true;
  }

  const recordedId = await writeAudit({
    action: spec.action,
    subject: spec.subject,
    actor,
    prev,
    next,
    verify,
    reverted,
    revertOf: spec.revertOf,
  });

  const outcome: ControlOutcome<T> = {
    action: spec.action,
    subject: spec.subject,
    dryRun: false,
    applied: !reverted,
    prev,
    next,
    verify,
    auditId: recordedId || undefined,
    reverted: reverted || undefined,
  };

  // One-call revert — only when the change is currently in effect (not already auto-reverted).
  if (!reverted) {
    outcome.revert = async (): Promise<ControlOutcome<T>> => {
      await spec.revertTo(prev);
      const revId = await writeAudit({
        action: `${spec.action}:revert`,
        subject: spec.subject,
        actor,
        prev: next, // before the revert, the value was `next`…
        next: prev, // …after the revert, it is `prev` again
        revertOf: recordedId || undefined,
      });
      return {
        action: `${spec.action}:revert`,
        subject: spec.subject,
        dryRun: false,
        applied: true,
        prev: next,
        next: prev,
        auditId: revId || undefined,
        reverted: true,
      };
    };
  }

  return outcome;
}
