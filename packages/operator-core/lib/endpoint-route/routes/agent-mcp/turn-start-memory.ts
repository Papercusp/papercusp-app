/**
 * POST /api/agent-mcp/turn-start-memory
 *
 * Plan: memory-delivery-unification-2026-07-12 (P-003a, decisions D-002/D-004).
 *
 * The UserPromptSubmit hook (userpromptsubmit-memory.sh) fetches on every
 * submitted prompt in a psu session. It first consumes the compact pending
 * CTRL transition (P-014), then runs the general-memory admission pipeline
 * with queryContext = the user's message, under the warm-session epoch
 * dedup (P-002, port 'turn-start') and a SMALL budget — injected lines
 * compound in a warm session, so turn-start is high-precision/low-volume
 * (D-004): the hard floors stay, the budget shrinks, and anything already
 * surfaced this epoch (initialize prelude, orient recall, a claim port) is
 * never re-paid.
 *
 * Body: { owner, prompt, workspace?, harness?, cwd? } — the hook passes
 * harness/workspace from its launch env so this endpoint does no
 * session-registry resolution on the hot path. `cwd` (EI-18893248175645463)
 * is a fallback ONLY: when `harness` is empty (an operator/superuser-scope
 * session, which legitimately has no single PAPERCUSP_HARNESS_SLUG), the
 * client's cwd lets detectHarnessSlugSync's env→marker-file→meta-repo chain
 * still resolve one — the same detection the MCP 'initialize' prelude uses —
 * instead of unconditionally starving the harness+hive pools for that
 * session's entire lifetime.
 *
 * CTRL is checked even for a low-signal prompt ("continue") because a mode,
 * loop, carry, or route transition must take effect at the very next boundary.
 * Memory no longer has a low-signal floor of its own (P-035 / F-E deleted the
 * 40-char gate — see the note below): relevance is decided by the relevance
 * floor, not by prompt length. Fail-soft by contract: any failure returns
 * `{ ok: true, text: '' }` — a hook must never surface an error into a turn.
 * `auth: 'loopback'` — the hook runs on this box.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { randomUUID } from 'node:crypto';
import type { ActivationRevision } from '../../../session-activation';

// Reuse the hook's emission ledger and the existing two-phase cursor store.
// This surface is separate from orientation: CTRL may be the only emitted block.
const CONTROL_DELIVERY_SURFACE = 'turn-start-control';
type ControlDelivery = {
  text: string;
  candidate?: { generation: number; activationRevision?: ActivationRevision };
};

// portable-identity P-010: the package half of orientation. Its receipt
// (allocation, deliveries, omissions) is staged on its own surface under the
// same delivery token, so it commits only once the hook proves it printed it.
const PACKAGE_SINK_DELIVERY_SURFACE = 'turn-start-package-sink';
// Discovery (anchor + identity sources) plus the evaluator's own 1.5s turn
// ceiling, kept inside the hook's 2.5s response wall.
const PACKAGE_SINK_WALL_MS = 1_800;
type PackageSinkDelivery = {
  classes: import('../../../agent-identities/package-orientation-classes').PackageOrientationClass[];
  receipt: Record<string, unknown> | null;
};

/*
 * NO LENGTH FLOOR HERE — deliberately (context-injection-audit-2026-07-28 P-035
 * / F-E). A `MIN_PROMPT_CHARS = 40` gate used to skip recall for any prompt
 * shorter than 40 characters, on the theory that "continue" / "y" / "ok" carry
 * no recall signal. It was DELETED with no replacement heuristic, and it should
 * not be reintroduced in any form:
 *
 *  - It was a PROXY for relevance, and it was measurably wrong. Prompt LENGTH
 *    does not predict recall signal: this exact gate is what produced the
 *    audit's founding symptom, silently dropping the owner's 23-char question —
 *    a specific, answerable, entirely on-topic prompt — while a 40-char
 *    pleasantry sailed through.
 *  - What it was standing in for now exists for real. F-B (P-032, D-010) made
 *    the push path `cosine-gated`, so the limit is a genuine CEILING and a
 *    signal-free prompt returns ZERO hits on its own merits. Relevance is
 *    judged by the relevance floor, not by a character count.
 *  - The ORDERING mattered and is the whole reason this could not be deleted
 *    when first found: before F-B the push path could not return zero, so
 *    removing the length gate would have handed every short prompt a SATURATED
 *    block of noise — strictly worse than dropping it. That constraint is gone.
 *
 * The degenerate empty-prompt case needs no guard here either: buildMemoryContextBlock
 * returns null on a blank queryContext (injection.ts), one layer down.
 */

