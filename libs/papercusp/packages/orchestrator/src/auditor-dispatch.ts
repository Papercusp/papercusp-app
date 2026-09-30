/**
 * G2 Auditor Dispatch — P-007 of papercusp-user-protection-gate-2026-05-31.
 *
 * The orchestrator screens every feature with `origin='remote'` and an un-set
 * (NULL) or 'pending' `audit_verdict` through the `auditor` role BEFORE it is
 * considered by the pick loop (the P-008 gate in `readFeaturesPg` already
 * prevents those features from entering the pick loop — this is the complement
 * that actually resolves the verdict).
 *
 * Decision flow:
 *   1. `selectRemotePendingFeatures` — finds remote+pending rows (via the
 *      `hfc_audit_pending_idx` partial index added by migration 098).
 *   2. `dispatchAuditorLane` — for each pending feature, calls the injected
 *      `AuditorSpawnFn` (which spawns the `auditor` role with the feature
 *      content as context) and captures `{ verdict, reasons }` from the
 *      agent's JSON output.
 *   3. `applyAuditVerdict` — pure verdict application + idempotency:
 *      - `admit` → sets `audit_verdict='admit'`, `audited_at=NOW()`.
 *      - `reject` → sets `audit_verdict='reject'`, `audit_reasons=<reasons>`,
 *        `audited_at=NOW()` AND creates a `needs-human` escalation carrying
 *        the feature id, verdict, and reasons so a human can override→admit or
 *        confirm-reject.
 *      - Local features (`origin='local'`) are NEVER re-audited (guard is
 *        purely defensive; the lane only picks remote rows).
 *      - Idempotent: re-applying an existing non-null verdict is a no-op.
 *
 * The audit lane is independent of the pick loop — both the legacy main loop
 * and the DBOS orchestrator call `dispatchAuditorLane` as a pre-pick pass on
 * each tick. The worst case if dispatch lags (e.g. on first boot) is that
 * remote features remain quarantined until the auditor runs — the P-008 gate
 * ensures they are NEVER auto-picked while pending, so the delay is safe.
 *
 * The `AuditorSpawnFn` seam is injected so:
 *   - Operator / DBOS wires the real `spawnInvokeOnce('auditor', …)` path.
 *   - Unit tests inject a stub that returns a predetermined `{ verdict, reasons }`.
 *
 * Note on trigger origin safety: the `sync_features_consolidated()` trigger
 * (wired in `libs/db/sql/002-per-harness-template.sql`) always stamps
 * `origin DEFAULT 'local'` when inserting into the per-harness
 * `harness_features` table. REMOTE features must NEVER be written directly
 * into per-harness `harness_features`; they arrive ONLY via the Hyperbee
 * projection path (which stamps `origin='remote'`). This is the gate's
 * foundational safety assumption — a row in `harness_features` without a
 * Hyperbee projection is always local by construction.
 */
import type { OrchestratorPg } from './invoke';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A remote+pending feature row from harness_features_consolidated. */
export interface RemotePendingFeature {
  harness_slug: string;
  feature_id: string;
  title: string | null;
  summary: string | null;
}

/** The structured verdict the auditor emits in its final JSON output. */
export interface AuditVerdict {
  verdict: 'admit' | 'reject';
  reasons: string;
}

/**
 * Spawn the `auditor` role for one feature and return its structured verdict.
 *
 * Injected: the operator wires `spawnInvokeOnce('auditor', [FEATURE_ID=…], …)`.
 * Tests inject a stub. Returns `null` on a spawn failure or a parse error
 * (treated as `reject` by the lane, with a canned reason, to fail-safe).
 */
export type AuditorSpawnFn = (
  harnessSlug: string,
  featureId: string,
  featureContext: string,
) => Promise<AuditVerdict | null>;

/**
 * A function that creates a needs-human escalation for a rejected remote feature.
 * Injected: the operator wires `openEscalation(…)`. Tests inject a stub.
 */
export type CreateEscalationFn = (input: {
  featureId: string;
  harnessSlug: string;
  reasons: string;
}) => Promise<void>;

/** Context for the auditor dispatch lane. */
export interface AuditorDispatchCtx {
  /** PG client scoped to harness_shared. */
  pg: OrchestratorPg;
  workspaceId: string;
  /** Function that spawns the auditor for one feature. */
  spawnAuditor: AuditorSpawnFn;
  /** Function that creates the needs-human escalation on reject. */
  createEscalation: CreateEscalationFn;
  /** Logger — default console.log. */
  log?: (msg: string) => void;
}

