/**
 * `state:read` — read one registered cell's VALUE at the moment of acting
 * (unified-agent-state-plane-2026-07-27 P-004, per D-058).
 *
 * WIRING, NOT A BUILD. Everything here already existed:
 *   • `getCell(cell, reader)` decides IF you may read (P-019);
 *   • `dispatchReadOnlyTool` (extracted from the predicate poller, D-058) invokes the
 *     resolver under YOUR role;
 *   • `valueAtPath` projects the cell's declared dot-path.
 * `cell-read.ts` composes the three; this file is the tool projection of it and holds
 * no logic of its own — deliberately, because a second place that assembles a cell read
 * is a second place that can drift on the audience check (D-042 / P-028).
 *
 * WHY A CELL READ RATHER THAN CALLING THE RESOLVER TOOL YOURSELF: the point is not
 * formatting, it is RE-DERIVABILITY (D-032). A value you copied into a message forty
 * minutes ago has rotted silently; a cell you read now has not. That is the same defect
 * P-017 (c)'s transcription detector flags from the other side.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { formatCellAssessment, formatCellHoist, formatCellPointers, readCell, type CellRead } from '../../cell-read';
import { listCells, getCell } from '../../cell-registry';
import { formatCellUnknown } from '../../cell-contract';
import { absentReadAftercare, resolveSelfSubject } from '../../cell-suggest';

/** The `value` branch of a cell read, plus a `summary` ONLY when its hoist has
 *  something to say (see `formatCellHoist` — a measured-empty channel stays quiet). */
