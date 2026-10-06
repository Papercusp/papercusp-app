/**
 * codex-gateway-config.ts — the ONE codex inference-gateway config.toml builder (WI-3645).
 *
 * Renders the `model_provider` blocks that point a codex CLI session at the localhost
 * Papercusp inference gateway. Consumed by BOTH codex config writers:
 *   • `spawn-mcp.ts` `writeSignedSpawnCodexHome` (same package) — SPAWNED agents
 *     (fleet members, bees; env-driven via PAPERCUSP_ACCOUNT_ID / PAPERCUSP_CODEX_GATEWAY);
 *   • operator-core `role-codex-home.ts` (via the `@papercusp/orchestrator/codex-gateway-config`
 *     subpath export) — the INTERACTIVE psu path (resolveAccountPin / bootstrap-su).
 *
 * Before this extraction each writer carried its own near-identical copy, and they DRIFTED:
 * the spawned copy learned unpinned auto-routing (WI-3645) while the interactive copy still
 * required a pin — which is exactly how "auto" stayed unwired interactively. One builder,
 * one behavior. (Owner directive 2026-07-09: "share as much code as possible with the claude
 * implementation, abstracting away the model specific things into shared code" — the claude
 * analogue is operator-core's `gatewaySpawnEnv`, which likewise routes pin-or-no-pin.)
 *
 * ROUTING SEMANTICS (mirrors the claude path):
 *   • `accountId` set   → gateway config WITH the `x-papercusp-account` pin header.
 *   • `gatewayOn` set   → gateway config WITHOUT the pin header (explicit-auto / unpinned):
 *     the gateway's own codex handling auto-selects — bearer pool first, then the codex-CLI
 *     account fallback — when no account header is present. The header is OMITTED entirely,
 *     never emitted empty (an empty pin would name a nonexistent account and 4xx).
 *   • neither           → `{ root: [], tables: [] }` (gateway off; direct egress unchanged).
 *
 * The `# BEGIN/END PAPERCUSP_CODEX_GATEWAY_*` marker lines are LOAD-BEARING: config writers
 * and diagnostics locate/replace the managed blocks by them — keep them byte-stable.
 */

/**
 * The one provider id every managed codex config names. Exported because it is
 * not just a config-writing detail: codex stamps it into each rollout's
 * `session_meta.model_provider` and re-resolves it against the CURRENT config at
 * `thread/resume`, so the RESUME path has to recognise a thread that is bound to
 * it and refuse to strip the table (WI-38706). One constant, both readers.
 */
export const CODEX_GATEWAY_PROVIDER_ID = 'papercusp-codex-gateway';

/** Escape a value for a TOML double-quoted basic string. */
export function tomlEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** The localhost gateway port (PAPERCUSP_GATEWAY_PORT override → default 8788). */
export function codexGatewayPort(): number {
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  return Number.isFinite(p) && p > 0 ? p : 8788;
}

export interface CodexGatewayConfigOpts {
  /** Gateway attribution/owner header (x-papercusp-owner) — the spawn/session owner id. */
  ownerId?: string | null;
  /** Admission-tier label (x-papercusp-priority) — the spawn role, when the tier flag resolved one. */
  priority?: string | null;
  /** Route through the gateway even with NO account pin (explicit-auto / unpinned).
   *  Ignored when `accountId` is set (a pin implies the gateway). */
  gatewayOn?: boolean;
}

/**
 * Feature policy baked into every Papercusp-managed CODEX_HOME.
 *
 * Codex 0.147 enables `remote_compaction_v2` by default. That native path cuts
 * the conversation before Papercusp can write a carry note or deliberately
 * restart the session, so managed sessions disable it and use
 * `session:request-compaction` instead. Interactive role/SU homes also disable
 * Codex's native memory store; short-lived spawn homes preserve their existing
 * memory setting by passing `disableMemories: false`.
 */
