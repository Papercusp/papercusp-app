/**
 * buildPlanContextBundle — the invariant launch seed for a plan agent.
 *
 * plan-agent-launch-2026-05-21, Phase 2 (P-009 / D-002).
 *
 * `plans:launch` (P-012) seeds a launched plan agent with this bundle
 * as its `systemPromptText`. The bundle is INVARIANT — there is no
 * context-depth choice (D-002). It has three parts:
 *
 *   1. a framing preamble — what the agent is, and what to do;
 *   2. the plan doc verbatim — the settled spec (`## Now`, items,
 *      decisions, prose);
 *   3. the per-revision rationale digest — the *why* behind each past
 *      change, the reasoning the plan doc itself does not carry.
 *
 * Raw conversation transcripts are NEVER inlined (D-002 / D-005): they
 * are retrievable on demand and scoped (P-008). The rationale digest
 * is the bounded, always-seeded distillation — one short entry per
 * revision that recorded a `rationale`.
 */

import { hashPlanContent } from './content-hash';
import { readPlanBySlug, resolvePlanScope, type PlanSourceOpts } from './source';
import { listPlanRevisions } from './revisions';
import { PLAN_STATUSES, type PlanStatus } from './parser';
import { readPlanHistoryContext, type PlanHistoryContext } from '../../prior-attempt-context';
import {
  readDelegationCounts,
  renderDelegationCount,
  type DelegationCounts,
  type PopulationCount,
} from '../../delegation-counts';
import type { ProviderRead } from '../../agent-obligation-providers';

const SECTION_RULE = '═══════════════════════════════════════════════════════════════';

/**
 * The framing preamble — what a launched plan agent is and does.
 * Static: every launch gets the same instruction (D-002 — the seed is
 * invariant, no context-depth knob).
 */
const LAUNCH_PREAMBLE = `# Plan agent — launched to advance a plan

You are an autonomous agent launched from a Papercusp plan. Your job
is to move that plan forward.

Read the plan below in full, starting with its \`## Now\` block — it
states where the plan stands and what the next action is. Then pick
up the next actionable item and work it.

The plan doc is the settled spec. The revision history that follows
it is the *reasoning* — why each past change was made, the arguments
and constraints that shaped decisions but were never written as plan
lines. Treat it as binding context: it is there so you do not
re-litigate questions the plan has already settled.

When you change the plan, record your reasoning — pass a \`rationale\`
to the \`plans:*\` write verb you use. That rationale becomes the
always-loaded context for the next agent launched on this plan.`;

/** One revision's rationale, as fed to the digest. */
export interface PlanBundleRationale {
  /** 1-based per-plan revision number. */
  seq: number;
  /** Revision creation time, epoch ms. */
  createdAt: number;
  /** Who made the revision. */
  authorKind: 'agent' | 'human';
  /** The recorded "why" — non-empty (the assembler is fed only
   *  revisions that have a rationale). */
  rationale: string;
}

/** Flat input to the pure assembler — everything the seed text needs,
 *  in a shape trivial to construct in a test. */
export interface PlanBundleInput {
  title: string;
  slug: string;
  status: PlanStatus | null;
  /** The plan doc verbatim — the parser `raw` field. */
  planMarkdown: string;
  /** Revision rationales newest-first; only revisions that recorded
   *  one (rationale-less revisions are omitted, not shown as blanks). */
  rationales: PlanBundleRationale[];
  /** The RESOLVED inputs this run executes with (plan-structured-inputs P-009).
   *  Omitted/null for a plan that declares none — the block is then absent entirely
   *  rather than rendered empty, so an un-parameterized plan's seed is unchanged. */
  inputs?: unknown;
  /** The plan's declared JSON Schema, used ONLY to label each input with its
   *  `description` and to mark which are required. Never rendered itself. */
  inputSchema?: unknown;
  history?: PlanHistoryContext;
  /**
   * The four live delegation counts, read in THIS render pass (P-006 / R-5).
   *
   * Three distinct states, kept distinct on purpose:
   *   - a `DelegationCounts` — render the posture block from these values;
   *   - `null` — the provider was reached for and failed; render the block in its
   *     explicit measurement-failed form, because a silent omission reads as "nothing
   *     is pending";
   *   - absent/`undefined` — no delegation read was attempted at all (a pure-assembly
   *     unit test, or a caller that does not seed delegation), so the block is omitted
   *     entirely and the seed is byte-identical to its pre-P-006 form.
   */
  delegation?: DelegationCounts | null;
}

