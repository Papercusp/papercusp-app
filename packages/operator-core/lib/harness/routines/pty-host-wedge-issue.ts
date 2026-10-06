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

export interface PtyHostIssueResult {
  action: 'created' | 'commented' | 'unchanged' | 'failed';
  id?: string;
  reason?: string;
}

export type WedgeIssueResult = PtyHostIssueResult;

export interface PtyHostMechanismIssueInput {
  /** Stable class key; sessions and owners are evidence, not the mechanism identity. */
  mechanism: string;
  title: string;
  summary: string;
  ownerIds: readonly string[];
  /** Total matching owners when `ownerIds` is a bounded sample. */
  totalOwners?: number;
  /** Already-redacted detail lines. Never include a full operator URL or environment dump. */
  details: readonly string[];
  /** Digest of the persisted evidence represented by this snapshot. */
  digest: string;
  createdBy: string;
  foundDuring: string;
  sourcePlanSlug?: string | null;
  severity?: IssueSeverity;
  nowIso?: string;
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

export function ptyHostMechanismIssueMarker(mechanism: string): string {
  return `pty-host-mechanism-key:${mechanism}`;
}

interface KeyedPtyHostIssueInput {
  marker: string;
  title: string;
  body: string;
  digest: string;
  payloadKey: 'ptyHostWedge' | 'ptyHostMechanism';
  createdBy: string;
  foundDuring: string;
  sourcePlanSlug: string | null;
  severity: IssueSeverity;
  nowIso: string;
}

/** Shared marker/digest/pending-admission writer for P-008 keyed PTY mechanisms. */
async function recordKeyedPtyHostIssue(
  input: KeyedPtyHostIssueInput,
  deps: WedgeIssueDeps,
): Promise<PtyHostIssueResult> {
  try {
    const found = await deps.listIssues({ q: input.marker, kinds: ['bug'] });
    const live = (found ?? []).filter(
      (i) => !TERMINAL_STATES.has(i.state) && typeof i.body === 'string' && i.body.includes(input.marker),
    );
    const lastSeenAt = input.nowIso;
    const payloadPatch = { [input.payloadKey]: { digest: input.digest, lastSeenAt } };

    if (live.length === 0) {
      const created = await deps.createIssue({
        title: input.title,
        body: input.body,
        severity: input.severity,
        kind: 'bug',
        createdBy: input.createdBy,
        foundDuring: input.foundDuring,
        sourcePlanSlug: input.sourcePlanSlug,
        // Automated detection is unreviewed. Keep it born-pending so the promoter, not the
        // detector, decides whether this signal belongs in the claimable queue.
        admission: 'pending',
      });
      await deps.mergeIssuePayload(created.id, payloadPatch).catch(() => undefined);
      return { action: 'created', id: created.id };
    }

    const item = live[0];
    const payload = (item.payload as Record<string, { digest?: string }> | null) ?? null;
    const prior = payload?.[input.payloadKey]?.digest;
    if (prior === input.digest) {
      return {
        action: 'unchanged',
        id: item.id,
        reason: input.payloadKey === 'ptyHostWedge' ? 'same-owner-set' : 'same-evidence-digest',
      };
    }

    await deps.commentIssue(item.id, input.body, input.createdBy);
    await deps.mergeIssuePayload(item.id, payloadPatch).catch(() => undefined);
    return { action: 'commented', id: item.id };
  } catch (e) {
    return { action: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * File or update one mechanism-keyed PTY issue using the same P-008 accountable writer as
 * wake-wedge episodes. The class key remains stable while the bounded evidence digest changes.
 */
export async function recordPtyHostMechanismEpisode(
  input: PtyHostMechanismIssueInput,
  deps: WedgeIssueDeps,
): Promise<PtyHostIssueResult> {
  if (!input.ownerIds.length) return { action: 'unchanged', reason: 'no-affected-hosts' };
  const marker = ptyHostMechanismIssueMarker(input.mechanism);
  const totalOwners = input.totalOwners ?? input.ownerIds.length;
  const details = input.details.slice(0, 25).map((line) => `- ${line}`);
  const shownOwners = Math.min(input.ownerIds.length, 25);
  const lines = [
    marker,
    '',
    input.summary,
    '',
    `${totalOwners} distinct psu-pty host(s) match this mechanism as of ${input.nowIso ?? new Date().toISOString()}.`,
    '',
    'Recent affected hosts (redacted event fields):',
    ...details,
    ...(totalOwners > shownOwners
      ? [`- ${totalOwners - shownOwners} additional host(s) omitted from this bounded detail list.`]
      : []),
    '',
    `This item is maintained automatically by \`${input.foundDuring}\` and keyed by mechanism. ` +
      'Closing it asserts the mechanism is fixed, not merely that the current sessions have gone away.',
  ];
  return recordKeyedPtyHostIssue(
    {
      marker,
      title: input.title,
      body: lines.join('\n'),
      digest: input.digest,
      payloadKey: 'ptyHostMechanism',
      createdBy: input.createdBy,
      foundDuring: input.foundDuring,
      sourcePlanSlug: input.sourcePlanSlug ?? null,
      severity: input.severity ?? 'minor',
      nowIso: input.nowIso ?? new Date().toISOString(),
    },
    deps,
  );
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
  return recordKeyedPtyHostIssue(
    {
      marker,
      title: `psu-pty hosts cannot receive wakes (${input.wedgeClass} class)`,
      body: buildBody(input, marker),
      digest: wedgeDigest(input.ownerIds),
      payloadKey: 'ptyHostWedge',
      createdBy: 'system:sweep-wedged-pty-hosts',
      foundDuring: 'sweep-wedged-pty-hosts',
      sourcePlanSlug: 'psu-pty-turn-boundary-generalization-2026-09-22',
      // `major`, not `critical`: this remains the calibrated P-008 wedge severity.
      severity: 'major',
      nowIso: input.nowIso ?? new Date().toISOString(),
    },
    deps,
  );
}
