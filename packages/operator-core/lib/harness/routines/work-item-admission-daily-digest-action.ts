/** Durable system action for the guarded P-012 daily full-corpus digest. */
import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { captureImprovement } from '../improvements/capture-core';
import { gatewayLlmEnv } from '../../inference-gateway/spawn-env';
import { notifySyncInvalidate } from '../../sync-sse';
import { linkWorkItem, resolveWorkItemRef } from '../../work-items';
import {
  DAILY_DIGEST_ACTOR,
  DEFAULT_DAILY_DIGEST_MAX_TOKENS,
  dailyDigestWatchdogKey,
  runWorkItemAdmissionDailyDigest,
  WORK_ITEM_ADMISSION_DAILY_DIGEST,
  type DailyDigestRunResult,
  type DailyDigestUmbrellaFiler,
  type DailyDigestUmbrellaLinker,
} from '../../work-items-admission-daily-digest';
import { optionalModelSpec } from '../../learning/model-policy';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

function runId(): string {
  return DBOS.workflowID?.trim() || `${WORK_ITEM_ADMISSION_DAILY_DIGEST}:${randomUUID()}`;
}

const productionFileUmbrella: DailyDigestUmbrellaFiler = async (input) => {
  const result = await captureImprovement({
    title: input.proposal.title,
    kind: 'bug',
    severity: 'major',
    body:
      `${input.proposal.body}\n\nDaily full-corpus digest evidence: ${input.proposal.reason}\n\n` +
      `Contributing work-items: ${input.proposal.memberIds.join(', ')}.`,
    scope: `harness:${input.harnessSlug}`,
    foundDuring: `${WORK_ITEM_ADMISSION_DAILY_DIGEST} ${input.runId}`,
    dedupScope: 'open',
    watchdogKey: input.watchdogKey,
    sourceRole: 'system',
    createdBy: DAILY_DIGEST_ACTOR,
    payloadExtra: {
      dailyDigest: {
        runId: input.runId,
        sourceBulkStageRunId: input.sourceBulkStageRunId,
        sourceCensusRunId: input.sourceCensusRunId,
        memberIds: input.proposal.memberIds,
        reason: input.proposal.reason,
      },
    },
  });
  const canonical =
    result.issue?.id ??
    result.possibleDuplicates.find((candidate) => candidate.state === 'open')?.id ??
    result.possibleDuplicates[0]?.id;
  if (!canonical) {
    throw new Error(
      `daily digest capture produced no linkable umbrella for '${input.proposal.title}' (${result.reason ?? 'unknown'})`,
    );
  }
  return { id: canonical, created: result.created };
};

const productionLinkUmbrella: DailyDigestUmbrellaLinker = async (input) => {
  const umbrella = await resolveWorkItemRef(input.umbrellaId, input.harnessSlug);
  if (!umbrella) throw new Error(`daily digest umbrella '${input.umbrellaId}' could not be resolved after capture`);
  let written = 0;
  for (const sourceId of input.sourceIds) {
    const result = await linkWorkItem(sourceId, umbrella, 'caused-by', {
      harness: input.harnessSlug,
      by: DAILY_DIGEST_ACTOR,
    });
    if ('error' in result) {
      throw new Error(`daily digest could not link ${sourceId} to ${input.umbrellaId}: ${result.error}`);
    }
    written += 1;
  }
  return written;
};

export interface AdmissionDailyDigestActionDeps {
  run: (ctx: SystemActionCtx) => Promise<DailyDigestRunResult>;
  invalidate: () => Promise<void>;
  log: (message: string) => void;
}

// optionalModelSpec is shared from learning/model-policy so a per-run override
// behaves identically across promoter, bulk-dedup and daily-digest.


async function productionRun(ctx: SystemActionCtx): Promise<DailyDigestRunResult> {
  if (process.env.VITEST) throw new Error('production admission daily digest must not run from a unit test');
  if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
    for (const [key, value] of Object.entries(gatewayLlmEnv(true))) {
      if (!process.env[key]) process.env[key] = value;
    }
  }
  const payload = ctx.payloadTemplate ?? {};
  const explicit = typeof payload.runId === 'string' ? payload.runId.trim() : '';
  const maxTokens = typeof payload.maxTokens === 'number' ? payload.maxTokens : DEFAULT_DAILY_DIGEST_MAX_TOKENS;
  const { llmCall } = await import('../../llm-testing/llm-client');
  return runWorkItemAdmissionDailyDigest({
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.installSlug,
    runId: explicit || runId(),
    maxTokens,
    model: optionalModelSpec(payload.model, 'daily digest'),
    llmCall: (input) => llmCall({ ...input, priority: 'scout', harnessSlug: ctx.installSlug }),
    fileUmbrella: productionFileUmbrella,
    linkUmbrella: productionLinkUmbrella,
  });
}

async function invalidateAdmissionRuns(): Promise<void> {
  await notifySyncInvalidate('workItemAdmission.runs');
}

export function makeWorkItemAdmissionDailyDigestAction(overrides: Partial<AdmissionDailyDigestActionDeps> = {}) {
  const deps: AdmissionDailyDigestActionDeps = {
    run: productionRun,
    invalidate: invalidateAdmissionRuns,
    log: (message) => console.log(`[${WORK_ITEM_ADMISSION_DAILY_DIGEST}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const result = await deps.run(ctx);
    await deps.invalidate();
    if (result.status === 'blocked') {
      deps.log(
        `${ctx.installSlug}: run=${result.runId} blocked=${result.blockedReason ?? 'unknown'} modelCalled=false`,
      );
      return;
    }
    deps.log(
      `${ctx.installSlug}: run=${result.runId} corpus=${result.corpusSize} ` +
        `umbrellas=${result.umbrellaYield} links=${result.linksWritten} ` +
        `tokens=${result.tokensIn}+${result.tokensOut}`,
    );
  };
}

registerSystemAction(WORK_ITEM_ADMISSION_DAILY_DIGEST, makeWorkItemAdmissionDailyDigestAction());