/** The assembled bundle plus the launch metadata `plans:launch` needs. */
export interface PlanContextBundle {
  /** The assembled seed text — preamble + plan doc + rationale digest.
   *  Goes straight into the plan-agent runner's `systemPromptText`. */
  text: string;
  slug: string;
  /** Frontmatter title, or the slug when untitled. */
  title: string;
  /** Lifecycle status — P-012 warns before launching a `superseded` plan. */
  status: PlanStatus | null;
  /** True when the plan lives in `docs/plans/archive/`. */
  archived: boolean;
  /** `hashPlanContent` of the plan doc — byte-identical to `plans:get`'s
   *  `contentHash`; P-012 stamps it on the `plan_runs` row as
   *  `plan_content_hash` (P-023's version badge compares against it). */
  contentHash: string;
  /** Number of revisions whose rationale entered the digest. */
  rationaleCount: number;
  history?: PlanHistoryContext;
}

/** Render one revision as a digest entry — a `· rev N` header line and
 *  the rationale indented beneath it (continuation lines indented too,
 *  so a multi-line rationale stays visually grouped). */
function formatRationaleEntry(r: PlanBundleRationale): string {
  const date = new Date(r.createdAt).toISOString().slice(0, 10);
  const body = r.rationale
    .trim()
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  return `· rev ${r.seq} — ${date} — ${r.authorKind}\n${body}`;
}

/**
 * Render the INPUTS block (plan-structured-inputs P-009) — the arguments this run was
 * started with, or '' when the plan declares none.
 *
 * This block is the whole reason the feature is not inert. Before it, a launched plan
 * agent received the plan markdown and the revision digest and nothing else, so a plan
 * whose text said "audit each path in `paths`" gave the agent no `paths`.
 *
 * Each value is JSON-encoded (not prose-formatted) so the agent can tell a string from
 * a one-element array, and each carries its schema `description` when one exists —
 * that description is the only place a plan author can explain what an argument MEANS,
 * so dropping it would leave the agent guessing at intent it was told.
 *
 * Values are delivered HERE, structurally, and never interpolated into the plan prose
 * (D-005): the moment `{{ inputs.x }}` renders inside plan markdown this becomes a
 * template language, and it grows conditionals within a month.
 */
export function renderInputsBlock(inputs: unknown, inputSchema: unknown): string {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return '';
  const entries = Object.entries(inputs as Record<string, unknown>);
  if (entries.length === 0) return '';

  const schema =
    inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)
      ? (inputSchema as { properties?: Record<string, { description?: unknown }>; required?: unknown })
      : null;
  const required = new Set(
    Array.isArray(schema?.required) ? schema!.required.filter((r): r is string => typeof r === 'string') : [],
  );
  const pad = Math.max(...entries.map(([k]) => k.length));

  const lines = entries.map(([k, v]) => {
    const desc = schema?.properties?.[k]?.description;
    const note = [required.has(k) ? 'required' : null, typeof desc === 'string' && desc.trim() ? desc.trim() : null]
      .filter(Boolean)
      .join(' — ');
    let rendered: string;
    try {
      rendered = JSON.stringify(v) ?? String(v);
    } catch {
      rendered = String(v);
    }
    return `${k.padEnd(pad)} = ${rendered}${note ? `   (${note})` : ''}`;
  });

  return [SECTION_RULE, 'INPUTS — the arguments this run was started with', SECTION_RULE, '', ...lines, ''].join('\n');
}

/** The four counts, in the order R-5 names them, with their brief labels. */
const DELEGATION_COUNT_LABELS = [
  ['planExecutionAgents', 'live plan-execution agents'],
  ['plansAwaitingDelegation', 'actionable plans awaiting delegation'],
  ['plansAwaitingAcceptance', 'plans awaiting acceptance'],
  ['activeDrainFleets', 'active drain fleets'],
] as const satisfies ReadonlyArray<readonly [keyof DelegationCounts, string]>;

