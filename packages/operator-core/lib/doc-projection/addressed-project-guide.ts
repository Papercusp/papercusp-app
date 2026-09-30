/**
 * addressed-project-guide.ts — the LAUNCH side of a blueprint-addressable Project guide
 * (identities-v1-2026-08-30 P-022).
 *
 * The projector (`scripts/project-doc-parts.mjs`) writes the DEFAULT guide — CLAUDE.md /
 * AGENTS.md composed from the UNADDRESSED parts — and every existing reader keeps getting
 * exactly that. A part with a non-empty `stack_scope` never lands in those files; it is
 * delivered HERE, at launch, to a wearer whose expanded stack (`guideAddressesForWearer`)
 * intersects its tokens:
 *
 *   role-launch-spec  ─ wearer = role su + static layers + suSessionBinding(fleetRole, modes)
 *        │               tokens = guideAddressesForWearer(wearer)
 *        ▼
 *   readAddressedGuideParts   SELECT … WHERE stack_scope && tokens AND client_scope && {client,all}
 *        │
 *        ▼
 *   composeProjectGuideForWearer   default text + addressed sections → projectGuideAtBudget
 *        │
 *        ▼
 *   renderSuPlaybook({ composeProjectGuide })   splices the result at PROJECT_GUIDE_MARKER
 *
 * `projectGuideAtBudget` stays the ONE budget seam (the item's explicit constraint): the
 * cap is the projector's own enforced budget, so a wearer's guide can never exceed what
 * the projector promised any reader — and a default guide, which the projector already
 * holds under that budget, passes through untouched (byte-identical).
 *
 * Section rendering mirrors the projector's `assemble` (heading emitted when
 * `target_section` changes; `(preamble)` emits none) and is PINNED to it in
 * addressed-project-guide.test.ts, so the addressed tail reads like the file it follows.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { projectGuideAtBudget } from '../prompt-assembly';
import { guideAddressesForWearer, guideAddressMatches, isPackageGuideAddress, type GuideWearer, type GuideWearerLayer } from './guide-address';

/**
 * The projector's enforced budget (`PROJECTION_BUDGET_CHARS` in project-doc-parts.mjs),
 * restated here as the cap on a WEARER's composed guide and pinned equal in the test —
 * the TS side cannot import the .mjs at runtime without dragging the script's pg client
 * into the operator bundle.
 */
export const ADDRESSED_GUIDE_MAX_CHARS = 160_000;

/** The projector's pseudo-section for parts above the first heading. */
export const GUIDE_PREAMBLE_SECTION = '(preamble)';

export interface AddressedGuidePart {
  part_key: string;
  body: string;
  ordinal: number;
  target_section: string | null;
  stack_scope: string[];
}

export interface ReadAddressedGuidePartsInput {
  workspaceId: string;
  harnessSlug: string;
  /** The composed doc the default guide was projected from (default `claude-md`). */
  docId?: string;
  /** The reader's client file axis — `claude` / `codex` — matched like the projector does. */
  client: string;
  /** The wearer's expanded tokens (`guideAddressesForWearer`). Empty ⇒ no read, no rows. */
  tokens: readonly string[];
  sql?: Sql;
}

/**
 * The live, projecting parts addressed to any of `tokens` for this client, in the
 * projector's read order (ordinal, then part_key). The predicate is exactly
 * `partTargetsClient && partReachesAudience` from the projector, expressed in SQL so the
 * partial GIN index on `stack_scope` (migration 1104) serves it. A `package:` token names
 * one workspace-unique installed resource (P-009 / D-022), so it matches in whichever
 * harness the package installed its part; every other kind stays per guide harness.
 */
