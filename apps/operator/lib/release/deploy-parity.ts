/**
 * Deploy honesty — P-015 of `gate-verdict-liveness-and-repair-reliability-2026-08-31`
 * (D-002 finding, D-004 verification contract).
 *
 * A force-deploy past a red gate silently breaks the tested==deployed invariant:
 * :3070 serves a build the gate never judged, while every gate read still LOOKS
 * like it describes the deployed code. D-002 measured the cost of leaving that
 * implicit: 16 force-deploys (13 SHAs, 11 sessions) Aug 23-28 made bypass the
 * routine shipping path, and one of them dropped a queue field and wedged the
 * gate's own recovery mechanism (EI-21813295393334986).
 *
 * This module makes the divergence LOUD and DURABLE, reusing the two existing
 * substrates rather than minting new ones (reuse-first):
 *
 *   - on a successful FORCED (un-green) deploy: assert a standing fact
 *     (`deploy-parity-broken`, harness-scoped — folds into every orient) and
 *     open the `deploy-parity:<harness>` CONDITION via severe-event broadcast
 *     (the condition bridge mints exactly ONE owning work-item — the same
 *     singleton machinery as `gate-red-streak:<harness>`, P-014/D-010);
 *   - on a successful GENUINE GREEN deploy: resolve the condition (the bridge
 *     settles the item), retract the fact, and VERIFY local `main` ==
 *     `origin/main` — reporting non-unified refs loudly in the resolution.
 *
 * ⚠ Deliberately NO auto-fast-forward of local `main` toward `origin/main`:
 * `plan.green` is REF-ANCHORED (deploy.ts: `green = targetSha === readySha`
 * where readySha is LOCAL `main`), so moving local `main` to a force-promoted
 * `origin/main` sha would LAUNDER an untested sha into the green pin and defeat
 * the deploy gate itself. Ref unification happens at the first genuine green by
 * the gate's own FF+push (D-004: "local main re-syncs to origin/main on that
 * first real green"); this module only OBSERVES and reports.
 *
 * Best-effort by construction (like recordRefusedDeploy / recordCoalescedDeploy
 * in deploy-cli.ts): a telemetry/honesty failure must never change a deploy's
 * outcome or exit code — every leg is individually guarded.
 */

/** Condition-lifecycle key for the tested≠deployed divergence on one harness.
 *  Same family as `gateRedStreakConditionKey` (coord/gate-ownership.ts) but
 *  deploy-plane: the gate keys say "the gate is red/stalled"; this one says
 *  "what is DEPLOYED was never judged". Both can be open at once — a long red
 *  with forces in it is exactly that. The condition bridge mints one owning
 *  work-item per open key (partial unique index work_items_condition_key_uq). */
export function deployParityConditionKey(harness: string): string {
  return `deploy-parity:${harness}`;
}

/** Standing-fact key (harness scope, scopeRef = the install slug). */
export const DEPLOY_PARITY_FACT_KEY = 'deploy-parity-broken';

/** What deploy-cli reports after executeDeploy resolves. */
export interface DeployParityEvent {
  /** DeployResult.ok — false means failed (and possibly rolled back): parity unchanged. */
  ok: boolean;
  /** plan.green at execution time (ref-anchored: target === the local releaseRef pin). */
  green: boolean;
  /** The sha that was deployed. */
  targetSha: string;
  /** Operator-home install slug (scopes the fact + condition). */
  installSlug: string;
  /** Integration tree root — where the ref-unification check runs. */
  integrationRoot: string;
}

/** Ref-unification observation for the genuine-green resolution. */
export interface RefUnification {
  localMain: string | null;
  originMain: string | null;
  /** true when both resolve and are equal; null when either ref is unreadable. */
  unified: boolean | null;
}

/** Injectable seams — tests drive every branch with fixtures (D-004: simulated
 *  force-deploy facts, simulated divergence) and never touch PG/coord/git. */
