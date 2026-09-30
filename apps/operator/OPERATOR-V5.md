# Operator (v5)

> **STALE — describes the retired card-feed scanner.** The scanner tables
> (`operator_last_scan`, `operator_scans`, …) were dropped by migration 167
> and the card-feed UI this doc describes
> (`app/_components/OperatorPanel.tsx`, `OperatorButton`,
> `OperatorAutoScanToggle`) was orphaned (no live component imported it —
> see `/internal/docs/design/operator-panel-visual-pass`) and has since been
> **deleted** (WI-4139, 2026-07-12): it depended on the removed
> `operator-last-scan`/`operator-scan` routes, the dropped
> `operator_last_scan` table, two local modules that no longer exist
> (`./hud/OperatorReactorCore`, `./hud/OperatorScanOverlay`), and a
> nonexistent `@restart/sync` package — it could not even typecheck. The
> live Operator concierge surface is `OperatorChat`
> (`app/_components/OperatorChat.tsx`), mounted via `OperatorChatSidebar` in
> `ChromeShell.tsx`; suggestions render inline and pending cards surface in
> a `PendingCardsBar`. The CLI/routes/tables below are historical only.

The Operator is the always-on workspace concierge accessed from the
top-bar Operator button. It scans, surfaces ~5 next-action suggestions
per scan, auto-dispatches the safe ones, and routes the risky ones for
explicit user approval.

For the architectural deep-dive, see the rendered docs at
`/spec/operator-v5` (source: `content/docs/spec/operator-v5.mdx`).

## Quick start (end-user)

1. Click the Operator button in the chrome.
2. First open: pick a daily budget (Light $5 / Active $20 / Heavy $50).
3. Operator scans and lists suggestions. Tier=low cards auto-dispatch;
   tier=medium needs a standing approval; tier=high always asks.
4. Customize voice/tone in `/settings/operator` (the substrate prompt
   with tier rules + schema is read-only).
5. Dismiss with reason → Operator learns to skip similar suggestions.
6. After 3 silent dispatches of the same `(capability, target)` in 24h,
   a candidate appears in settings — approve to skip future asks.

## CLI

```sh
# From the repo root:
npx tsx apps/operator/scripts/operator.ts <subcommand> [args...]

# Or alias it:
alias operator='npx tsx ~/papercupai-workspace/papercup/apps/operator/scripts/operator.ts'

operator status              # budget, trigger-state fingerprint, top candidates
operator stats               # 7-day KPIs (JSON, same as the settings panel)
operator scan [--background] # trigger a scan, stream the SSE result
operator pause | resume      # toggle background scanning (papercup-file based)
operator budget [N]          # show or set the daily cap (USD)
operator candidates          # list standing-approval candidates
operator approve <cap> <target>  # promote a candidate to STANDING-APPROVE
operator prefs list [--filter user-typed|operator-proposed]
operator prefs remove <key>
operator dismiss-clear       # forget all dismissed-cooldown entries
operator config              # print the substrate prompt
```

For deeper preferences manipulation:

```sh
npx tsx apps/operator/scripts/audit-prefs.ts list --filter user-typed
npx tsx apps/operator/scripts/audit-prefs.ts remove <key>
npx tsx apps/operator/scripts/audit-prefs.ts purge --before 2026-01-01
```

`OPERATOR_BASE_URL` env var overrides the default `http://localhost:3055`
for the network-bound subcommands.

## What lives where

```
lib/operator-*               14 modules: schema, parser, classifier,
                             budget, scan-lock, idle, trigger-state,
                             rate-limit, audit, last-scan, reconstruction,
                             message-status, ack-latency, fuzzy-dedup,
                             plugin-tier, plugin-suggestions, dismissed-cache,
                             standing-candidates, multi-workspace, stats

app/api/agent-mcp/operator-* 14 routes: scan, config, budget, preferences,
                             standing-approvals, audit, last-scan,
                             trigger-state, message-status, ack-latency,
                             dismissed, multi-workspace, stats, pause-flag

app/_components/             OperatorPanel (the main UI), OperatorButton,
                             OperatorBackgroundScanner (chrome-resident,
                             polls trigger-state, fires auto-fire toasts),
                             operator-shared-state (cross-component glue)

app/settings/operator/       Settings page (prompt-user editor, preferences
                             notebook, per-entry view, recent-undo strip,
                             standing-approval candidates, 7-day stats,
                             budget, read-only substrate prompt preview)

scripts/operator.ts          Power-user CLI (this README's quick-start)
scripts/audit-prefs.ts       Deeper preferences-CRUD CLI
content/docs/spec/operator-v5.mdx   Architecture docs
```

## Operational pre-flight (before this is fully live)

1. Apply migration `014-operator-scan-locks.sql` to PG.
2. Apply migration `015-operator-dismissed-cards.sql` to PG.
3. Provision the `system:operator` principal:
   ```
   POST /api/agent-mcp/provision { principal: "system:operator" }
   ```
4. Set the workspace's Paperclip company id (via the workspace
   switcher's "edit" action, or directly via
   `POST /api/agent-mcp/workspace/company-id`).

Until 014 is applied, multi-tab dedup silently fails open. Until 015 is
applied, dismissed-cards are local-machine only.

## Tests

```sh
cd apps/operator
npx vitest run lib/operator-*.test.ts    # 81 tests across 15 modules
```

Test coverage includes every PG-independent module. PG-dependent
modules (audit writes, message-status reads, plugin-suggestions) get
mocked-PG tests for the file-fallback paths.

## What's not in v5 (with reasons)

- **Auto-dispatch tier=high** — defeats safety model.
- **Editable substrate prompt** — defeats tier guardrails.
- **`dispatch_role` (Path a)** — held as fallback. The activation
  criterion (>25% unconsumed-fraction) is now visible on the stats
  panel; trigger reconsideration when it lights up.
- **`pending_events`-based dispatch (Path c)** — substrate orchestrator
  polls (`TICK_INTERVAL_MS=30_000`), so this is *slower* than
  `send_message`, not faster. Becomes viable when substrate adopts
  `LISTEN pending_events_inserted`.
- **Embedding-based dedup** — Levenshtein dedup ships in v5 (no infra
  dependency); embedding upgrade adds a service for marginal gain on
  short titles.
- **Cross-workspace dispatch** — multi-workspace view is read-only.
  Click a foreign card → switches workspace → opens the panel there,
  preserving RLS / audit / budget scoping.