export async function readAddressedGuideParts(input: ReadAddressedGuidePartsInput): Promise<AddressedGuidePart[]> {
  if (input.tokens.length === 0) return [];
  const packageTokens = input.tokens.filter(isPackageGuideAddress);
  const harnessTokens = input.tokens.filter((t) => !isPackageGuideAddress(t));
  const s = input.sql ?? getOrgPg().sql;
  const rows = (await s.unsafe(
    `SELECT part_key, body, ordinal, target_section, stack_scope
       FROM harness_shared.harness_doc_parts
      WHERE workspace_id = $1 AND doc_id = $3
        AND tombstone = false
        AND cardinality(stack_scope) > 0
        AND ((harness_slug = $2 AND stack_scope && $4::text[]) OR stack_scope && $6::text[])
        AND client_scope && $5::text[]
      ORDER BY ordinal, part_key`,
    [input.workspaceId, input.harnessSlug, input.docId ?? 'claude-md', harnessTokens, [input.client, 'all'], packageTokens],
  )) as unknown as AddressedGuidePart[];
  return rows;
}

/**
 * Render the addressed parts as the projector would — one `## heading` per change of
 * `target_section`, bodies joined by blank lines — under a lede that tells the reader
 * WHY these sections are here and are absent from the file on disk. Pure.
 */
export function renderAddressedGuideSections(
  parts: readonly AddressedGuidePart[],
  tokens: readonly string[],
  /** Override the lede block (heading + blockquote). The mid-session transition uses this;
   *  launch keeps the default so its render stays byte-identical. */
  lede?: string,
): string {
  if (parts.length === 0) return '';
  const blocks: string[] = [];
  blocks.push(
    lede ??
      '## Addressed guidance — for this session’s stack\n\n' +
        `> The sections below are projected only to a launch whose stack matches ` +
        `${tokens.map((t) => `\`${t}\``).join(', ')}. They are NOT in the repo's \`CLAUDE.md\` — ` +
        'they live as addressed doc parts (`harness_doc_parts.stack_scope`); edit them with ' +
        '`npm run set-doc-part -- --part-key <key> --stack-scope <tokens> …`.',
  );
  let section: string | null = null;
  for (const p of parts) {
    if (p.target_section !== section) {
      section = p.target_section;
      if (section && section !== GUIDE_PREAMBLE_SECTION) blocks.push(`## ${section}`);
    }
    blocks.push(p.body);
  }
  return `${blocks.join('\n\n')}\n`;
}

export interface ComposeProjectGuideForWearerInput {
  /** The default guide as resolved by renderSuPlaybook (the projected file's text). */
  defaultText: string;
  /** Its path — quoted by the budget seam's truncation pointer. */
  source: string;
  /** The addressed rows `readAddressedGuideParts` returned for this wearer. */
  parts: readonly AddressedGuidePart[];
  /** The wearer's tokens, for the lede and the launch record. */
  tokens: readonly string[];
  maxChars?: number;
}

export interface ComposedProjectGuideForWearer {
  text: string;
  truncated: boolean;
  addressed: { tokens: string[]; partKeys: string[]; addedChars: number } | null;
}

/**
 * The wearer's guide: the default text, then the addressed sections, held to the budget
 * by `projectGuideAtBudget`. With no addressed parts the default passes through the seam
 * unchanged — the projector already holds it under the same cap — so an unaddressed
 * launch renders byte-identically to a pre-P-022 one.
 */
export function composeProjectGuideForWearer(input: ComposeProjectGuideForWearerInput): ComposedProjectGuideForWearer {
  const maxChars = input.maxChars ?? ADDRESSED_GUIDE_MAX_CHARS;
  if (input.parts.length === 0) {
    const passthrough = projectGuideAtBudget(input.defaultText, input.source, maxChars);
    return { text: passthrough.text, truncated: passthrough.truncated, addressed: null };
  }
  const tail = renderAddressedGuideSections(input.parts, input.tokens);
  const combined = `${input.defaultText.replace(/\n+$/, '')}\n\n${tail}`;
  const budgeted = projectGuideAtBudget(combined, input.source, maxChars);
  return {
    text: budgeted.text,
    truncated: budgeted.truncated,
    addressed: {
      tokens: [...input.tokens],
      partKeys: input.parts.map((p) => p.part_key),
      addedChars: combined.length - input.defaultText.length,
    },
  };
}