/** Query clamp — embed the head of a long prompt, not a pasted document.
 *
 * ⚠ Applied to the CHROME-STRIPPED prompt (P-048), never the raw one. Against
 * the raw prompt this clamp was the defect rather than the guard: measured over
 * a live 7-day window (D-033), 70.0% of ALL turn-start queries were truncated
 * exactly here, 251 of those 254 rows machine-injected — so the clamp was
 * reliably keeping a wake's opening boilerplate and discarding the task content
 * behind it. Post-strip a typical wake is ~240 chars and never reaches it. */
const PROMPT_QUERY_CLAMP = 1_000;

/** D-004 small budget for the mid-epoch delta (chars). */
const TURN_START_BUDGET_CHARS = (() => {
  const raw = Number(process.env.PAPERCUSP_TURN_START_BUDGET_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4_000;
})();

const turnStartMemory = defineTool({
  method: 'POST',
  path: '/agent-mcp/turn-start-memory',
  auth: 'loopback',
  async handler(req) {
    let body: {
      owner?: string;
      prompt?: string;
      workspace?: string;
      harness?: string;
      cwd?: string;
      memoryEnabled?: boolean;
      /** Which TUI is asking — 'claude' | 'codex' | 'omp'. Recorded only (P-005). */
      client?: string;
      /**
       * ACK-ON-PROOF (owner-directive-delivery-redesign-2026-09-22 P-005): the
       * orientation `deliveryToken` this hook last EMITTED, or null when it can
       * prove none. The key's presence opts in; a hook that omits it keeps
       * ack-on-arrival. See read-cursors.ts.
       */
      confirmedDelivery?: string | null;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: true, text: '' });
    }
    const owner = (body.owner ?? '').trim();
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!owner) return Response.json({ ok: false, error: 'owner required' }, { status: 400 });
    try {
      let harness = (body.harness ?? '').trim();
      // EI-18893248175645463: PAPERCUSP_HARNESS_SLUG is only exported for
      // harness-scoped spawns, so an operator/superuser-scope session (which
      // legitimately spans multiple harnesses, or is simply launched bare)
      // never sends `harness` — and BOTH the harness AND hive pools (hive
      // resolution below fans out FROM harnessSlugs) went unconditionally
      // empty for that session's entire lifetime, not just an occasional
      // miss (measured: a clean per-session split, zero intra-session mix).
      // Fall back to the SAME env → marker-file → meta-repo detection chain
      // the MCP 'initialize' prelude already offers (detect-harness-slug.ts)
      // — using the CLIENT's cwd (the hook runs on this box, loopback-only,
      // so its cwd is the actual session's working directory), never the
      // operator's own process cwd, which would misattribute a session
      // working in a sibling harness (e.g. papercusp-public-site).
      if (!harness && typeof body.cwd === 'string' && body.cwd.trim()) {
        try {
          const { detectHarnessSlugSync } = await import('../../../memory/detect-harness-slug');
          harness = detectHarnessSlugSync({ cwd: body.cwd.trim() }).slug ?? '';
        } catch {
          /* detection is best-effort — an empty harness just stays a bare-session pull */
        }
      }
      const workspace = (body.workspace ?? '').trim();
      const { activeWorkspaceId } = await import('../../../workspace-registry');
      const workspaceId = workspace && workspace !== '*' ? workspace : activeWorkspaceId();

      /**
       * WI-37597: report THIS port's delivery coverage.
       *
       * Until this existed, `recordInjectionCoverage` was called from
       * `mid-turn-context.ts` and nowhere else, so `context_injection_coverage`
       * had never held a single `turn-start` row — for any client, ever. The
       * detector built to answer "is this client being served context?" was
       * therefore blind to a turn-start outage by construction, which is why
       * EI-20001110634702380 (a real turn-start injection failure) closed
       * cause-undetermined.
       *
       * Fail-silent and never awaited, exactly like the rest of this path: this
       * runs inside a hook-serving request whose whole contract is that it must
       * never cost the agent's turn. Losing a counter is a rounding error;
       * surfacing an error into a turn is a wedged agent.
       */
      const recordCoverage = (outcome: 'recalled' | 'no-recall' | 'no-signal'): void => {
        void (async () => {
          try {
            const { recordInjectionCoverage } = await import(
              '../../../memory/injection-delivery-coverage'
            );
            await recordInjectionCoverage([
              {
                port: 'turn-start',
                outcome,
                // Same contract as the memory_recall_stats `client` field: a
                // caller that sends none records '' (unattributed) rather than
                // being defaulted to a client name it might not be.
                client: typeof body.client === 'string' && body.client ? body.client : '',
                workspaceId,
              },
            ]);
          } catch {
            /* swallow — see the fail-silent note above. */
          }
        })();
      };

      const controlPromise = (async (): Promise<ControlDelivery> => {
        try {
          const {
            preparePendingControlTransition,
            markControlTransitionPrepared,
            failControlTransitionActivation,
            convergeActivationToLaunchRecord,
            applyRelaunchedActivation,
            acknowledgeControlTransition,
            renderControlTransitionContext,
          } = await import(
            '../../../agent-tools/coordination/control-anchor'
          );
          const { ackAndRead, clearReadCursor } = await import('../../../agent-tools/coordination/read-cursors');
          // WI-10003297: rendering is not delivery. Even a legacy hook without
          // a ledger must not acknowledge on arrival: it proves no emission.
          // A committed candidate survives an ACK write failure for next-turn retry.
          const proof = await ackAndRead(owner, CONTROL_DELIVERY_SURFACE, {
            confirmedToken: typeof body.confirmedDelivery === 'string' ? body.confirmedDelivery : null,
          }).catch(() => null);
          const confirmed = proof?.committed;
          if (confirmed && typeof confirmed.generation === 'number' && Number.isSafeInteger(confirmed.generation)) {
            const revision = confirmed.activationRevision as ActivationRevision | undefined;
            if (revision === undefined || (typeof revision?.specificationRevision === 'string' && typeof revision.stateRevision === 'string')) {
              const acknowledged = await acknowledgeControlTransition(owner, workspaceId, confirmed.generation, undefined, revision)
                .catch(() => false);
              // Once the authoritative write succeeded there is nothing to retry.
              // Retain committed proof on failures, but avoid another write on every
              // later turn after success. Cleanup failure merely permits a retry.
              if (acknowledged) await clearReadCursor(owner, CONTROL_DELIVERY_SURFACE).catch(() => {});
            }
          }
          const transition = await preparePendingControlTransition(owner, workspaceId);
          if (!transition) return { text: '' };
          const ctrl = renderControlTransitionContext(transition);
          const activationRevision = transition.state?.activation?.desired;
          // identities-v1 P-012: a stack mutation (a fleet posture attached / swapped /
          // detached; mode-axis layers once P-021 lands) rides THIS transition. The
          // layer text is a SEPARATE block after the `⟦CTRL⟧` line — outside the
          // anchor's 384-token budget — and degrades to nothing on any failure.
          // Rendering prepares a delivery candidate. Only the hook's later proof
          // of emission acknowledges it; failed rendering or delivery stays pending.
          let stack = '';
          let stackRendered = true;
          let stackRequiresFreshContext = false;
          try {
            const { renderStackTransitionContextResult } = await import('../../../stack-binding-channel');
            // portable-identity P-003: the addressed Project-guide parts a stack change
            // reaches ride the SAME transition. Target = the gate-selected launch record's
            // profile/harness/agent — what the launch composed with. Unresolvable ⇒ layer text
            // plus the wearer's package docs only (the harness-less target below).
            const { getOrgPg } = await import('@papercusp/db-org');
            const launchSpec = await (async () => {
              try {
                const { readGateSelectedLaunchSpec } = await import('../../../agent-tools/coordination/control-anchor');
                return { value: await readGateSelectedLaunchSpec(getOrgPg().sql, owner, workspaceId) };
              } catch {
                return null;
              }
            })();
            const client = typeof body.client === 'string' ? body.client : null;
            const guide = await (async () => {
              if (!launchSpec) return null;
              try {
                const { guideTargetFromLaunchSpec } = await import('../../../doc-projection/addressed-project-guide');
                return guideTargetFromLaunchSpec(launchSpec.value, { workspaceId, client });
              } catch {
                return null;
              }
            })();
            // P-009 / D-022: pack docs ride this transition — before = the owner's APPLIED
            // installation, after = what the desired revision leaves it holding (the same
            // decision the activation apply makes). Package tokens match in any harness, so a
            // profile with no guide still reads them against the workspace (harness '' matches
            // no blueprint/slot/role part).
            const packageResources = async () => {
              const [{ resolveWearerPackageDocKeys }, { sessionPackageDocKeysForRevision }, { appliedIdentityArtifact }] =
                await Promise.all([
                  import('../../../blueprint/package-memory-visibility'),
                  import('../../../blueprint/session-package-resources'),
                  import('../../../capability-envelope/identity-grants-port'),
                ]);
              const sql = getOrgPg().sql;
              const before = await resolveWearerPackageDocKeys(sql, { workspaceId, ownerId: owner });
              if (!activationRevision) return { before, after: before };
              if (!launchSpec) throw new Error('launch record unreadable');
              const after = await sessionPackageDocKeysForRevision(sql, { ownerId: owner, workspaceId,
                revision: activationRevision, artifact: appliedIdentityArtifact(launchSpec.value, activationRevision) });
              return { before, after };
            };
            const rendered = await renderStackTransitionContextResult(transition, {
              guide: guide ?? { workspaceId, harnessSlug: '', client: client ?? 'all' },
              packageResources,
              ...(activationRevision
                ? {
                    repoDir: typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined,
                    activation: {
                      specificationRevision: activationRevision.specificationRevision,
                      stateRevision: activationRevision.stateRevision,
                      idempotencyKey: `session-activation:${owner}:${activationRevision.specificationRevision}:${activationRevision.stateRevision}`,
                    },
                  }
                : {}),
            });
            stack = rendered.text;
            stackRendered = rendered.rendered;
            stackRequiresFreshContext = rendered.requiresFreshContext;
          } catch {
            /* the CTRL line is never lost to a stack-render fault */
            stackRendered = false;
          }
          const text = stack ? `${ctrl}\n\n${stack}` : ctrl;
          if (!stackRendered && activationRevision) {
            await failControlTransitionActivation(
              owner,
              workspaceId,
              transition.generation,
              activationRevision,
              'stack transition render failed',
            ).catch(() => undefined);
            // EI-23886889674609842: the failure record keeps the old `applied`, but a
            // session already relaunched on `desired` is denied every tool while it
            // does. Converge the authority receipt ONLY (never the delivery
            // watermark) when the gate-selected launch record proves `desired` is
            // what runs; the stack block stays pending for the next turn.
            await convergeActivationToLaunchRecord(
              owner,
              workspaceId,
              transition.generation,
              activationRevision,
            ).catch(() => false);
          }
          // WI-10002021: `requiresFreshContext` means "a successor host must carry this
          // before it is acknowledged" — a WAIT, not a permanent veto. But nothing ends
          // the wait on its own: `stackBefore` is rewritten ONLY when the control STATE
          // next changes (control-anchor's ON CONFLICT clause), never by acknowledgement.
          // So the successor recomputes the identical stackBefore→state.stack diff, gets
          // `relaunch-with-carry` again, skips prepare+ack again, and `applied` never
          // converges to the specification the session is actually running.
          // identity-grants-port then reads current !== applied and denies
          // 'stale-artifact' for EVERY tool for the life of the session — including the
          // coord:orient recovery door. That is the half WI-10002005 did not cover.
          //
          // The wait is genuinely over the moment THIS session's own launch record
          // carries the desired specification: the relaunch already happened and we are
          // the successor. Acknowledging a specification the session is demonstrably
          // running is fail-closed — an unreadable, absent, or non-matching launch
          // record keeps waiting, exactly as before.
          let awaitingRelaunch = stackRequiresFreshContext;
          if (stackRequiresFreshContext && activationRevision) {
            try {
              const { readSuLaunchSpecByOwner } = await import('../../../adv-sessions');
              const launched = (await readSuLaunchSpecByOwner(owner)) as
                { specificationRevision?: unknown } | null;
              const revision = launched?.specificationRevision;
              if (
                typeof revision === 'string' &&
                revision === activationRevision.specificationRevision
              ) {
                awaitingRelaunch = false;
              }
            } catch {
              /* never acknowledge on an unreadable launch record — keep waiting */
            }
          }
          let activationPrepared = true;
          if (stackRendered && !awaitingRelaunch && activationRevision) {
            // WI-10003459: a carry-respawn's launch artifact IS the consumption of
            // `desired`, so attribution must follow it from this first turn — not
            // from the next turn's delivery proof. Refuses (no write) unless the
            // latest desired was a restart onto this revision AND the launch record
            // carries it; in-place transitions keep waiting for proof. Never touches
            // the delivery watermark, so the prepare/ack below still run as before.
            await applyRelaunchedActivation(owner, workspaceId, transition.generation, activationRevision)
              .catch(() => false);
            // A verified successor already runs this launch artifact. Preserve
            // that independently-proven authority while the hook receipt is
            // pending, or the successor's first turn can lose every tool to
            // stale-artifact. This never advances the delivery watermark, and
            // the prepare below keeps delivery status at Prepared until proof.
            if (stackRequiresFreshContext) {
              await convergeActivationToLaunchRecord(owner, workspaceId, transition.generation, activationRevision)
                .catch(() => false);
            }
            activationPrepared = await markControlTransitionPrepared(
              owner,
              workspaceId,
              transition.generation,
              activationRevision,
            ).catch(() => false);
          }
          if (
            stackRendered &&
            !awaitingRelaunch &&
            activationPrepared &&
            Number.isSafeInteger(transition.generation)
          ) {
            return { text, candidate: { generation: transition.generation, ...(activationRevision ? { activationRevision } : {}) } };
          }
          return { text };
        } catch {
          return { text: '' }; // migration/operator skew must never block the prompt
        }
      })();

      /**
       * Resolve the human principal and chrome-free query once for both recall
       * legs. Personal Vault remains a separate authorization/search/output
       * path; sharing these two server-owned inputs does not add it to general
       * memory's scope fan-out.
       */
      const recallInputPromise = (async (): Promise<{
        userId: string | null;
        queryText: string;
      } | null> => {
        if (body.memoryEnabled === false) return null;
        const [{ getSessionUserOrDefault }, { stripInjectedChrome }] = await Promise.all([
          import('../../../auth'),
          import('../../../turn-provenance/turn-provenance'),
        ]);
        const user = await getSessionUserOrDefault().catch(() => null);
        return {
          userId: user?.id ?? null,
          queryText: stripInjectedChrome(prompt),
        };
      })();

      const memoryPromise = (async (): Promise<string> => {
        if (body.memoryEnabled === false) {
          // The port fired and the caller opted out — a real reading, and NOT
          // an outage. Recording nothing here would make a client that always
          // disables memory indistinguishable from one whose hook is dead.
          recordCoverage('no-signal');
          return '';
        }
        try {
          const [{ buildMemoryContextBlock }, { getMemoryBlockBoundedResult }, recallInput] = await Promise.all([
            import('../../../memory/injection'),
            import('../../../memory/injection-block-cache'),
            recallInputPromise,
          ]);
          if (!recallInput) return '';
          // Retrieve on what the turn is ABOUT, not on the scaffolding it
          // arrived in — see PROMPT_QUERY_CLAMP above and D-033. Never empty
          // for a non-empty prompt, so this cannot silently disable recall.
          const { queryText } = recallInput;
          // ⚠ P-006 / D-046 (the human-turn tail) is DELIBERATELY NOT WIRED HERE.
          // `memory/human-turn-tail.ts` implements the owner's chosen shape and is
          // fully tested, but its LIVE-corpus acceptance measured a REGRESSION and
          // D-046's own re-open clause governs: a topical prompt whose human tail is
          // procedural ("continue where you left off" — the single most common human
          // turn in this corpus) loses its on-topic hits entirely. See plan decision
          // D-047. Do not wire this without re-running that measurement.
          // The client has a hard 2.5s wall around this whole endpoint. Reuse
          // the existing operator SWR block cache so a slow recall build serves
          // on the next turn instead of suppressing the concurrently-ready CTRL
          // and orientation sections. Owner is the session/conversation key;
          // cross-session stale recall must never bleed.
          const bounded = await getMemoryBlockBoundedResult(
            workspaceId,
            `turn-start:${owner}`,
            async () => {
              // P-044 (F-L): resolve the agent's ACTION signals only when this
              // turn actually builds/revalidates memory. A stale cache hit must
              // return immediately rather than paying these lookups inline.
              let agentSignals;
              try {
                const { resolveAgentSignalsForOwner } = await import('../../../memory/agent-signals');
                agentSignals = await resolveAgentSignalsForOwner({
                  ownerId: owner,
                  workspaceId,
                  ...(body.cwd ? { cwd: body.cwd } : {}),
                });
              } catch {
                agentSignals = undefined;
              }
              return await buildMemoryContextBlock({
                userId: recallInput.userId,
                workspaceId,
                harnessSlugs: harness ? [harness] : [],
                // P-044: the COSINE leg still gets the human's words alone — that
                // is the point, not a leftover (identifiers were measured diluting
                // that vector, D-041). The signals ride the LEXICAL leg's query,
                // composed by `lexicalQueryText`.
                queryContext: {
                  userText: queryText.slice(0, PROMPT_QUERY_CLAMP),
                  ...(agentSignals ? { agentSignals } : {}),
                },
                // P-005 / migration 770: `client` is recorded on
                // memory_recall_stats and NEVER branched on — this endpoint stays
                // client-agnostic by contract (D-001 invariant 6). A caller that
                // sends no client records NULL (unattributed), which is what every
                // pre-P-005 hook does and what makes the coverage query honest.
                session: {
                  sessionId: owner,
                  port: 'turn-start',
                  ...(typeof body.client === 'string' && body.client ? { client: body.client } : {}),
                },
                budgetChars: TURN_START_BUDGET_CHARS,
                heading: 'Relevant memory (turn-start delta)',
              });
            },
          );
          // A deadline/error is NOT healthy quiet. Record nothing so the
          // delivery-coverage detector sees the missing turn; only a completed
          // empty build earns `no-recall`.
          if (bounded.status !== 'ready') return '';
          const block = bounded.block ?? '';
          // `no-signal` is reserved for a prompt that carried nothing to
          // retrieve ON — chrome-stripped to empty. A non-empty query that
          // simply matched nothing is `no-recall`: healthy quiet, and a
          // genuinely different reading from "we never asked".
          recordCoverage(block ? 'recalled' : queryText ? 'no-recall' : 'no-signal');
          return block;
        } catch {
          // Deliberately record NOTHING on a throw. The outcome vocabulary has
          // no failure value, and the two candidates both LIE: 'no-recall'
          // means healthy quiet and would hide the fault outright. Recording
          // nothing leaves this turn absent from the numerator, which is what
          // the outage detector already reads as broken — the honest answer.
          return '';
        }
      })();

      /**
       * Personal Vault is an isolated fourth leg. The builder resolves the
       * caller's role/plan/binding exclusively from server-owned state and
       * performs default-deny grant authorization before either embedding or
       * searching. A refusal or failure is silence — no empty heading and no
       * indication that private data exists.
       */
      const personalPromise = (async (): Promise<string> => {
        if (body.memoryEnabled === false) return '';
        try {
          const [{ buildPersonalAmbientContextBlock }, recallInput] = await Promise.all([
            import('../../../personal-vault/ambient'),
            recallInputPromise,
          ]);
          if (!recallInput?.userId) return '';
          return (
            (await buildPersonalAmbientContextBlock({
              ownerId: owner,
              userId: recallInput.userId,
              workspaceId,
              query: recallInput.queryText,
            })) ?? ''
          );
        } catch {
          return '';
        }
      })();

      // fleet-deltas-leader-primitives-2026-07-10 P-004 / D-004 ruling 3:
      // ORIENTATION THAT ARRIVES. `coord:orient` is mandated in three separate
      // places (the MCP initialize instructions, the su playbook, the
      // S17-orient-bootstrap LLM assert) and 119 of 378 working owners (31.5%,
      // 7d) still issue no coordination read of any kind — so the READ half
      // rides this rail instead of being asked for. The WRITE half
      // (declare-intent + lane claim) stays an explicit call, because it needs
      // an agent-authored intent no server can synthesize.
      //
      // Runs CONCURRENTLY with control+memory: this endpoint is under a hard
      // 2.5s wall in the hook, so a third section must not add serial latency.
      // Flag-gated with a fail-OPEN default, and fail-soft internally, so the
      // worst case is the pre-P-004 `[control, memory]` composition unchanged.
      const orientationPromise = (async (): Promise<{ block: string; deliveryToken: string | null }> => {
        const none = { block: '', deliveryToken: null };
        try {
          const [{ getFlag }, { FLAGS }, { buildTurnStartOrientationBlock }] = await Promise.all([
            import('@papercusp/flags/server'),
            import('@papercusp/flags'),
            import('../../../turn-start-orientation'),
          ]);
          const on = await getFlag(FLAGS.TURN_START_ORIENTATION, 'system').catch(() => true);
          if (!on) return none;
          return await buildTurnStartOrientationBlock({
            ownerId: owner,
            workspaceId,
            ...('confirmedDelivery' in body
              ? {
                  confirmedDeliveryToken:
                    typeof body.confirmedDelivery === 'string' && body.confirmedDelivery
                      ? body.confirmedDelivery
                      : null,
                }
              : {}),
          });
        } catch {
          return none;
        }
      })();

      // portable-identity P-010: every package contribution the wearer's stack
      // declares at the turn-start sink, evaluated under ONE aggregate budget
      // (agent-identities/turn-start-package-sink.ts). Concurrent with the
      // platform half and bounded, so a slow provider costs its omission row,
      // never the turn. Gated with orientation: it renders into that block.
      const packagePromise = (async (): Promise<PackageSinkDelivery> => {
        const none: PackageSinkDelivery = { classes: [], receipt: null };
        try {
          const [
            { getFlag },
            { FLAGS },
            { ackAndRead },
            { evaluateTurnStartPackageSink, packageSinkReceipt },
            { withBoundedTimeout },
            { pgHookTurnStore },
          ] = await Promise.all([
            import('@papercusp/flags/server'),
            import('@papercusp/flags'),
            import('../../../agent-tools/coordination/read-cursors'),
            import('../../../agent-identities/turn-start-package-sink'),
            import('../../../bounded-timeout'),
            import('../../../agent-identities/sync-hook-rules'),
          ]);
          const on = await getFlag(FLAGS.TURN_START_ORIENTATION, 'system').catch(() => true);
          if (!on) return none;
          // Commit last turn's receipt only if the hook proves it printed that text.
          await ackAndRead(owner, PACKAGE_SINK_DELIVERY_SURFACE, {
            confirmedToken: typeof body.confirmedDelivery === 'string' ? body.confirmedDelivery : null,
          }).catch(() => null);
          const detach = new AbortController();
          // P-011 / D-024: open the durable hook turn every later sink of this
          // turn joins (on any cluster worker), and charge what turn start
          // delivered, so one ceiling spans turn start, post-tool and stop. An
          // unreachable store costs only that sharing, never this turn's context.
          const turns = pgHookTurnStore();
          const evaluate = async () => {
            const turnId = await turns.begin(owner, workspaceId).then((turn) => turn.turnId, () => randomUUID());
            const sink = await evaluateTurnStartPackageSink({ ownerId: owner, workspaceId, turnId, signal: detach.signal });
            if (sink.result) {
              await turns.charge(owner, workspaceId, turnId,
                { tokens: sink.result.deliveredTokens, ms: sink.result.elapsedMs }).catch(() => undefined);
            }
            return sink;
          };
          const measured = await withBoundedTimeout(
            evaluate(),
            { fallback: null, timeoutMs: PACKAGE_SINK_WALL_MS, label: 'turn-start:package-sink' },
          );
          if (!measured.value) {
            detach.abort();
            return none;
          }
          return { classes: measured.value.classes, receipt: packageSinkReceipt(measured.value) };
        } catch {
          return none;
        }
      })();

      const [control, orientation, memory, personal, packages] = await Promise.all([
        controlPromise,
        orientationPromise,
        memoryPromise,
        personalPromise,
        packagePromise,
      ]);
      let deliveryToken = orientation.deliveryToken;
      let orientationBlock = orientation.block;
      if (packages.classes.length > 0) {
        try {
          const { appendPackageOrientationRows } = await import('../../../agent-identities/package-orientation-classes');
          orientationBlock = appendPackageOrientationRows(orientation.block, packages.classes).block;
        } catch {
          // The platform block is already staged; it is delivered unchanged.
        }
      }
      if (packages.receipt) {
        const token = deliveryToken ?? randomUUID();
        try {
          const { stage } = await import('../../../agent-tools/coordination/read-cursors');
          await stage(owner, PACKAGE_SINK_DELIVERY_SURFACE, {
            ...packages.receipt, rendered: orientationBlock !== orientation.block,
          }, { deliveryToken: token });
          deliveryToken = token;
        } catch {
          // An unstaged receipt only loses provenance; the rows are still delivered.
        }
      }
      if (control.candidate) {
        const token = deliveryToken ?? randomUUID();
        try {
          const { stage } = await import('../../../agent-tools/coordination/read-cursors');
          await stage(owner, CONTROL_DELIVERY_SURFACE, control.candidate, { deliveryToken: token });
          deliveryToken = token;
        } catch {
          // No durable candidate means no control ACK, even if orientation has
          // its own valid token. Keep delivering CTRL until staging succeeds.
        }
      }
      // ORDER IS DELIBERATE: control (a mode/route transition governs everything
      // after it) → orientation (what you hold and who is waiting on you) →
      // memory (background recall) -> explicitly granted private context.
      // Most-binding first; the private block is visibly separate and last.
      return Response.json({
        ok: true,
        text: [control.text, orientationBlock, memory, personal].filter(Boolean).join('\n\n'),
        ...(deliveryToken ? { deliveryToken } : {}),
      });
    } catch {
      return Response.json({ ok: true, text: '' });
    }
  },
});

export default [turnStartMemory];
