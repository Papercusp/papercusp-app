# @papercusp/agent-roster

The agent-roster presentation and its pure logic, as a host-free package: fleet
grouping and ordering, activity-liveness and thinking predicates, display-name and
glyph resolution, machine tabs, the search/filter pass, and the row/section
rendering.

It exists because two surfaces need the *same* roster. It was extracted from
`apps/operator-vite/src/components/adv/AgentsRunningPill.tsx` rather than copied —
a copy would have forked ~2,700 lines across two repos permanently.

## What a host supplies

Data arrives as props; nothing here fetches, routes, or reads a host module.
Everything host-specific enters through one of three seams, each with a working
default so you can adopt the roster with data alone:

| seam | what it covers | default |
|---|---|---|
| `chrome` | `Tooltip`, `LivenessDot`, `ThinkingDot` | `defaultRosterChrome` — unstyled dots carrying `data-liveness`, tooltip degrades to native `title` |
| `labels` | the cast-word vocabulary, agent-label and role normalization | `identityRosterLabels` — every word exactly as stored |
| `bulk` / `onInspect` | the message/wake/focus/kill/copy endpoints, and the live-thinking surface | omitted ⇒ **the affordance is not rendered at all** |

Omitting an action is the honest read-only mode: no checkboxes, no bulk bar, no
dead buttons. The row grid switches to its `--nocheck` template automatically.

```tsx
import { AgentRoster, ROSTER_STYLES, type RosterAgent } from '@papercusp/agent-roster';

<>
  <style>{ROSTER_STYLES}</style>
  <AgentRoster
    agents={agents}
    nowMs={nowMs}
    chrome={{ Tooltip, LivenessDot, ThinkingDot }}
    machineTab={machineTab}
    onMachineTabChange={setMachineTab}
    onInspect={setInspecting}
    bulk={{
      wake: async (ids) => (await post('/api/admin/coord/send', { to: ids })).ok
        ? `Nudged ${ids.length}` : 'Wake failed',
    }}
  />
</>
```

## Theming

Every colour in `ROSTER_STYLES` is a CSS custom property with a fallback —
`--bg-1`, `--bg-2`, `--fg`, `--fg-mute`, `--accent`, `--accent-ink`,
`--accent-strong`, `--border`. Define those and the roster takes your palette with
no fork. `--pc-roster-color-scheme` (default `dark`) drives the native checkbox's
`color-scheme` so the unchecked box renders for your surface rather than the
browser default.

## State the host owns, on purpose

- **The selected machine tab** is controlled (`machineTab` / `onMachineTabChange`).
  The operator keeps it in the URL via nuqs, which is a repo rule, not a
  preference: agent-readable surfaces read state from the URL, so anything in
  `useState` is invisible to them.
- **The inspector modal** is the host's; `onInspect` just reports the click, and
  `children` renders inside the roster root so the modal shares its stacking
  context.
- **The roster query.** Hosts poll, subscribe, or push however they like.

## Liveness

`Liveness` and `LIVE_MS` are declared here rather than imported, because this
package cannot depend on a host. That is the same local-copy-plus-guard pattern
operator-core's own `liveness.ts` uses for `STALE_MS`; the guard that keeps the two
from drifting lives host-side, where both are importable —
`apps/operator-vite/src/components/adv/agent-roster-liveness-parity.test.ts`.

Note what `activityLiveness` deliberately does **not** do: an armed loop is never
treated as evidence of life. A healthy loop keeps `lastActiveAt` fresh on its own;
an armed-but-not-firing loop is exactly the warm-dead session this must report as
stale. A missing `lastActiveAt` is `stale`, never a keepalive-derived "live".

## Tests

`npm run test:file -- libs/generic/agent-roster/src/logic.test.ts`

The pure logic is tested here. The rendered component is covered by the operator's
existing suite (`AgentsRunningPill.test.tsx`, `AgentsPillSessions.test.tsx`), which
passing **unchanged** after the extraction is the evidence that desktop behavior did
not move.
