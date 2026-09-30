/**
 * Shared prompt definitions for the Oracle + Delegate MCP servers.
 *
 * Three prompts:
 *   - oracle:system     — Oracle persona (concierge/router)
 *   - delegate:system   — delegate persona (cross-harness work)
 *   - dispatch:framing  — first-message wording for dispatchToAgent
 */

export const SHARED_PROMPTS = [
  {
    name: 'oracle:system',
    description:
      'Oracle persona: workspace concierge that answers questions and dispatches to agents.',
    arguments: [],
  },
  {
    name: 'delegate:system',
    description:
      'Delegate persona: spawned by Oracle to do cross-harness reads and dispatches without UI bolt-ons.',
    arguments: [],
  },
  {
    name: 'dispatch:framing',
    description:
      'Boilerplate first-message framing for dispatchToAgent. Args: role, context, feature?',
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
        required: false,
      },
    ],
  },
];

const ORACLE_SYSTEM_TEXT = `\
You are the Oracle. You sit at the workspace level: you can read across
all harnesses, navigate the user's browser, list and resume chats, and
dispatch work to role-scoped agents. Prefer the lightest action that
answers the user's question. If a tool already produces what they need,
return its output verbatim instead of paraphrasing.`;

const DELEGATE_SYSTEM_TEXT = `\
You are a delegate spawned by the Oracle to do cross-harness work
without a browser channel. Read with listHarnesses, getHarnessStatus,
listChats, listAgents. Write with dispatchToAgent or followUpInChat.
Do not narrate your steps; return the answer.`;

function dispatchFraming(args) {
  const role = String(args?.role ?? '<role>');
  const context = String(args?.context ?? '<context>');
  const feature = args?.feature ? `\n\nRelated: ${args.feature}.` : '';
  return (
    `You are the ${role} for this harness. ` +
    `The Operator is dispatching this to you because:\n\n${context}${feature}\n\n` +
    `Begin by acknowledging what you've understood, then proceed.`
  );
}

/** Render a prompt by name with provided args. */
export function runSharedPrompt(name, args = {}) {
  if (name === 'oracle:system') {
    return {
      description: 'Oracle persona — workspace concierge.',
      messages: [
        { role: 'system', content: { type: 'text', text: ORACLE_SYSTEM_TEXT } },
      ],
    };
  }
  if (name === 'delegate:system') {
    return {
      description: 'Delegate persona — cross-harness work.',
      messages: [
        { role: 'system', content: { type: 'text', text: DELEGATE_SYSTEM_TEXT } },
      ],
    };
  }
  if (name === 'dispatch:framing') {
    if (!args?.role || !args?.context) {
      throw new Error('dispatch:framing requires both role and context arguments.');
    }
    return {
      description: `Dispatch framing for role "${args.role}".`,
      messages: [
        { role: 'user', content: { type: 'text', text: dispatchFraming(args) } },
      ],
    };
  }
  throw new Error(`Unknown prompt: ${name}`);
}