export interface DeployParityDeps {
  assertFact: (input: {
    scope: 'harness';
    scopeRef: string;
    key: string;
    body: string;
    createdBy: string;
    ttlSec?: number;
    confidence?: 'verified';
    sourceRef?: string;
  }) => Promise<unknown>;
  retractFact: (args: {
    scope: 'harness';
    scopeRef: string;
    key: string;
    retractedBy?: string;
    reason?: string;
  }) => Promise<boolean>;
  broadcastSevereEvent: (ev: {
    summary: string;
    body?: string;
    category?: string;
    conditionKey?: string;
  }) => Promise<boolean>;
  broadcastSevereEventResolved: (res: { conditionKey: string; summary: string }) => Promise<boolean>;
  /** Is the `deploy-parity:<harness>` condition currently OPEN (bridge-minted
   *  owning work-item present)? Gates the green-path clears so a ROUTINE green
   *  deploy (no standing divergence) never spams a resolution. */
  hasOpenParityCondition: (installSlug: string) => Promise<boolean>;
  /** Fallback guard: the standing fact's live state ('live' | anything else). */
  factKeyState: (installSlug: string) => Promise<string>;
  /** Read local main vs origin/main (NO fetch — same no-fetch model as the gate). */
  readRefUnification: (integrationRoot: string) => Promise<RefUnification>;
  now?: () => Date;
}

/** Real wiring — lazy imports so `import`ing this module (or deploy-cli) stays light. */
export async function realDeployParityDeps(): Promise<DeployParityDeps> {
  const { assertFact, retractFact, findFactKeyState } = await import(
    '@papercusp/operator-core/lib/agent-facts/store'
  );
  const { broadcastSevereEvent, broadcastSevereEventResolved } = await import(
    '@papercusp/operator-core/lib/severe-event-broadcast'
  );
  const { getOrgPg } = await import('@papercusp/db-org');
  const { activeWorkspaceId } = await import('@papercusp/operator-core/lib/workspace-registry');
  return {
    assertFact: (input) => assertFact(input),
    retractFact: (args) => retractFact(args),
    broadcastSevereEvent,
    broadcastSevereEventResolved,
    hasOpenParityCondition: async (installSlug: string) => {
      const sql = getOrgPg().sql;
      let ws = '*';
      try {
        ws = activeWorkspaceId();
      } catch {
        /* standalone — matches nothing, which fails toward "not open" (no spam) */
      }
      // condition_key is NULLed by the bridge on settle, so presence == open
      // (the partial unique index guarantees at most one row).
      const rows = await sql<{ ok: number }[]>`
        SELECT 1 AS ok FROM harness_shared.work_items
         WHERE workspace_id = ${ws} AND harness_slug = ${installSlug}
           AND condition_key = ${deployParityConditionKey(installSlug)}
         LIMIT 1`;
      return rows.length > 0;
    },
    factKeyState: async (installSlug: string) => {
      const st = await findFactKeyState({
        scope: 'harness',
        scopeRef: installSlug,
        key: DEPLOY_PARITY_FACT_KEY,
      });
      return typeof st === 'string' ? st : ((st as { state?: string })?.state ?? 'not-found');
    },
    readRefUnification: async (integrationRoot: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      const rev = async (ref: string): Promise<string | null> => {
        try {
          const { stdout } = await run('git', ['-C', integrationRoot, 'rev-parse', '--verify', '--quiet', ref]);
          const sha = stdout.trim();
          return sha.length > 0 ? sha : null;
        } catch {
          return null;
        }
      };
      const localMain = await rev('main');
      const originMain = await rev('refs/remotes/origin/main');
      return {
        localMain,
        originMain,
        unified: localMain && originMain ? localMain === originMain : null,
      };
    },
  };
}

/**
 * The one entry deploy-cli calls after executeDeploy resolves. NEVER throws —
 * each leg is guarded so a PG/coord/git hiccup cannot fail (or re-order) a
 * deploy that already succeeded.
 */
