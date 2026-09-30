/**
 * Deduped owner escalation for owner-actionable embedding exhaustion.
 *
 * The local embedder fallback keeps memory tools degraded-but-running, but
 * OpenAI billing exhaustion and the daily spend cap require owner action. This
 * helper alerts once per outage window and clears the severe condition on the
 * next successful OpenAI embed.
 */

import { activeWorkspaceId } from '../workspace-registry';

export type EmbedExhaustionKind = 'openai_billing' | 'daily_cap';

export interface EmbedExhaustionNotification {
  kind: EmbedExhaustionKind;
  title: string;
  body: string;
  conditionKey: string;
  workspaceId: string;
}

type NotifyFn = (n: EmbedExhaustionNotification) => Promise<void> | void;
type ResolveFn = (n: { conditionKey: string; workspaceId: string }) => Promise<void> | void;

const DEFAULT_ALERT_COOLDOWN_MS = 45 * 60_000;

// EI-7475 follow-up: `openai_billing` and `daily_cap` are INDEPENDENT conditions (a hard
// OpenAI billing stop vs. our own spend backstop) — each gets its OWN latch/cooldown/
// conditionKey. A single shared latch would let one kind's cooldown silently suppress
// (or, on clear, wrongly resolve) the OTHER kind's alert if both occur within the same
// cooldown window — a real gap in an earlier version of this file.
function conditionKeyFor(kind: EmbedExhaustionKind): string {
  return `embed-exhaustion:${kind}`;
}

const alertedUntil: Record<EmbedExhaustionKind, number> = { openai_billing: 0, daily_cap: 0 };
const active: Record<EmbedExhaustionKind, boolean> = { openai_billing: false, daily_cap: false };
let notifyForTest: NotifyFn | null = null;
let resolveForTest: ResolveFn | null = null;

export function embedExhaustionAlertCooldownMs(): number {
  const n = Number(process.env.PAPERCUSP_EMBED_EXHAUSTION_ALERT_COOLDOWN_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ALERT_COOLDOWN_MS;
}

export function __setEmbedExhaustionNotifierForTest(notify: NotifyFn, resolve?: ResolveFn): void {
  notifyForTest = notify;
  resolveForTest = resolve ?? null;
}

export function __resetEmbedExhaustionAlertForTest(): void {
  alertedUntil.openai_billing = 0;
  alertedUntil.daily_cap = 0;
  active.openai_billing = false;
  active.daily_cap = false;
  notifyForTest = null;
  resolveForTest = null;
}

function copy(kind: EmbedExhaustionKind): { title: string; body: string } {
  if (kind === 'daily_cap') {
    return {
      title: 'Durable memory degraded - embedding daily cap reached',
      body:
        'The daily embedding spend cap was reached. memory:* is running on the local BGE-ONNX fallback with reduced recall breadth; raise PAPERCUSP_EMBED_DAILY_TOKEN_CAP or wait for the UTC reset.',
    };
  }
  return {
    title: 'Durable memory degraded - OpenAI embedding quota exhausted',
    body:
      'OpenAI embedding quota/billing is exhausted. memory:* is running on the local BGE-ONNX fallback with reduced recall breadth; add OpenAI credit or raise the billing cap. ' +
      'BUT if this workspace deliberately runs a local embedder (memoryEmbedderMode local/gemma), do NOT add credit — this alert means an OUTDATED or misconfigured process is still routing embeds to OpenAI (live 2026-07-10: pre-gemma dist-host bundles fell through an unknown pref to the auto→openai path); update or restart that process instead.',
  };
}

async function defaultNotify(n: EmbedExhaustionNotification): Promise<void> {
  const [{ notifyAttention }, { broadcastSevereEvent }] = await Promise.all([
    import('../attention-notify'),
    import('../severe-event-broadcast'),
  ]);
  await notifyAttention({
    kind: 'intervention',
    title: n.title,
    body: n.body,
    importance: 'urgent',
    workspaceId: n.workspaceId,
    data: { conditionKey: n.conditionKey, embedExhaustionKind: n.kind },
  });
  await broadcastSevereEvent({
    summary: n.title,
    body: n.body,
    category: 'severe-event',
    conditionKey: n.conditionKey,
  });
}

async function defaultResolve(input: { conditionKey: string; workspaceId: string }): Promise<void> {
  const { broadcastSevereEventResolved } = await import('../severe-event-broadcast');
  await broadcastSevereEventResolved({
    conditionKey: input.conditionKey,
    summary: 'Durable memory embedding recovered',
    body: 'A subsequent OpenAI embedding succeeded; the embedding exhaustion condition cleared.',
  });
}

function fire(p: Promise<void>): void {
  void p.catch((e) => {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[memory] embed exhaustion alert failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

export function maybeEscalateEmbedExhaustion(
  kind: EmbedExhaustionKind,
  opts: { now?: number; workspaceId?: string } = {},
): boolean {
  const now = opts.now ?? Date.now();
  if (now < alertedUntil[kind]) return false; // this KIND's own cooldown — never cross-suppressed by the other kind
  alertedUntil[kind] = now + embedExhaustionAlertCooldownMs();
  active[kind] = true;

  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const { title, body } = copy(kind);
  const n: EmbedExhaustionNotification = { kind, title, body, conditionKey: conditionKeyFor(kind), workspaceId };
  const notify = notifyForTest ?? (process.env.NODE_ENV === 'test' ? null : defaultNotify);
  if (notify) fire(Promise.resolve(notify(n)));
  return true;
}

export function clearEmbedExhaustionAlertIfActive(
  kind: EmbedExhaustionKind,
  opts: { workspaceId?: string } = {},
): boolean {
  if (!active[kind]) return false; // this KIND's own state — clearing one kind never touches the other
  active[kind] = false;
  alertedUntil[kind] = 0;
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const resolve = resolveForTest ?? (process.env.NODE_ENV === 'test' ? null : defaultResolve);
  if (resolve) fire(Promise.resolve(resolve({ conditionKey: conditionKeyFor(kind), workspaceId })));
  return true;
}
