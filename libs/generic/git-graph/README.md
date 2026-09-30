# @papercusp/git-graph

A self-contained React component library for rendering git commit graphs:

- `GitGraphPanel` — the full panel with virtualized commit list, expand/collapse, lane rendering
- `CommitNode` — individual node with lane connectors
- `CommitDetail` — diff/file/show panel
- `graphLayout` — pure layout function (lanes, node positions)
- `cache` — in-memory git log cache + preload helpers

## Usage

```ts
import { GitGraphPanel } from '@papercusp/git-graph';
import '@papercusp/git-graph/git-graph.css';

<GitGraphPanel
  commits={commits}
  onCommitClick={(c) => …}
/>
```

## Repos using this lib

- `ownerhandle/Restart` — main monorepo (admin harness UI)
- `papercupai/papercup-public-site` — papercupai.com (public harness mirror)

Both consume this lib via git submodule at `libs/git-graph/` (kept as a workspace
package so monorepo workspace resolution works the same).

## Peer deps

- `react` ^18 || ^19
- `lucide-react` (any version)

The host app must also bundle `git-graph.css` (imported once in the root layout).
