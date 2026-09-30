# @papercusp/token-kit

Generic, brand-value-free tooling for compiling DTCG design tokens to multiple
formats with [Style Dictionary](https://styledictionary.com) v4/v5. Shared across
projects — each project supplies its own `*.tokens.json` sources + SD config and
imports the transforms/formats/guards from here.

```js
import StyleDictionary from 'style-dictionary';
import { transforms, formats, preflight } from '@papercusp/token-kit';

preflight(globSync('src/*.tokens.json'));
transforms.forEach((t) => StyleDictionary.registerTransform(t));
formats.forEach((f) => StyleDictionary.registerFormat(f));
// …define platforms, build…
```

## What's here

| Export | |
|---|---|
| `transforms` | `tokenkit/name` (kebab var names, drop `color.`/`shop.` prefix), `tokenkit/srgb` (→ hex or `rgba()`), `tokenkit/oklch` (→ `oklch(L C H [/ a])`) — culori-backed |
| `formats` | `tokenkit/tailwind-theme` (Tailwind v4 `@theme { --color-* }` block), `tokenkit/grid-ts` (typed `as const` object for canvas/JS consumers) |
| `preflight` | source guards: zero-token files, tree-merge collisions, duplicate `$schema`/`_meta` |

Both formats prepend a neutral `/* AUTO-GENERATED — DO NOT EDIT. */` banner so
generated files carry no foreign branding; override it per file via the Style
Dictionary `options.banner` (e.g. to name your own tool + regen command).

## What's NOT here

Brand token **values**, project SD config, and project-specific drift/contract
checks stay in each consumer (e.g. `@papercusp/design-tokens`).

## Ownership

papercusp-owned shared library (per the "Restart depends on papercusp, never the
reverse" rule). First consumer: `@papercusp/design-tokens`. See
`Restart/docs/design-tokens-brief-for-papercusp.md` for the cross-project plan.
