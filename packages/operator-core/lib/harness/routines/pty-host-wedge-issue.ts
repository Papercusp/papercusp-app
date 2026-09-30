/**
 * Durable accountability for the psu-pty wedge sweep
 * (psu-pty-turn-boundary-generalization-2026-09-22, P-008).
 *
 * THE GAP THIS CLOSES. `pty-host-wedge-guard.ts` detects a wedged host, broadcasts a
 * fleet-wide notice and pages a human — and then FORGETS. Both of those surfaces are
 * ephemeral by construction: the broadcast is one-shot per condition episode (deliberately,
 * so it does not re-page) and an attention notification is dismissed. So a wedge that recurs
 * every few days leaves no owned trail, nobody is accountable for it, and each occurrence is
 * investigated from scratch by whoever happens to see the page. A detector without a durable
 * record produces recurring alarm, not repair.
 *
 * WHAT IT DOES. One work-item per WEDGE CLASS, found-or-created by a stable marker, updated
 * with a fresh comment when the picture changes. Keyed by class rather than by host on
 * purpose: the host set churns constantly (sessions come and go), so a per-host item would
 * mint unbounded rows for what is one recurring mechanism — and the mechanism, not the
 * session, is the thing somebody has to fix.
 *
 * ── THE THROTTLE, AND WHY IT IS NOT OPTIONAL ─────────────────────────────────────────
 * The sweep runs every 20 minutes. Commenting on every pass would add ~72 comments/day to a
 * single item during a persistent wedge, which destroys the item as a readable record and
 * trains readers to ignore it — the same death the one-shot broadcast exists to avoid. So a
 * comment is written only when the OWNER SET CHANGES, detected by a digest stored on the
 * item's own payload. An unchanged sweep is silent.
 *
 * ── FAIL-SOFT ────────────────────────────────────────────────────────────────────────
 * Every path here is best-effort and returns a verdict rather than throwing. Filing is
 * strictly less urgent than the broadcast and page it accompanies; a Postgres hiccup in the
 * bookkeeping must never take down the detector that found an active outage.
 */
import type { EngineerIssue, IssueSeverity } from '../../issues-engineer';
import type { BornAdmission } from '../../work-items-admission';
import type { WakeDeliveryHealth } from './psu-pty-delivery-rate';
import { renderWakeDeliveryHealth } from './psu-pty-delivery-rate';

/** Terminal states — an item in one of these cannot be the live record for a new episode. */
const TERMINAL_STATES = new Set(['done', 'dropped', 'resolved', 'closed']);

/**
 * The dedupe key, embedded in the body and matched with a literal substring search.
 *
 * A body marker rather than a topic tag: topic filtering joins `coord_links` and is
 * measurably lossy in both directions (see the CLAUDE.md note on lane-vs-topic), and a
 * dedupe key that silently misses is a key that mints a duplicate item every sweep.
 */
export function wedgeIssueMarker(wedgeClass: string): string {
  return `pty-host-wedge-key:${wedgeClass}`;
}

export interface WedgeIssueDeps {
  listIssues: (filter: { q?: string; kinds?: readonly string[] }) => Promise<EngineerIssue[]>;
  createIssue: (input: {
    title: string;
    body: string;
    severity?: IssueSeverity;
    kind?: 'bug';
    createdBy?: string;
    foundDuring?: string;
    sourcePlanSlug?: string | null;
    /**
     * Admission the filing is born with, threaded through the seam rather than left to
     * the writer's default. `work_items.admission` has NO column default, so an
     * unstamped create mints NULL — which `isAdmitted` reads as pre-gate legacy and
     * therefore immediately claimable. That is a SILENT born-pending bypass: no error,
     * no warning, and indistinguishable in the database from the genuinely-legacy rows.
     */
    admission?: BornAdmission | null;
  }) => Promise<EngineerIssue>;
  commentIssue: (id: string, body: string, authorId?: string) => Promise<unknown>;
  mergeIssuePayload: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
}

export interface WedgeIssueInput {
  wedgeClass: string;
  /** Distinct wedged owners for this class, in the sweep's own worst-first order. */
  ownerIds: readonly string[];
  /** Rendered per-host detail lines, already formatted by the sweep. */
  detail: readonly string[];
  /** Delivery-rate reading to fold in (P-007 telemetry). */
  health?: WakeDeliveryHealth;
  nowIso?: string;
}

export interface WedgeIssueResult {
  action: 'created' | 'commented' | 'unchanged' | 'failed';
  id?: string;
  reason?: string;
}

