/** Shared activation-audit gate used by every plan lifecycle entry door. */

type Tx = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

import { RUBRIC_TEMPLATE_NAME } from './rubric-template';
import { parsePlan } from './parser';

export const ACTIVATION_PLAN_STATUSES = ['ready', 'active'] as const;

export function isActivationPlanStatus(status: string | null | undefined): boolean {
  return status === 'ready' || status === 'active';
}

/** True only for the transition that ENTERS ready/active, not a later edit. */
export function entersActivationPlanStatus(
  before: string | null | undefined,
  after: string | null | undefined,
): boolean {
  return !isActivationPlanStatus(before) && isActivationPlanStatus(after);
}

/**
 * Whether a plan template is exempt from the conversation-audit activation gate.
 *
 * Rubric-template plans are authored through the rubric write path, whose structured
 * document is the source of truth and whose activation is part of proposing/ratifying
 * the rubric itself. Requiring a separate conversation audit would reject every
 * rubric activation and leave the caller with a misleading post-write lookup error.
 * Keep this predicate here so every plan write door shares the same exemption.
 */
export function isActivationAuditExemptTemplate(template: string | null | undefined): boolean {
  return template === RUBRIC_TEMPLATE_NAME;
}

/** The stored reverse-coverage verdict, read defensively from the activation JSON. */
function itemProvenanceCheckOf(
  activation: unknown,
): { enforced: boolean; items: Record<string, string> } | null {
  const parsed = typeof activation === 'string' ? safeJson(activation) : activation;
  const check = (parsed as { itemProvenanceCheck?: unknown } | null)?.itemProvenanceCheck as
    | { enforced?: unknown; items?: unknown }
    | undefined;
  if (!check || typeof check !== 'object' || check.enforced !== true) return null;
  const items = check.items && typeof check.items === 'object' ? (check.items as Record<string, string>) : {};
  return { enforced: true, items };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface ConversationActivationGateVerdict {
  satisfied: boolean;
  code?: 'conversation_audit_required' | 'item_provenance_unresolved';
  message?: string;
  auditSeq?: number;
  /** P-003: current items the enforced audit did not resolve. */
  unresolvedItems?: string[];
  /** Existing ready/active plan with no audit: activated before this gate could enforce. */
  grandfathered?: boolean;
}

export function conversationAuditRequiredMessage(planSlug: string): string {
  return (
    `Plan '${planSlug}' cannot enter ready/active or start until it has a completed conversation audit. ` +
    `Read the full source conversation with sessions:search/read, then call plans:audit { phase:'activation', ` +
    `slug:'${planSlug}', sourceRanges:[...], mappings:[...] }; repair every omission/open mapping and retry.`
  );
}

export async function evaluateConversationActivationGate(
  tx: Tx,
  scope: { workspaceId: string; harnessSlug: string; planSlug: string },
): Promise<ConversationActivationGateVerdict> {
  const rows = await tx<Array<{ audit_seq: number; activation: unknown }>>`
    SELECT audit_seq, activation
      FROM harness_shared.plan_audits
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${scope.planSlug}
       AND audit_kind = 'activation'
     ORDER BY audit_seq DESC
     LIMIT 1`;
  const row = rows[0];
  if (row) {
    // plan-item-provenance-2026-09-29 P-003: an ENFORCED audit resolved a specific
    // item set. An item added (or un-dropped) after it has no recorded provenance, so
    // the lifecycle doors refuse it until a re-audit resolves it. Unenforced (legacy)
    // audits keep passing — they were recorded with the gap as a warning.
    const check = itemProvenanceCheckOf(row.activation);
    if (check?.enforced) {
      const planRows = await tx<Array<{ content: string }>>`
        SELECT content
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND plan_slug = ${scope.planSlug}
         LIMIT 1`;
      const unresolved = planRows[0]?.content
        ? parsePlan(planRows[0].content, { filePath: `${scope.planSlug}.md` }).items
            .filter((item) => item.storedStatus !== 'dropped')
            .map((item) => item.id)
            .filter((id) => !check.items[id] || check.items[id] === 'unresolved')
        : [];
      if (unresolved.length > 0) {
        return {
          satisfied: false,
          code: 'item_provenance_unresolved',
          auditSeq: Number(row.audit_seq),
          unresolvedItems: unresolved,
          message:
            `Plan '${scope.planSlug}' has item(s) with no recorded provenance since activation audit #${row.audit_seq}: ` +
            `${unresolved.join(', ')}. Re-run plans:audit { phase:'activation' } citing the owner turn for each, or ` +
            'declare it in itemProvenance (derived / agent-added with a reason).',
        };
      }
    }
    return { satisfied: true, auditSeq: Number(row.audit_seq) };
  }

  // EI-21514925652793324: recorder + enforcer can deploy together after plans
  // were already activated on an older operator. A plan already sitting in
  // ready/active when this check runs cannot retroactively create the audit that
  // preceded its transition. Grandfather that EXISTING state only. A fresh
  // draft→ready/active write is evaluated while the stored row is still draft,
  // so it continues to refuse until plans:audit records the activation audit.
  const planRows = await tx<Array<{ content: string }>>`
    SELECT content
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${scope.planSlug}
     LIMIT 1`;
  const storedStatus = planRows[0]?.content
    ? parsePlan(planRows[0].content, { filePath: `${scope.planSlug}.md` }).frontmatter.status
    : null;
  if (isActivationPlanStatus(storedStatus)) {
    const message =
      `Plan '${scope.planSlug}' is already ${storedStatus} with no activation audit, so it is grandfathered ` +
      'instead of being retroactively blocked. Record plans:audit { phase:\'activation\' } on its next material plan edit.';
    console.warn(`[plan-activation-gate] ${message}`);
    return { satisfied: true, grandfathered: true, message };
  }
  return {
        satisfied: false,
        code: 'conversation_audit_required',
        message: conversationAuditRequiredMessage(scope.planSlug),
      };
}

export type ActivationGateRefusalCode = NonNullable<ConversationActivationGateVerdict['code']>;

/** The non-throwing refusal withPlanLock returns when a lifecycle door fails the
 *  activation gate. It carries the gate's OWN verdict — a missing conversation audit
 *  and an item with no recorded provenance (plan-item-provenance-2026-09-29 P-003)
 *  need different repairs, so the door must not collapse one into the other. */
export interface ActivationGateRefusalValue {
  ok: false;
  code: ActivationGateRefusalCode;
  message: string;
  unresolvedItems?: string[];
}

export function activationGateRefusalValue(
  planSlug: string,
  verdict: ConversationActivationGateVerdict,
): ActivationGateRefusalValue {
  return {
    ok: false,
    code: verdict.code ?? 'conversation_audit_required',
    message: verdict.message ?? conversationAuditRequiredMessage(planSlug),
    ...(verdict.unresolvedItems?.length ? { unresolvedItems: verdict.unresolvedItems } : {}),
  };
}

const ACTIVATION_GATE_REFUSAL_CODES: ReadonlySet<string> = new Set<ActivationGateRefusalCode>([
  'conversation_audit_required',
  'item_provenance_unresolved',
]);

/** Typed guard for the non-throwing refusal returned by withPlanLock. */
export function isActivationGateRefusalValue(value: unknown): value is ActivationGateRefusalValue {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ActivationGateRefusalValue>;
  return (
    candidate.ok === false &&
    typeof candidate.code === 'string' &&
    ACTIVATION_GATE_REFUSAL_CODES.has(candidate.code) &&
    typeof candidate.message === 'string'
  );
}

export function domainFailureMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}