export async function recordDeployParity(ev: DeployParityEvent, deps: DeployParityDeps): Promise<void> {
  if (!ev.ok) return; // failed deploy (rollback restores prior state) — parity unchanged
  const sha12 = ev.targetSha.slice(0, 12);
  const slug = ev.installSlug;
  const nowIso = (deps.now?.() ?? new Date()).toISOString();

  if (!ev.green) {
    // ── FORCE path: a build the gate never judged is now what :3070 serves. ──
    // The harness slug is repeated per clause on purpose (the 2026-08-17
    // truncated-inbox lesson from the gate-recovery broadcast): inbox summaries
    // truncate, and the unscoped tail is what survives and gets believed.
    await deps
      .assertFact({
        scope: 'harness',
        scopeRef: slug,
        key: DEPLOY_PARITY_FACT_KEY,
        createdBy: 'system:deploy-cli',
        body:
          `FORCE-DEPLOY past the gate on ${slug}: :3070 serves UNTESTED build ${sha12} ` +
          `(deployed ${nowIso}) — tested≠deployed on ${slug}. The green gate did NOT judge this ` +
          `build; do not read ${slug} gate verdicts as describing the deployed code. Parity (and ` +
          `this fact) clears automatically on ${slug}'s next GENUINE green deploy; every further ` +
          `force re-stamps it. (P-015 deploy honesty; D-002 measured 16 forces Aug 23-28.)`,
        ttlSec: 90 * 24 * 3600, // max — cleared on green, never silently lapses mid-red
        confidence: 'verified',
        sourceRef: `deploy-cli force ${sha12}`,
      })
      .catch(() => {});
    await deps
      .broadcastSevereEvent({
        summary:
          `[${slug}] FORCE-DEPLOY past the gate on ${slug} — :3070 now serves UNTESTED ${sha12}; ` +
          `tested≠deployed on ${slug} until its next genuine green deploy`,
        body:
          `Build ${ev.targetSha} was deployed WITHOUT a green verdict (forced past the gate). ` +
          `Until a genuine green deploy restores tested==deployed on ${slug}, no gate verdict ` +
          `describes the running build.\n\n` +
          `The \`${deployParityConditionKey(slug)}\` condition owns ONE work-item for this ` +
          `divergence (the condition bridge mints it) — claim THAT item rather than filing ` +
          `another. It tracks the deployed-build divergence only; gate-red diagnosis stays on ` +
          `the \`gate-red-streak:${slug}\` item.`,
        category: 'severe-event',
        conditionKey: deployParityConditionKey(slug),
        // NOT oneShot: every further force re-alarms (the bridge upserts the
        // same open item), so the alarm's last_seen tracks reality.
      })
      .catch(() => {});
    return;
  }

  // ── GENUINE GREEN path: tested==deployed restored. Clear, and verify refs. ──
  // Guard BOTH clears on a standing divergence actually existing, so the
  // routine auto-serve green deploy (the overwhelmingly common case) never
  // spams a resolution — the same "green tick must not broadcast recovery for
  // nothing" rule release-actions applies to the red-streak resolve.
  let open = false;
  try {
    open = await deps.hasOpenParityCondition(slug);
  } catch {
    /* unreadable → fall through to the fact guard */
  }
  if (!open) {
    try {
      if ((await deps.factKeyState(slug)) !== 'live') return;
    } catch {
      return; // neither guard readable — do nothing rather than spam
    }
  }

  let unification: RefUnification = { localMain: null, originMain: null, unified: null };
  try {
    unification = await deps.readRefUnification(ev.integrationRoot);
  } catch {
    /* unreadable stays null — reported as unverified, never as unified */
  }
  const refsLine =
    unification.unified === true
      ? `Refs unified: local main == origin/main (${(unification.localMain ?? '').slice(0, 12)}).`
      : unification.unified === false
        ? `⚠ Refs NOT unified: local main ${(unification.localMain ?? 'unreadable').slice(0, 12)} vs ` +
          `origin/main ${(unification.originMain ?? 'unreadable').slice(0, 12)} — something moved ` +
          `origin/main outside the gate (the D-002 force-promote class). Do NOT fast-forward local ` +
          `main to origin/main by hand: green is ref-anchored to local main, so that would launder ` +
          `an unjudged sha into the green pin. Investigate which ref reflects a real green verdict.`
        : `Ref unification UNVERIFIED (a ref was unreadable) — not a divergence claim in either direction.`;

  await deps
    .broadcastSevereEventResolved({
      conditionKey: deployParityConditionKey(slug),
      summary:
        `[${slug}] tested==deployed RESTORED on ${slug} — genuine green deploy of ${sha12}; the ` +
        `earlier force-deploy parity alarm for ${slug} is resolved. ${refsLine} This says nothing ` +
        `about any other harness.`,
    })
    .catch(() => {});
  await deps
    .retractFact({
      scope: 'harness',
      scopeRef: slug,
      key: DEPLOY_PARITY_FACT_KEY,
      retractedBy: 'deploy-cli',
      reason: `genuine green deploy of ${sha12} restored tested==deployed`,
    })
    .catch(() => {});
}
