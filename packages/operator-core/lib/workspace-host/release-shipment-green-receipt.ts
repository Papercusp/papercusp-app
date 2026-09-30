import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import {
  deriveWorkspaceHostCanonicalArtifactUrls,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';
import type { ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal.mjs';
import {
  appendTaskReleaseReceipt,
  getTask,
  taskReleaseJournalFromDetail,
  type TaskReleaseJournal,
} from '../task-manager/store';
import { gitPipelinePosition, type PipelinePosition } from '../git-pipeline-position';
import { BYOC_RELEASE_MILESTONES, projectByocReleaseMilestones } from '../byoc-release-carry';
import {
  openWorkspaceHostReleaseRecorder,
  releaseJournalBundleDigests,
  resolveWorkspaceHostReleaseBinding,
  type WorkspaceHostReleaseStage,
} from './release-stage-receipt';
import { readWorkspaceHostRuntimeRelease } from './soak-store';
import {
  WORKSPACE_HOST_PUBLICATION_KIND,
  WORKSPACE_HOST_PUBLICATION_SCHEMA_VERSION,
  WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME,
  WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME,
  workspaceHostPublicationManifestFailures,
  type WorkspaceHostPublicationManifest,
} from './publication-manifest';

export const WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE = 'release.shipment.green';
export const WORKSPACE_HOST_RELEASE_SHIPMENT_CONTRACT = 'workspace-host-release-shipment-green-v1';

const TASK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 30_000;
const BUNDLE_TIMEOUT_MS = 300_000;
const RELEASE_SERVING_PATH = 'apps/operator/lib/release/deploy.ts';

export type WorkspaceHostReleaseShipmentFailure =
  | 'invalid-input'
  | 'release-task-not-found'
  | 'release-journal-missing';

export class WorkspaceHostReleaseShipmentError extends Error {
  constructor(readonly reason: WorkspaceHostReleaseShipmentFailure, detail: string) {
    super(detail);
    this.name = 'WorkspaceHostReleaseShipmentError';
  }
}

export interface WorkspaceHostReleaseShipmentReceipt {
  outcome: 'committed' | 'refused';
  stage: typeof WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE;
  releaseTaskId: string;
  /** Null for a first shipment whose manifest declares no rollback edge (D-437). */
  rollbackReleaseTaskId: string | null;
  hostId: string;
  bundleSha256: string;
  sourceSha: string;
  evidenceRefs: string[];
}

export interface WorkspaceHostReleaseShipmentInput {
  workspaceId: string;
  hostId: string;
  releaseTaskId: string;
  /**
   * The release task whose published image is the current manifest's declared rollback target.
   * Required exactly when that manifest declares `lifecycle.rollbackTarget`; omitted for the first
   * green shipment in a workspace, whose manifest has no earlier green-shipped release to name (D-437).
   */
  rollbackReleaseTaskId?: string | null;
  /**
   * Whether any OTHER release in this release task's workspace/harness scope has a committed
   * `release.shipment.green` receipt. Guards the no-declared-target branch: once anything has
   * shipped green, a manifest that omits its rollback edge is refused again.
   */
  hasPriorGreenShipment?: (releaseTaskId: string) => Promise<boolean>;
  ledger?: ReleaseTaskLedger;
  readHostRuntimeRelease?: (workspaceId: string, hostId: string) => Promise<unknown>;
  readPipelinePosition?: (sourceSha: string) => Promise<PipelinePosition>;
  fetchArtifact?: typeof fetch;
}

interface ShipmentBundleMeasurement {
  manifest: WorkspaceHostPublicationManifest;
  manifestUrl: string;
  bundleUrl: string;
  bundleSha256: string;
  bundleBytes: number;
}

type ShipmentCheck =
  | { ok: true; measurement: ShipmentBundleMeasurement }
  | { ok: false; evidenceRefs: string[] };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function taskScope(task: unknown): { workspaceId: string | null; harnessSlug: string | null; taskClass: string | null } {
  const row = asRecord(task);
  return {
    workspaceId: typeof row?.workspaceId === 'string' ? row.workspaceId : null,
    harnessSlug: typeof row?.harnessSlug === 'string' ? row.harnessSlug : null,
    taskClass: typeof row?.class === 'string' ? row.class : null,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function defaultLedger(): ReleaseTaskLedger {
  return { getTask, taskReleaseJournalFromDetail, appendTaskReleaseReceipt };
}

/**
 * Whether any OTHER deploy task in this release task's workspace + harness + launcher + artifact
 * kind holds a committed receipt for `stage`. A pure existence census (no freshness window, no
 * input-hash match): it tells a genuine first green shipment, which can have no rollback edge yet,
 * from a publisher that omitted one (D-437).
 */
export async function hasCommittedReleaseStageInScope(
  currentTaskId: string,
  stage: string,
  inject?: Sql,
): Promise<boolean> {
  const sql = inject ?? getOrgPg().sql;
  const rows = await sql<Array<{ found: boolean }>>`
    SELECT EXISTS (
      SELECT 1
        FROM harness_shared.task_ledger current_task
        JOIN harness_shared.task_ledger candidate
          ON candidate.workspace_id = current_task.workspace_id
         AND candidate.harness_slug IS NOT DISTINCT FROM current_task.harness_slug
         AND candidate.task_id <> current_task.task_id
         AND candidate.class = 'deploy'
         AND candidate.launched_by IS NOT DISTINCT FROM current_task.launched_by
         AND candidate.detail #>> '{release,artifactIdentity,kind}'
               IS NOT DISTINCT FROM current_task.detail #>> '{release,artifactIdentity,kind}'
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(candidate.detail #> '{release,receipts}') = 'array'
              THEN candidate.detail #> '{release,receipts}'
            ELSE '[]'::jsonb
          END
        ) AS prior(receipt)
       WHERE current_task.task_id = ${currentTaskId}
         AND prior.receipt ->> 'stage' = ${stage}
         AND prior.receipt ->> 'state' = 'committed'
    ) AS found
  `;
  return rows[0]?.found === true;
}

/** The release a new cut names as its rollback edge (D-437): the last one that shipped green. */
export interface GreenShippedRelease {
  taskId: string;
  version: string;
}

/**
 * The most recent OTHER deploy task in this release task's workspace + harness + launcher +
 * artifact kind whose `release.shipment.green` receipt committed, ordered by that receipt's
 * `recordedAt`. Same scope as {@link hasCommittedReleaseStageInScope}, so the publisher's rollback
 * edge and the shipment receipt's first-shipment check can never disagree about what shipped.
 * Returns null when nothing in scope has shipped green (the first shipment has no rollback edge).
 */
export async function latestGreenShippedReleaseInScope(
  currentTaskId: string,
  inject?: Sql,
): Promise<GreenShippedRelease | null> {
  const sql = inject ?? getOrgPg().sql;
  const rows = await sql<Array<{ taskId: string; version: string | null }>>`
    SELECT candidate.task_id AS "taskId",
           candidate.detail #>> '{release,artifactIdentity,version}' AS version
      FROM harness_shared.task_ledger current_task
      JOIN harness_shared.task_ledger candidate
        ON candidate.workspace_id = current_task.workspace_id
       AND candidate.harness_slug IS NOT DISTINCT FROM current_task.harness_slug
       AND candidate.task_id <> current_task.task_id
       AND candidate.class = 'deploy'
       AND candidate.launched_by IS NOT DISTINCT FROM current_task.launched_by
       AND candidate.detail #>> '{release,artifactIdentity,kind}'
             IS NOT DISTINCT FROM current_task.detail #>> '{release,artifactIdentity,kind}'
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(candidate.detail #> '{release,receipts}') = 'array'
            THEN candidate.detail #> '{release,receipts}'
          ELSE '[]'::jsonb
        END
      ) AS prior(receipt)
     WHERE current_task.task_id = ${currentTaskId}
       AND prior.receipt ->> 'stage' = ${WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE}
       AND prior.receipt ->> 'state' = 'committed'
     ORDER BY prior.receipt ->> 'recordedAt' DESC NULLS LAST, candidate.task_id DESC
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  if (typeof row.version !== 'string' || row.version.length === 0) {
    // A green shipment whose task names no version cannot be pinned; publishing without an edge
    // here would make the next shipment refuse with rollback-target-undeclared, so fail loudly now.
    throw new Error(`green-shipped release task ${row.taskId} records no artifactIdentity.version`);
  }
  return { taskId: row.taskId, version: row.version };
}

export function workspaceHostReleaseShipmentStage(
  sourceSha: string,
  rollbackReleaseTaskId: string | null,
): WorkspaceHostReleaseStage {
  return {
    stage: WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE,
    identity: {
      shipmentContract: WORKSPACE_HOST_RELEASE_SHIPMENT_CONTRACT,
      sourceSha,
      rollbackReleaseTaskId: rollbackReleaseTaskId ?? NO_ROLLBACK_RELEASE,
    },
  };
}

/** Identity/run-ref token for a shipment with no rollback release (first green shipment, D-437). */
const NO_ROLLBACK_RELEASE = 'none';

function exactBundleDigests(journal: TaskReleaseJournal): string[] {
  return releaseJournalBundleDigests(journal).filter((digest) => DIGEST.test(digest));
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; evidenceRef: string }> {
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, evidenceRef: 'shipment-failed:manifest-body-missing' };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, evidenceRef: 'shipment-failed:manifest-too-large' };
      }
      chunks.push(next.value);
    }
  } catch (error) {
    return { ok: false, evidenceRef: 'shipment-failed:manifest-read:' + errorName(error) };
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(body) };
  } catch {
    return { ok: false, evidenceRef: 'shipment-failed:manifest-encoding-invalid' };
  }
}

async function readManifest(
  fetchArtifact: typeof fetch,
  expectedBundleSha256: string,
): Promise<
  | { ok: true; manifest: WorkspaceHostPublicationManifest; manifestUrl: string; bundleUrl: string }
  | { ok: false; evidenceRef: string }
> {
  let urls: ReturnType<typeof deriveWorkspaceHostCanonicalArtifactUrls>;
  try {
    urls = deriveWorkspaceHostCanonicalArtifactUrls(expectedBundleSha256);
  } catch {
    return { ok: false, evidenceRef: 'shipment-failed:manifest-url:invalid-bundle-digest' };
  }

  let response: Response;
  try {
    response = await fetchArtifact(urls.manifestUrl, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
  } catch (error) {
    return { ok: false, evidenceRef: 'shipment-failed:manifest-fetch:' + errorName(error) };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, evidenceRef: 'shipment-failed:manifest-http-status:' + response.status };
  }

  const textResult = await readBoundedText(response, MAX_MANIFEST_BYTES);
  if (!textResult.ok) return { ok: false, evidenceRef: textResult.evidenceRef };

  let raw: unknown;
  try {
    raw = JSON.parse(textResult.text);
  } catch {
    return { ok: false, evidenceRef: 'shipment-failed:manifest-json-invalid' };
  }
  const envelope = asRecord(raw);
  const artifact = asRecord(envelope?.artifact);
  const release = asRecord(artifact?.release);
  const files = asRecord(envelope?.files);
  const bundle = asRecord(files?.bundle);
  const signature = asRecord(files?.signature);
  const trustReport = asRecord(envelope?.trustReport);
  if (
    envelope?.schemaVersion !== WORKSPACE_HOST_PUBLICATION_SCHEMA_VERSION ||
    envelope?.kind !== WORKSPACE_HOST_PUBLICATION_KIND ||
    !artifact ||
    !release ||
    !bundle ||
    !signature ||
    !trustReport ||
    bundle.name !== WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME ||
    signature.name !== WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME ||
    bundle.sha256 !== expectedBundleSha256 ||
    release.bundleSha256 !== expectedBundleSha256
  ) {
    return { ok: false, evidenceRef: 'shipment-failed:manifest-contract-mismatch' };
  }

  const manifest = raw as WorkspaceHostPublicationManifest;
  let failures: ReturnType<typeof workspaceHostPublicationManifestFailures>;
  try {
    failures = workspaceHostPublicationManifestFailures({
      artifact: manifest.artifact,
      trustReport: manifest.trustReport,
      bundle: { sha256: manifest.files.bundle.sha256, bytes: manifest.files.bundle.sizeBytes },
      signature: { sha256: manifest.files.signature.sha256, bytes: manifest.files.signature.sizeBytes },
    });
  } catch (error) {
    return { ok: false, evidenceRef: 'shipment-failed:manifest-validation:' + errorName(error) };
  }
  if (failures.length > 0) {
    return {
      ok: false,
      evidenceRef: 'shipment-failed:manifest-validation:' + failures.map((failure) => failure.code).join(','),
    };
  }
  if (
    !Number.isSafeInteger(manifest.files.bundle.sizeBytes) ||
    manifest.files.bundle.sizeBytes <= 0 ||
    manifest.artifact.release.bundleUrl !== urls.bundleUrl
  ) {
    return { ok: false, evidenceRef: 'shipment-failed:manifest-bundle-descriptor-invalid' };
  }
  return { ok: true, manifest, manifestUrl: urls.manifestUrl, bundleUrl: urls.bundleUrl };
}

async function hashBundleResponse(
  response: Response,
  expectedBytes: number,
): Promise<{ ok: true; sha256: string; bytes: number } | { ok: false; evidenceRef: string }> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, evidenceRef: 'shipment-failed:bundle-http-status:' + response.status };
  }
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, evidenceRef: 'shipment-failed:bundle-body-missing' };
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > expectedBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, evidenceRef: 'shipment-failed:bundle-exceeds-manifest-size' };
      }
      hash.update(next.value);
    }
  } catch (error) {
    return { ok: false, evidenceRef: 'shipment-failed:bundle-read:' + errorName(error) };
  }
  if (bytes !== expectedBytes) {
    return { ok: false, evidenceRef: 'shipment-failed:bundle-size-mismatch:' + bytes + '/' + expectedBytes };
  }
  return { ok: true, sha256: hash.digest('hex'), bytes };
}

async function measurePublishedBundle(
  fetchArtifact: typeof fetch,
  expectedBundleSha256: string,
): Promise<ShipmentCheck> {
  const manifestResult = await readManifest(fetchArtifact, expectedBundleSha256);
  if (!manifestResult.ok) return { ok: false, evidenceRefs: [manifestResult.evidenceRef] };

  let bundleResponse: Response;
  try {
    bundleResponse = await fetchArtifact(manifestResult.bundleUrl, { signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS) });
  } catch (error) {
    return { ok: false, evidenceRefs: ['shipment-failed:bundle-fetch:' + errorName(error)] };
  }
  const hashed = await hashBundleResponse(bundleResponse, manifestResult.manifest.files.bundle.sizeBytes);
  if (!hashed.ok) return { ok: false, evidenceRefs: [hashed.evidenceRef] };
  if (hashed.sha256 !== expectedBundleSha256) {
    return {
      ok: false,
      evidenceRefs: [
        'shipment-failed:bundle-digest-mismatch:expected-' + expectedBundleSha256 + ':actual-' + hashed.sha256,
      ],
    };
  }
  return {
    ok: true,
    measurement: {
      manifest: manifestResult.manifest,
      manifestUrl: manifestResult.manifestUrl,
      bundleUrl: manifestResult.bundleUrl,
      bundleSha256: hashed.sha256,
      bundleBytes: hashed.bytes,
    },
  };
}

function prefixCompatibleSha(a: string | null, b: string | null): boolean {
  const left = a?.toLowerCase() ?? '';
  const right = b?.toLowerCase() ?? '';
  if (!/^[0-9a-f]{7,64}$/.test(left) || !/^[0-9a-f]{7,64}$/.test(right)) return false;
  return left.startsWith(right) || right.startsWith(left);
}

function pipelineEvidence(position: PipelinePosition, sourceSha: string): { evidenceRefs: string[]; failures: string[] } {
  const serving = position.serving;
  const unknown = new Set(position.positionsUnknown);
  const failures: string[] = [];
  const evidenceRefs = ['shipment-source-sha:' + sourceSha];

  if (position.positions.inMain === true && !unknown.has('inMain')) {
    evidenceRefs.push('shipment-source-in-main:' + sourceSha);
  } else {
    failures.push(unknown.has('inMain') ? 'shipment-failed:main-ancestry-unmeasured' : 'shipment-failed:source-not-in-main');
  }

  if (position.positions.deployed === true && !unknown.has('deployed') && position.deployedSha) {
    evidenceRefs.push('shipment-deployed-sha:' + position.deployedSha);
  } else {
    failures.push(unknown.has('deployed') ? 'shipment-failed:deployed-ancestry-unmeasured' : 'shipment-failed:source-not-deployed');
  }

  if (
    serving.evidence !== 'health-sha' ||
    !serving.reportedSha ||
    !prefixCompatibleSha(position.deployedSha, serving.reportedSha)
  ) {
    failures.push('shipment-failed:serving-health-sha-not-bound-to-deploy');
  } else {
    evidenceRefs.push('shipment-serving-health-sha:' + serving.reportedSha);
  }

  if (
    serving.codeAsOfSource !== 'deploy' ||
    serving.codeAsOfMs === null ||
    !Number.isFinite(serving.codeAsOfMs) ||
    serving.startedAtMs === null ||
    !Number.isFinite(serving.startedAtMs) ||
    serving.startedAtMs < serving.codeAsOfMs ||
    serving.startedSinceCodeChange !== true
  ) {
    failures.push('shipment-failed:normal-release-trigger-not-observed');
  } else {
    evidenceRefs.push('shipment-release-trigger-at:' + new Date(serving.codeAsOfMs).toISOString());
    evidenceRefs.push('shipment-serving-started-at:' + new Date(serving.startedAtMs).toISOString());
  }

  return { evidenceRefs, failures };
}

function releaseTaskScopeMismatch(currentTask: unknown, rollbackTask: unknown): boolean {
  const current = taskScope(currentTask);
  const rollback = taskScope(rollbackTask);
  if (current.taskClass !== 'deploy' || rollback.taskClass !== 'deploy') return true;
  if (current.workspaceId && rollback.workspaceId && current.workspaceId !== rollback.workspaceId) return true;
  return Boolean(current.harnessSlug && rollback.harnessSlug && current.harnessSlug !== rollback.harnessSlug);
}

export async function recordWorkspaceHostReleaseShipment(
  input: WorkspaceHostReleaseShipmentInput,
): Promise<WorkspaceHostReleaseShipmentReceipt> {
  const { workspaceId, hostId, releaseTaskId } = input;
  const rollbackReleaseTaskId = input.rollbackReleaseTaskId ?? null;
  if (
    !workspaceId.trim() ||
    !hostId.trim() ||
    !TASK_ID.test(releaseTaskId) ||
    (rollbackReleaseTaskId !== null && !TASK_ID.test(rollbackReleaseTaskId))
  ) {
    throw new WorkspaceHostReleaseShipmentError(
      'invalid-input',
      'release shipment requires workspaceId, hostId, a valid release task id, and a valid rollback release task id when one is given',
    );
  }
  const ledger = input.ledger ?? defaultLedger();
  const currentTask = await ledger.getTask(releaseTaskId);
  if (!currentTask) {
    throw new WorkspaceHostReleaseShipmentError('release-task-not-found', 'release shipment task not found');
  }
  const currentJournal = ledger.taskReleaseJournalFromDetail(currentTask.detail);
  if (!currentJournal) {
    throw new WorkspaceHostReleaseShipmentError('release-journal-missing', 'release shipment journal missing');
  }

  const runRef =
    'release-shipment-verification:' + hostId + ':' + releaseTaskId + ':' +
    (rollbackReleaseTaskId ?? NO_ROLLBACK_RELEASE);
  const priorCommitted = currentJournal.receipts.find(
    (receipt) =>
      receipt.stage === WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE &&
      receipt.state === 'committed' &&
      receipt.evidenceRefs.includes(runRef),
  );
  if (priorCommitted) {
    const digests = exactBundleDigests(currentJournal);
    return {
      outcome: 'committed',
      stage: WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE,
      releaseTaskId,
      rollbackReleaseTaskId,
      hostId,
      bundleSha256: digests[0] ?? '',
      sourceSha: typeof asRecord(currentJournal.source)?.sha === 'string' ? String(asRecord(currentJournal.source)?.sha) : '',
      evidenceRefs: priorCommitted.evidenceRefs,
    };
  }

  const sourceSha = typeof asRecord(currentJournal.source)?.sha === 'string' ? String(asRecord(currentJournal.source)?.sha) : '';
  const stage = workspaceHostReleaseShipmentStage(sourceSha, rollbackReleaseTaskId);
  const recorder = await openWorkspaceHostReleaseRecorder({
    releaseTaskId,
    workspaceId,
    hostId,
    stages: { shipment: stage },
    runRef,
    ledger,
    readHostRuntimeRelease: input.readHostRuntimeRelease ?? readWorkspaceHostRuntimeRelease,
  });

  const finish = async (
    outcome: 'committed' | 'refused',
    evidenceRefs: string[],
  ): Promise<WorkspaceHostReleaseShipmentReceipt> => {
    await recorder.settle('shipment', outcome, evidenceRefs);
    return {
      outcome,
      stage: WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE,
      releaseTaskId,
      rollbackReleaseTaskId,
      hostId,
      bundleSha256: recorder.binding.bundleSha256,
      sourceSha: recorder.binding.sourceSha,
      evidenceRefs: [runRef, ...evidenceRefs],
    };
  };
  await recorder.begin('shipment');

  const shipmentIndex = BYOC_RELEASE_MILESTONES.findIndex((milestone) => milestone.key === 'shipment');
  const projection = projectByocReleaseMilestones(currentJournal);
  const missing = shipmentIndex < 0
    ? projection.milestones.map((milestone) => milestone.key)
    : projection.milestones.slice(0, shipmentIndex)
        .filter((milestone) => milestone.status !== 'verified')
        .map((milestone) => milestone.key + ':' + milestone.status);
  if (missing.length > 0) {
    return finish('refused', ['shipment-failed:prior-milestones-unverified:' + missing.join(',')]);
  }
  if (!GIT_SHA.test(recorder.binding.sourceSha)) {
    return finish('refused', ['shipment-failed:release-source-sha-invalid']);
  }

  // D-437: with no rollback release named, there is no rollback task to validate here; whether that
  // is allowed is decided below, once the current manifest shows whether it declares a rollback edge.
  let rollbackJournal: TaskReleaseJournal | null = null;
  let rollbackDigest: string | null = null;
  if (rollbackReleaseTaskId !== null) {
    const rollbackTask = await ledger.getTask(rollbackReleaseTaskId);
    if (!rollbackTask) {
      return finish('refused', ['shipment-failed:rollback-release-task-not-found']);
    }
    if (releaseTaskScopeMismatch(currentTask, rollbackTask)) {
      return finish('refused', ['shipment-failed:rollback-release-task-scope-mismatch']);
    }
    rollbackJournal = ledger.taskReleaseJournalFromDetail(rollbackTask.detail);
    if (!rollbackJournal) {
      return finish('refused', ['shipment-failed:rollback-release-journal-missing']);
    }
    const rollbackArtifactIdentity = asRecord(rollbackJournal.artifactIdentity);
    if (
      rollbackArtifactIdentity?.bundleSha256 !== undefined &&
      (typeof rollbackArtifactIdentity.bundleSha256 !== 'string' ||
        !DIGEST.test(rollbackArtifactIdentity.bundleSha256))
    ) {
      return finish('refused', ['shipment-failed:rollback-bundle-unrecorded']);
    }
    if (!rollbackJournal.receipts.some((receipt) => receipt.stage.startsWith('publish.') && receipt.state === 'committed')) {
      return finish('refused', ['shipment-failed:rollback-release-not-published']);
    }
    if (rollbackReleaseTaskId === releaseTaskId) {
      return finish('refused', ['shipment-failed:rollback-release-task-is-current-task']);
    }
    const rollbackDigests = exactBundleDigests(rollbackJournal);
    if (rollbackDigests.length !== 1) {
      return finish('refused', [
        rollbackDigests.length === 0
          ? 'shipment-failed:rollback-bundle-unrecorded'
          : 'shipment-failed:rollback-bundle-ambiguous',
      ]);
    }
    rollbackDigest = rollbackDigests[0]!;
  }

  // A concrete release-owned path makes gitPipelinePosition read :3070's process start/deploy
  // timestamps as well as its health SHA. The explicit candidate SHA remains the target of every
  // ancestry leg; the path selects only the serving process whose activation must be measured.
  const readPipeline =
    input.readPipelinePosition ??
    ((sha) => gitPipelinePosition({ path: RELEASE_SERVING_PATH, sha }));
  const fetchArtifact = input.fetchArtifact ?? fetch;
  const [pipelineResult, currentBundleResult, rollbackBundleResult] = await Promise.allSettled([
    readPipeline(recorder.binding.sourceSha),
    measurePublishedBundle(fetchArtifact, recorder.binding.bundleSha256),
    rollbackDigest === null ? Promise.resolve(null) : measurePublishedBundle(fetchArtifact, rollbackDigest),
  ]);

  const evidenceRefs: string[] = [];
  const failures: string[] = [];
  let currentMeasurement: ShipmentBundleMeasurement | null = null;
  let rollbackMeasurement: ShipmentBundleMeasurement | null = null;

  if (pipelineResult.status === 'fulfilled') {
    const measured = pipelineEvidence(pipelineResult.value, recorder.binding.sourceSha);
    evidenceRefs.push(...measured.evidenceRefs);
    failures.push(...measured.failures);
  } else {
    failures.push('shipment-failed:pipeline-position-read:' + errorName(pipelineResult.reason));
  }
  if (currentBundleResult.status === 'fulfilled') {
    const result = currentBundleResult.value;
    if (result.ok) {
      currentMeasurement = result.measurement;
      evidenceRefs.push(
        'shipment-current-manifest:' + currentMeasurement.manifestUrl,
        'shipment-current-bundle:' + currentMeasurement.bundleSha256 + ':' + currentMeasurement.bundleBytes,
      );
      if (
        currentMeasurement.manifest.artifact.buildManifest.source.revision !== recorder.binding.sourceSha ||
        currentMeasurement.manifest.artifact.release.version !== recorder.binding.version ||
        currentMeasurement.manifest.artifact.image.version !== recorder.binding.version
      ) {
        failures.push('shipment-failed:current-manifest-release-binding-mismatch');
      }
    } else {
      failures.push(...result.evidenceRefs);
    }
  } else {
    failures.push('shipment-failed:current-artifact-read:' + errorName(currentBundleResult.reason));
  }
  if (rollbackReleaseTaskId === null || rollbackJournal === null) {
    // D-437 first-shipment branch: no rollback release was named. That is allowed only when the
    // current manifest declares no rollback edge AND nothing in this scope has ever shipped green.
    if (currentMeasurement) {
      if (currentMeasurement.manifest.artifact.lifecycle.rollbackTarget) {
        failures.push('shipment-failed:rollback-release-task-required');
      } else {
        const hasPriorGreenShipment =
          input.hasPriorGreenShipment ??
          ((taskId: string) => hasCommittedReleaseStageInScope(taskId, WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE));
        try {
          if (await hasPriorGreenShipment(releaseTaskId)) {
            failures.push('shipment-failed:rollback-target-undeclared');
          } else {
            evidenceRefs.push('shipment-rollback-target:none-first-shipment');
          }
        } catch (error) {
          failures.push('shipment-failed:prior-green-shipment-read:' + errorName(error));
        }
      }
    }
  } else if (rollbackBundleResult.status === 'fulfilled') {
    const result = rollbackBundleResult.value;
    if (result === null) {
      failures.push('shipment-failed:rollback-artifact-unmeasured');
    } else if (result.ok) {
      rollbackMeasurement = result.measurement;
      evidenceRefs.push(
        'shipment-rollback-manifest:' + rollbackMeasurement.manifestUrl,
        'shipment-rollback-bundle:' + rollbackMeasurement.bundleSha256 + ':' + rollbackMeasurement.bundleBytes,
      );
      const rollbackSourceSha = typeof asRecord(rollbackJournal.source)?.sha === 'string'
        ? String(asRecord(rollbackJournal.source)?.sha)
        : '';
      if (
        !GIT_SHA.test(rollbackSourceSha) ||
        rollbackMeasurement.manifest.artifact.buildManifest.source.revision !== rollbackSourceSha ||
        rollbackMeasurement.manifest.artifact.image.version !== rollbackMeasurement.manifest.artifact.release.version
      ) {
        failures.push('shipment-failed:rollback-manifest-release-binding-mismatch');
      }
      try {
        const rollbackBinding = await resolveWorkspaceHostReleaseBinding({
          releaseTaskId: rollbackReleaseTaskId,
          stage: WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE,
          hostRuntimeRelease: {
            bundleSha256: rollbackMeasurement.bundleSha256,
            version: rollbackMeasurement.manifest.artifact.release.version,
          },
          ledger,
        });
        if (
          rollbackBinding.sourceSha !== rollbackSourceSha ||
          rollbackBinding.version !== rollbackMeasurement.manifest.artifact.release.version
        ) {
          failures.push('shipment-failed:rollback-task-manifest-binding-mismatch');
        }
      } catch (error) {
        failures.push('shipment-failed:rollback-task-binding:' + errorName(error));
      }
    } else {
      failures.push(...result.evidenceRefs);
    }
  } else {
    failures.push('shipment-failed:rollback-artifact-read:' + errorName(rollbackBundleResult.reason));
  }

  if (currentMeasurement && rollbackMeasurement) {
    const target = currentMeasurement.manifest.artifact.lifecycle.rollbackTarget;
    const priorImage = rollbackMeasurement.manifest.artifact.image;
    if (
      !target ||
      target.id !== priorImage.id ||
      target.version !== priorImage.version
    ) {
      failures.push('shipment-failed:rollback-image-does-not-match-manifest-target');
    } else {
      evidenceRefs.push('shipment-rollback-target:' + target.id + '@' + target.version);
    }
  }

  if (failures.length > 0) {
    return finish('refused', [...evidenceRefs, ...failures].slice(0, 60));
  }
  return finish('committed', evidenceRefs.slice(0, 60));
}