// ─── 1. Selector ─────────────────────────────────────────────────────────────

/**
 * Return all remote+pending rows across ALL harnesses for this workspace.
 * Uses the `hfc_audit_pending_idx` partial index from migration 098 so the
 * query is efficient even with a large consolidated table.
 *
 * Exported for direct unit testing without the rest of the lane.
 */
export async function selectRemotePendingFeatures(
  pg: OrchestratorPg,
  workspaceId: string,
  harnessSlug?: string,
): Promise<RemotePendingFeature[]> {
  if (harnessSlug) {
    return pg`
      SELECT harness_slug, feature_id, title, summary
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id   = ${workspaceId}
         AND harness_slug   = ${harnessSlug}
         AND origin         = 'remote'
         AND (audit_verdict IS NULL OR audit_verdict = 'pending')
       ORDER BY harness_slug, feature_id
    ` as Promise<RemotePendingFeature[]>;
  }
  return pg`
    SELECT harness_slug, feature_id, title, summary
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId}
       AND origin       = 'remote'
       AND (audit_verdict IS NULL OR audit_verdict = 'pending')
     ORDER BY harness_slug, feature_id
  ` as Promise<RemotePendingFeature[]>;
}

// ─── 2. Verdict application ───────────────────────────────────────────────────

/**
 * Apply the auditor's verdict to a remote feature in
 * `harness_shared.harness_features_consolidated`.
 *
 * Guarantees:
 *   - **Idempotent**: if `audit_verdict` is already non-null (a prior run set
 *     it), this is a no-op — we never override an existing verdict.
 *   - **Local-untouched**: if `origin='local'`, returns immediately; local
 *     features are never audited or modified by this function.
 *   - **admit** → `audit_verdict='admit'`, `audited_at=NOW()`.
 *   - **reject** → `audit_verdict='reject'`, `audit_reasons=<reasons>`,
 *     `audited_at=NOW()`.  The caller is responsible for creating the
 *     escalation (so it can be tested independently).
 *
 * Returns `'applied'`, `'idempotent'` (verdict already set), or `'local'`
 * (local feature, untouched).
 */
export async function applyAuditVerdict(
  pg: OrchestratorPg,
  workspaceId: string,
  harnessSlug: string,
  featureId: string,
  verdict: AuditVerdict,
): Promise<'applied' | 'idempotent' | 'local'> {
  // Read current state to check the invariants.
  const rows = (await pg`
    SELECT origin, audit_verdict
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND feature_id   = ${featureId}
     LIMIT 1
  `) as Array<{ origin: string | null; audit_verdict: string | null }>;
  const row = rows[0];
  if (!row) {
    // No consolidated row — nothing to update.
    return 'idempotent';
  }
  // Never modify local features.
  if (row.origin === 'local' || row.origin == null) {
    return 'local';
  }
  // Idempotent: a verdict is already set.
  if (row.audit_verdict != null) {
    return 'idempotent';
  }

  if (verdict.verdict === 'admit') {
    await pg`
      UPDATE harness_shared.harness_features_consolidated
         SET audit_verdict = 'admit',
             audited_at    = NOW()
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${harnessSlug}
         AND feature_id   = ${featureId}
         AND origin       = 'remote'
         AND audit_verdict IS NULL
    `;
  } else {
    await pg`
      UPDATE harness_shared.harness_features_consolidated
         SET audit_verdict = 'reject',
             audit_reasons = ${verdict.reasons},
             audited_at    = NOW()
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${harnessSlug}
         AND feature_id   = ${featureId}
         AND origin       = 'remote'
         AND audit_verdict IS NULL
    `;
  }
  return 'applied';
}

// ─── 3. Parse the auditor's JSON output ──────────────────────────────────────

/**
 * Parse the auditor's final JSON output into a structured verdict.
 * The auditor is prompted to emit ONLY:
 *   `{ "verdict": "admit" | "reject", "reasons": "…" }`
 *
 * Returns `null` if the output is missing, unparseable, or has an invalid
 * verdict field (the lane treats `null` as `reject`/fail-safe).
 *
 * Exported for unit testing.
 */