/** Stable digest of the affected population — the throttle's change signal. */
export function wedgeDigest(ownerIds: readonly string[]): string {
  return [...new Set(ownerIds)].sort().join(',');
}

function buildBody(input: WedgeIssueInput, marker: string): string {
  const when = input.nowIso ?? new Date().toISOString();
  const lines = [
    `${marker}`,
    '',
    `${input.ownerIds.length} psu-pty host(s) in the \`${input.wedgeClass}\` class could not ` +
      `receive wakes as of ${when}.`,
    '',
    // The delivery rate is the P-007 telemetry this item was told to carry. It is rendered
    // through the shared renderer so an UNMEASURED window says so in words instead of
    // formatting a 0% that would read as a total outage.
    input.health ? renderWakeDeliveryHealth(input.health) : 'wake-delivery success rate: not supplied.',
    '',
    'Affected hosts:',
    ...input.detail,
    '',
    'This item is maintained automatically by the `sweep-wedged-pty-hosts` routine ' +
      '(psu-pty-turn-boundary-generalization-2026-09-22, P-008). It is keyed by wedge CLASS, ' +
      'so recurrences append here rather than minting a new row. Closing it asserts the ' +
      'MECHANISM is fixed, not merely that the current hosts have gone away — the sweep will ' +
      'open a fresh item on the next episode.',
  ];
  return lines.join('\n');
}

/**
 * File or update the durable record for one wedge class.
 *
 * Returns `unchanged` when the affected owner set matches the digest already stored on the
 * item, which is the common case on a persistent wedge.
 */
export async function recordWedgeEpisode(
  input: WedgeIssueInput,
  deps: WedgeIssueDeps,
): Promise<WedgeIssueResult> {
  if (!input.ownerIds.length) return { action: 'unchanged', reason: 'no-wedged-hosts' };

  const marker = wedgeIssueMarker(input.wedgeClass);
  const digest = wedgeDigest(input.ownerIds);

  try {
    const found = await deps.listIssues({ q: marker, kinds: ['bug'] });
    // Belt and braces: `q` is a substring match over title+body, so confirm the marker is
    // really present rather than trusting a loose hit, and ignore terminal rows — a closed
    // item is a historical record, and a NEW episode deserves a new, openly-owned one.
    const live = (found ?? []).filter(
      (i) => !TERMINAL_STATES.has(i.state) && typeof i.body === 'string' && i.body.includes(marker),
    );

    if (live.length === 0) {
      const created = await deps.createIssue({
        title: `psu-pty hosts cannot receive wakes (${input.wedgeClass} class)`,
        body: buildBody(input, marker),
        // `major`, not `critical`: a wedged host is a real outage for that agent, but the
        // sweep's busy-gate class is explicitly detect-only with unmeasured precision, so
        // this must not be the severity that wakes someone at night on a maybe.
        severity: 'major',
        kind: 'bug',
        createdBy: 'system:sweep-wedged-pty-hosts',
        foundDuring: 'sweep-wedged-pty-hosts',
        sourcePlanSlug: 'psu-pty-turn-boundary-generalization-2026-09-22',
        // 'pending', not 'auto': this is an automated detector's filing that no human
        // has reviewed, so the promoter is exactly who should judge it. The same
        // reasoning that picked `major` over `critical` above applies with more force
        // here — the busy-gate class is explicitly detect-only with UNMEASURED
        // precision, so a filing-time bypass would admit unreviewed, possibly-false
        // episodes straight into the claimable queue. Rides in THIS insert rather than
        // a post-create update, or the row is claimable in the gap between the two.
        admission: 'pending',
      });
      await deps
        .mergeIssuePayload(created.id, { ptyHostWedge: { digest, lastSeenAt: input.nowIso ?? new Date().toISOString() } })
        .catch(() => undefined);
      return { action: 'created', id: created.id };
    }

    const item = live[0];
    const prior = (item.payload as { ptyHostWedge?: { digest?: string } } | null)?.ptyHostWedge?.digest;
    if (prior === digest) {
      return { action: 'unchanged', id: item.id, reason: 'same-owner-set' };
    }

    await deps.commentIssue(item.id, buildBody(input, marker), 'system:sweep-wedged-pty-hosts');
    await deps
      .mergeIssuePayload(item.id, { ptyHostWedge: { digest, lastSeenAt: input.nowIso ?? new Date().toISOString() } })
      .catch(() => undefined);
    return { action: 'commented', id: item.id };
  } catch (e) {
    return { action: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}
