# Phase 5 — Harness design-adapter unification (handoff)

## Context

Phases 1-4 (shipped 2026-05-13) established the workspace's DTCG design-token spine:

- `papercup/design-tokens/primitives.tokens.json` — canonical brand palette (sky/emerald/amber/gold/rose/slate)
- `papercup/design-tokens/desktop.semantic.tokens.json` — desktop semantic mappings
- `papercup-rust-mobile/design-tokens/mobile.{semantic,component,primitives}.tokens.json` — mobile-side layers (mobile mirrors workspace primitives via `mirror.mjs`)
- Style Dictionary v4 emits CSS for desktop, Kotlin + Swift for mobile

Today the harness app has its own DTCG-aware spine in `apps/operator/lib/design-adapter*/` that's independent of the workspace token store. Phase 5 unifies them.

## Design intent — what to PRESERVE

**The harness Design tab uses per-harness DTCG stores by design.** Each harness owns its own design exploration scratchpad; that separation is intentional and confirmed correct (2026-05-13). Phase 5 does NOT unify the stores or rewire `list_tokens` to point at workspace tokens. Phase 5 only **augments** the harness designer-agent's awareness of the workspace brand palette so it doesn't reinvent primitives.

The flow is:
- **Per-harness store** = mission-scoped scratchpad (designer agent proposes; user accepts)
- **Workspace store** = brand canon (accepted designs may eventually graduate here)

## Recommended scope

Two augmentations, both small and isolated.

### 5a. Add a read-only "Workspace brand palette" reference pane

The "Tokens" pane in `app/design/[slug]/DesignDashboard.tsx` keeps querying `/api/plugins/design-phase/list_tokens` (per-harness, primary). **Add a secondary read-only reference section** showing workspace brand tokens so the user can compare proposals against canon without leaving the page.

Concretely:

- Add `/api/agent-mcp/list_workspace_tokens` that reads `papercup/design-tokens/*.tokens.json` + `papercup-rust-mobile/design-tokens/mobile.*.tokens.json` (if reachable) and returns a flattened `DtcgToken[]`.
- Add a collapsed "Brand reference" sub-section below the per-harness Tokens list.
- The shared loader can live in `apps/operator/lib/design-adapter/workspace-tokens.ts`.
- **Do NOT** replace or merge the per-harness store — these are two distinct stores with different lifecycles.

### 5b. Wire the designer-agent prompt to ingest workspace tokens

`apps/operator/lib/design-spec/designer-prompt.ts` already accepts a "Summary of the active DTCG token store — IDs + types only" in its prompt assembly. Currently the harness designer-agent only sees per-harness tokens. Phase 5b extends the prompt input to include workspace primitives + each platform's semantic layer.

The plumbing is small: pass the workspace token IDs as additional context to the designer prompt. The model now knows the brand palette exists and can:

- Reuse existing primitives instead of proposing duplicates (e.g., "use `{color.sky.400}` instead of inventing `#38bdf8`")
- Propose changes to the brand palette as `proposedToken` against the workspace store

### 5c (optional, larger) — adopt Style Dictionary in the harness emitter

Today `lib/design-adapter-react-tailwind/tokens.ts` has a custom in-house emitter. Phase 5c would refactor it to delegate to Style Dictionary's `css/variables` + `javascript/module-flat` transforms. Pure refactor, output should be byte-identical.

## Non-goals

- Changing the harness's per-harness DTCG store concept — those stay
- Forcing all design tokens through the workspace store — workspace is the brand palette, harnesses still propose their own component tokens
- Changing any platform output format

## Time estimate

- 5a + 5b: ~2 hours
- 5c (refactor harness emitter to SD): ~3 hours, can defer indefinitely

## Open questions for the harness team

1. **Workspace token endpoint location** — under `agent-mcp` (mirrors `operator-converse` etc.), `harness` (mirrors existing token APIs), or new `/api/design-tokens/`?
2. **Designer-agent token-proposal target** — when the agent proposes a new brand-palette token via `proposedToken`, where does it write? A PR against `papercup/design-tokens/`, a per-harness override, or both?
3. **Mobile-token visibility in the harness UI** — should the Tokens pane show mobile-only tokens (mobile semantic/component layers) too, or only brand primitives? If yes, how does the harness check out the mobile repo (relative path vs npm publish vs read-only sync)?

## Pointers

- Architecture: `papercup/design-tokens/IMPLEMENTATION_PLAN.md`
- Canonical primitives: `papercup/design-tokens/primitives.tokens.json`
- Desktop semantic: `papercup/design-tokens/desktop.semantic.tokens.json`
- Existing harness design-adapter: `apps/operator/lib/design-adapter*/`
- Existing designer prompt: `apps/operator/lib/design-spec/designer-prompt.ts`
- Mobile mirror script (reference for any cross-repo sync): `papercup-rust-mobile/design-tokens/mirror.mjs`