function valueResult(out: Extract<CellRead, { status: 'value' }>) {
  const hoistProse = out.unknownHoist ? formatCellHoist(out.unknownHoist) : null;
  /**
   * WI-36259 — HOIST A NON-AUTHORITATIVE READING INTO THE SUMMARY, for the same reason
   * `unknownHoist` exists: this registry's own axis-2 rule is that in-band is necessary but
   * NOT sufficient, because "a per-row qualifier a caller can skip past is how the defect
   * survives contact with a hurried consumer". A caller who acts on an INFERRED gate
   * candidate as though it were observed is precisely that hurried consumer — it is the
   * misread this cell exists to prevent — so the caveat has to be where they cannot miss it,
   * not nested under `source`.
   *
   * Deliberately quiet when the reading IS authoritative: a line that prints on every read
   * is a line agents learn to skip, which would spend the hoist channel to say "normal".
   */
  const sourceProse =
    out.source && !out.source.authoritative
      ? `⚠ INFERRED, not observed: ${out.headline} came from ${
          out.source.value === null ? 'an unattributed source' : `\`${out.source.value}\``
        } — ${out.source.why}`
      : null;
  /**
   * P-006 — THE DISCOVERY LINE. Unlike the two above it this one is NOT quiet on the
   * healthy path, and that asymmetry is deliberate: those two QUALIFY the headline, so
   * printing them when nothing is wrong would spend a warning channel to say "normal".
   * A pointer qualifies nothing — it names a door — and a door only helps the reader who
   * did not already know it was there. Gating it on the very condition the reader is
   * trying to evaluate is what left `gate.greenCheckpoint.ownership` undiscoverable in
   * the first place. It stays affordable because it carries its own `when`, so a reader
   * on the healthy path dismisses it in one glance. See `formatCellPointers`.
   */
  const pointerProse = out.pointers ? formatCellPointers(out.pointers) : null;
  /**
   * P-005 / D-014 — THE ASSESSMENT LEADS, RESOLVED OR NOT.
   *
   * ⚠ THIS DELIBERATELY BREAKS the asymmetry `sourceProse` and `hoistProse` follow, and
   * D-014 records the argument so it is not "fixed" back. Until P-005 this branch read
   * `status === 'unavailable'` only, citing D-008. But D-008 fixes the assessment SHAPE
   * and requires pull/push/subscription consumers to project the SAME contract — it
   * never ratified suppressing the resolved branch; that was an extrapolation from the
   * two caveats above.
   *
   * The extrapolation does not hold, because those two QUALIFY a headline the reader
   * already holds, so silence costs nothing. The assessment IS the answer — the whole
   * point of this plan is to put the MEANING in front of the raw number. Rendering it
   * only when it is missing would make semantics visible solely in their absence, which
   * teaches the exact habit the plan exists to remove: read the number, infer the
   * meaning yourself.
   *
   * It goes FIRST in the summary for the same reason. The renderer is shared with
   * `cell-wake-fold` (D-014 §2) so a push and a pull cannot drift.
   */
  const assessmentProse = out.assessment ? formatCellAssessment(out.assessment, out.cell) : null;
  const summary = [assessmentProse, hoistProse, sourceProse, pointerProse]
    .filter((s): s is string => s !== null)
    .join(' · ');
  return summary === '' ? { ok: true, ...out } : { ok: true, ...out, summary };
}

export default defineTool({
  name: 'state:read',
  description:
    'Read a registered state CELL by name, right now, instead of trusting a value someone transcribed earlier. Returns {status:"value"|"unknown"|"absent"}. "unknown" is IN-BAND and branchable (code: not-applicable | resolver-failed | not-measured | insufficient-data) — never treat it as false or as zero. "absent" means the cell does not exist FOR YOU: unregistered and out-of-audience are deliberately indistinguishable. Omit `cell` to list the cells you may read. A caller-relative cell needs `as` as a bare subject string, e.g. `{ cell:"git.pipelinePosition", as:"packages/operator-core/lib/x.ts" }`.',
  guidance: {
    when: 'At the moment you ACT on a value that can change under you — a deploy position, a holder\'s goal, a queue depth. Also whenever you are about to quote such a value into a message or a plan: read it, do not copy it.',
    notWhen: 'A value you just computed this turn. A one-off analytic slice — that is dev:pg_query. Waiting for it to CHANGE — that is state:subscribe, not a poll loop.',
    chaining:
      'state:read { cell } → act. status:"unknown" → branch on unknown.code: not-measured means ask for access/enablement (retrying is pointless), resolver-failed means retry-or-escalate, insufficient-data means supply more input (often `as`). status:"absent" → the cell is not yours to read; do not reconstruct it from another surface.',
  },
  // @not-a-cell This IS the cell registry's read door, not a bespoke read competing with
  // it — the one tool the gate's name signature cannot classify, because it reads EVERY
  // cell rather than projecting one. A `@cell-lens` marker would be a category error (it
  // names no single cell), so the exemption is the correct declaration, not a dodge.
  capability: 'coord:read',
  requirePrincipal: false,
  // state-plane-adoption-2026-08-02 P-003 / D-005. All five registered cells are
  // release-pipeline cells, and `release-fixer` — the role whose entire job is repairing
  // a red gate — could not read any of them. Verified before widening (the item required
  // it): the CAPABILITY gate does not bite (release-fixer makes 229 successful coord:*
  // calls, incl. coord:declare-intent/emit/send which are all `coord:write`), so the
  // agentRoles gate was the sole blocker.
  //
  // Widened HERE, at the use site, and deliberately NOT by adding release-fixer to
  // SU_ROLES: capability/cutover-role-parity.test.ts asserts FLEET_CAPABILITY_ROLES ≡
  // SU_ROLES ∪ {cup}, so SU_ROLES membership DEFINES the fleet capability-cutover set —
  // joining it would confine this role's native file-read/edit/git to the capability:*
  // tools. role-config.ts holds `doc-steward` out of SU_ROLES for exactly this reason.
  // Safe to widen: this tool audience-filters per reader, so a wider allowlist exposes
  // no cell a role may not see.
  agentRoles: [...SU_ROLES, 'release-fixer'],
  args: z.object({
    cell: z
      .string()
      .max(120)
      .optional()
      .describe('Dotted cell id, e.g. "git.pipelinePosition". Omit to LIST the cells you may read.'),
    as: z
      .string()
      .max(200)
      .optional()
      .describe(
        'The SUBJECT for a caller-relative cell — pass the value directly as a bare string, not an object such as `{path:...}`. Example: `as:"packages/operator-core/lib/x.ts"`. For an agent-scoped cell, the literal "self" means you. Required only when the cell declares callerRelativity.kind="parameter"; the read tells you the parameter name if it is missing.',
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const reader = {
      ownerId: identity.ownerId,
      roles: ctx.role ? [ctx.role] : [],
      harnessSlug: ctx.harnessSlug ?? undefined,
    };

    // No cell named ⇒ the DIRECTORY, filtered to this reader. `listCells(reader)` omits
    // narrow cells rather than marking them, for the same non-oracle reason `absent`
    // exists: a directory that showed "3 cells you may not see" would enumerate them.
    if (!args.cell) {
      const cells = listCells(reader).map((s) => ({
        cell: s.cell,
        headline: s.headline,
        shape: s.shape,
        nullable: s.nullable,
        callerRelativity: s.callerRelativity,
        readable: s.changeSignal.kind === 'poll',
        // P-002 (EI-21069242359753673): an event-signalled cell has no resolver to
        // poll, so `state:subscribe` REFUSES it and redirects to events:await. The
        // directory used to send exactly those callers to state:subscribe — a
        // guaranteed refusal on their next call. Name the key here instead, which is
        // what the refusal itself does.
        ...(s.changeSignal.kind === 'event' ? { awaitKey: s.changeSignal.key } : {}),
        // D-008 — WHAT THIS CELL CAN TELL YOU, not just where its number lives.
        // `headline`/`shape` describe the raw measurement; the code vocabulary is how
        // a caller decides BEFORE dispatching whether this cell answers their
        // question. Omitted (rather than sent as an empty list) for a cell that has
        // not migrated yet, so absence reads as "no semantics declared" instead of
        // "declared none" — the same distinction the read's own optional field draws.
        ...(s.assessment ? { assessmentCodes: Object.keys(s.assessment.codes) } : {}),
      }));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              cells,
              count: cells.length,
              note: 'Cells you may read. `readable:false` = event-signalled: it has no resolver to poll, so state:subscribe refuses it — await its `awaitKey` with events:await instead. `readable:true` cells take state:subscribe. A cell whose callerRelativity is a `parameter` needs `as`; where that parameter is an agent identity, `as:"self"` means you. `assessmentCodes` lists the closed set of meanings that cell can report — read it to see whether a cell answers your question before you dispatch; its absence means that cell declares no semantics yet, NOT that it is always fine. This list is audience-filtered; cells outside your audience are omitted, not marked.',
            }),
          },
        ],
      };
    }

    // P-003 — `as:"self"` for an IDENTITY-keyed cell resolves to the caller's own
    // ownerId (the coord-tools convention, absent from the plane until now). Every
    // other subject, and every non-identity parameter, passes through untouched.
    // Resolved against the cell's own declared relativity, so a per-PATH cell can
    // never silently answer about a file named "self". `getCell` is audience-checked,
    // so an unreadable cell resolves nothing and falls through to `absent` below.
    const specForSelf = getCell(args.cell, reader);
    const subject = specForSelf ? resolveSelfSubject(args.as, specForSelf, reader.ownerId) : args.as;

    const out = await readCell(
      args.cell,
      reader,
      {
        workspaceId: identity.workspaceId ?? ctx.workspaceId ?? 'default',
        harnessSlug: ctx.harnessSlug ?? null,
        // FAIL CLOSED on an absent role. `''` matches no tool's role allowlist, so the
        // dispatch is refused with `role_not_allowed` and renders as a `not-measured`
        // unknown — honest and safe. Substituting a real role here (a 'su' default,
        // say) would WIDEN the second gate for a caller who never presented one, which
        // is the same failure D-042 names: an access default that fails OPEN.
        role: ctx.role ?? '',
      },
      subject,
    );

    // `summary` renders the unknown in prose so a human-facing surface never shows a
    // bare `undefined` — but `unknown.code` stays on the payload, because prose cannot
    // be branched on and that is the exact defect cell-contract.ts exists to prevent.
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            out.status === 'unknown'
              ? {
                  ok: true,
                  ...out,
                  // P-006 — the pointer survives an unknown, because the cell it names has
                  // its OWN resolver: "I could not answer" is not "nothing here can".
                  summary: [
                    formatCellUnknown(out.unknown),
                    out.pointers ? formatCellPointers(out.pointers) : null,
                  ]
                    .filter((s): s is string => s !== null && s !== '')
                    .join(' · '),
                }
              : out.status === 'absent'
                ? (() => {
                    // P-002 — NAVIGATION aftercare on a refusal that stays an
                    // INFORMATION dead end. Candidates come from listCells(reader)
                    // ONLY: suggesting out-of-audience names would leak exactly what
                    // `absent` exists to hide. Silent when there is nothing to say.
                    const aftercare = absentReadAftercare(out.cell, listCells(reader));
                    const base = `No cell "${out.cell}" is readable by you. It may not exist, or it may be outside your audience — these are deliberately indistinguishable. Do NOT reconstruct the value from another surface.`;
                    const extra = aftercare.notACell
                      ? ` ⓘ ${aftercare.notACell}`
                      : aftercare.didYouMean
                        ? ` Did you mean: ${aftercare.didYouMean.map((c) => `\`${c}\``).join(', ')}?`
                        : '';
                    return { ok: true, ...out, ...aftercare, summary: base + extra };
                  })()
                : // D-039 — a LOUD hoist gets prose too. The payload already carries
                  // `unknownHoist` for a program to branch on; this is the half that
                  // reaches a reader who skims. Silent on a measured-empty channel, so
                  // the line keeps meaning something when it does appear.
                  valueResult(out),
          ),
        },
      ],
    };
  },
});
