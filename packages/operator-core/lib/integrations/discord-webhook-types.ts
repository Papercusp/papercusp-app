/**
 * discord-webhook-types — types for the Phase 9 §11 Discord
 * outbound-webhook integration per papercusp-dogfood-v5.
 *
 * Types-only and PURE. No fetch, no PG, no Discord SDK.
 *
 * Twenty-fourth module in the dogfood-arc types-only spine.
 *
 * Per v5 §11:
 *   - Per-harness Discord channel pointer in .papercusp/config.json.
 *   - Optional outbound webhook: if discord_webhook_url is set,
 *     operator posts events (feature filed, PR opened/merged,
 *     escalation).
 *   - New module apps/operator/lib/integrations/outbound-webhook.ts
 *     handles the queue + retry; this types module pins the wire
 *     payload + event-kind taxonomy + URL validators.
 *
 * Discord webhook payload follows Discord's standard shape:
 *   { content, embeds[], username, avatar_url }
 */

/**
 * The event kinds the operator posts to Discord per v5 §11.
 *
 *   feature_filed   — a new shared-feature was created
 *   pr_opened       — a PR was opened (from §8.1)
 *   pr_merged       — a PR was merged (from §8.5 auto-merge or manual)
 *   escalation      — an escalation was emitted (rebase conflict,
 *                     verifier divergence, etc.)
 */
export const DISCORD_EVENT_KINDS = [
  'feature_filed',
  'pr_opened',
  'pr_merged',
  'escalation',
] as const;
export type DiscordEventKind = (typeof DISCORD_EVENT_KINDS)[number];

/**
 * Per-event payload discriminator. Each kind carries the minimum
 * data needed to render a Discord message; the runtime adapter
 * maps these into the webhook's {content, embeds[]} format.
 */
export interface FeatureFiledPayload {
  kind: 'feature_filed';
  harness_slug: string;
  feature_id: string;
  title: string;
  filed_by_github_login: string;
}

export interface PrOpenedPayload {
  kind: 'pr_opened';
  harness_slug: string;
  pr_number: number;
  pr_url: string;
  title: string;
  author_github_login: string;
}

export interface PrMergedPayload {
  kind: 'pr_merged';
  harness_slug: string;
  pr_number: number;
  pr_url: string;
  title: string;
  merged_by_github_login: string;
}

export interface EscalationPayload {
  kind: 'escalation';
  harness_slug: string;
  escalation_kind: string;
  summary: string;
}

export type DiscordEventPayload =
  | FeatureFiledPayload
  | PrOpenedPayload
  | PrMergedPayload
  | EscalationPayload;

/**
 * Discord webhook wire payload per Discord's standard shape.
 *
 *   POST <webhook_url>
 *   { content, embeds[], username?, avatar_url? }
 *
 * Content is the plain-text message body; embeds carry rich
 * formatted blocks. Both are optional but at least one must be
 * present. Discord rejects payloads with neither.
 */
export interface DiscordWebhookPayload {
  /** Plain-text message body. Max 2000 chars per Discord's limit. */
  content?: string;
  /** Rich embed blocks; max 10 per Discord's limit. */
  embeds?: DiscordEmbed[];
  /** Override the webhook's display username. */
  username?: string;
  /** Override the webhook's display avatar URL. */
  avatar_url?: string;
}

/**
 * Discord embed sub-shape. Mirrors Discord's API spec for the
 * fields we actually use; not the full embed object.
 */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number; // RGB int, e.g. 0x00ff00
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string; icon_url?: string };
  timestamp?: string; // ISO 8601
}

/**
 * Convert a CSS hex color string (e.g. '#5865F2') to the integer form
 * Discord embeds expect. Returns 0 on any parse failure.
 */