/**
 * The seam role-launch-spec hands to `renderSuPlaybook({ composeProjectGuide })`: expand
 * the wearer, read the addressed rows, compose. A read failure (no DB, no column yet on
 * an older schema) degrades to the DEFAULT guide and is reported through `onError` —
 * the guide every reader got before P-022 is never withheld because addressing failed.
 */
export function projectGuideComposerForWearer(opts: {
  wearer: GuideWearer;
  workspaceId: string;
  harnessSlug: string;
  client: string;
  docId?: string;
  sql?: Sql;
  maxChars?: number;
  onError?: (err: unknown) => void;
}): (resolved: { text: string; source: string }) => Promise<ComposedProjectGuideForWearer> {
  const tokens = guideAddressesForWearer(opts.wearer);
  return async (resolved) => {
    let parts: AddressedGuidePart[] = [];
    try {
      parts = await readAddressedGuideParts({
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
        docId: opts.docId,
        client: opts.client,
        tokens,
        sql: opts.sql,
      });
    } catch (err) {
      opts.onError?.(err);
      parts = [];
    }
    return composeProjectGuideForWearer({
      defaultText: resolved.text,
      source: resolved.source,
      parts,
      tokens,
      maxChars: opts.maxChars,
    });
  };
}

// ─── One wearer path: launch and mid-session share these (portable-identity P-003) ───
//
// EI-24345639608517597: launch composed the addressed guide for its wearer, but a
// mid-session stack change (take-leadership, fleet:join, a mode flip) delivered only the
// changed LAYER text — a part addressed to `blueprint:su.fleet-leader` never reached an
// agent that BECAME leader. The fix is not a second path: both sides derive the wearer
// with `suGuideWearer`, resolve the guide's harness with `guideHarnessForLaunchProfile`,
// and read through `readAddressedGuideParts`. The transition delivers exactly the
// difference, so launch-as-member + member→leader transition carries the same addressed
// parts as launch-as-leader.

type SuBindingModule = Pick<typeof import('@papercusp/orchestrator/blueprint'), 'suEffectiveBinding' | 'normalizeStackBinding'>;

/**
 * The su wearer of a runtime binding: the static su layers with the runtime layers
 * attached over them (exclusive slots replace — a selected domain displaces the default
 * one, exactly as the rendered stack does). The ONE su wearer mapping for the guide.
 */
export function suGuideWearer(
  bp: SuBindingModule,
  runtimeLayers: readonly import('@papercusp/orchestrator/blueprint').BoundLayer[],
): GuideWearer {
  const layers: GuideWearerLayer[] = bp
    .suEffectiveBinding(bp.normalizeStackBinding(runtimeLayers))
    .layers.map((l) => ({ slot: l.slot, id: l.id }));
  return { role: 'su', layers };
}

/**
 * Which harness's doc parts a launch profile's guide was projected from: the ENGINEER
 * profile splices papercusp's own CLAUDE.md (parts under PAPERCUSP_HARNESS_SLUG, default
 * `papercusp`); POWER splices the managed repo's guide (its own harness); GENERIC has no
 * guide. Unknown/absent profiles are engineer — the launch default.
 */
export function guideHarnessForLaunchProfile(
  profile: string | null | undefined,
  harnessSlug: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const p = (profile ?? '').trim().toLowerCase();
  if (p === 'generic') return null;
  if (p === 'power') return (harnessSlug ?? '').trim() || null;
  return env.PAPERCUSP_HARNESS_SLUG ?? 'papercusp';
}

export interface AddressedGuideTarget {
  workspaceId: string;
  harnessSlug: string;
  client: string;
  docId?: string;
  sql?: Sql;
}

/**
 * The guide target of a live session, from its gate-selected launch record (the SAME
 * record whose profile/harness/agent the launch composed with). `client` prefers the
 * record's agent — what the launch passed — over the turn hook's report. Null when the
 * profile carries no guide or no client is known.
 */