export function codexManagedFeaturesToml(
  opts: { disableMemories?: boolean; headless?: boolean } = {},
): string[] {
  return [
    '# Papercusp owns context carry/restart; Codex native compaction must not cut first.',
    '[features]',
    ...(opts.disableMemories === false ? [] : ['memories = false']),
    'remote_compaction_v2 = false',
    // Custom providers do not consult `model_catalog_url` unless this Codex feature is on.
    // Without it, /model silently falls back to the shared/default-account cache even while
    // the gateway can serve newer model ids for inference.
    'api_key_model_discovery = true',
    // A headless managed PTY has no human who can answer Codex's plugin/app
    // authentication elicitation. Leaving plugins enabled makes a 401 from the
    // remote ChatGPT plugin catalog start an OAuth browser flow for every fleet
    // member, even when model inference uses an API key or custom provider and
    // needs no ChatGPT login. Suppress that optional interactive surface only
    // for headless sessions; visible sessions keep the ordinary plugin UX.
    ...(opts.headless
      ? [
          'plugins = false',
          'auth_elicitation = false',
        ]
      : []),
    '',
  ];
}

/**
 * The managed gateway blocks for a codex `config.toml`: `root` lines (top-level
 * `model_provider = …`) and `tables` lines (the `[model_providers.…]` table).
 * Empty when neither a pin nor `gatewayOn` asked for the gateway.
 */
export function codexGatewayConfigToml(
  accountId?: string | null,
  opts: CodexGatewayConfigOpts = {},
): { root: string[]; tables: string[] } {
  const pinnedAccount = accountId?.trim();
  // WI-3645: a pin gets routing config as before; a caller that passes NO pin but sets
  // `gatewayOn` (the explicit-auto / unpinned case) ALSO gets routing config, just without the
  // account-pin header — the gateway's own codex fallback auto-selects when the header is
  // absent. Only a caller that passes neither (gateway fully off) gets no config.
  if (!pinnedAccount && !opts.gatewayOn) return { root: [], tables: [] };
  const providerId = CODEX_GATEWAY_PROVIDER_ID;
  // `/v1/models` is shared by the Claude and Codex adapters. Inference is
  // unambiguous from `/v1/responses`, but the native model-catalog client does
  // not stamp Codex's usual originator header. Make the provider identity
  // explicit so an unpinned `account=auto` catalog request cannot fall through
  // to Claude's differently-shaped `{ data: [...] }` response.
  const headers: Record<string, string> = { originator: 'codex_cli_rs' };
  if (pinnedAccount) headers['x-papercusp-account'] = pinnedAccount;
  const ownerId = opts.ownerId?.trim();
  if (ownerId) headers['x-papercusp-owner'] = ownerId;
  const priority = opts.priority?.trim();
  if (priority) headers['x-papercusp-priority'] = priority;
  const gatewayBaseUrl = `http://127.0.0.1:${codexGatewayPort()}`;
  const headerEntries = Object.entries(headers);
  const httpHeadersLine = headerEntries.length
    ? [`http_headers = { ${headerEntries.map(([k, v]) => `"${tomlEscape(k)}" = "${tomlEscape(v)}"`).join(', ')} }`]
    : [];
  return {
    root: [
      '# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT',
      '# Route Codex model traffic through the Papercusp inference gateway account pin.',
      `model_provider = "${providerId}"`,
      '# END PAPERCUSP_CODEX_GATEWAY_ROOT',
      '',
    ],
    tables: [
      '# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER',
      `[model_providers.${providerId}]`,
      'name = "Papercusp Codex Gateway"',
      `base_url = "${gatewayBaseUrl}/v1"`,
      // Codex model discovery is a distinct provider endpoint. Without this full URL,
      // the TUI falls back to its shared/default-account cache instead of asking our
      // selected gateway account, so newly released models disappear only in PSU
      // `--account=auto` sessions even though inference can already serve them.
      `model_catalog_url = "${gatewayBaseUrl}/v1/models"`,
      'wire_api = "responses"',
      'experimental_bearer_token = "papercusp-gateway"',
      ...httpHeadersLine,
      '# END PAPERCUSP_CODEX_GATEWAY_PROVIDER',
      '',
    ],
  };
}
