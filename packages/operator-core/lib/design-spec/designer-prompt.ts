/**
 * Designer agent prompt assembler.
 *
 * Composes the prompt the designer agent loads when spawned for a
 * feature. Inputs come from the design-phase plan §4.1:
 *   - feature record (description, acceptance criteria)
 *   - DESIGN_SPEC.md (resolved via fallback chain)
 *   - component registry summary
 *   - token store summary
 *   - adjacent design memos
 *   - current-surface screenshot URL (for redesigns)
 *
 * The MCP surface (§15) is what the designer queries at runtime; this
 * file builds the *initial* prompt with the framing + everything
 * static-able.
 */
import { renderResolvedSpec, type ResolvedDesignSpec } from './resolver';
import { IR_VERSION } from '../design-ir/schema';

export interface DesignerPromptInputs {
  /** The resolved DESIGN_SPEC.md document. */
  designSpec: ResolvedDesignSpec;
  /** The feature being designed. */
  feature: {
    id: string;
    title: string;
    summary?: string | null;
    acceptanceCriteria?: string | null;
    /** When set, this is a redesign; designer should consult current state. */
    isRedesign?: boolean;
  };
  /** Summary of the component registry — names + summaries only;
   *  designer queries the full entry via MCP `getRegistryComponent`. */
  registrySummary?: ReadonlyArray<{ id: string; summary: string }>;
  /** Summary of the active DTCG token store — IDs + types only. */
  tokenSummary?: ReadonlyArray<{ id: string; type: string }>;
  /** Adjacent memos worth knowing about (slug + title). */
  memos?: ReadonlyArray<{ slug: string; title: string; status: string }>;
  /** The active ecosystem the designer is targeting. */
  ecosystem: string;
  /** The IR-version the active adapters support. */
  irVersion?: string;
}

const FRAMING = `You are the **designer agent** for the papercusp design phase.

Your job is to produce a UI specification (the **UI IR**), not to write
implementation code. The implementer agent that runs after you will
read your spec and write the actual code. If you are tempted to commit
component code, stop — you are about to collapse your role into the
implementer's.

## What you produce

A single JSON document that validates against the UI IR v{{IR_VERSION}}
schema. Submit via the \`submitSpec\` MCP tool. Self-check first with
\`lintSpec\` and \`validateSpec\`.

## What you read

- This prompt + the resolved DESIGN_SPEC below — your global rules
- The component registry (search via \`searchRegistry\`, get full
  entries via \`getRegistryComponent\`)
- The token store (\`listTokens\`, \`readToken\`)
- Adjacent design memos (\`listMemos\`, \`readMemo\`) — past decisions
  in this codebase that bind your choices
- For redesigns: a current-surface screenshot via
  \`captureCurrentSurface\`

## How you think

1. Read the feature description and acceptance criteria.
2. Search the registry for components that already serve this purpose.
   **Always prefer existing components** — if one fits, use it.
3. Search adjacent memos for prior decisions that constrain you.
4. Sketch the layout in your head: what's the surface? What states does
   it have? What interactions? Where does i18n copy go?
5. If you need a token that doesn't exist, declare it in
   \`tokens.proposed[]\` with a reason — do not inline literals.
6. If you need a component that doesn't exist, write the spec assuming
   it exists; the registry team adds it. Do not silently inline.
7. Emit IR. Run \`lintSpec\` until clean (zero errors; warnings OK with
   justification).
8. Submit.

## Constraints (non-negotiable)

- Output IR JSON, never JSX/Tailwind/Qt/etc.
- Every user-facing string is \`{ key, default }\`, even when no i18n
  runtime exists yet.
- Visual properties reference tokens, never literals.
- Every interactive element has \`a11y.role\` or \`ariaLabel\` (or maps
  to a registry component that supplies one).
- Loading states have \`aria-live\` regions.
- Error states have a recovery action.
- \`kind: "raw"\` is forbidden unless the IR genuinely cannot express
  what you need — and even then, document why.

## Output

The MCP \`submitSpec\` tool takes \`(featureId, ir)\`. The runtime
validates + lints; you'll see the result and can iterate.

`;

/**
 * Build the full designer-agent prompt as a single string.
 */
export function buildDesignerPrompt(input: DesignerPromptInputs): string {
  const parts: string[] = [];

  parts.push(FRAMING.replace('{{IR_VERSION}}', input.irVersion ?? IR_VERSION));

  parts.push('## Feature', '');
  parts.push(`- **id:** \`${input.feature.id}\``);
  parts.push(`- **title:** ${input.feature.title}`);
  if (input.feature.summary) parts.push(`- **summary:** ${input.feature.summary}`);
  if (input.feature.acceptanceCriteria) {
    parts.push('', '### Acceptance criteria', '', input.feature.acceptanceCriteria);
  }
  if (input.feature.isRedesign) {
    parts.push('', '> **This is a redesign.** Call `captureCurrentSurface(featureId)` before sketching, so you understand what already exists. Justify every change against the current state.');
  }
  parts.push('');

  parts.push(`## Target ecosystem`, '', `\`${input.ecosystem}\``, '');

  parts.push('## Resolved DESIGN_SPEC.md', '', renderResolvedSpec(input.designSpec), '');

  if (input.registrySummary && input.registrySummary.length > 0) {
    parts.push('## Component registry (summary)', '');
    parts.push('| id | summary |');
    parts.push('|---|---|');
    for (const r of input.registrySummary) {
      parts.push(`| \`${r.id}\` | ${r.summary} |`);
    }
    parts.push('');
    parts.push('Use `getRegistryComponent(id)` for full props, variants, examples.', '');
  }

  if (input.tokenSummary && input.tokenSummary.length > 0) {
    parts.push('## Tokens (summary)', '');
    parts.push('| id | type |');
    parts.push('|---|---|');
    for (const t of input.tokenSummary) {
      parts.push(`| \`${t.id}\` | ${t.type} |`);
    }
    parts.push('');
    parts.push('Use `readToken(id)` for value + metadata.', '');
  }

  if (input.memos && input.memos.length > 0) {
    parts.push('## Relevant design memos', '');
    for (const m of input.memos) {
      parts.push(`- \`${m.slug}\` — ${m.title} *(${m.status})*`);
    }
    parts.push('');
    parts.push('Use `readMemo(slug)` to load any of these in full.', '');
  }

  return parts.join('\n');
}
