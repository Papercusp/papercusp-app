# A JSX component test's \"React is not defined\" flake: put jsx:react-jsx in the package tsconfig, not only in vitest.config esbuild
URL: /internal/docs/agent-insights/jsx-runtime-belongs-in-package-tsconfig-not-only-vitest-esbuild

Component tests that omit `import React` pass under a package's vitest.config esbuild override but fail intermittently with \"React is not defined\" under any run that uses the base @papercusp/test-config. Fix: add jsx:react-jsx to the package tsconfig so the automatic runtime is config-path-independent.

## Symptom

A React component test flip-flops: it passes when you run it in isolation
(`npx vitest run path/to/Foo.test.tsx` from the package dir), but the Tests tab /
green-checkpoint records intermittent red rows with:

```
Foo > renders …: React is not defined
```

The component and its test both omit `import React` (the repo convention — rely
on the automatic JSX runtime). `test_runs` history shows the same file passing on
some commits and failing on others, `source: local`, with no source change
between them. It is **not** in the flakiness ranking (`testing:flakiness`) because
that ranks pass/fail *flips of the same invocation* — this is two *different*
config paths writing rows for one file.

## Root cause

The shared base config `@papercusp/test-config`'s `defineVitestConfig` sets **no**
`esbuild.jsx`. esbuild's default is the **classic** JSX transform
(`React.createElement`), so a file that never imports React throws
`React is not defined` at render.

A package can override this in its own `vitest.config.ts`:

```ts
export default mergeConfig(defineVitestConfig({ layer: 'unit' }), {
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
});
```

But that override lives in **one config path only**. Any run that transforms the
file under the *base* config instead of the package config gets the classic
transform → red. So the file passes under `npm run test --workspace <pkg>` (uses
the package config) and fails under whatever path used the base config — the
intermittent flake.

## Fix — make the JSX runtime config-path-independent

Vite/esbuild reads `jsx` from the **nearest tsconfig** whenever a run does not
explicitly set `esbuild.jsx`. So put the setting where every path sees it — a
package `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react"
    // …match a sibling UI lib: ui-primitives / dock-workbench
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

Now the automatic runtime applies under the base config *and* the package
override (keep the override as a belt). Prove it before/after by running the file
with the base config directly:

```bash
# a throwaway config that is JUST the base (no override), in the package dir:
#   import { defineVitestConfig } from '@papercusp/test-config';
#   export default defineVitestConfig({ layer: 'unit' });
npx vitest run src/Foo.test.tsx --config that-base.config.ts
```

Before the tsconfig: 4 failed (`React is not defined`). After: 4 passed.

## Generalize

Any package whose `vitest.config.ts` carries an `esbuild: { jsx: 'automatic' }`
override but has **no tsconfig** is exposed to this same class. The override is a
belt; the tsconfig `jsx: react-jsx` is the suspenders that make it survive being
transformed under the base config. (EI-11021, marketplace-public-ui.)
