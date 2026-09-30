# @papercusp/agent-chat

Reusable chat UI for harness/director agents. Built on `@assistant-ui/react`
with custom action-block rendering for `patch:` and `promote:` blocks emitted
by agent runtimes.

## Exports

- `HarnessChat` — main chat surface
- `PatchBlock`, `PromoteBlock` — action block renderers
- `useHarnessChatRuntime` — runtime hook (streaming, action parsing)
- `type ActionBlock` — discriminated union of supported action shapes

## Repos using this lib

- `papercupai/papercup` — main monorepo (admin harness UI)
- `papercupai/papercup-public-site` — papercupai.com (public harness mirror)

Both consume this lib via git submodule at `libs/agent-chat/`.

## Peer deps

- `react` ^18 || ^19
- `@assistant-ui/react` (any version, host's choice)
- `lucide-react`
- `sonner`
