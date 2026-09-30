# cup:spawn "structural error" — a missing transport identity default plus miscoded caller errors
URL: /internal/docs/agent-insights/fleet-spawn-structural-error-identity-and-coding

Why the advertised curl-able superuser HTTP path failed deterministically (no uiClientId default → resolveAgentIdentity throws) and why zod failures inflated the structural tool-error class (define-tool threw plain Errors that dispatch coded handler_error instead of invalid_input).

:::caution\[`cup:spawn` is retired — the two DEFECTS it exposed are general]
`cup:spawn` **refuses** as of 2026-08-09 (the Mug · Kettle · Cup tier is
[retired](/internal/docs/agent-insights/mug-kettle-cup-tier-is-retired)), so the watchdog
key `repeated-tool-error:cup:spawn:structural` can no longer fire. Kept because neither
defect was cup-specific: a **missing transport identity default**, and **caller errors
miscoded as structural** — the latter makes any tool's watchdog blame the tool for what is
really a bad call. Both patterns are worth recognising on the live launch paths.
:::

## Symptom

The watchdog key `repeated-tool-error:cup:spawn:structural` fired and filed
EI-334 ("Tool cup:spawn returns a structural error"). Sample error:

```
resolveAgentIdentity: superuser context is missing uiClientId — re-run install-standalone-mcp.sh to mint a ?client= id
```

Every client-less call to `POST /api/agent-tools/fleet/spawn?superuser=1` — the
curl-able admin trigger advertised in the tool's own docstring — failed with a
500 `handler_error` before the spawn engine was even reached.

## Two distinct legs (fixing one alone leaves the key firing)

1. **The HTTP transport admitted superusers without giving them an identity.**
   `tooldef-http/src/http-projection.ts`'s superuser block defaulted
   `workspaceId`/`harnessSlug`/`role`/`runId`/`spawnId` — but not `uiClientId`.
   `resolveAgentIdentity`'s contract says the per-transport route folds the
   tier identity into `ctx.uiClientId`; for a superuser ctx with none it
   THROWS (attributability is a hard requirement). So any identity-resolving
   tool (`fleet:*`, `coord:*`, `plans:*` writes…) was structurally broken over
   the client-less superuser HTTP path. Fix (now in TWO layers): the HTTP
   transport's superuser block defaults a transport-level `su-http-loopback`
   id (`http-projection.ts`), AND — the broader fix — the single L1 identity
   primitive `resolveAgentIdentity` itself falls back to
   `SUPERUSER_FALLBACK_CLIENT_ID` (`'su-loopback'`, in
   `coordination/identity.ts`) for ANY admitted-superuser ctx with no
   `uiClientId`, so EVERY transport is covered uniformly — not just the JSON
   HTTP path — and no transport can forget it (EI-2127). The host validator
   already proved loopback + the on-disk bearer = the machine admin, so a fixed
   id is attributable — same stability class as a `?client=` machine UUID. An
   explicit client id still wins; non-superuser callers get NO default
   (unattributable writes stay rejected — EI-318's forgery concern is about
   *trusting caller-supplied* ids, not about assigning a fixed one post-proof).

2. **Schema-validation failures were coded `handler_error` → structural.**
   `defineTool`'s projected fn threw a plain `Error('invalid_args: …')` on a
   zod parse failure; the dispatch-stack catch coded any plain Error
   `handler_error` (500). The watchdog's TS classifier (`classifyToolError`)
   checks `error_code` FIRST, so these caller mistakes (e.g. a >2000-char
   `brief`) landed in the **structural** class — the "tool is broken" bucket.
   Fix: a typed `InvalidInputError` (name-matched like
   `UnauthorizedToolError`, dual-module-instance safe) thrown from
   define-tool's two parse sites, mapped to `invalid_input` (HTTP 400) in
   dispatch-stack. `invalid_input` was already in the taxonomy, the HTTP 400
   mapping, the invocation-status mapping, and the watchdog's caller class —
   the plumbing existed end-to-end; nothing ever produced the code.

## Gotchas worth keeping

* The watchdog's SQL classifier and the TS `classifyToolError` **diverged** on
  legacy rows: SQL also matches `error_message LIKE 'invalid_args:%'` → caller
  even when `error_code='handler_error'`; the TS fn trusts `error_code` first.
  With `invalid_input` now actually emitted, both agree on new rows.
* Resolving the EI right after the fix is safe even though pre-fix error rows
  remain in the 24h collector window: `partitionSignalsByKnownKeys` routes
  signals whose `latestAt` predates the resolution to `staleResolved` (dropped,
  not re-filed). Only a genuinely NEW structural failure re-captures.
* A spawned child exiting 1 with output `You've hit your session limit` is the
  Claude account limit, not the spawn path — the nursery row, `fleet:tree`
  visibility, and pid all prove the launch leg worked.

Fixed 2026-06-12 (plan `self-improvement-consume-edges-2026-06-12` P-002 /
brief B-02). Tests: tooldef 368, tooldef-http 6, agent-mcp http-projection 34

* artifacts 23, operator-core agent-tools-catchall 7 — all green; live
  before/after probes on `:3170`.
