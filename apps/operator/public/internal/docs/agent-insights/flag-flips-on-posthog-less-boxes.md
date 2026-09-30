# Flag flips on PostHog-less boxes — MCP flags:set fails, the HTTP route works
URL: /internal/docs/agent-insights/flag-flips-on-posthog-less-boxes

>-

## The gotcha

`flags:set` over MCP (papercusp-su) calls `setFlag()` and surfaces the raw
PostHog failure:

```json
{ "ok": false, "reason": "flag-backend-not-configured" }
```

On a box with no PostHog credential (the shared dev box), **every MCP flag
flip fails this way**. The flag system is fine — the *write fallback* only
exists in the HTTP route.

## The working path

```bash
curl -s -X POST http://127.0.0.1:3070/api/flags/set \
  -H 'Content-Type: application/json' \
  -d '{"key":"papercusp-improvement-auto-implement","enabled":true}'
# → {"ok":true,"key":"…","enabled":true,"backend":"pg-override"}
```

The route (`packages/operator-core/lib/endpoint-route/routes/flags/set.ts`,
`auth: 'loopback'`) falls back to `setFlagOverride()` (PG override store),
calls `publishFlagChange()` so live readers update without a restart, and
records the `flag:set` audit row with `backend: pg-override`. Verify with MCP
`flags:get` (the read side resolves overrides correctly on every transport).

`/admin/features` rides this same route — the UI works too.

## Notes

* Reads are fine everywhere; only the MCP *write* lacks the fallback. Filed as
  EI-407 (transport divergence — the endpoint system promises one tool per
  verb across HTTP/MCP/IPC).
* The audit trail for ANY flag flip is `audit:list` with action `flag:set`
  (singular — `flags:set` as an action filter matches nothing).
* Observed during the consume-edges P-013 supervised proof (2026-06-12):
  both the protective pause and the un-pause of
  `papercusp-improvement-auto-implement` rode the pg-override fallback.
