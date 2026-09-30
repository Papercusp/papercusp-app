# Desktop agent MCP over UDS — support, selection, verification, and rollback
URL: /internal/docs/agent-insights/desktop-agent-mcp-uds-support-and-rollback

Runbook for the opt-in direct Unix-socket MCP path: supported clients/platforms, PAPERCUSP_MCP_TRANSPORT selection, packaged assets, verification, and HTTP rollback.

## Current rollout status

HTTP remains the default. The real full-catalog P-008 experiment proved that direct UDS is functional, bounded, and semantically equivalent, but it missed the preregistered warm-p50 speedup target twice (0.9209x and 0.9321x against a required ≤0.8x). Plan `desktop-agent-mcp-uds-2026-09-08` Decision D-011 therefore permits UDS only as an explicit opt-in; do not describe it as a default or promise a measured speedup.

## Support matrix

| Client / boundary                                                   | Route                               | Status                                                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Owned OMP 18.0.3 extension on local Linux                           | `uds` or explicitly selected `auto` | Verified with the installed OMP process, production adapter, private discovery, full staging catalog, real tool calls, reconnect, and rollback |
| Owned OMP on macOS                                                  | HTTP by default                     | `node:net` supports Unix sockets, but no hardware acceptance was completed; do not claim verified UDS support                                  |
| Windows, WSL boundaries, remote operators, or `PAPERCUSP_IPC_TCP=1` | HTTP                                | UDS selection is inapplicable and the launcher keeps the HTTP route                                                                            |
| Stock Codex and Claude MCP clients                                  | HTTP                                | Their installed MCP configuration surfaces do not natively accept this Unix-socket transport; do not emit invented `unix://` configuration     |

## Select the route

Use the existing selector; there is no second feature flag:

```bash
PAPERCUSP_MCP_TRANSPORT=uds psu --agent=omp ...
PAPERCUSP_MCP_TRANSPORT=auto psu --agent=omp ...
```

Omitting the variable, setting it to an empty value, or setting `http` preserves the default HTTP MCP route. `uds` requires a valid private per-port discovery descriptor and refuses when unavailable. `auto` is also an explicit opt-in: it uses a verified compatible local descriptor when present and otherwise retains HTTP. Unknown values fail closed. A tracked OMP resume restores the mode saved in that session's MCP profile, so rollback must update or recreate the session profile rather than relying on an unrelated parent-shell value.

## Packaged desktop contract

The desktop sidecar rebuilds `@papercusp/omp`, bundles `scripts/psu.mjs`, and stages `native-client.cjs` plus `native-extension.mjs` beside it. The launcher resolves those adjacent packaged assets first and falls back to `packages/omp-plugin/dist` only in a source checkout. The finished-sidecar verifier requires both adjacent files so a release cannot silently ship a selector whose runtime assets are absent.

## Verify a release candidate

1. Confirm the operator publishes a per-port descriptor whose file/socket/parent modes are `0600`/`0600`/`0700`, whose PID owns the socket, and whose generation matches the live operator.
2. Run the existing focused suites for `agent-mcp-client`, `mcp-uds`, `uds-transport`, and the installed OMP roundtrip.
3. Run `papercusp-desktop/bin/verify-sidecar-bundle.sh` on the assembled target sidecar and confirm both OMP native MCP runtime assets pass.
4. Launch an installed OMP session with `PAPERCUSP_MCP_TRANSPORT=uds`, verify full catalog discovery and one read-only real tool journey, then resume the same native session and repeat.
5. Inspect writer-backed request origin: the UDS leg must record MCP connection `uds` and the intended serving build; report direct HTTP and any proxy path separately.

## Roll back safely

Do not roll back while a mutating call is in flight. After the call has a known result—or after authoritative state reconciliation for an unknown outcome—close the session, select `PAPERCUSP_MCP_TRANSPORT=http`, and launch a new profile. Verify one read-only HTTP tool journey and confirm request-origin telemetry says `http`. No schema, data, listener, or migration rollback is required: both routes share the same dispatcher and HTTP remains continuously supported. Never force-deploy past a red release gate for this rollout.
