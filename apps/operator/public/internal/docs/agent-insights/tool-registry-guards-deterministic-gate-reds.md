# Adding a tool/flag? Update its registry guards — or the green-checkpoint goes red (deterministically)
URL: /internal/docs/agent-insights/tool-registry-guards-deterministic-gate-reds

A new tool with expose:{ipc:true} must be added to EXPECTED_IPC_ELIGIBLE (ipc-allowlist.test.ts); a tool's `args` must be a plain/strict z.object — `.passthrough()` (and `.refine()`/ZodEffects) drop additionalProperties:false and trip the tool-input-schema-rejection guard; a new dark flag needs KNOWN_DARK_FLAGS. These are DETERMINISTIC green-checkpoint reds (they fail local + checkpoint identically), distinct from env-flaky timing reds — and they're a recurring deploy-gate whack-a-mole. Real case: papercup:converse violated TWO guards at once.

When the green-checkpoint goes red, triage the failure into two classes — the fix
(and the owner) differ:

* **Deterministic** (a registry/list guard out of sync) — fails *identically* local
  and in the checkpoint. **Anyone can green it in-lane**: update the list. This page.
* **Env-flaky** (timing-sensitive in the checkpoint's slower `/tmp` clone) — passes
  local, fails the checkpoint. Needs the test made robust to slow timing — usually the
  deploy-gate owner's deeper fix.

A change that adds a tool, flag, or routine but **forgets to update the guard that
pins it** produces a deterministic red that blocks *every* run until synced. The
recurring offenders:

## 1. A new IPC-exposed tool → `EXPECTED_IPC_ELIGIBLE`

`expose: { ipc: true }` on a `defineTool` makes the tool IPC direct-dispatch eligible.
`packages/operator-core/lib/__tests__/ipc-allowlist.test.ts` pins that set in
`EXPECTED_IPC_ELIGIBLE` (a security-reviewed allowlist — IPC bypasses the per-workspace
tx). Add a tool with `expose:{ipc:true}` and you MUST add it there too, with a
justification (the test's own message: *"change both expose + this list, with
justification"*).

## 2. A tool's `args` must project to `additionalProperties:false`

`tool-input-schema-rejection.test.ts` asserts EVERY projected tool's inputSchema is
strict (`additionalProperties:false`) — the wire-level unknown-key rejection. Gotchas
that silently make a schema LOOSE:

* **`.passthrough()`** → `additionalProperties:true`. If your tool aliases another and
  wants to forward arbitrary fields, **reuse the target tool's strict schema**, don't
  `.passthrough()`. (Export the target's `ArgsSchema` and set `args: ArgsSchema`.)
* **`.refine()` / `.superRefine()`** wrap the object in a `ZodEffects`, which *can* drop
  `additionalProperties:false` from the projection. If you need a cross-field rule, keep
  a PLAIN `z.object` for `args` (so the inputSchema stays strict) and validate the
  refined schema in the HANDLER instead.

The failure message doesn't name the tool by `.name` (projected tools carry
`pluginName`/`description`, not `name`); to find the offender, dump
`loose.map(t => t.pluginName + ': ' + t.description?.slice(0,40))`.

## 3. Other pinned registries

* **`tools-md-sync`** — a tool's `guidance` / `when` block must round-trip; run
  `cd packages/operator-core && npx vitest run tools-md-sync` after any tool edit.
* **A new flag** — `libs/flags/src/production-defaults.test.ts` requires every flag to
  default ON unless consciously in `KNOWN_DARK_FLAGS` (with a justification).

## Why it matters for the deploy

The green-checkpoint is the *only* gate, and it runs `test:affected` POST-hoc — so a
guard-violating change that lands on `staging` (git-sync auto-commits) isn't caught
until the checkpoint, which then holds `main` for the WHOLE fleet. With many agents
shipping, these reds can arrive faster than they're fixed (the "whack-a-mole" that froze
the gate for hours on 2026-06-21). The cheap prevention: run the affected guard tests
locally before your tool/flag change settles — they're fast and deterministic.

## Related

* `mem0-entity-store-collection-leak` — another registry/projection subtlety.
* The "Adding a tool" discipline in `CLAUDE.md` (per-role guidance) — this page is the
  CI-guard companion to it.
