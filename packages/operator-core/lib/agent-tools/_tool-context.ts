/**
 * PapercuspToolContext — the type-safe opt-in for `ctx.tx` (EI-10968).
 *
 * `ToolContext<Tx = any>` (libs/generic/tooldef/src/types.ts) defaults `Tx` to `any` so
 * the framework stays storage-agnostic — tooldef has no dependency on `postgres` or any
 * other DB client and must not gain one. That default means the near-universal call-site
 * idiom
 *
 *     const rows = await ctx.tx<Array<{ id: string }>>`SELECT …`;
 *
 * is a generic call on an `any`: TypeScript DISCARDS the `<…>` type argument and hands
 * back `any` for `rows`. It LOOKS type-checked (the syntax is right there) but isn't —
 * a column rename or a typo'd field silently becomes `undefined` at runtime with zero
 * compile-time signal. See EI-10968 for the full trace (this was found because a
 * DIFFERENT lint — the no-implicit-any check on `rows.map(...)` callbacks — happened to
 * catch the very first tool that mapped over its rows; every non-mapping caller stayed
 * silently unchecked).
 *
 * FIX: import THIS alias and type your handler's `ctx` param with it instead of the bare
 * `ToolContext` re-exported from `@papercusp/agent-mcp`:
 *
 *     import type { PapercuspToolContext } from '../_tool-context';
 *
 *     async handler(args, ctx: PapercuspToolContext) {
 *       const rows = await ctx.tx!<Array<{ id: string }>>`SELECT …`; // now really typed
 *       ...
 *     }
 *
 * `tx` stays OPTIONAL on both aliases (`tx?: Sql`, not `tx: Sql`) even though every real
 * call site treats it as always-present: `UnifiedToolContext`/`ToolContext`'s own `tx` is
 * optional, and TypeScript's structural check for "is this narrower type assignable
 * wherever the framework's declared (wider, optional-tx) context type is expected" is a
 * PRESENCE check independent of `any` — a required `tx` here would make the whole alias
 * fail that check and `defineTool(...)` would stop compiling at every callsite (verified:
 * this is exactly what broke when this alias was first drafted with `tx: Sql`). Use the
 * non-null assertion (`ctx.tx!<T>`) at each call site — it makes the pre-existing implicit
 * assumption (tx is always bound for an authenticated tool call) explicit instead of
 * silently baked into `any`.
 *
 * This is safe to do PER TOOL FILE — it is not a framework-wide default change, and does
 * not require touching tooldef. TypeScript's `any`-is-bidirectionally-compatible rule
 * means a handler typed `(args, ctx: PapercuspToolContext) => …` (tx?: Sql) is still
 * assignable wherever `defineTool`'s declared `handler: (args, ctx: ToolContext) => …`
 * (tx?: any) is expected — the wider `any` absorbs the narrower `Sql`, so every OTHER
 * tool file (and tooldef itself) is completely unaffected by a file opting in here.
 *
 * `Sql` (from the `postgres` package) is the real runtime shape of `ctx.tx` in every
 * Papercusp host binding (see endpoint-route/routes/agent-tools/catchall.ts's
 * `resolvePrincipalAndTx` — `tx: sql` where `sql` is `getOrgPg().sql` / a
 * `withWorkspace`-scoped handle, both `Sql` instances) — so this is not a narrowing
 * guess, it is the actual type already in use everywhere `ctx.tx` is passed to a
 * `Sql`-typed helper (e.g. `route-workspace.ts`'s `fn: (tx: Sql) => …`).
 *
 * TWO aliases, because `defineTool` hands two DIFFERENT context types to a handler
 * depending on the gate, and neither is a plain `Tx`-parameterized `ToolContext` in
 * the common case:
 *   - a PRINCIPAL-gated tool (`defineTool({ capability, args, handler })`, the
 *     default — `requirePrincipal` absent/true) gets `ctx: ToolContext<Tx = any>`.
 *     `PapercuspToolContext` binds that.
 *   - a ROLE-gated tool (`defineTool({ requirePrincipal: false, agentRoles, … })` —
 *     what most su/agent-facing tools in this tree actually are, e.g. sessions:*,
 *     loop:checkpoint) gets `ctx: UnifiedToolContext` instead, whose `tx?: any` has
 *     NO generic parameter to bind at all. `PapercuspUnifiedToolContext` overrides
 *     just that one field via `Omit` + intersection.
 */
import type { ToolContext, UnifiedToolContext } from '@papercusp/agent-mcp';
import type { Sql } from 'postgres';

/** For a PRINCIPAL-gated `defineTool` (no `requirePrincipal: false`). `tx` stays
 *  optional (matches `ToolContext`'s own shape) — see the file doc for why a
 *  required `tx` breaks `defineTool`'s overload resolution; use `ctx.tx!<T>`. */
export type PapercuspToolContext = ToolContext<Sql | undefined>;

/** For a ROLE-gated `defineTool` (`requirePrincipal: false`) — the majority of
 *  su/agent-facing tools. `UnifiedToolContext` has no `Tx` type param, so this
 *  overrides its `tx?: any` field directly instead of binding a generic. `tx`
 *  stays optional — see the file doc; use `ctx.tx!<T>` at call sites. */
export type PapercuspUnifiedToolContext = Omit<UnifiedToolContext, 'tx'> & { tx?: Sql };