export function parseAuditorOutput(raw: string): AuditVerdict | null {
  if (!raw || !raw.trim()) return null;
  // The auditor may wrap its output in a code fence — strip it.
  const stripped = raw.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  // Find the first JSON object in the output.
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    if (obj.verdict !== 'admit' && obj.verdict !== 'reject') return null;
    const reasons = typeof obj.reasons === 'string' ? obj.reasons : String(obj.reasons ?? '');
    return { verdict: obj.verdict as 'admit' | 'reject', reasons };
  } catch {
    return null;
  }
}

// ─── 4. Dispatch lane ────────────────────────────────────────────────────────

/**
 * One pass of the auditor dispatch lane.
 *
 * For each remote+pending feature (optionally scoped to one harness), spawns
 * the auditor, parses its verdict, writes the verdict to PG, and (on reject)
 * creates the needs-human escalation.  Runs sequentially — the auditor is a
 * lightweight read-only role and the pending set is expected to be small.
 *
 * Never throws — errors are logged and that feature is left pending for the
 * next tick (fail-safe: a stuck auditor never blocks the pick loop; the P-008
 * gate already keeps pending features quarantined).
 *
 * Returns a summary of what was processed.
 */
export async function dispatchAuditorLane(
  ctx: AuditorDispatchCtx,
  harnessSlug?: string,
): Promise<{ admitted: string[]; rejected: string[]; errors: string[] }> {
  const log = ctx.log ?? console.log;
  const admitted: string[] = [];
  const rejected: string[] = [];
  const errors: string[] = [];

  let pending: RemotePendingFeature[];
  try {
    pending = await selectRemotePendingFeatures(ctx.pg, ctx.workspaceId, harnessSlug);
  } catch (err) {
    log(`[auditor-dispatch] selectRemotePendingFeatures failed: ${(err as Error).message}`);
    return { admitted, rejected, errors: [`selector-error: ${(err as Error).message}`] };
  }

  if (pending.length === 0) return { admitted, rejected, errors };

  log(`[auditor-dispatch] screening ${pending.length} remote-pending feature(s)`);

  for (const feature of pending) {
    const fid = `${feature.harness_slug}/${feature.feature_id}`;
    try {
      // Build the feature context string fed to the auditor.
      const ctx_parts: string[] = [];
      if (feature.title) ctx_parts.push(`Title: ${feature.title}`);
      if (feature.summary) ctx_parts.push(`Summary: ${feature.summary}`);
      const featureContext = ctx_parts.join('\n') || '(no description)';

      // Spawn the auditor and get the raw output.
      let verdict = await ctx.spawnAuditor(feature.harness_slug, feature.feature_id, featureContext);

      // Fail-safe: a null result (spawn error / parse failure) → auto-reject.
      if (verdict === null) {
        log(`[auditor-dispatch] ${fid}: spawn/parse failed → fail-safe reject`);
        verdict = {
          verdict: 'reject',
          reasons: 'Auditor spawn or output parse failed — fail-safe quarantine until a human reviews.',
        };
      }

      log(`[auditor-dispatch] ${fid}: verdict=${verdict.verdict}`);

      // Apply the verdict to PG.
      const applyResult = await applyAuditVerdict(
        ctx.pg,
        ctx.workspaceId,
        feature.harness_slug,
        feature.feature_id,
        verdict,
      );
      if (applyResult === 'idempotent') {
        log(`[auditor-dispatch] ${fid}: already audited — skip`);
        continue;
      }
      if (applyResult === 'local') {
        log(`[auditor-dispatch] ${fid}: local feature — skip`);
        continue;
      }

      if (verdict.verdict === 'admit') {
        admitted.push(feature.feature_id);
      } else {
        rejected.push(feature.feature_id);
        // Create the needs-human escalation so the human can override or confirm.
        try {
          await ctx.createEscalation({
            featureId: feature.feature_id,
            harnessSlug: feature.harness_slug,
            reasons: verdict.reasons,
          });
          log(`[auditor-dispatch] ${fid}: reject escalation created`);
        } catch (escErr) {
          log(`[auditor-dispatch] ${fid}: escalation create failed (non-fatal): ${(escErr as Error).message}`);
          errors.push(`${fid}:escalation-error`);
        }
      }
    } catch (err) {
      log(`[auditor-dispatch] ${fid}: error: ${(err as Error).message}`);
      errors.push(`${fid}:${(err as Error).message}`);
    }
  }

  if (admitted.length + rejected.length > 0) {
    log(
      `[auditor-dispatch] done: admitted=${admitted.length} rejected=${rejected.length} errors=${errors.length}`,
    );
  }
  return { admitted, rejected, errors };
}
