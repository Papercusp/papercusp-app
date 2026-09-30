/**
 * improvements:triage — Queen-turn triage (P-020 from self-learning-central-2026-06-06).
 *
 * The Queen reads the digest and triages each idea:
 * - type-routes (product→place, process→gate)
 * - attaches triage decision + reason
 * - updates idea lifecycle state
 *
 * This is a working tool (not just read-only) — the Queen calls it to record her
 * triage decisions per idea.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { readImprovementItems, countImprovementItems } from '../../harness/improvements/read-items';
import { buildDigest } from '../../harness/improvements/digest';
import { readOwnerFullAutonomyGrant } from '../../harness/improvements/full-autonomy-grant';
import { applyHumanQueueRanking, humanQueueRankerSpec, type RankedHumanQueueItem } from '../../queue-ranker/human-queue';
import { triageIdea, summarizeTriages, type IdeaType, type TriageDecision } from '../../harness/improvements/triage';
import { applyTriageDecision } from '../../harness/improvements/triage-core';

/**
 * How many open ideas one triage invocation reads.
 *
 * This is a WINDOW, not the corpus. It was previously an unnamed `100` inline in the
 * read, which is how `retriage-all` came to describe itself as a pass over "EVERY open
 * idea" while only ever reaching the first {@link TRIAGE_WINDOW} rows. Every mode now
 * stamps a `coverage` block derived from this constant plus the real `COUNT(*)`, so the
 * bound travels with the result instead of living only here.
 */
const TRIAGE_WINDOW = 100;

