/**
 * `dispatch:framing` — small template Oracle uses when delegating to
 * an agent role via dispatchToAgent. Args:
 *   - role: target role (architect, orchestrator, …)
 *   - context: short plain-English description of what's being asked
 *   - feature: optional feature/issue id
 *
 * Returns the canonical first-message wording. Centralizing this lets
 * Oracle/delegate emit consistent dispatch messages and lets external
 * agents borrow the convention.
 */

import { definePrompt } from '@papercusp/tooldef';
import type { PromptResult } from '@papercusp/tooldef';

export default definePrompt({
  name: 'dispatch:framing',
  description:
    'Boilerplate first-message framing for dispatchToAgent. Args: role, context, feature?.',
  arguments: [
    { name: 'role', description: 'Target agent role.', required: true },
    {
      name: 'context',
      description: 'One-paragraph description of what the agent should focus on.',
      required: true,
    },
    {
      name: 'feature',
      description: 'Optional feature/issue id (F-001, BRIEF-BRF-12).',
    },
  ],
  async render(args): Promise<PromptResult> {
    const role = args.role || '<role>';
    const context = args.context || '<context>';
    const feature = args.feature ? `\n\nRelated: ${args.feature}.` : '';

    const text =
      `You are the ${role} for this harness. ` +
      `The Operator is dispatching this to you because:\n\n${context}${feature}\n\n` +
      `Begin by acknowledging what you've understood, then proceed.`;
    return {
      description: `Dispatch framing for role "${role}".`,
      messages: [{ role: 'user', content: { type: 'text', text } }],
    };
  },
});
