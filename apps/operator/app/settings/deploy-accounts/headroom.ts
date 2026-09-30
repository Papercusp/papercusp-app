/**
 * Pure helpers for the deploy-accounts pool view's live rate-headroom column.
 *
 * The data comes from `GET /api/admin/inference-gateway/stats` (the gateway's
 * normalized `GatewayHeadroom` read-model). The gateway is the only process that
 * sees the `anthropic-ratelimit-unified-*` headers, and it reflects the
 * **currently-bound** account's most-constraining unified window — so utilization
 * is shown on the one account the gateway is routing egress through.
 *
 * Kept pure + colocated so the formatting + command interpolation are unit-tested
 * without standing up the nuqs page or the gateway process.
 */

/** The subset of the gateway `/stats` headroom the pool view renders. */
export interface PoolHeadroom {
  reachable: boolean;
  accountId?: string;
  /** 0..100+ (101 = over the rolling 5h budget). */
  utilizationPct?: number;
  /** Seconds until the binding window resets. */
  resetInSec?: number;
  paused?: boolean;
  /** The binding window is currently hard-rejected (over budget). */
  rejected?: boolean;
  /** Which unified window is binding ('5h' | '7d' | 'unified'). */
  window?: string;
}

/** Severity tone for a utilization percent — drives the bar colour. */
export function utilizationTone(pct: number | undefined): 'ok' | 'warn' | 'bad' {
  if (pct === undefined) return 'ok';
  if (pct >= 90) return 'bad';
  if (pct >= 70) return 'warn';
  return 'ok';
}

/** Compact reset countdown: "45s" · "10m" · "1h" · "1h 3m" · "now". */
export function formatResetIn(sec: number | undefined): string {
  if (sec === undefined || sec <= 0) return 'now';
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * The isolated-config-dir `claude setup-token` command for an account id. The
 * isolated `CLAUDE_CONFIG_DIR` keeps the mint off this box's own ~/.claude login.
 * An empty/unsafe id degrades to the literal `<id>` placeholder (never injects).
 */
export function setupTokenCommand(id: string): string {
  const safe = id && /^[A-Za-z0-9._-]+$/.test(id) ? id : '<id>';
  return `CLAUDE_CONFIG_DIR="$HOME/.claude-deploy-${safe}" claude setup-token`;
}

/** Is THIS account the one the gateway is currently routing egress through? */
export function isActiveAccount(headroom: PoolHeadroom | null, id: string): boolean {
  return !!headroom?.reachable && headroom.accountId === id;
}
