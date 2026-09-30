/**
 * `state:subscribe` — wake me when a registered CELL crosses a condition
 * (unified-agent-state-plane-2026-07-27 P-004, per D-058).
 *
 * ── THIS TOOL ADDS NO SUBSCRIPTION MECHANISM, AND THAT IS THE POINT ─────────
 *
 * P-004 says it outright: "Reuse-first: do not add a second subscription mechanism."
 * `predicate_watches` already binds (tool, args, dot-path, comparator) and polls it
 * under the registrant's role — which is EXACTLY `CellSpec.changeSignal`'s
 * `{ kind:'poll', tool, path }`, the same triple under a different name.
 *
 * So this is a PRESET over `watch:create`, in the same sense `events:await` is
 * (D-007 — the third preset, `topics:subscribe`, was retired 2026-08-09 for taking
 * zero calls; this one is live at 25 calls/11 agents and is WHY the base primitive
 * stayed): it resolves a cell NAME to the predicate that cell
 * already declares, and hands it to the one registration path. It deliberately does
 * NOT re-implement registration — `watch:create` owns the dedupe (an identical
 * predicate JOINS an existing poller instead of starting a second), the inline first
 * eval (a broken tool/role fails loudly now, and an already-true condition fires
 * immediately), and the await/GC pairing. Duplicating ~150 lines of that here is
 * precisely the "second mechanism" the item forbids.
 *
 * What the caller gains over calling `watch:create` by hand: they name a CELL instead
 * of hand-copying a tool name and a dot-path. A hand-copied path is a transcription,
 * and a transcription rots when the resolver's shape moves — the same defect the
 * P-017 (c) detector flags. Here the cell is the single source of that triple.
 *
 * ── THE AUDIENCE CHECK RUNS HERE TOO ────────────────────────────────────────
 *
 * Subscribing is a read: it observes the cell's value on a schedule. So it goes
 * through `getCell(cell, reader)` exactly as `state:read` does, and a cell outside the
 * reader's audience is ABSENT — never subscribable. Skipping this would make
 * `state:subscribe` a bypass of `canReadCell` that returns the value one poll later,
 * which is the silent-leak hazard D-042 names and P-028 gates.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { getCell } from '../../cell-registry';
import { resolveSelfSubject } from '../../cell-suggest';
import { PREDICATE_OPS } from '../../events/await/predicate-watch';
import { softText, clampText, LIMITS } from '../limits';
import watchTool from '../events/watch';
import { CHECKPOINT_MAX_RUNTIME_SEC } from '../../release-checkpoint-launch';

/**
 * EI-20037590613603206 — the GC HORIZON for the `once` watch this tool registers.
 * It is NOT a wait budget, and that distinction is the whole fix.
 *
 * A `once` watch CLEARS ITSELF when it fires, so its expiry only ever reaps watches
 * that NEVER fire. `predicate-watch.ts` (`'gc: paired event_awaits registration gone
 * (cancelled/consumed/expired)'`) reaps a predicate watch exactly when its paired
 * `event_awaits` row is gone — so the expiry IS the only reaper on this path. That
 * rules out the tempting "just make it null" fix: it would trade a stranded caller
 * for an unbounded leak of the watches most likely to leak.
 *
 * What it must NOT do is front-run a legitimate wait. Inheriting watch:create's
 * generic `AWAIT_DEFAULT_TIMEOUT_SEC` (30min) did exactly that: this tool's own
 * See-also — and `release:checkpoint-run`'s — sends callers here to wait for
 * `gate.greenCheckpoint.verdict`, a suite whose systemd backstop allows up to
 * `CHECKPOINT_MAX_RUNTIME_SEC`. The subscription expired first, every time, and a
 * TIMEOUT wake reads as "the thing I am waiting on has STALLED".
 *
 * Sized like WI-5685 sized `CHECKPOINT_AWAIT_DEFAULT_TIMEOUT_SEC` for the sibling
 * `events:await-checkpoint` path — DERIVED from the slowest registered cell's real
 * producer ceiling plus grace for the verdict to land, not from an observed suite
 * duration. A generic value is safe here precisely because callers never wait ON it:
 * this tool deliberately withholds `timeout_sec`/`on_timeout` (events:await owns
 * those), so nothing but garbage collection depends on the number.
 */
export const STATE_SUBSCRIBE_GC_HORIZON_SEC = CHECKPOINT_MAX_RUNTIME_SEC + 10 * 60;