export function guideTargetFromLaunchSpec(
  launchSpec: unknown,
  fallback: { workspaceId: string; client?: string | null },
): AddressedGuideTarget | null {
  const spec = launchSpec && typeof launchSpec === 'object' ? (launchSpec as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const harnessSlug = guideHarnessForLaunchProfile(str(spec.profile), str(spec.harnessSlug));
  const client = str(spec.agent) ?? str(fallback.client);
  if (!harnessSlug || !client) return null;
  return { workspaceId: str(spec.workspaceId) ?? fallback.workspaceId, harnessSlug, client };
}

export interface AddressedGuideTransition {
  /** Inject-now text: newly addressed sections, then a no-longer-applies notice. '' when nothing moved. */
  text: string;
  tokensBefore: string[];
  tokensAfter: string[];
  /** Parts the new stack reaches and the old one did not — delivered in full. */
  attachedPartKeys: string[];
  /** Parts the old stack reached and the new one does not — named, never re-sent. */
  detachedPartKeys: string[];
  truncated: boolean;
}

/**
 * The addressed-guide half of a stack transition: read the parts addressed to either
 * wearer in ONE query, deliver the ones only `after` reaches (rendered exactly as the
 * launch renders them, under a mid-session lede) and name the ones only `before` reached.
 * Held to the same budget seam as the launch guide. Throws on a read failure — the
 * caller decides how to surface it (it must not be silent: a lost attach is the bug).
 *
 * `before: null` is a FULL-RESYNC (the control transition carried no `stackBefore`, which
 * happens whenever more than one anchor generation moved between deliveries — a
 * take-leadership bumps posture, AUTO and the loop). The anchor's
 * replace-full-never-merge-behind rule applies: deliver the COMPLETE addressed set for
 * `after` — exactly what a launch with that stack composes — under a lede that says it
 * replaces any addressed guidance delivered earlier (what that was is unknown here, so it
 * cannot be named part by part).
 */
export async function composeAddressedGuideTransition(
  input: AddressedGuideTarget & { before: GuideWearer | null; after: GuideWearer; maxChars?: number },
): Promise<AddressedGuideTransition> {
  if (input.before === null) return composeAddressedGuideResync({ ...input, after: input.after });
  const tokensBefore = guideAddressesForWearer(input.before);
  const tokensAfter = guideAddressesForWearer(input.after);
  const none: AddressedGuideTransition = {
    text: '', tokensBefore, tokensAfter, attachedPartKeys: [], detachedPartKeys: [], truncated: false,
  };
  if (tokensBefore.length === tokensAfter.length && tokensBefore.every((t, i) => t === tokensAfter[i])) return none;
  const parts = await readAddressedGuideParts({
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    docId: input.docId,
    client: input.client,
    tokens: [...new Set([...tokensBefore, ...tokensAfter])],
    sql: input.sql,
  });
  const attached = parts.filter((p) => guideAddressMatches(p.stack_scope, tokensAfter) && !guideAddressMatches(p.stack_scope, tokensBefore));
  const detached = parts.filter((p) => guideAddressMatches(p.stack_scope, tokensBefore) && !guideAddressMatches(p.stack_scope, tokensAfter));
  if (attached.length === 0 && detached.length === 0) return none;
  const gained = tokensAfter.filter((t) => !tokensBefore.includes(t));
  const blocks: string[] = [];
  if (attached.length > 0) {
    blocks.push(
      renderAddressedGuideSections(
        attached,
        tokensAfter,
        '## Addressed guidance — now applies to this session’s stack\n\n' +
          `> Your stack changed mid-session (now matching ${gained.map((t) => `\`${t}\``).join(', ') || 'a new address'}), ` +
          'so these Project-guide sections now apply to you — a launch with this stack carries them. ' +
          'They are NOT in the repo\'s `CLAUDE.md`; they live as addressed doc parts (`harness_doc_parts.stack_scope`).',
      ).replace(/\n+$/, ''),
    );
  }
  if (detached.length > 0) {
    blocks.push(
      '## Addressed guidance — no longer applies\n\n' +
        '> Your stack no longer matches these Project-guide sections delivered earlier; disregard them from here on:\n\n' +
        detached
          .map((p) => `- \`${p.part_key}\`${p.target_section && p.target_section !== GUIDE_PREAMBLE_SECTION ? ` (section “${p.target_section}”)` : ''} — addressed to ${p.stack_scope.map((t) => `\`${t}\``).join(', ')}`)
          .join('\n'),
    );
  }
  const budgeted = projectGuideAtBudget(
    `${blocks.join('\n\n')}\n`,
    `harness_doc_parts:${input.harnessSlug}/${input.docId ?? 'claude-md'}`,
    input.maxChars ?? ADDRESSED_GUIDE_MAX_CHARS,
  );
  return {
    text: budgeted.text,
    tokensBefore,
    tokensAfter,
    attachedPartKeys: attached.map((p) => p.part_key),
    detachedPartKeys: detached.map((p) => p.part_key),
    truncated: budgeted.truncated,
  };
}

/** Whether this guide carries ANY live addressed part for the client (the reader's predicate minus the tokens). */
async function hasAddressedGuideParts(target: AddressedGuideTarget): Promise<boolean> {
  const s = target.sql ?? getOrgPg().sql;
  const rows = (await s.unsafe(
    `SELECT 1 AS present
       FROM harness_shared.harness_doc_parts
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3
        AND tombstone = false
        AND cardinality(stack_scope) > 0
        AND client_scope && $4::text[]
      LIMIT 1`,
    [target.workspaceId, target.harnessSlug, target.docId ?? 'claude-md', [target.client, 'all']],
  )) as unknown as unknown[];
  return rows.length > 0;
}

/** Full-resync half of `composeAddressedGuideTransition`: the complete set, replacing whatever came before. */
async function composeAddressedGuideResync(
  input: AddressedGuideTarget & { after: GuideWearer; maxChars?: number },
): Promise<AddressedGuideTransition> {
  const tokensAfter = guideAddressesForWearer(input.after);
  const parts = await readAddressedGuideParts({
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    docId: input.docId,
    client: input.client,
    tokens: tokensAfter,
    sql: input.sql,
  });
  const none: AddressedGuideTransition = {
    text: '', tokensBefore: [], tokensAfter, attachedPartKeys: [], detachedPartKeys: [], truncated: false,
  };
  // Nothing reaches the new stack: say so only when this guide HAS addressed parts for the
  // client (something could have been delivered earlier); otherwise the resync is silent.
  if (parts.length === 0 && !(await hasAddressedGuideParts(input))) return none;
  const body = parts.length > 0
    ? renderAddressedGuideSections(
        parts,
        tokensAfter,
        '## Addressed guidance — the complete set for this session’s stack\n\n' +
          `> Your stack changed mid-session and was re-synced in full (matching ${tokensAfter.map((t) => `\`${t}\``).join(', ')}). ` +
          'These are ALL the Project-guide sections addressed to it — exactly what a launch with this stack carries — and they ' +
          'REPLACE any addressed guidance delivered to you earlier: an addressed section not listed here no longer applies. ' +
          'They are NOT in the repo\'s `CLAUDE.md`; they live as addressed doc parts (`harness_doc_parts.stack_scope`).',
      )
    : '## Addressed guidance — none for this session’s stack\n\n' +
      '> Your stack changed mid-session and was re-synced in full: no Project-guide section is addressed to it, so any ' +
      'addressed guidance delivered to you earlier no longer applies.\n';
  const budgeted = projectGuideAtBudget(
    body,
    `harness_doc_parts:${input.harnessSlug}/${input.docId ?? 'claude-md'}`,
    input.maxChars ?? ADDRESSED_GUIDE_MAX_CHARS,
  );
  return {
    text: budgeted.text,
    tokensBefore: [],
    tokensAfter,
    attachedPartKeys: parts.map((p) => p.part_key),
    detachedPartKeys: [],
    truncated: budgeted.truncated,
  };
}