/**
 * True only when the population is measured, empty, AND has no unmeasured residue.
 *
 * The residue check is the load-bearing half. `{ count: 0, unmeasured: 3 }` is a
 * FLOOR of zero over a partially-classified population — "I found none among the
 * ones I could classify" — which is not the same claim as "there are none", and
 * only the second one may authorize a launch or an idle report. Collapsing the two
 * would reintroduce the bounded-measurement-as-verdict error one layer above the
 * provider that went to the trouble of reporting the residue.
 */
function isKnownZero(read: ProviderRead<PopulationCount>): boolean {
  return read.status !== 'unknown' && read.value.count === 0 && read.value.unmeasured === 0;
}

/** True when at least one member is established. A positive count is sound even
 *  with an unmeasured residue — the residue can only make a floor larger. */
function isKnownPositive(read: ProviderRead<PopulationCount>): boolean {
  return read.status !== 'unknown' && read.value.count > 0;
}

/**
 * Decide the ONE next action the brief directs, under R-6's priority order.
 *
 * Acceptance outranks delegation, and delegation outranks idling. The interesting
 * cases are the unmeasured ones, and they all resolve the same way: an unknown
 * NEVER authorizes an action. Specifically —
 *
 *  - a launch needs THREE established facts (no pending acceptance, zero live
 *    plan-execution agents, at least one plan awaiting delegation). An unknown in
 *    any of the three withholds the launch, because D-005 makes launch conditional
 *    on a live zero-agent count, and an unmeasured count is not a zero one;
 *  - an IDLE report is also a claim, not a default. "No actionable plan exists"
 *    read off a failed measurement is how a brief tells an agent to stand down
 *    while work is in fact waiting, so an unknown reports the unknown instead.
 *
 * That asymmetry is deliberate: the two error directions are not symmetric in cost
 * (spawning into taken work vs. idling past open work), but BOTH are wrong, so the
 * unknown branch claims neither.
 */
function directedDelegationAction(counts: DelegationCounts): string {
  if (isKnownPositive(counts.plansAwaitingAcceptance)) {
    return (
      'ACCEPTANCE FIRST — at least one plan is awaiting acceptance. Finish that acceptance flow ' +
      '(grade it, or drive the recruited independent grader to a scorecard, then transition the plan ' +
      'explicitly to `shipped`) BEFORE selecting any new plan to execute. Do not launch a plan fleet to ' +
      'work around a pending acceptance.'
    );
  }

  const acceptanceSettled = isKnownZero(counts.plansAwaitingAcceptance);
  const noLiveAgents = isKnownZero(counts.planExecutionAgents);
  const haveActionable = isKnownPositive(counts.plansAwaitingDelegation);

  if (acceptanceSettled && noLiveAgents && haveActionable) {
    return (
      'DELEGATE — no acceptance is pending and live plan-execution agents is 0, so select the next ' +
      'actionable plan and launch or attach a plan fleet for it. Confirm the plan you pick actually ' +
      'yields a pickable item first (see the upper-bound note below).'
    );
  }

  // The idle third state. Deliberately NOT conditioned on `noLiveAgents`: with
  // nothing awaiting acceptance and nothing actionable there is no delegation to
  // make whether or not agents are already running, so adding that clause would
  // only send the both-zero case to the DO-NOT-SPAWN fallback when the count is
  // merely unknown. (A second, `noLiveAgents`-guarded idle branch used to sit
  // directly below this one; its condition was strictly stronger than this one's,
  // so this branch always returned first and it was unreachable.)
  if (acceptanceSettled && isKnownZero(counts.plansAwaitingDelegation)) {
    return (
      'REPORT IDLE — no plan is awaiting acceptance and no actionable plan is awaiting delegation. ' +
      'Report idle / no work. DO NOT launch an agent: there is nothing for it to pick up, and an idle ' +
      'agent consumes budget while making the next real delegation harder to see.'
    );
  }

  if (acceptanceSettled && haveActionable && !noLiveAgents) {
    return (
      'HOLD — an actionable plan is waiting, but live plan-execution agents is not an established 0 ' +
      `(${renderDelegationCount(counts.planExecutionAgents)}). Plan execution is already staffed, or the ` +
      'count could not be established. Either way, do not add another agent on top of it; report the ' +
      'state instead.'
    );
  }

  return (
    'DO NOT SPAWN — the delegation picture is not established (see the counts above; ' +
    `degraded sources: ${counts.degradedSources.length > 0 ? counts.degradedSources.join(', ') : 'none'}). ` +
    'An unmeasured count is neither a zero nor a green light. Report what could not be measured and why, ' +
    'and do not launch a plan fleet or claim idle off an unknown.'
  );
}

