/**
 * outbound-webhook — Phase 9 P-054b Discord outbound webhook poster.
 *
 * Reads `discord_webhook_url` from the harness shared config and POSTs
 * Discord events with exponential backoff (max 3 retries, 5xx only).
 *
 * Pure side-effectful module; all types imported from discord-webhook-types.
 */

import {
  type DiscordEventKind,
  type DiscordWebhookPayload,
  DISCORD_WEBHOOK_MAX_RETRIES,
  discordWebhookBackoffMs,
  isRetryableDiscordStatus,
  validateDiscordPayload,
  isValidDiscordWebhookUrl,
  clampDiscordContent,
} from './discord-webhook-types';

// Discord embed color constants (RGB ints).
const COLOR_BLUE   = 0x5865F2; // feature filed
const COLOR_GREEN  = 0x57F287; // PR opened
const COLOR_PINK   = 0xEB459E; // PR merged
const COLOR_YELLOW = 0xFEE75C; // escalation

export type { DiscordEventKind };

export interface WebhookPostOptions {
  webhookUrl: string;
  payload: DiscordWebhookPayload;
}

export type WebhookPostResult =
  | { ok: true; status: number }
  | { ok: false; reason: 'invalid_url' | 'invalid_payload' | 'network_error' | 'http_error' | 'max_retries_exceeded'; detail?: string };

/**
 * Post a Discord webhook payload with retry.
 * Returns ok:true on 2xx; ok:false with structured reason otherwise.
 */
export async function postDiscordWebhook(opts: WebhookPostOptions): Promise<WebhookPostResult> {
  const { webhookUrl, payload } = opts;

  if (!isValidDiscordWebhookUrl(webhookUrl)) {
    return { ok: false, reason: 'invalid_url' };
  }

  const validationError = validateDiscordPayload(payload);
  if (validationError) {
    return { ok: false, reason: 'invalid_payload', detail: validationError.kind };
  }

  // Defensively clamp content.
  const safePayload: DiscordWebhookPayload = {
    ...payload,
    content: payload.content ? clampDiscordContent(payload.content) : undefined,
  };

  let lastStatus = 0;
  for (let attempt = 0; attempt <= DISCORD_WEBHOOK_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(discordWebhookBackoffMs(attempt - 1));
    }

    let res: Response;
    try {
      res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(safePayload),
      });
    } catch (err) {
      if (attempt < DISCORD_WEBHOOK_MAX_RETRIES) continue;
      return { ok: false, reason: 'network_error', detail: String(err) };
    }

    if (res.ok) {
      return { ok: true, status: res.status };
    }

    lastStatus = res.status;
    if (!isRetryableDiscordStatus(res.status)) {
      return { ok: false, reason: 'http_error', detail: `HTTP ${res.status}` };
    }
  }

  return { ok: false, reason: 'max_retries_exceeded', detail: `last status ${lastStatus}` };
}

// ─── Event builder helpers ────────────────────────────────────────────────────

export interface FeatureFiledEvent {
  harnessSlug: string;
  featureId: string;
  title: string;
}

export interface PrOpenedEvent {
  harnessSlug: string;
  prNumber: number;
  title: string;
  author: string;
  htmlUrl: string;
}

export interface PrMergedEvent {
  harnessSlug: string;
  prNumber: number;
  title: string;
  author: string;
  htmlUrl: string;
  auto: boolean;
}

export interface EscalationEvent {
  harnessSlug: string;
  featureId?: string;
  summary: string;
}

/**
 * Build the Discord payload for each event kind.
 */
export function buildDiscordPayload(event: FeatureFiledEvent & { kind: 'feature_filed' }): DiscordWebhookPayload;
export function buildDiscordPayload(event: PrOpenedEvent & { kind: 'pr_opened' }): DiscordWebhookPayload;
export function buildDiscordPayload(event: PrMergedEvent & { kind: 'pr_merged' }): DiscordWebhookPayload;
export function buildDiscordPayload(event: EscalationEvent & { kind: 'escalation' }): DiscordWebhookPayload;
export function buildDiscordPayload(
  event:
    | (FeatureFiledEvent & { kind: 'feature_filed' })
    | (PrOpenedEvent & { kind: 'pr_opened' })
    | (PrMergedEvent & { kind: 'pr_merged' })
    | (EscalationEvent & { kind: 'escalation' }),
): DiscordWebhookPayload {
  switch (event.kind) {
    case 'feature_filed':
      return {
        username: 'Papercusp',
        embeds: [
          {
            title: `📋 New feature filed — ${event.featureId}`,
            description: event.title,
            color: COLOR_BLUE,
            footer: { text: event.harnessSlug },
          },
        ],
      };

    case 'pr_opened':
      return {
        username: 'Papercusp',
        embeds: [
          {
            title: `🔀 PR #${event.prNumber} opened`,
            description: `**${event.title}**\nby @${event.author}`,
            url: event.htmlUrl,
            color: COLOR_GREEN,
            footer: { text: event.harnessSlug },
          },
        ],
      };

    case 'pr_merged':
      return {
        username: 'Papercusp',
        embeds: [
          {
            title: `✅ PR #${event.prNumber} merged${event.auto ? ' (auto)' : ''}`,
            description: `**${event.title}**\nby @${event.author}`,
            url: event.htmlUrl,
            color: COLOR_PINK,
            footer: { text: event.harnessSlug },
          },
        ],
      };

    case 'escalation':
      return {
        username: 'Papercusp',
        embeds: [
          {
            title: `⚠️ Escalation${event.featureId ? ` — ${event.featureId}` : ''}`,
            description: event.summary,
            color: COLOR_YELLOW,
            footer: { text: event.harnessSlug },
          },
        ],
      };
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
