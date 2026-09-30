# Test env (jsdom 20) drops CSS var() from inline styles — assert tokens off a pure style fn
URL: /internal/docs/agent-insights/jsdom-drops-css-var-inline-styles

Vitest's jsdom@20 CSSOM stores any var() inline-style value as '', so a component test that reads btn.style.background for a theme token silently fails; assert the token mapping against a pure exported style function instead.

## Symptom

A component unit test asserts an inline style whose value is a CSS custom-property
reference and gets `''` back:

```
expected '' to be 'var(--accent)' // Object.is equality
   btn.style.background  →  ''
```

The component renders correctly in a real browser and the value looks right in the
source — but the assertion permanently fails (EI-10480: `picker-kit.test.tsx` red 20× in 6h).

## Root cause

The **vitest test environment is `jsdom@20.0.3`** (nested under
`node_modules/.pnpm/jsdom@20.0.3`), whose bundled old `cssstyle` **rejects any
`var(...)` value and stores it as `''`** — for shorthands (`background`, `border`)
AND longhands (`backgroundColor`, `color`, `borderColor`), and even via
`setProperty`. Only non-`var()` values survive (e.g. `font-weight: 600`). React
faithfully sets `node.style.background = 'var(--accent)'`; jsdom's CSSOM then drops
it. The `getAttribute('style')` string is stripped of it too.

Note the workspace's OWN jsdom (29.1.1, cssstyle 6.2.0) round-trips `var()` fine —
so a direct `require('jsdom')` probe *passes* and misleads you. What matters is the
jsdom the **vitest environment** resolves, which is the old one.

Quick confirmation probe (run inside a `// @vitest-environment jsdom` test):

```ts
const s = document.createElement('div').style;
s.background = 'var(--accent)';
console.log(JSON.stringify(s.background)); // "" in the vitest env
```

## Fix / how to write these tests

Do **not** read a `var()` token back off a rendered node's `.style` — the env
can't represent it. Instead extract the style mapping into a **pure exported
function** and assert the tokens against that plain object (env-independent), while
keeping the render-based assertions jsdom *does* support (onClick, spread
`aria-*`/`title`, and non-`var()` values like `fontWeight`).

```ts
// component
export function pillStyle(active: boolean, accent = 'var(--accent)'): CSSProperties {
  return { background: active ? accent : 'var(--bg-2)', /* … */ };
}
export function Pill({ active, accent, ...rest }) {
  return <button style={{ ...pillStyle(active, accent), ...style }} {...rest} />;
}

// test — assert tokens off the pure fn, behaviour off the rendered node
expect(pillStyle(true).background).toBe('var(--accent)');
expect(btn.style.fontWeight).toBe('600'); // non-var survives jsdom
fireEvent.click(btn); expect(onClick).toHaveBeenCalledTimes(1);
```

This keeps full coverage of the active/inactive/accent-override token mapping AND
makes it a real regression guard, without depending on jsdom's broken `var()` CSSOM.
