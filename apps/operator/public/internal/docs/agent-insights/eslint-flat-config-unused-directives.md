# ESLint autofix and unused disable directives in Papercusp
URL: /internal/docs/agent-insights/eslint-flat-config-unused-directives

Papercusp's root eslint.config.mjs is a minimal custom-rule flat config, not a recommended ruleset. Broad eslint --fix runs may correctly strip stale disable comments for rules such as no-console that are not active; check the config before treating that diff as a regression.

## The Trap

The root `eslint.config.mjs` is intentionally small. It wires Papercusp's custom
rules and TypeScript parser support, but it does **not** load ESLint recommended
rules, TypeScript recommended rules, or a general `no-console` policy.

That means a broad command such as:

```bash
npx eslint packages/operator-core/lib --fix
```

can remove comments like:

```ts
// eslint-disable-next-line no-console
```

as unused disable directives. In this repository, that can be a correct autofix:
the disabled rule may never have been active for that file.

## What To Do

Before trusting or reverting a large autofix diff, read `eslint.config.mjs` and
identify which rules are actually active for the paths you touched. Treat the
configured `papercusp/*` rules as authoritative; common rules such as
`no-console`, `@typescript-eslint/no-unused-vars`, or
`import/no-relative-packages` may be vestigial disable comments unless a local
config has explicitly enabled them.

If a broad `--fix` run removes many stale disable comments while also fixing the
targeted Papercusp rule you intended to address, do not assume the comment
removal is a behavioral regression. Verify the active rule set first, then keep
the diff scoped to the rule you meant to fix if that is easier to review.

## Why This Was Filed

During the bare `::jsonb` cast cleanup for `EI-6682`, a broad ESLint fix removed
many `no-console` disable comments. That looked like an unrelated regression and
cost a review cycle, but the root cause was the minimal flat config: `no-console`
was not active there, so the disable comments were stale.
