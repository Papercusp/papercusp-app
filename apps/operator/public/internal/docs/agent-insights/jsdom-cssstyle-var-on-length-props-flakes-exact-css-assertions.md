# jsdom drops var() on standard length props — don't exact-match serialized CSS in tests
URL: /internal/docs/agent-insights/jsdom-cssstyle-var-on-length-props-flakes-exact-css-assertions

A component test that asserts `el.style.top === 'var(--x, 0px)'` is flip-flaky: jsdom's cssstyle handles var() on standard length properties (top/left/width…) inconsistently across versions. Assert the intent (substring on the custom-property ref), never the exact serialized string.

## Symptom

A jsdom (`@vitest-environment jsdom`) component test asserts an inline CSS value
exactly:

```ts
expect(banner.style.top).toBe('var(--pc-env-bar-h, 0px)');
```

and fails intermittently with:

```
expected '' to be 'var(--pc-env-bar-h, 0px)'   // Object.is equality
```

It passes in isolation and in the full suite most of the time, then reds — the
classic flip-flaky red-test-watchdog pattern (EI-10456: 15 failures in 6h, green
on re-run).

## Root cause

jsdom serializes/validates inline styles through the `cssstyle` package. For a
**standard length property** (`top`, `left`, `right`, `bottom`, `width`, …) the
setter validates the value. Whether a `var(...)` value is preserved verbatim vs
rejected to `''` depends on the **installed cssstyle version**:

* cssstyle ≥ 6.x (`lib/properties/top.js`): `if (parsers.hasVarFunc(v)) this._setProperty(property, v)` — the var() value is stored verbatim (`var(--pc-env-bar-h, 0px)`). Green.
* Older cssstyle: `top` was validated strictly as a `<length>`, so a `var(...)` value failed validation and was **dropped to `''`**. Red.

Because npm can hoist/resolve a different cssstyle across installs (and the value
is gone from BOTH `el.style.top` *and* `getAttribute('style')` — they share the
setter), an exact-equality assertion on the serialized string is coupled to a
dependency detail the component has no control over. The **component is correct**
— `top: var(--pc-env-bar-h, 0px)` is right for a real browser (it stacks the
banner below the env-switcher bar per EI-9921). Only the *test* was fragile.

> Red herring: the var regexes in cssstyle (`/^var\(/`, `/(?<=[*/\s(])var\(/`)
> are **not** global-flagged, so `hasVarFunc` is stateless — this is NOT a
> stateful-`.test()`/`lastIndex` flip. It's version-dependent validation.

## Fix / rule

When a jsdom test must check a CSS value that may contain `var()` / `calc()` on a
standard property, **assert the intent, not the exact serialized string**:

```ts
// robust to cssstyle serialization variance (whitespace after the comma, etc.)
expect(banner.style.top).toContain('--pc-env-bar-h');
expect(banner.style.top).not.toBe('0px');
```

* Substring-match the custom-property / function reference; don't `toBe(...)` the
  whole serialized value (whitespace after the comma also differs across versions:
  `var(--x, 0px)` vs `var(--x,0px)`).
* If jsdom genuinely can't represent the value (an old cssstyle drops it to `''`),
  that's a *dependency* problem — pin/upgrade cssstyle — not something to paper
  over in the component (never contort correct production CSS to satisfy jsdom).

## See also

* The watchdog-filed bug: EI-10456.
* The behaviour under test: EI-9921 (banner offsets below the env bar via
  `--pc-env-bar-h`).
