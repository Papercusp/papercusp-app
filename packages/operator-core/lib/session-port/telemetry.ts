import { randomUUID } from 'node:crypto';
import { generated, withWorkspace } from '@papercusp/db-org';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { SessionPortInspection } from './service';
import type { SessionPortContractSummary } from './types';

export type SessionPortTelemetryStage = 'inspected' | 'prepared' | 'pending' | 'delivered' | 'failed';

export interface SessionPortTelemetryInput {
  workspaceId: string;
  stage: SessionPortTelemetryStage;
  portId?: string | null;
  sourceAdvSessionId: number;
  targetAdvSessionId?: number | null;
  sourceBackend?: string | null;
  targetBackend?: string | null;
  targetProvider?: string | null;
  targetModel?: string | null;
  targetAccount?: string | null;
  fidelity?: string | null;
  omittedAttachments?: number | null;
  unsupportedBlocks?: number | null;
  redactions?: number | null;
  summarized?: boolean | null;
  summaryModel?: string | null;
  summaryPromptVersion?: number | null;
  sourceHash?: string | null;
  renderedHash?: string | null;
  estimatedTokens?: number | null;
  protocolVersion?: number | null;
  idempotentReuse?: boolean | null;
  persistenceLatencyMs?: number | null;
  cleanupOutcome?: 'deleted' | 'already-absent' | 'failed' | null;
  failureClass?: string | null;
}

/** Runtime allowlist. Even a caller that passes extra properties cannot put
 * transcript text, raw errors, tokens, prompts, or artifact paths in audit_log. */
export function sessionPortTelemetryDetails(input: SessionPortTelemetryInput): Record<string, unknown> {
  return {
    stage: input.stage,
    protocol_version: input.protocolVersion ?? null,
    source_adv_session_id: input.sourceAdvSessionId,
    target_adv_session_id: input.targetAdvSessionId ?? null,
    source_backend: input.sourceBackend ?? 'claude',
    target_backend: input.targetBackend ?? null,
    target_provider: input.targetProvider ?? null,
    target_model: input.targetModel ?? null,
    target_account: input.targetAccount ?? null,
    fidelity: input.fidelity ?? null,
    omitted_attachments: input.omittedAttachments ?? null,
    unsupported_blocks: input.unsupportedBlocks ?? null,
    redactions: input.redactions ?? null,
    summarized: input.summarized ?? null,
    summary_model: input.summaryModel ?? null,
    summary_prompt_version: input.summaryPromptVersion ?? null,
    source_hash: input.sourceHash ?? null,
    rendered_hash: input.renderedHash ?? null,
    estimated_tokens: input.estimatedTokens ?? null,
    idempotent_reuse: input.idempotentReuse ?? null,
    persistence_latency_ms: input.persistenceLatencyMs ?? null,
    cleanup_outcome: input.cleanupOutcome ?? null,
    failure_class: input.failureClass ?? null,
  };
}

export function classifySessionPortFailure(error: unknown): string {
  const text = String(error instanceof Error ? error.message : error ?? '').toLowerCase();
  if (/protocol|version|upgrade|migration|relation .*session_ports/.test(text)) return 'protocol-or-rollout';
  if (/authority|fleet|claim|lock|loop|auto|drain/.test(text)) return 'authority';
  if (/source|snapshot|archive|jsonl|claude/.test(text)) return 'source';
  if (/budget|context|fit|token count|summar/.test(text)) return 'budget-or-summary';
  if (/artifact|seed|checksum|hash/.test(text)) return 'artifact';
  if (/persist|transcript|timeout|timed out/.test(text)) return 'native-persistence';
  if (/account|provider|gateway/.test(text)) return 'target-routing';
  return 'unknown';
}

export function telemetryFromInspection(
  workspaceId: string,
  stage: SessionPortTelemetryStage,
  inspection: SessionPortInspection,
  summary?: SessionPortContractSummary | null,
): SessionPortTelemetryInput {
  const stats = summary?.stats ?? inspection.stats;
  return {
    workspaceId,
    stage,
    sourceAdvSessionId: inspection.source.advSessionId,
    sourceBackend: inspection.source.backend,
    targetBackend: inspection.target.backend,
    targetProvider: inspection.target.provider,
    targetModel: inspection.target.model,
    targetAccount: inspection.target.account,
    fidelity: summary?.fidelity ?? (inspection.requiresSummary ? 'summary-tail' : 'full'),
    omittedAttachments: stats.omittedAttachments,
    unsupportedBlocks: stats.unsupportedBlocks,
    redactions: stats.redactions,
    summarized: summary ? summary.summary != null : inspection.requiresSummary,
    summaryModel: summary?.summary?.model ?? null,
    summaryPromptVersion: summary?.versions.summaryPrompt ?? null,
    sourceHash: inspection.source.sha256,
    renderedHash: summary?.hashes.rendered ?? null,
    estimatedTokens: summary ? Number(inspection.fullHistoryEstimatedTokens) : inspection.fullHistoryEstimatedTokens,
    protocolVersion: inspection.protocolVersion,
  };
}

/** Best-effort diagnostics, matching existing operator audit semantics. */
export async function recordSessionPortTelemetry(input: SessionPortTelemetryInput): Promise<boolean> {
  try {
    const details = sessionPortTelemetryDetails(input);
    await withWorkspace(input.workspaceId, async (tx) => {
      await drizzle(tx).insert(generated.auditLogInHarnessShared).values({
        id: `session-port-${randomUUID()}`,
        ts: Date.now(),
        actor: 'system:session-port',
        action: `session-port.${input.stage}`,
        subject: input.portId ?? `source:${input.sourceAdvSessionId}`,
        details: details as any,
        workspaceId: input.workspaceId,
      });
    });
    return true;
  } catch {
    return false;
  }
}