export default defineTool({
  name: 'improvements:triage',
  profile: 'engineer',
  description:
    'Triage turn: route each scored idea by the D-005 taxonomy (product→place; code-bug→the policy tier\'s lane; infra-environment→owner-escalation; process-prompt→gate/gym; needs-design→plans:new). The risk-tier policy is the one safety verdict — triage adds only routing (D-003). Before routing, a deployment-staleness screen diverts a tool-failure filing whose tool source differs from the serving build to land-the-deploy, not a code fix (P-003). Persists the decision on the idea lifecycle. (P-010) Per-Hive scope filtering.',
  guidance: {
    when:
      'To triage captured ideas: read the digest summary, walk the human queue in RANK order (the P-040 ranker — triage-all carries each item\'s rank breakdown), classify by the D-005 taxonomy, decide (place/gate/gym/reject), and record your judgment. (P-010) Pass harnessSlug for one Hive. mode=retriage-all re-routes the open-idea WINDOW after a taxonomy/policy change — every mode returns `coverage`; retriage-all adds `complete`, and complete:false means ideas beyond the window KEPT their old routing.',
    notWhen: 'You want to READ ideas — use improvements:digest. You want to CAPTURE — use improvements:capture. You want implementation status — use improvements:resolve.',
    chaining: "improvements:triage → work_items:create/update for placed ideas, or coord:escalate for human-gate ideas. A rank breakdown showing a 'calibration' contribution → calibration:summary { predictor } to weigh the bettor's claim before deciding.",
    seeAlso: [
      'improvements:digest (READ the ideas without recording a judgment)',
      'improvements:capture (FILE a new idea)',
      'work_items:create (place a triaged idea as tracked work)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // Triage uses the issue helpers' own short-lived DB calls and never reads
  // ctx.tx. In particular, triage-one must not hold the ambient workspace
  // transaction while a queue-wide ranking pass is running under load.
  skipWorkspaceTx: true,
  // Queue-wide summary/retriage scans can legitimately sit behind the shared
  // issue/ranking reads for longer than the generic 60s tool budget. The
  // historical false-timeout reached 187s before the handler returned
  // successfully; leave enough headroom for that bounded batch.
  timeoutSec: 300,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    mode: z
      .enum(['summary', 'triage-all', 'triage-one', 'retriage-all'])
      .optional()
      .describe(
        'Summary: show triage breakdown without applying decisions. Triage-all: classify all open ideas. Triage-one: triage a single idea by id. Retriage-all: re-run the deterministic route over the ranked open-idea WINDOW — or over exactly `ids` — already-triaged included (triaged→triaged is valid), and PERSIST it; the backlog migration pass for a taxonomy change (consume-edges P-021).',
      ),
    ideaId: z.string().optional().describe('For triage-one mode, the idea to triage'),
    decision: z
      .enum(['place', 'gate', 'gym', 'reject'])
      .optional()
      .describe('For triage-one, the triaging agent\'s decision'),
    reason: z.string().optional().describe('Reason for the decision (required if decision is set)'),
    harnessSlug: z.string().min(1).max(80).optional().describe('(P-010) restrict to a specific Pot\'s ideas (default: all)'),
    ids: z
      .array(z.string().min(1))
      .min(1)
      .max(TRIAGE_WINDOW)
      .optional()
      .describe(
        'Scope the pass to an EXPLICIT id set instead of the ranked first-window read (EI-19374906980984233). This is how a backlog COHORT gets re-routed after a taxonomy fix: the window read can never reach rows ranked past it, and widening the write to the whole corpus was deliberately declined. Applied as a SQL predicate; `coverage.scope` becomes "requested-ids" and `complete` then means every requested id was examined.',
      ),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);

    // EI-19374906980984233: `ids` scopes the digest-backed read below. triage-one
    // returns before that read and takes its single subject from `ideaId`, so an `ids`
    // here would be silently dropped — refuse instead of pretending it was honoured.
    if (args.ids && args.mode === 'triage-one') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'triage-one does not accept `ids` — it triages the single `ideaId`. Use mode=retriage-all with `ids` for a cohort.',
            }),
          },
        ],
      };
    }
    const scopedIds = args.ids && args.ids.length > 0 ? args.ids : undefined;

    // Triage-one only needs the requested item's lifecycle write. The full
    // digest/ranking prelude below is for queue views, not this targeted
    // operation. Running it here made a single Blender/Mug triage call scan
    // and rank 100 ideas before touching one item; under load that could
    // outlive the 60s dispatcher deadline and return the misleading
    // "handler returned but signal had aborted" timeout (EI-21826830445006528).
    if (args.mode === 'triage-one') {
      if (!args.ideaId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'triage-one mode requires ideaId',
              }),
            },
          ],
        };
      }

      if (!args.decision || !args.reason) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'triage-one mode requires decision + reason',
              }),
            },
          ],
        };
      }

      // Persist the Queen's decision durably (learning-system-audit P-010):
      // writes payload.ideaLifecycle (state machine validated), records
      // payload.decidedReason + CLOSES the issue on reject (queue-as-memory —
      // the next same-signature capture recalls "already decided: <reason>").
      const result = await applyTriageDecision({
        id: args.ideaId,
        decision: args.decision as TriageDecision,
        reason: args.reason,
        by: 'Queen',
      });
      if (!result.ok) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ ok: false, error: result.error }) },
          ],
        };
      }

      // Guidance follows the decision that was actually RECORDED, never the one
      // requested. A pre-route screen can change it (P-003 deployment staleness), and
      // echoing the request back as though it had been applied is exactly how a divert
      // becomes invisible to the caller who asked for the original route.
      const effectiveDecision = result.decision ?? (args.decision as TriageDecision);
      let note = '';
      if (result.deploymentStalenessDivert) {
        note =
          `DIVERTED by the deployment-staleness screen (P-003 / EI-22450280531836927): requested ` +
          `${result.deploymentStalenessDivert.requestedDecision}, recorded gate → ` +
          `${result.deploymentStalenessDivert.target}. The file defining this filing's tool differs between the ` +
          `serving build and the tree, so the reported condition may already be repaired and merely UNDEPLOYED — ` +
          `the repair is to LAND THE DEPLOY, not a code change. Confirm with dev:pipeline_position before re-routing.`;
      } else if (effectiveDecision === 'place') {
        note = 'Decision persisted. Use work_items:create to assign and track the implementation.';
      } else if (effectiveDecision === 'gate') {
        note = 'Decision persisted. Escalate for human review before proceeding.';
      } else if (effectiveDecision === 'gym') {
        note = 'Decision persisted. Gym A/B dispatch for verification (P-040). Next: call cup:spawn or harness:create to instantiate the gym with the target prompt variant for evaluation.';
      } else if (effectiveDecision === 'reject') {
        note = 'Decision persisted: issue CLOSED with decidedReason — the recall matcher surfaces it on the next same-signature capture.';
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'triage-one',
              ideaId: args.ideaId,
              decision: effectiveDecision,
              requestedDecision: args.decision,
              reason: args.reason,
              lifecycle: result.lifecycle,
              closed: result.closed ?? false,
              ...(result.deploymentStaleness ? { deploymentStaleness: result.deploymentStaleness } : {}),
              ...(result.deploymentStalenessDivert
                ? { deploymentStalenessDivert: result.deploymentStalenessDivert }
                : {}),
              note,
            }),
          },
        ],
      };
    }

    // Read all open ideas (P-010: filter by harnessSlug if provided), human
    // lane ranked by the ONE queue ranker (frontier P-040/P-045, D-005) — the
    // Queen's triage walk follows the same order the digest, the tab, and the
    // owner inbox show, with each item carrying its rank.features breakdown.
    // `issueIds` is a SQL predicate, never a post-filter (see ReadImprovementOpts.issueIds:
    // filtering after the read returns the first N of the whole corpus and then shrinks it,
    // which looks like it worked). Both legs keep the SAME filter — WI-1206660's guard —
    // so `corpusTotal` always describes the set this call actually read.
    const readOpts = {
      state: 'open' as const,
      limit: TRIAGE_WINDOW,
      harnessSlug: args.harnessSlug,
      ...(scopedIds ? { issueIds: scopedIds } : {}),
    };
    // D2 (EI-18790490225750395), propagated here from `improvements:digest`: the TRUE
    // corpus total — a real COUNT(*), never bounded by `limit`. Without it `buildDigest`
    // falls back to `total = candidates.length`, so this tool reported its own 100-row
    // WINDOW as the backlog size AND set `windowed:false`, which reads as a positive
    // assertion that nothing was truncated. Best-effort exactly as in digest.ts: a count
    // failure degrades to `undefined` (prior behaviour) rather than sinking the triage.
    const [items, corpusTotal] = await Promise.all([
      readImprovementItems(readOpts),
      countImprovementItems(readOpts).catch(() => undefined),
    ]);
    // The OWNER FULL-AUTONOMY grant (Phase 2): the Queen's recorded triage must match the
    // live dispatch — when ON, protected-surface kind=bugs route to the auto-implement lane.
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const ownerFullAutonomy = await readOwnerFullAutonomyGrant(ws);
    const digest = await applyHumanQueueRanking(
      buildDigest(items, { nowMs: Date.now(), ownerFullAutonomy, corpusTotal }),
      { candidates: items },
    );
    // The window/corpus framing every mode below stamps onto its result, so a count
    // computed over a capped fetch can never be read as a corpus-wide verdict.
    // A requested id that does not come back is NOT a no-op: it is already terminal, not
    // topic-tagged, or outside the harness lens. Counting only what came back is the
    // silent partial this block exists to make impossible — the same failure `coverage`
    // was added for, one scope down.
    const examinedIds = new Set(items.map((item) => item.id));
    const missingIds = scopedIds ? scopedIds.filter((id) => !examinedIds.has(id)) : [];
    const coverage = {
      // WHAT this pass was scoped to. Without it a caller cannot tell a corpus-wide
      // `corpusTotal` from a cohort-sized one, and the two mean opposite things.
      scope: scopedIds ? ('requested-ids' as const) : ('corpus' as const),
      window: TRIAGE_WINDOW,
      examined: items.length,
      requested: scopedIds ? scopedIds.length : null,
      missing: scopedIds ? missingIds.length : null,
      missingIds: scopedIds ? missingIds.slice(0, 20) : null,
      corpusTotal: corpusTotal ?? null,
      windowed: digest.window.windowed,
    };

    // Summary mode: just show the breakdown
    if (!args.mode || args.mode === 'summary') {
      const summary = summarizeTriages([...digest.humanQueue, ...digest.autoEligible]);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'summary',
              digest: {
                census: digest.census,
                window: digest.window,
                autoEligible: digest.autoEligible.length,
                humanQueue: digest.humanQueue.length,
              },
              // The breakdown below is computed over `coverage.examined` rows, NOT the
              // corpus: `triageSummary.total` is a floor. Read `coverage` before quoting
              // any of these counts as a backlog-wide figure.
              coverage,
              triageSummary: summary,
              // The one ranker's registry as data (P-040/D-005) — name/weight/
              // description per feature, the inspectable half of rank.features.
              ranker: humanQueueRankerSpec(),
            }),
          },
        ],
      };
    }

    // Triage-all: classify all open ideas and show decisions. The human queue
    // leads in RANK ORDER (P-040/P-045) with each item's breakdown attached, so
    // the Queen walks the same order every other surface shows.
    if (args.mode === 'triage-all') {
      const decide = (item: (typeof digest.autoEligible)[number]) => {
        const triage = triageIdea(item);
        return {
          id: item.id,
          title: item.title,
          kind: item.kind,
          ideaType: item.ideaType,
          score: item.score,
          decision: triage.decision,
          reason: triage.reason,
          target: triage.target,
        };
      };
      const rankedQueue: RankedHumanQueueItem[] = digest.humanQueue;
      const decisions = [
        ...rankedQueue.map((item) => ({
          ...decide(item),
          rankScore: item.rank.score,
          rankFeatures: item.rank.features
            .filter((f) => f.contribution !== 0)
            .map((f) => `${f.feature}: ${f.contribution.toFixed(2)}`),
        })),
        ...digest.autoEligible.map(decide),
      ];

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'triage-all',
              // Keep the preview contract machine-readable and near the front of the
              // envelope. A prose-only note at the end can be truncated away while the
              // decisions remain, making a no-op bulk read look like a successful write.
              previewOnly: true,
              persisted: false,
              appliedCount: 0,
              coverage,
              decisions,
              note:
                'Review the decisions above. Use triage-one to record each decision you choose to apply. ' +
                'PREVIEW ONLY — this mode persists nothing. `decisions` covers the first ' +
                `${coverage.examined} open idea(s)` +
                (coverage.windowed ? ` of ${coverage.corpusTotal ?? 'an unknown number of'} in the corpus.` : '.'),
            }),
          },
        ],
      };
    }

    // Retriage-all (consume-edges P-021): one deterministic pass over the open-idea
    // WINDOW — already-triaged included (triaged→triaged is a valid transition) — so a
    // taxonomy change re-routes standing items rather than only new ones.
    // Decisions are persisted (by='improvement-retriage'); the Queen/owner can
    // still re-take any of them via triage-one.
    //
    // ⚠ This reaches the first TRIAGE_WINDOW open ideas, NOT the whole corpus. This
    // comment used to claim "EVERY open idea", which is the dangerous reading: after a
    // taxonomy change an operator sees `scanned: 100 / applied: 100`, concludes the
    // standing backlog was re-routed, and never learns the remainder kept its stale
    // routing — a silent partial that looks exactly like success. The result now carries
    // `coverage` + `complete` so the bound is impossible to miss. Widening the WRITE to
    // the full corpus is deliberately NOT done here: that turns a reporting fix into a
    // bulk mutation of every open idea and needs its own decision.
    if (args.mode === 'retriage-all') {
      const all = [...digest.humanQueue, ...digest.autoEligible];
      const byDecision: Record<TriageDecision, number> = { place: 0, gate: 0, gym: 0, reject: 0 };
      const byType: Record<IdeaType, number> = {
        'product': 0,
        'code-bug': 0,
        'infra-environment': 0,
        'process-prompt': 0,
        'needs-design': 0,
      };
      const failures: Array<{ id: string; error: string }> = [];
      let applied = 0;
      // P-003: how many filings this pass kept OUT of the code-fix lane because their
      // subject is already repaired in the tree and merely undeployed. Counted from the
      // RECORDED decision, so the tally cannot disagree with what was persisted.
      let deploymentStalenessDiverted = 0;
      const deploymentStalenessDivertedIds: string[] = [];
      for (const item of all) {
        const triage = triageIdea(item);
        const res = await applyTriageDecision({
          id: item.id,
          decision: triage.decision,
          reason: triage.reason,
          by: 'improvement-retriage',
          comment: false, // batch pass — the lifecycle carries the decision, no thread spam
        });
        if (res.ok) {
          applied += 1;
          // The recorded decision, not the recommended one: a pre-route screen or guard
          // can change it, and counting the recommendation would report a route that was
          // never persisted (the same under-report triage-one carried until P-003).
          byDecision[res.decision ?? triage.decision] += 1;
          if (res.deploymentStalenessDivert) {
            deploymentStalenessDiverted += 1;
            if (deploymentStalenessDivertedIds.length < 20) deploymentStalenessDivertedIds.push(item.id);
          }
          if (item.ideaType) byType[item.ideaType] += 1;
        } else {
          failures.push({ id: item.id, error: res.error ?? 'unknown' });
        }
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'retriage-all',
              scanned: all.length,
              applied,
              // `scanned`/`applied` count the WINDOW, never the corpus. `complete` is the
              // one field that answers "did this re-route the standing backlog?" — false
              // means ideas outside the window kept their previous routing.
              coverage,
              // `complete` answers "did this re-route what it set out to?", and what that
              // IS depends on the scope. Corpus scope: false whenever rows sat past the
              // window. Requested-ids scope: false whenever a requested id never came back
              // — otherwise a cohort sweep that skipped half its ids reports success.
              complete: scopedIds ? missingIds.length === 0 : !coverage.windowed,
              completeOver: coverage.scope,
              // Corpus rows this call did not touch. Meaningless under an id scope (the
              // read was never trying to cover the corpus), so report it as NOT MEASURED
              // rather than as a 0 that reads like "nothing left".
              remaining: scopedIds
                ? null
                : coverage.corpusTotal === null
                  ? null
                  : Math.max(0, coverage.corpusTotal - all.length),
              byDecision,
              byType,
              // P-003 (EI-22450280531836927): filings whose subject is already repaired
              // in the tree and merely UNDEPLOYED. These were routed to land-the-deploy
              // instead of at a code fix — the number this screen exists to move.
              deploymentStalenessDiverted,
              deploymentStalenessDivertedIds,
              failures: failures.slice(0, 10),
              failureCount: failures.length,
            }),
          },
        ],
      };
    }

    // Triage-one: record the Queen's decision for a single idea
    if (args.mode === 'triage-one') {
      if (!args.ideaId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'triage-one mode requires ideaId',
              }),
            },
          ],
        };
      }

      if (!args.decision || !args.reason) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'triage-one mode requires decision + reason',
              }),
            },
          ],
        };
      }

      // Persist the Queen's decision durably (learning-system-audit P-010):
      // writes payload.ideaLifecycle (state machine validated), records
      // payload.decidedReason + CLOSES the issue on reject (queue-as-memory —
      // the next same-signature capture recalls "already decided: <reason>").
      const result = await applyTriageDecision({
        id: args.ideaId,
        decision: args.decision as TriageDecision,
        reason: args.reason,
        by: 'Queen',
      });
      if (!result.ok) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ ok: false, error: result.error }) },
          ],
        };
      }

      // Guidance follows the decision that was actually RECORDED, never the one
      // requested. A pre-route screen can change it (P-003 deployment staleness), and
      // echoing the request back as though it had been applied is exactly how a divert
      // becomes invisible to the caller who asked for the original route.
      const effectiveDecision = result.decision ?? (args.decision as TriageDecision);
      let note = '';
      if (result.deploymentStalenessDivert) {
        note =
          `DIVERTED by the deployment-staleness screen (P-003 / EI-22450280531836927): requested ` +
          `${result.deploymentStalenessDivert.requestedDecision}, recorded gate → ` +
          `${result.deploymentStalenessDivert.target}. The file defining this filing's tool differs between the ` +
          `serving build and the tree, so the reported condition may already be repaired and merely UNDEPLOYED — ` +
          `the repair is to LAND THE DEPLOY, not a code change. Confirm with dev:pipeline_position before re-routing.`;
      } else if (effectiveDecision === 'place') {
        note = 'Decision persisted. Use work_items:create to assign and track the implementation.';
      } else if (effectiveDecision === 'gate') {
        note = 'Decision persisted. Escalate for human review before proceeding.';
      } else if (effectiveDecision === 'gym') {
        note = 'Decision persisted. Gym A/B dispatch for verification (P-040). Next: call cup:spawn or harness:create to instantiate the gym with the target prompt variant for evaluation.';
      } else if (effectiveDecision === 'reject') {
        note = 'Decision persisted: issue CLOSED with decidedReason — the recall matcher surfaces it on the next same-signature capture.';
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'triage-one',
              ideaId: args.ideaId,
              decision: effectiveDecision,
              requestedDecision: args.decision,
              reason: args.reason,
              lifecycle: result.lifecycle,
              closed: result.closed ?? false,
              ...(result.deploymentStaleness ? { deploymentStaleness: result.deploymentStaleness } : {}),
              ...(result.deploymentStalenessDivert
                ? { deploymentStalenessDivert: result.deploymentStalenessDivert }
                : {}),
              note,
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: 'Unknown mode',
          }),
        },
      ],
    };
  },
});