/**
 * Render the DELEGATION POSTURE block — the four LIVE counts plus the
 * acceptance-first priority order (P-006, bars R-5 and R-6).
 *
 * Why this block exists at all: the launch preamble above it is static by design
 * (D-002 — the seed is invariant), and a delegation count baked into static prompt
 * text is stale the moment it is written. D-004 settles that these values come from
 * the shared provider AT DECISION TIME, so they are rendered here, per launch, from
 * a read taken in this same render pass — never from a constant.
 *
 * `counts === null` means the provider itself was unreachable. That renders as an
 * explicit measurement failure rather than being omitted: a brief that silently
 * drops the block looks identical to one reporting that nothing is pending, and the
 * agent would then have no way to tell "nothing to do" from "I never looked".
 */
export function renderDelegationPostureBlock(counts: DelegationCounts | null): string {
  const header = [SECTION_RULE, 'DELEGATION POSTURE — live at launch, not a prompt constant', SECTION_RULE, ''];

  // The priority order is stated unconditionally, including on the failure path:
  // it is a policy, so it does not depend on whether this read succeeded.
  const priority = [
    'PRIORITY ORDER — apply top-first; a lower rule never pre-empts a higher one:',
    '  1. ACCEPTANCE — finish any plan awaiting acceptance before starting new plan execution.',
    '  2. DELEGATION — only then, and only if live plan-execution agents is 0 and an actionable',
    '     plan exists, select the next plan and launch or attach a plan fleet.',
    '  3. IDLE — if no actionable plan exists, report idle / no work. Never spawn an idle agent.',
    '',
  ];

  if (!counts) {
    return [
      ...header,
      '⚠ The live delegation counts could not be read on this launch. They are UNKNOWN — which is not',
      '  the same as zero, and must not be rounded to one.',
      '',
      ...priority,
      'DIRECTED NEXT ACTION',
      '  DO NOT SPAWN — the delegation picture was never measured. Report that the counts were',
      '  unavailable; do not launch a plan fleet, and do not claim idle, off a failed measurement.',
      '',
    ].join('\n');
  }

  const pad = Math.max(...DELEGATION_COUNT_LABELS.map(([, label]) => label.length));
  const countLines = DELEGATION_COUNT_LABELS.map(
    ([key, label]) => `  ${label.padEnd(pad)} : ${renderDelegationCount(counts[key])}`,
  );

  const degraded =
    counts.degradedSources.length > 0
      ? ['', `⚠ Sources that degraded to unknown on this read: ${counts.degradedSources.join(', ')}.`]
      : [];

  return [
    ...header,
    `Read from the shared provider at ${counts.observedAt} (${counts.elapsedMs}ms, ${counts.schemaVersion}).`,
    'These are point-in-time values. If you are about to act on one, re-read it — do not trust this',
    'line an hour from now.',
    '',
    ...countLines,
    ...degraded,
    '',
    ...priority,
    'DIRECTED NEXT ACTION',
    ...directedDelegationAction(counts)
      .split('\n')
      .map((line) => `  ${line}`),
    '',
    '⚠ `actionable plans awaiting delegation` is a PLAN-level UPPER BOUND, deliberately wider than',
    '  `plans:items { actionable: true }`. It answers "does this plan need an agent?" and does not',
    '  apply the item-level gating that withholds items with a linked blocked work-item, or items',
    '  already under live coverage. So a plan whose only `todo` items are blocked is counted here and',
    '  would still yield no pickable item. Before you launch against this number, confirm the plan you',
    '  picked actually has a pickable item; a non-zero count is a reason to LOOK, not a guarantee.',
    '',
  ].join('\n');
}

