import { z } from 'zod';
import { gitPipelineSnapshot } from '../../git-pipeline-stats';
import { checkpointProducerCertificate } from '../../events/await/checkpoint-verified-wait';
import type { ProducerHealthCertificate } from '../../events/await/verified-wait';
import { createProgressLeaseCertificate, type ProgressLeaseRegistration } from '../../events/await/progress-lease';

const progressLeaseRemedySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spec-widen'), instructions: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal('outside-lane-placement'), instructions: z.string().min(1).max(2000) }),
  z.object({
    kind: z.literal('leader-claim'),
    workItemId: z.string().min(1).max(200).nullable().optional(),
    harness: z.string().min(1).max(120).nullable().optional(),
  }),
  z.object({
    kind: z.literal('create-unblock-item'),
    title: z.string().min(1).max(1000),
    summary: z.string().min(1).max(8000).nullable().optional(),
    harness: z.string().min(1).max(120),
  }),
]);

export const progressLeaseInputSchema = z.object({
  source_kind: z.enum(['state-cell', 'tool-call-delta', 'checkpoint-revision', 'managed-task-advance', 'claim-transition']),
  tool: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()).optional(),
  path: z.string().min(1).max(300),
  op: z.enum(['changed', 'increased']).optional(),
  units: z.string().min(1).max(120),
  writer: z.string().min(1).max(200).optional(),
  expected_cadence_sec: z.number().int().positive().max(7 * 24 * 60 * 60),
  owner_id: z.string().min(1).max(200),
  work_item_id: z.string().min(1).max(200).optional(),
  remedy_after_misses: z.number().int().min(2).max(10).optional(),
  remedy: progressLeaseRemedySchema.describe(
    'Applied after repeated cadence misses. The first cadence miss automatically wakes owner_id; accepted kinds are spec-widen, outside-lane-placement, leader-claim, and create-unblock-item. wake-owner is not a remedy kind.',
  ),
});

export type ProgressLeaseInput = z.infer<typeof progressLeaseInputSchema>;

export async function resolveProgressLeaseCertificate(input: {
  progressLease: ProgressLeaseInput;
  subscriberId: string;
  workspaceId: string;
  harnessSlug: string | null;
  role: string;
  timeoutSec?: number;
  nowMs?: number;
}): Promise<ProducerHealthCertificate> {
  return createProgressLeaseCertificate(input.progressLease as ProgressLeaseRegistration, input);
}

export const producerHealthInputSchema = z
  .object({
    kind: z.literal('green-checkpoint'),
    pipeline: z
      .string()
      .min(1)
      .max(64)
      .describe(
        'Sanitized basename of the integration root that emits the event (for example "papercusp" in release:green:papercusp), not the routine name "green-checkpoint".',
      ),
    candidate_sha: z.string().min(1).max(128).optional(),
    run_id: z.string().min(1).max(200).optional(),
    expected_cadence_sec: z.number().int().positive().max(7 * 24 * 60 * 60),
    owner_id: z.string().min(1).max(200).optional(),
    work_item_id: z.string().min(1).max(200).optional(),
  })
  .describe(
    'Opt into a verified wait backed by authoritative producer health. The push event remains primary; at the bounded deadline the sweeper re-checks this producer, re-parks progress, or wakes with stalled/absent diagnosis. Currently supports green-checkpoint.',
  );

export type ProducerHealthInput = z.infer<typeof producerHealthInputSchema>;

export async function resolveProducerHealthCertificate(input: {
  producerHealth: ProducerHealthInput;
  subscriberId: string;
  timeoutSec?: number;
  nowMs?: number;
}): Promise<ProducerHealthCertificate> {
  const producer = input.producerHealth;
  const issuedAtMs = input.nowMs ?? Date.now();
  const expectedCadenceMs = producer.expected_cadence_sec * 1_000;
  const verificationDeadlineMs = issuedAtMs + (input.timeoutSec == null ? expectedCadenceMs : input.timeoutSec * 1_000);
  const snapshot = await gitPipelineSnapshot(producer.pipeline, { includeActiveRun: true });
  if (!snapshot.routines.greenCheckpoint && !snapshot.activeRun) {
    throw new Error(
      `producer health — unknown green-checkpoint pipeline: ${producer.pipeline}. ` +
        'Use the sanitized integration-root basename from the event key (for example "papercusp" in release:green:papercusp), not the routine name "green-checkpoint"; no wait was registered.',
    );
  }
  return checkpointProducerCertificate({
    pipeline: producer.pipeline,
    candidateSha: producer.candidate_sha,
    runId: producer.run_id,
    ownerId: producer.owner_id ?? null,
    workItemId: producer.work_item_id ?? null,
    issuedAtMs,
    expectedCadenceMs,
    verificationDeadlineMs,
    snapshot,
  });
}
