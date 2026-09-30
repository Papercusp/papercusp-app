# @papercusp/card-stack

An overlapping **card-deck browser** for a group of same-type items: the
active card is the right-most, the pile of upcoming cards stacks left-and-down
behind it with their real content dimmed underneath, a centred category badge
and `‹ Prev / Next ›` pills straddle the active card's top edge, and cycling
animates the classic index-based deck pattern (the top card flies off to the
right with a tilt + fade while the next card settles in on a slight spring —
stepping back flies it back on).

- **Animation without a dependency** — every card in the window
  `[active-1 … active+maxPeek]` stays mounted as the same element type; only
  its transform/opacity (derived from its distance to the active index)
  changes, so pure CSS transitions do all the motion (the same technique as
  the Motion/Framer card-stack example, minus the drag physics). The deck's
  height animates between cards via a measured `ResizeObserver` layout.
- **Headless of domain** — `renderCard` render-prop; optional `renderExpanded`
  and `header` (category badge). Theming via CSS custom properties
  (`--bg-1`, `--bg-2`, `--accent`, `--border`, `--fg*`) with self-contained
  fallbacks, so it renders sensibly with no theme at all.
- **Category accents** — pass `accent` (the deck's category color) and the
  whole chrome tints from it via `--cs-accent`: card edge, badge, the active
  position dot, nav hovers. One deck = one category = one hue.
- **Accessible** — keyboard ← → on the focused deck, `aria-hidden` stacked
  layers, clickable position dots (`role=tablist`, always shown — a one-card
  deck still renders its single selected dot), labelled Prev/Next.

```tsx
import { CardStack } from '@papercusp/card-stack';

<CardStack
  items={ideas}
  getKey={(idea) => idea.id}
  accent="#a78bfa"
  header={<><span className="pc-cardstack__header-label">first-principles</span>
           <span className="pc-cardstack__header-count">{ideas.length}</span></>}
  renderCard={(idea) => <IdeaCard idea={idea} />}
  ariaLabel="first-principles ideas"
/>
```

Peer deps: `react` (18/19), `lucide-react` (the two chevrons).

Born in the Papercusp operator's Learning tab (Ideas decision-queue and
Observations stacks, 2026-07-19); extracted here because nothing in it knows
about Papercusp.
