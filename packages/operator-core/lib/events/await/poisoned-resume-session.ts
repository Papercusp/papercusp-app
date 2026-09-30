import { markAdvSessionEnded } from '../../adv-sessions';
import { analyzeClaudeResumeTranscriptFile, CLAUDE_TOOL_REFERENCE_POISON_TURNS } from '../../claude-resume-tool-references.mjs';
import { markSessionBriefPoisoned, type SessionBriefPoisonMarker } from '../../session-brief';
import type { ResumeTurnContext } from './resume-turn-outcome';

export interface PoisonedResumeResult {
  poisoned: boolean;
  turns: number;
  ended?: boolean;
  reason?: string;
}

export interface PoisonedResumeDeps {
  analyze?: typeof analyzeClaudeResumeTranscriptFile;
  markBrief?: typeof markSessionBriefPoisoned;
  markEnded?: typeof markAdvSessionEnded;
  now?: () => Date;
}

/**
 * Quarantine one Claude session incarnation after its transcript records the
 * exact unavailable-tool-reference error on three consecutive assistant turns.
 * The durable brief marker blocks queued wakes; the adv-session end schedules
 * the existing lock/work-item lease release hook.
 */
export async function quarantineRepeatedClaudeToolReferenceFailures(
  context: ResumeTurnContext | null | undefined,
  evidence: string,
  deps: PoisonedResumeDeps = {},
): Promise<PoisonedResumeResult> {
  if (
    !context || context.agent !== 'claude' || !Number.isSafeInteger(context.advSessionId) ||
    context.advSessionId <= 0 || !context.ownerId || !context.workspaceId || !context.sessionId ||
    !context.startedAt || !context.transcriptPath
  ) return { poisoned: false, turns: 0, reason: 'resume identity or transcript unavailable' };

  const analysis = (deps.analyze ?? analyzeClaudeResumeTranscriptFile)(context.transcriptPath);
  if (!analysis) return { poisoned: false, turns: 0, reason: 'Claude transcript could not be read' };
  if (analysis.trailingMissingToolReferenceTurns < CLAUDE_TOOL_REFERENCE_POISON_TURNS) {
    return { poisoned: false, turns: analysis.trailingMissingToolReferenceTurns };
  }

  const now = (deps.now ?? (() => new Date()))();
  const marker: SessionBriefPoisonMarker = {
    advSessionId: context.advSessionId,
    sessionId: context.sessionId,
    startedAt: context.startedAt,
    at: now.toISOString(),
    by: 'resume-turn-detector',
    reason: `${analysis.trailingMissingToolReferenceTurns} consecutive Claude assistant turns replayed an unavailable Papercusp tool reference`,
    evidence: evidence.slice(0, 400),
  };
  const markBrief = deps.markBrief ?? markSessionBriefPoisoned;
  if (!(await markBrief(context.ownerId, context.workspaceId, marker))) {
    return {
      poisoned: false,
      turns: analysis.trailingMissingToolReferenceTurns,
      reason: 'durable poison marker write failed; leaving the session retryable',
    };
  }

  const markEnded = deps.markEnded ?? markAdvSessionEnded;
  const ended = await markEnded(context.advSessionId, null, 'reconciler', { observedAt: now });
  return { poisoned: true, turns: analysis.trailingMissingToolReferenceTurns, ended };
}
