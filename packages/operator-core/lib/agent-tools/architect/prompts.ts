/**
 * Prompt composition for architect:chat + brainstorm:chat. Extracted
 * here so the tool handlers can be self-contained (IPC allowlist
 * eligibility): every disk/PG read that builds the prompt lives in
 * one place, dispatched by the tool itself rather than the Hono route
 * shim.
 *
 * Layering note: imports `harnessDir`/`safeRead`/`parseFeatures`/
 * `resolvePhasedProject` from `app/api/_hono/harness.ts`. That's a
 * reverse-direction edge (lib → app) — flagged because the helpers
 * predate this split and have many other call-sites on the route side.
 * Folding them into a `lib/harness/project.ts` is a documented future
 * refactor; for now, this file is the only place outside `app/api/`
 * that imports from harness.ts, so the smell is bounded.
 */

import { join } from 'node:path';
import { type ProjectEntry } from '../../harness-registry';
import {
  harnessDir,
  safeRead,
  parseFeatures,
  resolvePhasedProject,
} from '../../harness-core';
import { type Phase, phasePhaseLabel } from '../../harness-phases';
import { buildMemoryContextBlock } from '../../memory/injection';
import { activeWorkspaceId } from '../../workspace-registry';

export type ChatHistoryEntry = { role: 'user' | 'assistant'; content: string };

function reviewsDir(project: ProjectEntry): string {
  return join(harnessDir(project), 'pending-reviews');
}

function brainstormPath(project: ProjectEntry): string {
  return join(harnessDir(project), 'brainstorm.md');
}

export async function resolveSlug(
  slug: string,
  phase: string | undefined,
): Promise<ProjectEntry | null> {
  return resolvePhasedProject(slug, phasePhaseLabel(phase));
}

export async function composeArchitectPrompt(
  project: ProjectEntry,
  history: ChatHistoryEntry[],
  message: string,
  reviewId?: string,
): Promise<string> {
  const featuresList = await parseFeatures(project);
  const features = JSON.stringify(
    { features: featuresList.map((f) => ({ id: f.id, title: f.title, status: f.status, attempts: f.attempts })) },
    null,
    2,
  );
  const issues = safeRead(join(harnessDir(project), 'issues.md')) ?? '';
  let reviewContext = '';
  if (reviewId) {
    const rpath = join(reviewsDir(project), `${reviewId.replace(/[^A-Za-z0-9_.-]/g, '')}.json`);
    const rraw = safeRead(rpath);
    if (rraw) reviewContext = `\n\n## Pending review in context\n\n${rraw}\n`;
  }

  const systemPrompt = `You are the ARCHITECT in an autonomous coding harness, chatting with the human supervisor through the /harness Inbox.

Your job is to help them clarify intent: ask Socratic questions about any vagueness until the user's intent is precise and testable, then propose a concrete plan item or decision.

Current state:

## features (harness_features in Postgres — summary)
${features.slice(0, 3000)}

## issues.md tail
${issues.slice(-3000)}
${reviewContext}

Rules:
- Prefer short, pointed clarifying questions over long speeches.
- When you're ready to propose a change, emit a fenced block. The UI shows the user a summary + Accept button; they trust you on the mechanical details.

Format for plan proposals:
\`\`\`proposal:contract
SUMMARY: <1–3 sentences in plain English: what will change and why. This is the ONLY text the user reads by default.>
---
<complete replacement file contents — verbatim, nothing elided>
\`\`\`

Use \`proposal:contract\` as the fence language. First line after the fence MUST start with \`SUMMARY:\` then human-facing text; then a line \`---\`; then the full replacement body.

For a supervisor note (short message appended, not replacing a file):
\`\`\`note:supervisor
<text that appends to supervisor-notes.md>
\`\`\`

When the user wants you to create a *plan* (not a feature or spec change), emit a \`promote:plan\` block instead. This creates a new standalone plan document that feeds the plan→feature pipeline.

\`\`\`promote:plan
TITLE: <Short imperative title>
STATUS: draft
SUMMARY: <1–3 sentences the human reads before accepting. What will the plan contain and what problem does it solve.>
---
## Now

**State:** <One paragraph where things currently stand.>
**Next:** <One sentence — single next concrete action and who should take it.>

## Phase 1 — <Phase name>

- **P-001** \`todo\` <Concrete work item — imperative, testable, one sentence>
- **P-002** \`todo\` <Next item>

## Phase 2 — <Phase name>

- **P-003** \`todo\` <…>

## Decisions

### D-001: <Decision title>
<Rationale — why this choice, what was rejected.>
\`\`\`

Rules for \`promote:plan\`:
- The body (after \`---\`) must be valid plan markdown — it is written verbatim. The \`## Now\` block is mandatory; at least one phase with at least one item is required.
- Item IDs (P-NNN) are placeholders in the proposal; the server re-allocates real sequential IDs on Accept.
- Plan items must use the parser grammar \`- **P-NNN** \`todo\` <text>\`; do not use Markdown checkbox syntax.
- Decision IDs (D-NNN) are similarly re-allocated; keep them for cross-referencing within the block.
- \`STATUS: draft\` is the only valid value at creation time.
- Prefer 3–8 items per phase; keep phases focused. Do not invent items to pad.

For a supervisor note (short message appended, not replacing a file):
\`\`\`note:supervisor
<text that appends to supervisor-notes.md>
\`\`\`

Rules for proposals:
- The summary is what the user sees. Make it precise and plain-English. No jargon without definition.
- The body must be complete — do not elide. The UI writes it verbatim on Accept.
- Be decisive but never fabricate facts. If you don't know a constraint, ask instead of proposing.`;

  // Architect runs inside one specific harness — fan out to its
  // harness-scoped memory pool (plus the legacy workspace pool which
  // injection.ts still reads through for back-compat).
  const memBlock = await buildMemoryContextBlock({
    userId: null,
    workspaceId: activeWorkspaceId(),
    harnessSlugs: [project.slug],
    queryContext: message,
    heading: 'Architect memory (relevant entries)',
  });
  const memorySection = memBlock ? `\n\n---\n\n${memBlock}` : '';

  const trimmed = history.slice(-10);
  const fullPrompt = [
    ...trimmed.map((m) => `${m.role === 'user' ? 'User' : 'Architect'}: ${m.content}`),
    `User: ${message}`,
    'Architect:',
  ].join('\n\n');

  return `${systemPrompt}${memorySection}\n\n---\n\n${fullPrompt}\n`;
}

