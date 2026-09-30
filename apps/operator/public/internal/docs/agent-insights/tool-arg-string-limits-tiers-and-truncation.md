# Tool-arg string limits: shared tiers + truncate-don't-reject (why softText can't be a zod transform)
URL: /internal/docs/agent-insights/tool-arg-string-limits-tiers-and-truncation

~1,000+ agent tool calls in 14 days FAILED purely on too-long STRING args, then blind-retried the same over-length value. The durable fix is a shared limits.ts (named char tiers + hardText/softText/clampText). The non-obvious trap: a truncating zod .transform() in tool args CRASHES the whole MCP catalog's schema-gen, so softText advertises a plain string and truncation is applied HANDLER-side via clampText.

## The waste this fixes

A telemetry audit (`harness_shared.tool_invocations`, 14d) found **\~1,000+ agent tool calls FAILED
purely on too-long STRING args** — `invalid_args: <field>: Too big: expected string to have <=N`.
Top offenders: `fleet:place_batch.brief` (412), `plans:set-status.note` (132),
`improvements:capture.title` (111), `events:await.note` (58), `loop:arm.goal` (46). Every failure is a
**wasted round-trip plus a blind retry** — agents re-send a *trimmed* value rather than fixing the
real problem (an owner watched a session arm `loop:arm` **4×**, re-trimming its goal each time, to fit
≤500). A failed tool call costs far more than a longer payload.

## The shared layer — `agent-tools/limits.ts`

* **Named char tiers** so a cap is a tier, not an ad-hoc literal (a "title" was 180 here / 200 / 280
  elsewhere): `IDENT=200`, `SHORT_TITLE=1000`, `ANNOTATION=2000`, `BRIEF=16000`, `CONTENT=16000`,
  `BODY=32000`. They only ever **raise**; never lower a field below its current cap.
* **`hardText(max, {min?})`** → `z.string().min(min ?? 1).max(max)` — REJECTS over-cap. Use ONLY where
  an over-length value is genuinely invalid downstream (an id/key, one plan-item line, a stored body
  with a real bound). A reject is now *recoverable in one retry* (see the invalid\_args message below).
* **`softText(max, {min?})`** → a NON-rejecting `z.string()` (+ optional `min`) whose value the handler
  clamps with **`clampText(value, max)`**. Use for advisory/echoed free-text the tool only echoes —
  goals, notes, briefs, summaries. Bouncing those on length is pure friction.

## The trap: `softText` is NOT a zod `.transform()`

The obvious implementation of "truncate instead of reject" is a zod transform
(`z.string().transform(s => s.slice(0, max))`). **It silently breaks the entire MCP tool catalog.**

`z.toJSONSchema(def.args)` runs — **with no try/catch** — at the critical point:

* At `defineTool` registration (`libs/generic/tooldef/src/define-tool.ts`), via `toJsonSchema(def.args)` in
  `registerLegacyAsProjected` / `registerRoleGatedAsProjected` (the `schema-adapter.ts` pluggable
  adapter, which defaults to `z.toJSONSchema`).

> **Note (2026-06-26):** A `builtinInputSchema` helper in `_mcp-handler.ts` used to call
> `z.toJSONSchema` a second time at `tools/list` request time. It is now dead code — the
> `tools/list` handler uses `listMcpProjections`, which returns the projected registry's
> **pre-computed** JSON schemas (computed once at registration). The consequence is unchanged:
> a transform on any tool's `args` schema crashes schema-gen for the **whole module at startup**,
> not just the offending tool.

A zod `.transform()` is **unrepresentable in JSON Schema**, so `z.toJSONSchema` throws — and because
it's un-guarded, schema-gen crashes for the **whole catalog**, not just the offending tool. So:

> **`softText` keeps the advertised arg a plain string; truncation happens HANDLER-side via
> `clampText(args.field, max)`.** Each soft field is `softText(max)` in the schema **and**
> `clampText(args.field, max)` in the handler. (Forget the handler call and you get accept-but-don't-
> truncate — safe, but not clamped.)

Truncation is **silent** (no per-call result warning) — acceptable because these values are
non-load-bearing; the `.describe()` says "auto-truncated to N chars if longer."

## The other half: make a hard reject recoverable

For `hardText` fields, `packages/agent-mcp/src/server.ts` formats a string `too_big` issue with the
over-by amount and the target, instead of the bare zod text:

```
goal: too long — 412 chars over the 500-char limit; trim to 500.
```

So an agent that *does* hit a hard cap trims to the right length **once** instead of guessing (the
loop:arm-×4 pattern).

## Recurrence guard

`packages/operator-core/lib/agent-tools/limits.test.ts` asserts tiers are ascending, `softText`
accepts an over-length value **without error** and stays JSON-Schema-representable (no `maxLength` →
no transform), `hardText` rejects + advertises `maxLength`, and `clampText` truncates/passes-through.

## Rule of thumb

Advisory **echoed** free-text (the tool just stores/echoes it) → `softText` + `clampText`, never
reject. A field with a **real downstream constraint** → `hardText` (now recoverable). New tool string
args should reference a tier, not a fresh literal.