/**
 * Assemble the seed text. Pure — no IO — so the assembly is unit
 * testable without the FS or the embedded PG; `buildPlanContextBundle`
 * does the reads and calls this.
 */
export function assemblePlanContextBundleText(input: PlanBundleInput): string {
  const headerLines = [`THE PLAN — ${input.title}`, `slug: ${input.slug}   ·   status: ${input.status ?? 'draft'}`];
  if (input.status === 'superseded') {
    headerLines.push(
      '⚠ This plan is superseded — confirm it is still the right plan ' + 'to work before making changes.',
    );
  }

  const digest =
    input.rationales.length > 0
      ? input.rationales.map(formatRationaleEntry).join('\n\n')
      : 'No revision rationales have been recorded for this plan yet.';

  // The INPUTS block sits BETWEEN the header and the plan body: the agent should know
  // what it was given before it reads instructions that refer to those arguments.
  const inputsBlock = renderInputsBlock(input.inputs, input.inputSchema);

  // The delegation posture sits directly under the preamble, ABOVE the plan body.
  // Placement is behavioural, not cosmetic: R-6 forbids spawning when nothing is
  // actionable, and the plan body is the text most likely to read as "go do this".
  // The agent has to know the posture before it reads an instruction it might act on.
  const delegationBlock =
    input.delegation !== undefined ? renderDelegationPostureBlock(input.delegation) : '';

  return [
    LAUNCH_PREAMBLE,
    '',
    ...(delegationBlock ? [delegationBlock] : []),
    SECTION_RULE,
    headerLines.join('\n'),
    SECTION_RULE,
    '',
    ...(inputsBlock ? [inputsBlock] : []),
    input.planMarkdown.trimEnd(),
    '',
    SECTION_RULE,
    'REVISION HISTORY — the reasoning behind the plan above',
    SECTION_RULE,
    '',
    'Newest first. Each entry is one recorded change and why it was made.',
    '',
    digest,
    '',
    ...(input.history
      ? [SECTION_RULE, 'PLAN HISTORY — own and bounded child evidence', SECTION_RULE, JSON.stringify(input.history), '']
      : []),
  ].join('\n');
}

/**
 * Build the launch context bundle for a plan. Reads the plan doc from
 * the filesystem (canonical) and the rationale chain from
 * `plan_revisions`, then assembles the invariant seed.
 *
 * Returns `null` when the slug does not resolve to a plan — the caller
 * (`plans:launch`) surfaces "plan not found".
 *
 * The revision read is best-effort: the plan doc is the substance of
 * the bundle, so a `plan_revisions` outage must not block a launch —
 * the digest is simply empty when the revision DB is unreachable.
 */