export async function composeBrainstormPrompt(
  project: ProjectEntry,
  history: ChatHistoryEntry[],
  message: string,
): Promise<string> {
  const brainstorm = safeRead(brainstormPath(project)) ?? '';
  const featuresList = await parseFeatures(project);
  const features = JSON.stringify(
    { features: featuresList.map((f) => ({ id: f.id, title: f.title, status: f.status })) },
    null,
    2,
  );

  const systemPrompt = `You are a BRAINSTORM PARTNER for a software project. You're chatting with the human supervisor of a coding harness to help them explore ideas before they become features.

Your job: expand the space of possibilities. Suggest analogues, probe "have you considered…", challenge hidden assumptions. You are expansive, not reductive. This is pre-plan ideation — nothing needs to be final yet.

Current state:

## Existing features (harness_features in Postgres — summary)
${features.slice(0, 2000)}

## Brainstorm scratchpad (what the user is working on)
${brainstorm.slice(0, 8000)}

Rules:
- Lead with ideas, tradeoffs, analogues from other domains. Be concrete.
- When an idea matures enough to be acted on, emit a fenced action block:
  - \`\`\`promote:feature — create a new todo feature in harness_features. Put a short title on the first line, then markdown body explaining intent + optional claims.
  - \`\`\`promote:plan — create a new plan document that feeds the plan→feature pipeline.
  - \`\`\`promote:issue — file as an issue in issues.json. First line is title; rest is evidence/context.
- Don't promote too eagerly. Wait until the user signals the idea is ready, or ask them first.
- Keep responses short and punchy. Long speeches kill brainstorming.`;

  // Brainstorm is also harness-scoped (called from a specific
  // harness's inbox) — same fan-out shape as architect.
  const memBlock = await buildMemoryContextBlock({
    userId: null,
    workspaceId: activeWorkspaceId(),
    harnessSlugs: [project.slug],
    queryContext: message,
    heading: 'Brainstorm memory (relevant entries)',
  });
  const memorySection = memBlock ? `\n\n---\n\n${memBlock}` : '';

  const trimmed = history.slice(-10);
  const fullPrompt = [
    ...trimmed.map((m) => `${m.role === 'user' ? 'User' : 'Partner'}: ${m.content}`),
    `User: ${message}`,
    'Partner:',
  ].join('\n\n');

  return `${systemPrompt}${memorySection}\n\n---\n\n${fullPrompt}\n`;
}