export default defineTool({
  name: 'state:subscribe',
  description:
    'Wake me when a registered state CELL changes or crosses a condition — instead of burning turns re-reading it. Names a cell (state:read lists them); the cell supplies the resolver + path. `on` is OPTIONAL — omit it for "wake me when this moves" (op `changed`), which on an assessed cell follows its semantic CODE, so you wake when the MEANING moves; `target` overrides. A PRESET over watch:create: inherits its dedupe, its inline first eval (a broken condition fails NOW; an already-true one fires immediately), and its wake floors. Fires on the false→true EDGE. A cell outside your audience is absent, not subscribable.',
  guidance: {
    when: 'You need to proceed only once a value MOVES or crosses a threshold — a deploy landing, a gate verdict flipping, a queue draining, a holder releasing. Use it INSTEAD of a sleep/poll loop; that loop is what this exists to kill.',
    notWhen: 'You need the value now — that is state:read. The event has an exact key already — that is events:await. A recurring TIME schedule — routines own those.',
    chaining:
      'state:subscribe { cell } → END YOUR TURN. Omitting `on` means `changed`; never write `ne` against the value\'s current reading to mean that — it transcribes a volatile value and misses a move landing before the call. A valued `on` on an assessed cell must name `target` — refused, not guessed. Standing watch: no `timeout_sec`/`on_timeout`/`wake` (events:await owns those) — the watch outlives a gate suite; why-field is `note`. once:false re-fires per change. Cancel via events:cancel.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // state-plane-adoption-2026-08-02 P-003 / D-005 — kept in lockstep with state:read's
  // allowlist: reading a cell you cannot then wait on is a half-open door, and the gate
  // verdict is the value a red-gate repairer most needs to wait on rather than re-poll.
  // release-fixer holds `coord:write` (verified: 82 coord:emit + 26 coord:declare-intent
  // + 4 coord:send successes, all `coord:write`), so the capability gate does not bite.
  // Widened at the use site, NOT via SU_ROLES — that set defines the fleet
  // capability-cutover (see the fuller note on state:read). Audience filtering still
  // applies per this tool's own contract: a cell outside your audience is absent, not
  // subscribable.
  agentRoles: [...SU_ROLES, 'release-fixer'],
  args: z.object({
    cell: z.string().min(1).max(120).describe('Dotted cell id to watch, e.g. "git.pipelinePosition". state:read (no args) lists the ones you may read.'),
    on: z
      .object({
        op: z.enum(PREDICATE_OPS).describe('Comparator applied to the cell value. `changed` needs no `value` — it compares each reading to the previous one.'),
        value: z.unknown().optional().describe('Operand (omit for `exists` and `changed`).'),
      })
      .optional()
      .describe(
        'The condition on the cell VALUE. Fires on the false→true edge, not on every poll that matches. OMIT IT to mean `{op:"changed"}` — wake me when this value moves — which is what you want for a deploy sha or a gate verdict. Do NOT hand-write `ne` against the value\'s current reading to express that: it transcribes a volatile value into the watch, and if the value moves between your read and this call the watch is armed against a stale operand and never fires.',
      ),
    as: z
      .string()
      .max(200)
      .optional()
      .describe('SUBJECT for a caller-relative cell (see state:read `as`). Where the cell\'s parameter is an agent identity, the literal "self" means you. Not an identity override — your audience is always what is checked.'),
    target: z
      .enum(['assessment', 'measurement', 'material'])
      .optional()
      .describe(
        'WHICH of the cell\'s paths your condition is about. "assessment" = the declared semantic CODE, and the DEFAULT on a cell that declares one: wake me when the MEANING moves, even if the raw number did not. "measurement" = the headline value — say it for a threshold or a sha. "material" = the declared materiality path (P-021). A target the cell does not declare is refused, never silently swapped for one it does.',
      ),
    of: z
      .string()
      .optional()
      .describe('RENAMED to `target` ("value" is now "measurement"). Refused, never translated — see the refusal.'),
    once: z.boolean().optional().describe('true (DEFAULT) = fire once then clear. false = standing; re-fires on each false→true cross.'),
    interval_sec: z.number().int().min(15).max(3600).optional().describe('Poll cadence (default 60).'),
    note: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('Why you are watching — echoed into the wake turn. Auto-truncated to 2000 chars if longer — never refused for length (P-012).'),
  }),
  async handler(args, ctx) {
    /**
     * P-005 / D-014 §4 — `of` IS REFUSED, NEVER TRANSLATED.
     *
     * `of: 'value'|'material'` became `target: 'assessment'|'measurement'|'material'`.
     * Renaming rather than aliasing is the alpha default, but the DECISIVE argument is
     * this tool's own P-021 restraint (see the target block below): re-pointing a
     * caller's predicate does not narrow their condition, it evaluates it against a
     * DIFFERENT DOMAIN.
     *
     * Zod strips an undeclared key silently, so dropping `of` from the schema would do
     * exactly that: a caller who asked for `material` would fall through to the new
     * assessment default and be watching a code enum, where `{op:'ne', value:<a sha>}`
     * is true on the FIRST poll — an instant spurious wake. So `of` stays in the schema
     * as a plain string PURELY so the handler can SEE it and refuse it by name. Widened
     * from the old enum on purpose: `of:'assessment'` (the natural half-migrated guess)
     * would otherwise die in the parser with no pointer to `target`.
     */
    if (args.of !== undefined) {
      const replacement = args.of === 'material' ? 'material' : args.of === 'value' ? 'measurement' : null;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              cell: args.cell,
              error: 'of_renamed',
              reason:
                `\`of\` was renamed to \`target\` and is deliberately NOT translated: silently re-pointing your operand would evaluate it against a different domain. ` +
                (replacement
                  ? `Re-send with target:"${replacement}".`
                  : `Re-send with target:"assessment" | "measurement" | "material".`) +
                ` "value" is now "measurement", and a cell that declares an assessment now defaults an operand-free subscription to that assessment.`,
              renamedTo: 'target',
              ...(replacement ? { useTarget: replacement } : {}),
            }),
          },
        ],
        isError: true,
      };
    }

    // P-004 — the default condition. 12 of 50 measured failures passed no `on` at
    // all, and 11 more invented an operator spelling for it; "wake me when this
    // moves" is simply what subscribing to a volatile cell usually means.
    const on = args.on ?? { op: 'changed' as const, value: undefined };
    const identity = resolveAgentIdentity(ctx);
    const reader = {
      ownerId: identity.ownerId,
      roles: ctx.role ? [ctx.role] : [],
      harnessSlug: ctx.harnessSlug ?? undefined,
    };

    // Gate 1, same oracle as state:read. Absent ⇒ absent: a cell you may not read is
    // not one you may watch, and the refusal must not distinguish "not registered"
    // from "not yours" (P-019's non-oracle property).
    const spec = getCell(args.cell, reader);
    if (!spec) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              status: 'absent',
              cell: args.cell,
              // P-004: `error` is lifted VERBATIM into tool_invocations.error_code by
              // the dispatcher's extractRefusalCode (truncated at 80 chars), so a prose
              // sentence here becomes an unqueryable code — which is exactly why this
              // tool's whole refusal taxonomy had to be reconstructed from error_message
              // and args_json. The code goes in `error`; the prose goes in `reason`.
              error: 'cell_absent',
              reason: `No cell "${args.cell}" is subscribable by you. It may not exist, or it may be outside your audience — deliberately indistinguishable. Do not watch a substitute surface instead.`,
            }),
          },
        ],
        isError: true,
      };
    }

    // An event-signalled cell needs no poller at all — it already HAS a key, so the
    // correct primitive is the plain await. Registering a predicate for it would start
    // a poll against a value that pushes.
    if (spec.changeSignal.kind !== 'poll') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              cell: args.cell,
              error: 'cell_event_signalled',
              reason: `cell "${args.cell}" is event-signalled, not polled — subscribe to its key directly with events:await { key: "${spec.changeSignal.key}" } rather than polling for it.`,
              eventKey: spec.changeSignal.key,
            }),
          },
        ],
        isError: true,
      };
    }

    // P-003 — `as:"self"` resolves to the caller's own ownerId for an IDENTITY-keyed
    // cell, kept in LOCKSTEP with state:read: a subject shorthand you may read with
    // but not wait on is the same half-open door the role allowlist comment warns
    // about. Resolved BEFORE the missing-subject check below so `self` satisfies it.
    const asSubject = resolveSelfSubject(args.as, spec, identity.ownerId);

    // Axis 3 — a caller-relative cell cannot be watched without its subject, for the
    // same reason it cannot be read without one: there is no question yet.
    const rel = spec.callerRelativity;
    if (rel.kind === 'parameter' && (asSubject === undefined || asSubject.trim() === '')) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              cell: args.cell,
              error: 'subject_required',
              reason: `cell "${args.cell}" is relative to "${rel.param}" — pass \`as\` to say WHAT you are watching.`,
              missingParam: rel.param,
            }),
          },
        ],
        isError: true,
      };
    }
    const resolverArgs = rel.kind === 'parameter' ? { [rel.param]: asSubject as string } : {};

    /**
     * P-021, extended by P-005/D-014 §4 — WHICH path the predicate watches:
     * the declared assessment CODE, the raw measurement, or the materiality path.
     *
     * ⚠ NO DECLARED PATH IS EVER APPLIED SILENTLY, and that restraint is
     * the whole design of this knob. The caller's `on: {op, value}` is written
     * against a value they have in mind; quietly re-pointing it at a coarser
     * sibling path would not narrow their condition, it would evaluate it against
     * a DIFFERENT DOMAIN. Concretely: `on:{op:'ne', value:'4c871fdc'}` — the
     * natural "wake me when the candidate moves" — silently redirected onto a
     * BOOLEAN containment path is `ne` against a sha it can never equal, i.e. a
     * predicate that is true on the first poll. The agent would be woken
     * instantly and told it was a material change. A wake is an interrupt (D-044)
     * and a spurious one is a false all-clear that resumes an agent on a
     * condition never established — exactly what `comparePredicate`'s absent-
     * evidence rule already refuses to do one layer down.
     *
     * So materiality stays OPT-IN per subscription, and asking for ANY target the
     * cell does not declare is an ERROR rather than a silent fallback to a path it
     * does. The one default this tool applies — D-007's assessment default, below —
     * is confined to conditions that name no domain at all.
     */
    const assessmentPath = spec.assessment?.path;
    const refuse = (error: string, extra: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, cell: args.cell, error, ...extra }) }],
      isError: true,
    });

    if (args.target === 'assessment' && !assessmentPath) {
      return refuse('no_assessment', {
        reason: `cell "${args.cell}" declares no assessment, so there is no semantic code to watch — and the registry will not invent one from the raw value (D-004: an assessment is DECLARED meaning, never derived). Re-subscribe with target:"measurement" to watch "${spec.changeSignal.path}". A value-bearing cell without an assessment is unfinished, not exempt (D-008) — the durable fix is to declare one.`,
        watchedPath: spec.changeSignal.path,
      });
    }
    if (args.target === 'material' && !spec.materiality) {
      return refuse('no_materiality', {
        reason: `cell "${args.cell}" declares no materiality path, so there is no coarser answer to watch. Either its every change is material (the registry's default), or it should declare one. Re-subscribe with target:"measurement" to watch "${spec.changeSignal.path}" — and expect a wake on every change to it.`,
        watchedPath: spec.changeSignal.path,
      });
    }

    /**
     * ── D-007's assessment DEFAULT, narrowed to an operand-free condition ────────
     *
     * D-007 defaults a NEW subscription on an assessed cell to the assessment path.
     * That default is the point of P-005: `changed` against the code wakes you when
     * the MEANING moves even though the raw measurement did not.
     *
     * But applied to a condition that carries an OPERAND it commits the very defect
     * the essay above refuses `of` to avoid — and it would do so to EVERY existing
     * caller at once, because P-004 gave all ten built-in cells an assessment. Both
     * failure directions are live in `comparePredicate`, and both are silent:
     *   • `{op:'ne', value:'<a sha>'}` against a code enum is `!absent && !deepEq`,
     *     i.e. TRUE on the first poll — an instant spurious wake reported as a real
     *     transition.
     *   • `{op:'gt', value:3}` against a code enum is `Number('healthy')` → NaN →
     *     `false` FOREVER. The agent parks on a watch that can never fire, which no
     *     error surface will ever tell it.
     *
     * An operand is a domain the caller has already named implicitly. `exists` and
     * `changed` name none — they are the same question on either path and cannot
     * misfire on either — so the default applies exactly there and is REFUSED, not
     * guessed, everywhere else. Defaulting a valued condition to `measurement`
     * instead would be just as silent in the other direction (a caller who meant
     * `eq:'red'` on a gate-verdict CODE would be pointed at the raw value), which is
     * why this is a refusal and not a smarter guess.
     */
    const carriesOperand = on.op !== 'exists' && on.op !== 'changed';
    if (args.target === undefined && assessmentPath && carriesOperand) {
      return refuse('target_required', {
        reason: `cell "${args.cell}" declares an assessment, so an operand-free subscription now defaults to its semantic code at "${assessmentPath}". Your \`${on.op}\` carries an operand, and this tool never evaluates a caller's operand against a domain they did not name. Say target:"measurement" to compare "${spec.changeSignal.path}" (a threshold, a sha, a boolean), or target:"assessment" to compare the code enum. Or omit \`on\` entirely to mean "wake me when the MEANING moves".`,
        assessmentPath,
        measurementPath: spec.changeSignal.path,
      });
    }

    const target: 'assessment' | 'measurement' | 'material' =
      args.target ?? (assessmentPath ? 'assessment' : 'measurement');
    /**
     * ⚠ A predicate observes the RAW path. `readCell` DOWNGRADES an undeclared code to
     * `unavailable` (the closed-vocabulary rule); a poller reading `assessment.path`
     * does not get that projection and would compare the undeclared string verbatim.
     * Left as-is deliberately: normalising here would be a second projection of the
     * read contract, which D-008 forbids, and the divergence only exists when a
     * resolver emits a code its own registration never declared — a registry defect.
     * The safe direction holds meanwhile: `changed` still fires on that transition.
     */
    const watchedPath =
      target === 'assessment'
        ? (assessmentPath as string)
        : target === 'material'
          ? (spec.materiality as { path: string }).path
          : spec.changeSignal.path;

    // P-012 — an over-cap `note` is TRUNCATED and reported, never refused: the
    // primitive whose job is to replace polling must not bounce a caller over prose
    // length (9 of 57 measured calls — 16% of all refusals — were for exactly this).
    // Same softText/clampText contract the delegate (watch:create) applies to its own
    // `note`; the old `z.string().max(2000)` here refused at parse time, BEFORE the
    // handler or the delegate's clamp could run.
    const noteClamped = clampText(args.note, LIMITS.ANNOTATION);
    const noteTruncated =
      typeof args.note === 'string' && typeof noteClamped === 'string' && noteClamped.length < args.note.length
        ? { originalChars: args.note.length, storedChars: noteClamped.length }
        : null;

    // DELEGATE. The cell contributes exactly the triple it already declares; every
    // other knob is watch:create's, unchanged. Parsing through watch:create's own
    // schema (rather than hand-building its args) means a change to that schema
    // surfaces HERE as a parse error instead of silently dropping a field.
    const once = args.once ?? true;
    const watchArgs = watchTool.args.parse({
      pattern: `cell:${args.cell}`,
      wake: true,
      once,
      // EI-20037590613603206: the `once` path must NOT inherit watch:create's generic
      // 30min default — see STATE_SUBSCRIBE_GC_HORIZON_SEC. A STANDING watch (once:false)
      // is deliberately left unset so watch:create still yields `null` (no expiry): it is
      // not garbage after one fire, so it is not on the same GC contract at all.
      ...(once ? { timeout_sec: STATE_SUBSCRIBE_GC_HORIZON_SEC } : {}),
      interval_sec: args.interval_sec,
      // `measurement` stays unannotated: it is what an unqualified "cell X changed"
      // has always meant, and re-labelling it would churn every existing note.
      note:
        noteClamped ??
        `cell ${args.cell}${target === 'measurement' ? '' : ` (${target})`} ${on.op}${on.value === undefined ? '' : ` ${JSON.stringify(on.value)}`}`,
      predicate: {
        tool: spec.changeSignal.tool,
        args: resolverArgs,
        path: watchedPath,
        op: on.op,
        ...(on.value === undefined ? {} : { value: on.value }),
      },
    });
    const result = await watchTool.handler(watchArgs as never, ctx);
    if (noteTruncated) {
      // Stamp the repair on the delegate's own success body so the caller SEES the
      // truncation (P-012: "truncate with a warning") without a second content item.
      const first = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content?.[0];
      if (first && first.type === 'text' && typeof first.text === 'string') {
        try {
          const parsed = JSON.parse(first.text) as Record<string, unknown>;
          parsed.noteTruncated = noteTruncated;
          parsed.noteRepair = `note exceeded the ${LIMITS.ANNOTATION}-char soft cap and was stored truncated (${noteTruncated.originalChars} → ${noteTruncated.storedChars} chars) — accepted, not refused (P-012).`;
          first.text = JSON.stringify(parsed);
        } catch {
          // Non-JSON delegate body: the truncation itself still applied; skip the stamp.
        }
      }
    }
    return result;
  },
});
