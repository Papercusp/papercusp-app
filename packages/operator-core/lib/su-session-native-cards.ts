/** Translate native questions into the existing PUI card/response protocol.
 * The shared correlator validates the workspace and response exactly once. */
import { z } from 'zod';
import { cancelPendingCardsForRun, registerCard, resolveCardResponse } from '@papercusp/agent-mcp';
import type { CanUseTool, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { approvalCardText, humanToolName } from './su-session-approval-display';
import type { SuSessionEventInput } from './su-session-host';
import type { RpcFrame } from './su-session-stdio-peer';

const record = (value: unknown): RpcFrame => value && typeof value === 'object' && !Array.isArray(value) ? value as RpcFrame : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';

/** Claude's allow suggestions, re-scoped to this runtime: a PUI card never
 * writes a settings file (D-021). */
export function sessionAllowRules(suggestions: readonly PermissionUpdate[] | undefined): PermissionUpdate[] {
  return (suggestions ?? []).flatMap((update) => update.type === 'addRules' && update.behavior === 'allow'
    && update.rules.length ? [{ ...update, destination: 'session' as const }] : []);
}

/** The exact rule and lifetime the remembered choice grants, with the tool
 * named the way the card names it (P-008: never a raw MCP id). */
export function rememberedApprovalLabel(updates: readonly PermissionUpdate[]): string | undefined {
  const rules = updates.flatMap((update) => update.type === 'addRules'
    ? update.rules.map((rule) => rule.ruleContent ? `${humanToolName(rule.toolName)}(${rule.ruleContent})` : humanToolName(rule.toolName)) : []);
  return rules.length ? `Always allow ${rules.join(', ')} until this session's runtime stops` : undefined;
}

/** What the model is told when the owner skips (Esc / Decline) a question
 * card. P-014: a skip is a normal choice, not a failure, so the wording must
 * not read as an error the agent should apologise for or work around, and it
 * must stop the agent re-asking the same question. An interrupt is different
 * (the whole turn is ending) and keeps the generic denial. */
export const SKIPPED_QUESTION_MESSAGE = 'The user skipped this question without answering. '
  + 'This is not an error: continue without that answer, and do not ask the same question again.';

export class SuNativeCards {
  private epoch = 0;
  /** `cwd` is the chat's launch directory; approval cards show paths relative to it. */
  constructor(private readonly workspaceId: string, private readonly runId: string,
    private readonly emit: (event: SuSessionEventInput) => void, private readonly cwd?: string) {}

  cancel(): void { this.epoch++; cancelPendingCardsForRun(this.runId); }

  private async ask(turnId: string, prompt: string, choices?: string[]): Promise<string | null> {
    const answers = await this.askAnswers(turnId, prompt, choices?.map((label) => ({ label })));
    return answers?.[0] ?? null;
  }

  private async askAnswers(turnId: string, prompt: string,
    choices?: Array<{ label: string; description?: string }>, multiSelect = false, signal?: AbortSignal,
    details?: string): Promise<string[] | null> {
    if (signal?.aborted) return null;
    const presentation = choices?.length
      ? { kind: multiSelect ? 'checkbox' as const : 'radio' as const,
        options: choices.map((choice, index) => ({ id: String(index), ...choice })) }
      : { kind: 'text' as const };
    const dataSchema = choices?.length
      ? z.object({ picks: z.array(z.string()).min(1).max(multiSelect ? choices.length : 1).refine((picks) => presentation.kind !== 'text'
        && new Set(picks).size === picks.length && picks.every((pick) => presentation.options.some((option) => option.id === pick)), 'Choose displayed options') })
      : z.object({ value: z.string() });
    const card = registerCard({ workspaceId: this.workspaceId, runId: this.runId,
      spec: { prompt, dataSchema, presentation, allowDecline: true } });
    const cancel = () => { resolveCardResponse({ correlationId: card.correlationId, action: 'cancel', expectedWorkspaceId: this.workspaceId }); };
    signal?.addEventListener('abort', cancel, { once: true });
    this.emit({ type: 'card', phase: 'opened', turnId, card: {
      correlationId: card.correlationId, createdAt: Date.now(), prompt, fallbackText: prompt,
      ...(details ? { details } : {}), presentation, allowDecline: true,
    } });
    const response = await card.result.finally(() => signal?.removeEventListener('abort', cancel));
    this.emit({ type: 'card', phase: 'closed', turnId, correlationId: card.correlationId,
      resolution: response.action === 'submit' ? 'submitted' : response.action === 'decline' ? 'declined' : 'cancelled' });
    if (response.action !== 'submit') return null;
    return 'picks' in response.payload ? response.payload.picks.map((pick) => choices![Number(pick)].label) : [response.payload.value];
  }

  async handleClaude(toolName: string, input: Record<string, unknown>, turnId: string,
    options: Parameters<CanUseTool>[2]): ReturnType<CanUseTool> {
    const epoch = this.epoch;
    const deny = (message = 'The PUI response was declined or cancelled') => ({ behavior: 'deny' as const, message });
    try {
      if (options.signal.aborted) return deny();
      // A deferred MCP wrapper can carry a native AskUserQuestion request. It
      // cannot execute that client-local tool, so ask through the same PUI card
      // and return the owner's answer to Claude as the denied wrapper result.
      // Otherwise the owner sees a generic "Allow tools_invoke?" permission
      // whose raw JSON offers no way to choose an answer.
      if (toolName === 'mcp__papercusp-su__tools_invoke' && input.name === 'AskUserQuestion') {
        const answered = await this.handleClaude('AskUserQuestion', record(input.args), turnId, options);
        if (!answered || answered.behavior !== 'allow') return answered ?? deny();
        const answers = record(record(answered).updatedInput).answers;
        return deny(`PUI owner answered AskUserQuestion: ${JSON.stringify(answers)}. The MCP wrapper cannot execute this native tool; continue using the recorded answer without asking again.`);
      }
      if (toolName !== 'AskUserQuestion') {
        // P-008: a readable question and the change itself; the raw arguments
        // ride as the card's details, shown only behind the PUI's Ctrl+R.
        const { prompt, details } = approvalCardText(toolName, input, {
          title: options.title, description: options.description, decisionReason: options.decisionReason, cwd: this.cwd });
        // The broader remembered permission is a separate, labelled choice and
        // exists only when Claude offers one (PUBLIC_RELEASE_UX, Approvals).
        const remembered = sessionAllowRules(options.suggestions);
        const rememberLabel = rememberedApprovalLabel(remembered);
        const choice = await this.askAnswers(turnId, prompt,
          [{ label: 'Approve' }, { label: 'Decline' }, ...(rememberLabel ? [{ label: rememberLabel }] : [])], false, options.signal, details);
        if (epoch !== this.epoch || options.signal.aborted) return deny();
        if (choice?.[0] === 'Approve') return { behavior: 'allow', updatedInput: input };
        return rememberLabel && choice?.[0] === rememberLabel
          ? { behavior: 'allow', updatedInput: input, updatedPermissions: remembered } : deny();
      }
      const questions = z.array(z.object({
        question: z.string().min(1), multiSelect: z.boolean().optional(),
        options: z.array(z.object({ label: z.string().min(1), description: z.string().optional(), preview: z.string().optional() })).min(1),
      })).min(1).max(4).parse(input.questions);
      if (new Set(questions.map((question) => question.question)).size !== questions.length) {
        throw new Error('Claude questions must have distinct prompts');
      }
      const answers: Record<string, string> = {};
      for (const question of questions) {
        if (epoch !== this.epoch || options.signal.aborted) return deny();
        let other = 'Type a different answer';
        while (question.options.some((option) => option.label === other)) other += '…';
        const choices = question.options.map((option) => ({ label: option.label,
          description: [option.description, option.preview].filter(Boolean).join('\n') }));
        const picks = await this.askAnswers(turnId, question.question, [...choices, { label: other }], question.multiSelect, options.signal);
        if (epoch !== this.epoch || options.signal.aborted) return deny();
        if (!picks) return deny(SKIPPED_QUESTION_MESSAGE);
        const selected = picks.filter((pick) => pick !== other);
        if (picks.includes(other)) {
          const custom = await this.askAnswers(turnId, question.question, undefined, false, options.signal);
          if (epoch !== this.epoch || options.signal.aborted) return deny();
          if (!custom) return deny(SKIPPED_QUESTION_MESSAGE);
          selected.push(...custom);
        }
        answers[question.question] = selected.join(', ');
      }
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'error', scope: 'command', code: 'native_question_failed', message, recoverable: true });
      return deny(message);
    }
  }

  /** True means this is a supported native request, now waiting for PUI input. */
  handle(backend: 'codex' | 'omp', frame: RpcFrame, turnId: string, reply: (frame: RpcFrame) => void): boolean {
    const method = text(frame.method), params = record(frame.params), epoch = this.epoch;
    let run: (() => Promise<RpcFrame>) | undefined;
    if (backend === 'codex' && frame.id != null) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
        run = async () => {
          const prompt = [text(params.reason) || 'Approve this tool action?', text(params.command),
            params.cwd ? `Directory: ${text(params.cwd)}` : ''].filter(Boolean).join('\n');
          const choice = await this.ask(turnId, prompt, ['Approve', 'Decline']);
          return { id: frame.id, result: { decision: choice === 'Approve' ? 'accept' : choice === 'Decline' ? 'decline' : 'cancel' } };
        };
      } else if (method === 'item/tool/requestUserInput') {
        run = async () => {
          const answers: Record<string, { answers: string[] }> = {};
          for (const value of Array.isArray(params.questions) ? params.questions : []) {
            if (epoch !== this.epoch) break;
            const question = record(value);
            if (!text(question.id) || !text(question.question) || question.isSecret === true) {
              throw new Error('This native question requires a form PUI cannot safely display');
            }
            const choices = Array.isArray(question.options) ? question.options.map((option) => text(record(option).label)) : undefined;
            const answer = await this.ask(turnId, text(question.question), choices);
            if (answer === null) break;
            answers[text(question.id)] = { answers: [answer] };
          }
          return { id: frame.id, result: { answers } };
        };
      }
    } else if (backend === 'omp' && frame.type === 'extension_ui_request' && typeof frame.id === 'string') {
      if (method === 'confirm') run = async () => ({ type: 'extension_ui_response', id: frame.id,
        confirmed: await this.ask(turnId, [text(frame.title), text(frame.message)].filter(Boolean).join('\n'), ['Confirm', 'Decline']) === 'Confirm' });
      else if (method === 'select' || method === 'input' || method === 'editor') run = async () => {
        const choices = method === 'select' && Array.isArray(frame.options) ? frame.options.map(text) : undefined;
        const value = await this.ask(turnId, text(frame.title) || 'Your response', choices);
        return { type: 'extension_ui_response', id: frame.id, ...(value === null ? { cancelled: true } : { value }) };
      };
      else if (method === 'cancel') { this.cancel(); return true; }
    }
    if (!run) return false;
    void run().then(reply).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'error', scope: 'command', code: 'native_question_failed', message, recoverable: true });
      reply(backend === 'codex' ? { id: frame.id, error: { code: -32602, message } }
        : { type: 'extension_ui_response', id: frame.id, cancelled: true });
    });
    return true;
  }
}