export async function buildPlanContextBundle(
  slug: string,
  opts: PlanSourceOpts & {
    harnessSlug?: string;
    /**
     * The resolved inputs this run executes with (P-009). Passed in by the caller
     * rather than re-read here, because the caller has already had them VALIDATED by
     * the start gate — re-deriving them would risk seeding the agent with values the
     * gate never approved. Omit to fall back to the plan's stored values.
     */
    inputs?: unknown;
    /**
     * The delegation read, injectable (P-006). Production omits it and gets
     * `readDelegationCounts` against the resolved workspace.
     *
     * It is a seam rather than a module mock for two reasons. It lets R-6's falsifier
     * be executed directly — force the actionable count to zero and read the directed
     * action — instead of being approximated. And it keeps a unit test that merely
     * builds a bundle from silently reaching for a database: without the seam that
     * read still "passes" (the provider degrades every source to `unknown` rather
     * than throwing), so the test would quietly assert against an all-unknown posture
     * block while looking like it exercised a real one.
     */
    readDelegation?: (workspaceId: string) => Promise<DelegationCounts | null>;
    /**
     * Per-source budget for the production delegation read. Omitted in production,
     * where `DELEGATION_COUNT_READ_TIMEOUT_MS` (900ms) is correct: this block feeds
     * a turn-start brief, so a slow source must degrade to an explicit unknown
     * rather than hold the launch.
     *
     * It exists for the live integration tests, and it is NOT a convenience. Those
     * tests assert on the DIRECTIVE the block renders, and every source degrading
     * to `unknown` renders a DO-NOT-SPAWN directive — so on a loaded box the 900ms
     * budget turns a wiring assertion into a coin flip whose failure looks exactly
     * like a wrong directive. Widening the budget keeps the PRODUCTION reader (the
     * property those tests exist to check, which `readDelegation` would replace)
     * while removing the load race.
     */
    delegationTimeoutMs?: number;
  } = {},
): Promise<PlanContextBundle | null> {
  const read = await readPlanBySlug(slug, opts);
  if (!read) return null;
  const { parsed, archived, row } = read;

  let rationales: PlanBundleRationale[] = [];
  try {
    // Full (workspaceId, harnessSlug) scope so the rationale digest
    // reads the plan's own workspace spine (audit P-008 / mig 218).
    const scope = await resolvePlanScope(opts);
    const revisions = await listPlanRevisions(slug, scope);
    rationales = revisions
      .filter((r) => typeof r.rationale === 'string' && r.rationale.trim().length > 0)
      .map((r) => ({
        seq: r.seq,
        createdAt: r.createdAt,
        authorKind: r.authorKind,
        rationale: (r.rationale as string).trim(),
      }));
  } catch (err) {
    // Best-effort (D-014 spirit): a revision-DB outage must not block a
    // launch. Proceed with an empty digest; the plan doc still seeds.
    console.warn(
      `[plan-context-bundle] revision history unavailable for ${slug}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const title = parsed.frontmatter.title ?? slug;
  // WI-7259 (sibling of WI-7246): canonical-first — a scheduled-run snapshot
  // copies its parent plan's body verbatim, frontmatter included, so
  // `parsed.frontmatter.status` reads the PARENT's lifecycle for every
  // snapshot. `title` stays frontmatter-first (display text, not identity).
  // `row.status` is an untyped DB column (`string | null`) — narrow it to the
  // parser's PlanStatus union before trusting it over the (already-narrow)
  // frontmatter value; an unrecognized column value falls through instead of
  // widening PlanBundleInput.status's type.
  const rowStatus =
    typeof row.status === 'string' && (PLAN_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as PlanStatus)
      : null;
  const status = rowStatus ?? parsed.frontmatter.status ?? null;
  const history = await readPlanHistoryContext(slug, row.harnessSlug ?? opts.harnessSlug ?? '');

  // R-5: the four counts are read HERE, in the render pass, from the one shared
  // provider — never carried in from a constant or a cache. `readDelegationCounts`
  // is itself uncached and bounds each source, so this cannot hang a launch.
  //
  // Best-effort in the same spirit as the revision digest above, with one deliberate
  // difference: a failure degrades to `null`, NOT to an omitted block. Omitting it
  // would render a seed indistinguishable from one where nothing is pending, and the
  // agent decides whether to SPAWN off that distinction.
  let delegation: DelegationCounts | null = null;
  try {
    const scope = await resolvePlanScope(opts);
    delegation = opts.readDelegation
      ? await opts.readDelegation(scope.workspaceId)
      : await readDelegationCounts({
          workspaceId: scope.workspaceId,
          ...(opts.delegationTimeoutMs != null ? { sourceTimeoutMs: opts.delegationTimeoutMs } : {}),
        });
  } catch (err) {
    console.warn(
      `[plan-context-bundle] delegation counts unavailable for ${slug}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const text = assemblePlanContextBundleText({
    title,
    slug,
    status,
    planMarkdown: parsed.raw,
    rationales,
    inputs: opts.inputs !== undefined ? opts.inputs : row.templateData,
    inputSchema: row.inputSchema,
    history,
    delegation,
  });

  return {
    text,
    slug,
    title,
    status,
    archived,
    contentHash: hashPlanContent(parsed.raw),
    rationaleCount: rationales.length,
    history,
  };
}
