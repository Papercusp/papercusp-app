/**
 * The P-318 `desktop-session.customer-acceptance` release receipt.
 *
 * Customer acceptance is a successful, authenticated hosted-desktop controller takeover on the
 * active customer workspace, while that workspace's release-bound host is running. The audit row
 * is written only after the controller credential has opened the desktop socket. Initialization
 * readiness and a registry row alone do not establish this outcome (D-410).
 */
import { getOrgPg } from '@papercusp/db-org';
import { desktopAuditAction, desktopAuditSubject } from '../desktop/desktop-audit';
import {
  appendTaskReleaseReceipt,
  getTask,
  taskReleaseJournalFromDetail,
  type TaskReleaseJournal,
} from '../task-manager/store';
import type { Sql } from 'postgres';
import type { ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal.mjs';
import {
  openWorkspaceHostReleaseRecorder,
  resolveWorkspaceHostReleaseBinding,
  WorkspaceHostReleaseBindingError,
  type WorkspaceHostReleaseStage,
} from './release-stage-receipt';
import { readWorkspaceHostRuntimeRelease } from './soak-store';

export const WORKSPACE_HOST_CUSTOMER_ACCEPTANCE_STAGE = 'desktop-session.customer-acceptance';
export const WORKSPACE_HOST_CUSTOMER_ACCEPTANCE_EVIDENCE_VERSION = 'hosted-controller-takeover-v1';

const TASK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export class WorkspaceHostCustomerAcceptanceError extends Error {
  constructor(
    readonly reason:
      | 'invalid-input'
      | 'customer-binding-inactive'
      | 'host-not-running'
      | 'takeover-not-found'
      | 'release-prerequisite-missing'
      | 'takeover-predates-release',
    detail: string,
  ) {
    super(detail);
    this.name = 'WorkspaceHostCustomerAcceptanceError';
  }
}

export interface WorkspaceHostCustomerAcceptanceInput {
  workspaceId: string;
  hostId: string;
  customerWorkspaceId: string;
  hostedSessionId: string;
  channelId: string;
  releaseTaskId: string;
  /** Dependency injection for tests. */
  sql?: Sql;
  ledger?: ReleaseTaskLedger;
  readHostRuntimeRelease?: (workspaceId: string, hostId: string) => Promise<unknown>;
}

export interface WorkspaceHostCustomerAcceptanceReceipt {
  outcome: 'committed';
  stage: typeof WORKSPACE_HOST_CUSTOMER_ACCEPTANCE_STAGE;
  releaseTaskId: string;
  bundleSha256: string;
  auditEventId: string;
  evidenceRefs: string[];
}

interface ActiveHostRow {
  desired_state: string;
  observed_state: string;
  observed_revision: number | string;
  desired_revision: number | string;
  organization_id: string;
}

interface HostedTakeoverAuditRow {
  id: string;
  ts: number | string;
  actor: string;
  action: string;
  subject: string;
  details: unknown;
}

function defaultLedger(): ReleaseTaskLedger {
  return { getTask, taskReleaseJournalFromDetail, appendTaskReleaseReceipt };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

export function workspaceHostCustomerAcceptanceStage(bundleSha256: string): WorkspaceHostReleaseStage {
  return {
    stage: WORKSPACE_HOST_CUSTOMER_ACCEPTANCE_STAGE,
    identity: {
      bundleSha256,
      evidenceSource: WORKSPACE_HOST_CUSTOMER_ACCEPTANCE_EVIDENCE_VERSION,
    },
  };
}

function committedReceipt(
  journal: TaskReleaseJournal,
  matches: (stage: string) => boolean,
): TaskReleaseJournal['receipts'][number] | undefined {
  return journal.receipts.find((receipt) => receipt.state === 'committed' && matches(receipt.stage));
}

function bundleRefs(receipt: TaskReleaseJournal['receipts'][number]): string[] {
  return receipt.evidenceRefs.filter((ref) => /^(?:bundle:sha256|provider:bundle):[0-9a-f]{64}$/.test(ref));
}

function prerequisiteReceipts(
  journal: TaskReleaseJournal,
  bundleSha256: string,
): TaskReleaseJournal['receipts'][number][] {
  const build = committedReceipt(journal, (stage) => stage.startsWith('release.build.'));
  const publication = committedReceipt(journal, (stage) => stage === 'publish.finalize');
  const rootBootstrap = committedReceipt(journal, (stage) =>
    ['workspace.root-bootstrap', 'root.bootstrap'].includes(stage),
  );
  const fixedAgentInitialization = committedReceipt(journal, (stage) =>
    ['workspace.fixed-agent-initialization', 'fixed-agent.initialization'].includes(stage),
  );
  const required = [build, publication, rootBootstrap, fixedAgentInitialization];
  if (required.some((receipt) => !receipt)) return [];
  const settled = required as Array<NonNullable<(typeof required)[number]>>;
  if (
    !settled.every((receipt) =>
      bundleRefs(receipt).every((ref) => ref.endsWith(bundleSha256)),
    ) ||
    !bundleRefs(build!).some((ref) => ref === `bundle:sha256:${bundleSha256}`) ||
    !bundleRefs(publication!).some(
      (ref) => ref === `bundle:sha256:${bundleSha256}` || ref === `provider:bundle:${bundleSha256}`,
    )
  ) {
    return [];
  }
  return settled;
}

/**
 * Record the live customer desktop event for the exact release task. The caller supplies the
 * session/channel selectors from the user flow; this function independently reads the authenticated
 * hosted takeover audit, active customer binding, host state, and the release journal prerequisites.
 */
export async function recordWorkspaceHostCustomerAcceptance(
  input: WorkspaceHostCustomerAcceptanceInput,
): Promise<WorkspaceHostCustomerAcceptanceReceipt> {
  const { workspaceId, hostId, customerWorkspaceId, hostedSessionId, channelId, releaseTaskId } = input;
  if (
    ![workspaceId, hostId, customerWorkspaceId, hostedSessionId, channelId].every(nonEmpty) ||
    !TASK_ID.test(releaseTaskId)
  ) {
    throw new WorkspaceHostCustomerAcceptanceError('invalid-input', 'Customer-acceptance identity is malformed');
  }

  const sql = input.sql ?? getOrgPg().sql;
  const hostRows = await sql<ActiveHostRow[]>`
    SELECT host.desired_state, host.observed_state, host.observed_revision, host.desired_revision,
           customer.organization_id
      FROM harness_shared.workspace_hosts AS host
      JOIN harness_shared.customer_workspaces AS customer
        ON customer.workspace_id = host.workspace_id
       AND customer.workspace_host_id = host.id
     WHERE host.workspace_id = ${workspaceId}
       AND host.id = ${hostId}
       AND customer.id = ${customerWorkspaceId}
       AND customer.state = 'active'
       AND customer.deleted_at IS NULL
     LIMIT 1
  `;
  const host = hostRows[0];
  if (!host) {
    throw new WorkspaceHostCustomerAcceptanceError(
      'customer-binding-inactive',
      'No active customer workspace binding connects this customer workspace to the host',
    );
  }
  if (
    host.desired_state !== 'running' ||
    host.observed_state !== 'running' ||
    Number(host.observed_revision) !== Number(host.desired_revision)
  ) {
    throw new WorkspaceHostCustomerAcceptanceError(
      'host-not-running',
      'Customer acceptance requires the target host to be observed running at its desired revision',
    );
  }

  const action = desktopAuditAction('takeover', 'started');
  const subject = desktopAuditSubject('hosted', hostId, channelId);
  const auditRows = await sql<HostedTakeoverAuditRow[]>`
    SELECT id, ts, actor, action, subject, details
      FROM harness_shared.audit_log
     WHERE workspace_id = ${workspaceId}
       AND action = ${action}
       AND subject = ${subject}
       AND details ->> 'target' = 'hosted'
       AND details ->> 'hostId' = ${hostId}
       AND details ->> 'customerWorkspaceId' = ${customerWorkspaceId}
       AND details ->> 'organizationId' = ${host.organization_id}
       AND details ->> 'hostedSessionId' = ${hostedSessionId}
       AND details ->> 'channelId' = ${channelId}
     ORDER BY ts DESC
     LIMIT 1
  `;
  const audit = auditRows[0];
  const details = asRecord(audit?.details);
  const detail = typeof details?.detail === 'string' ? details.detail : '';
  const desktopSessionId = detail.startsWith('desktop=') ? detail.slice('desktop='.length).trim() : '';
  if (
    !audit ||
    audit.action !== action ||
    audit.subject !== subject ||
    !details ||
    details.target !== 'hosted' ||
    details.hostId !== hostId ||
    details.customerWorkspaceId !== customerWorkspaceId ||
    details.organizationId !== host.organization_id ||
    details.hostedSessionId !== hostedSessionId ||
    details.channelId !== channelId ||
    typeof details.userId !== 'string' ||
    details.userId.trim() === '' ||
    audit.actor !== details.userId ||
    !desktopSessionId
  ) {
    throw new WorkspaceHostCustomerAcceptanceError(
      'takeover-not-found',
      'No matching authenticated hosted-desktop controller takeover was recorded for this customer, host, session, and channel',
    );
  }

  const ledger = input.ledger ?? defaultLedger();
  const task = await ledger.getTask(releaseTaskId);
  if (!task) {
    throw new WorkspaceHostReleaseBindingError('task-not-found', WORKSPACE_HOST_CUSTOMER_ACCEPTANCE_STAGE, 'release task not found');
  }
  const journal = ledger.taskReleaseJournalFromDetail(task.detail);
  if (!journal) {
    throw new WorkspaceHostReleaseBindingError(
      'journal-missing',
      WORKSPACE_HOST_CUSTOMER_ACCEPTANCE_STAGE,
      'release task has no release journal',
    );
  }

  const readRuntime = input.readHostRuntimeRelease ?? readWorkspaceHostRuntimeRelease;
  const stageRuntime = await readRuntime(workspaceId, hostId);
  const binding = await resolveWorkspaceHostReleaseBinding({
    releaseTaskId,
    stage: WORKSPACE_HOST_CUSTOMER_ACCEPTANCE_STAGE,
    hostRuntimeRelease: stageRuntime,
    ledger,
  });
  const prerequisites = prerequisiteReceipts(journal, binding.bundleSha256);
  if (prerequisites.length !== 4) {
    throw new WorkspaceHostCustomerAcceptanceError(
      'release-prerequisite-missing',
      'Customer acceptance requires committed build, publication, root-bootstrap, and fixed-agent initialization receipts for this bundle',
    );
  }
  const eventAt = Number(audit.ts);
  const latestPrerequisiteAt = Math.max(...prerequisites.map((receipt) => Date.parse(receipt.recordedAt)));
  if (
    !Number.isFinite(eventAt) ||
    !Number.isFinite(latestPrerequisiteAt) ||
    eventAt < latestPrerequisiteAt
  ) {
    throw new WorkspaceHostCustomerAcceptanceError(
      'takeover-predates-release',
      'The hosted-desktop takeover must occur after this release task completed its publication and host initialization prerequisites',
    );
  }

  const recorder = await openWorkspaceHostReleaseRecorder({
    releaseTaskId,
    workspaceId,
    hostId,
    stages: { customerAcceptance: workspaceHostCustomerAcceptanceStage(binding.bundleSha256) },
    runRef: `hosted-desktop-takeover:${audit.id}`,
    ledger,
    readHostRuntimeRelease: async () => stageRuntime,
  });
  await recorder.begin('customerAcceptance');
  const evidenceRefs = [
    `hosted-desktop-takeover:${audit.id}`,
    `hosted-session:${hostedSessionId}`,
    `hosted-channel:${channelId}`,
    `desktop-session:${desktopSessionId}`,
    `customer-workspace:${customerWorkspaceId}`,
    `customer-actor:${audit.actor}`,
    `host:${hostId}`,
    `bundle:sha256:${recorder.binding.bundleSha256}`,
  ];
  await recorder.settle('customerAcceptance', 'committed', evidenceRefs);
  return {
    outcome: 'committed',
    stage: WORKSPACE_HOST_CUSTOMER_ACCEPTANCE_STAGE,
    releaseTaskId,
    bundleSha256: recorder.binding.bundleSha256,
    auditEventId: audit.id,
    evidenceRefs,
  };
}