export function formatDiscordEmbedColor(hex: string): number {
  if (typeof hex !== 'string') return 0;
  const cleaned = hex.startsWith('#') ? hex.slice(1) : hex;
  const parsed = parseInt(cleaned, 16);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Alias for validateDiscordWebhookPayload for callers that use the shorter
 * name. Returns the first validation error or null on success.
 */
export const validateDiscordPayload = validateDiscordWebhookPayload;

export const DISCORD_CONTENT_MAX = 2000;
export const DISCORD_EMBEDS_MAX = 10;
export const DISCORD_USERNAME_MAX = 80;

/**
 * Structural predicate for the webhook URL. Discord requires
 * the canonical form `https://discord.com/api/webhooks/<id>/<token>`.
 *
 * The legacy `discordapp.com` host is also accepted (Discord still
 * supports it but recommends migrating to discord.com).
 */
const DISCORD_WEBHOOK_URL_RE =
  /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;
export function isValidDiscordWebhookUrl(url: string): boolean {
  if (typeof url !== 'string') return false;
  return DISCORD_WEBHOOK_URL_RE.test(url);
}

/**
 * Structural predicate for the channel-URL pointer per v5 §11.
 *
 *   https://discord.com/channels/<guild_id>/<channel_id>
 */
const DISCORD_CHANNEL_URL_RE =
  /^https:\/\/(?:discord|discordapp)\.com\/channels\/\d+\/\d+$/;
export function isValidDiscordChannelUrl(url: string): boolean {
  if (typeof url !== 'string') return false;
  return DISCORD_CHANNEL_URL_RE.test(url);
}

/**
 * Derive the `discord://` URI scheme from an HTTPS channel URL per
 * v5 §11 "switch-to-harness behavior". Discord desktop intercepts
 * the discord:// scheme and focuses the channel.
 */
export function deriveDiscordUriFromChannelUrl(url: string): string | null {
  if (!isValidDiscordChannelUrl(url)) return null;
  return 'discord://' + url.slice('https://'.length);
}

/**
 * Validate a webhook payload before POST. Returns null on success
 * or a structured failure reason.
 */
export type WebhookPayloadValidationError =
  | { kind: 'content_too_long'; length: number; max: number }
  | { kind: 'too_many_embeds'; count: number; max: number }
  | { kind: 'username_too_long'; length: number; max: number }
  | { kind: 'no_content_or_embeds' };

export function validateDiscordWebhookPayload(
  payload: DiscordWebhookPayload,
): WebhookPayloadValidationError | null {
  const hasContent = typeof payload.content === 'string' && payload.content.length > 0;
  const hasEmbeds = Array.isArray(payload.embeds) && payload.embeds.length > 0;
  if (!hasContent && !hasEmbeds) {
    return { kind: 'no_content_or_embeds' };
  }
  if (typeof payload.content === 'string' && payload.content.length > DISCORD_CONTENT_MAX) {
    return { kind: 'content_too_long', length: payload.content.length, max: DISCORD_CONTENT_MAX };
  }
  if (Array.isArray(payload.embeds) && payload.embeds.length > DISCORD_EMBEDS_MAX) {
    return { kind: 'too_many_embeds', count: payload.embeds.length, max: DISCORD_EMBEDS_MAX };
  }
  if (typeof payload.username === 'string' && payload.username.length > DISCORD_USERNAME_MAX) {
    return { kind: 'username_too_long', length: payload.username.length, max: DISCORD_USERNAME_MAX };
  }
  return null;
}

/**
 * Truncate content to Discord's limit. Used as a defensive last
 * step before POST so an over-length escalation message becomes a
 * truncated message rather than a webhook rejection.
 */
export function clampDiscordContent(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw.length <= DISCORD_CONTENT_MAX ? raw : raw.slice(0, DISCORD_CONTENT_MAX);
}

/**
 * Per v5 §11 retry policy: "Retries with exponential backoff on 5xx
 * (3 attempts)." Pure constants — runtime imports.
 */
export const DISCORD_WEBHOOK_MAX_RETRIES = 3;
export const DISCORD_WEBHOOK_INITIAL_BACKOFF_MS = 1000;
export const DISCORD_WEBHOOK_BACKOFF_MULTIPLIER = 2;

/**
 * Pure backoff calculator: compute the wait before retry attempt N.
 * `attempt` is 0-indexed (attempt 0 → initial backoff).
 */
export function discordWebhookBackoffMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new TypeError('attempt must be a non-negative integer');
  }
  return (
    DISCORD_WEBHOOK_INITIAL_BACKOFF_MS *
    Math.pow(DISCORD_WEBHOOK_BACKOFF_MULTIPLIER, attempt)
  );
}

/**
 * Predicate: should the webhook retry on this HTTP status? Per
 * v5 §11: 5xx retryable; everything else terminal (4xx is
 * usually a misconfigured URL or revoked webhook).
 */
export function isRetryableDiscordStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * `.papercusp/config.json` Discord pointer per v5 §11.
 */
export interface DiscordConfigPointer {
  discord_channel_url: string | null;
  discord_webhook_url: string | null;
}

/**
 * Structural predicate for the pointer in .papercusp/config.json.
 */
export function isDiscordConfigPointer(input: unknown): input is DiscordConfigPointer {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  const channel = r.discord_channel_url;
  const webhook = r.discord_webhook_url;
  if (channel !== null && (typeof channel !== 'string' || !isValidDiscordChannelUrl(channel))) {
    return false;
  }
  if (webhook !== null && (typeof webhook !== 'string' || !isValidDiscordWebhookUrl(webhook))) {
    return false;
  }
  return true;
}

/**
 * Empty pointer — used when .papercusp/config.json has no Discord
 * config.
 */
export function emptyDiscordConfigPointer(): DiscordConfigPointer {
  return { discord_channel_url: null, discord_webhook_url: null };
}
