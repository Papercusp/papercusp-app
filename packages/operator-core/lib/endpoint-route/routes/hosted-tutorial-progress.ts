import { defineTool, dispatchProjectedTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { z } from 'zod';
import type { VerifiedTenantServerContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { exactOriginOr403, jsonError, selectedHostedPrincipal, tenantContext, workspaceHeaderMismatch } from '../hosted-browser-context';
import { readTutorialProgress, updateTutorialProgress, tutorialProgressUpdateSchema, TutorialProgressConflict } from '../../onboarding/cloud-tutorial-progress';
import { sameTutorialScope } from '../../onboarding/cloud-tutorial-lesson';
import { authorizeTutorialHelp, tutorialHelpRequestSchema, type TutorialHelpRequest } from '../../onboarding/cloud-tutorial-help';
import { isTtsEngineUnavailable } from '../../voice-release-availability';
export const HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH = '/hosted/browser/onboarding/tutorial-progress' as const;
export const HOSTED_BROWSER_TUTORIAL_HELP_PATH = '/hosted/browser/onboarding/tutorial-help' as const;
export const HOSTED_BROWSER_TUTORIAL_SPEECH_PATH = '/hosted/browser/onboarding/tutorial-speech' as const;

export interface TutorialAssistanceDependencies {
  answer?: (input: TutorialHelpRequest, signal: AbortSignal, workspaceId: string) => Promise<string>;
  speech?: (text: string, engine: string, voiceId: string | undefined) => Promise<{ audio: ArrayBuffer; contentType: string }>;
}
const speechSchema = tutorialHelpRequestSchema.extend({
  engine: z.enum(['kokoro', 'elevenlabs', 'openai', 'cartesia']),
  voiceId: z.string().min(1).max(200).optional(),
}).strict();

async function answerLesson(input: TutorialHelpRequest, signal: AbortSignal, workspaceId: string): Promise<string> {
  await import('../../agent-tools/index');
  const converse = lookupByMcpName('operator:converse');
  if (!converse) throw new Error('tutorial_help_unavailable');
  const ctx: UnifiedToolContext = { log: () => {}, signal, progress: () => {}, emit: () => {}, workspaceId,
    role: 'operator', runId: crypto.randomUUID(), spawnId: crypto.randomUUID(), transport: 'in_process', uiClientId: null };
  const result = await dispatchProjectedTool(converse, 'operator:converse', {
    messages: [{ role: 'user', content: input.question }], trigger: 'user_message', modality: 'text',
    hostTrust: 'public', lessonContext: input.context, sessionUser: null,
  }, ctx, {});
  if (!result.ok || result.result?.isError || signal.aborted) throw new Error('tutorial_help_unavailable');
  const content = result.result?.content.find(part => part.type === 'text');
  const value = JSON.parse(content?.type === 'text' ? content.text : '{}') as { assembled?: unknown };
  if (typeof value.assembled !== 'string' || !value.assembled.trim()) throw new Error('tutorial_help_empty');
  return value.assembled.trim().slice(0, 2000);
}
async function speakLesson(text: string, engine: string, voiceId: string | undefined) {
  // Release scope (voice-final-public-release-2026-10-01#D-005): this route calls
  // synthesize() directly, so it must refuse release-unavailable engines itself.
  if (isTtsEngineUnavailable(engine)) throw new Error('tutorial_speech_unavailable');
  const [{ synthesize }, { loadVoicePrefs }] = await Promise.all([
    import('./agent-mcp/tts-synth'), import('../../voice-prefs'),
  ]);
  const speech = await synthesize(engine as Parameters<typeof synthesize>[0], text, voiceId, await loadVoicePrefs());
  if (!speech.ok) throw new Error('tutorial_speech_unavailable');
  return speech;
}

/** Two leaves on the existing hosted onboarding boundary; the existing brain
 * and synthesis registry own execution. No new conversation or agent service. */
export function createHostedTutorialAssistanceRoutes({ origin, controlPlaneWorkspaceId, dependencies = {} }: {
  origin: string; controlPlaneWorkspaceId: string; dependencies?: TutorialAssistanceDependencies;
}) {
  return [HOSTED_BROWSER_TUTORIAL_HELP_PATH, HOSTED_BROWSER_TUTORIAL_SPEECH_PATH].map(path => defineTool({
    method: 'POST', path, auth: { capabilities: ['workspace:view'], kind: ['user'], trust: ['verified'] },
    cors: { origins: [origin] }, sampleRate: 0,
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      if (!principal.capabilities.has('workspace:view')) return jsonError('permission_missing', 403);
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      const raw: unknown = await request.json().catch(() => null);
      const parsed = (path === HOSTED_BROWSER_TUTORIAL_SPEECH_PATH ? speechSchema : tutorialHelpRequestSchema).safeParse(raw);
      if (!parsed.success) return jsonError('invalid_tutorial_context', 400);
      let input: TutorialHelpRequest;
      try {
        input = authorizeTutorialHelp({ tenantId: principal.activeOrganizationId, userId: principal.userId, workspaceId: principal.selectedWorkspaceId! },
          { expectedScope: parsed.data.expectedScope, context: parsed.data.context, question: parsed.data.question });
      } catch (error) { return jsonError(error instanceof Error ? error.message : 'invalid_tutorial_context', 403); }
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
      try {
        if (path === HOSTED_BROWSER_TUTORIAL_HELP_PATH) {
          const answer = await (dependencies.answer ?? answerLesson)(input, signal, controlPlaneWorkspaceId);
          if (signal.aborted) return jsonError('tutorial_help_cancelled', 408);
          return Response.json({ answer }, { headers: { 'cache-control': 'no-store' } });
        }
        const voice = speechSchema.parse(raw);
        const speech = await (dependencies.speech ?? speakLesson)(input.question, voice.engine, voice.voiceId);
        if (signal.aborted) return jsonError('tutorial_speech_cancelled', 408);
        return new Response(speech.audio, { headers: { 'content-type': speech.contentType, 'cache-control': 'no-store' } });
      } catch { return jsonError(path === HOSTED_BROWSER_TUTORIAL_HELP_PATH ? 'tutorial_help_unavailable' : 'tutorial_speech_unavailable', 503); }
    },
  }));
}
export function createHostedTutorialProgressRoutes({ origin, controlPlaneWorkspaceId, runTenant }: {
  origin: string; controlPlaneWorkspaceId: string;
  runTenant: <T>(context: VerifiedTenantServerContext, fn: (tx: Sql) => Promise<T>) => Promise<T>;
}) {
  return (['GET', 'POST'] as const).map(method => defineTool({
    method, path: HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH,
    auth: { capabilities: ['workspace:view'], kind: ['user'], trust: ['verified'] },
    cors: { origins: [origin] }, sampleRate: 0,
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      if (!principal.capabilities.has('workspace:view')) return jsonError('permission_missing', 403);
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      if (method === 'POST') {
        const csrf = exactOriginOr403(request, origin);
        if (csrf) return csrf;
      }
      const scope = { tenantId: principal.activeOrganizationId, userId: principal.userId, workspaceId: principal.selectedWorkspaceId! };
      const requestedVersion = new URL(request.url).searchParams.get('version');
      if (requestedVersion !== null && requestedVersion !== '1' && requestedVersion !== '2') return jsonError('invalid_tutorial_version', 400);
      const version = requestedVersion === '2' ? 2 : 1;
      const parsed = method === 'POST' ? tutorialProgressUpdateSchema.safeParse(await request.json().catch(() => null)) : null;
      if (parsed && !parsed.success) return jsonError('invalid_tutorial_progress', 400);
      if (parsed?.success && !sameTutorialScope(scope, parsed.data.expectedScope)) return jsonError('tutorial_scope_changed', 403);
      try {
        const record = await runTenant(tenantContext(principal), tx => parsed?.success
          ? updateTutorialProgress(tx, scope, parsed.data) : readTutorialProgress(tx, scope, version));
        return Response.json({ record }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof TutorialProgressConflict) return Response.json({ error: 'tutorial_progress_conflict', record: error.current }, { status: 409, headers: { 'cache-control': 'no-store' } });
        return jsonError('tutorial_progress_unavailable', 503);
      }
    },
  }));
}
