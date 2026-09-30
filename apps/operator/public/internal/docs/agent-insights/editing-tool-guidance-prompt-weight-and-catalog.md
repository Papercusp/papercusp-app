# Editing a tool's description or guidance: the 2× weight rule and the catalog follow-on
URL: /internal/docs/agent-insights/editing-tool-guidance-prompt-weight-and-catalog

Editing a tool's guidance costs 2x its characters only when the tool declares no explicit description; it also makes the tool catalog stale. Measure before and after, and regenerate.

CLAUDE.md warns that nearly every prompt-weight gate red comes from *growing* an existing tool's `description`/`guidance` rather than from adding a new tool. This is the arithmetic behind that warning, plus the follow-on step the edit silently requires.

## The 2× rule is conditional — and the condition is easy to miss

A guidance edit costs **twice** the characters you type **only when the tool declares no explicit `description` field**. In that case the projection composes one:

```text
"When to use: {when}\n\nWhen NOT to use: {notWhen}\n\nChaining: {chaining}"
```

so every guidance character is counted twice — once in its own field, once inside the composed description. A tool that declares its own `description` counts its guidance once.

Measured 2026-09-02, three independent confirmations:

| tool           | explicit `description`? | total | breakdown                                               |
| -------------- | ----------------------- | ----- | ------------------------------------------------------- |
| `harness:list` | no                      | 1016  | description 530 · when 273 · notWhen 123 · chaining 90  |
| `docs:search`  | yes                     | 1238  | description 402 · when 192 · notWhen 194 · chaining 450 |

For `harness:list`, 530 ≈ 486 (the guidance sum) plus the label prefixes — description *is* the composition. For `docs:search`, 402 bears no relation to the 836 guidance sum — it is the tool's own field.

The third confirmation is the generated diff: after a single guidance edit, `.papercusp/tool-catalog.json` changes **2 lines** for a composed-description tool (the field *and* the description) but **1 line** for an explicit-description tool.

## Do not reason about which case applies — measure

```bash
npm run tool-weight -- <tool>     # seconds, no pc-heavy queue; prints the per-field split
```

Run it **before and after** the edit. Budget is 1500 chars, hard cap 1600.

Guessing is costly in both directions. Assume 2× on an explicit-description tool and you over-estimate, which can deter a clarification that was affordable. Assume 1× on a composed one and you under-estimate, which can breach the gate — and a prompt-weight red freezes the shared fleet gate hours later, far from the edit that caused it.

The per-field split also tells you *what* to trim. `chaining` is routinely the heavy field (450 of `docs:search`'s 1238), which is why CLAUDE.md points there rather than at `description` — for a composed-description tool, description has no independent content of its own.

## Leave headroom for the next editor

Passing the gate is not the whole bar. A first draft that lands at 1411/1500 leaves 89 chars for everyone after you. Prefer saying the same thing in fewer characters: tightening one clarification from 173 to 99 chars moved `docs:search` from 89 to 162 chars of headroom with no loss of meaning.

## The follow-on the edit does not run

Editing any tool's description or guidance makes `.papercusp/tool-catalog.json` **stale**:

```bash
npm run gen:tool-catalog
```

`gen:tool-catalog:check` is in the affected-guard set for tool edits, so skipping this fails the gate. Confirm the diff is scoped to the tool you touched — a 2-line (or 1-line) diff naming only your tool is what correct looks like.

⚠ Read the check's own pass/fail line, not a piped exit code. Piping the check into `tail` reports **tail's** status, so a stale catalog can print a zero exit directly beneath a failure mark. Use the first element of PIPESTATUS, or redirect to a file and read it separately.

## Where the clarification goes

Per repo convention, per-tool when/not-when belongs on the tool, cross-tool patterns in `<role>.tools.md`, behavior rules in `<role>.persona.md`.

A useful pattern for "an agent invented an argument": say what does *not* exist **and** hand over the route that does. The clarification added to `docs:search` reads:

```text
No `section` filter here (docs:outline has one) — scope via docs:outline { section } then docs:get.
```

That names the asymmetry so the argument is not re-invented, and gives the working alternative rather than only a refusal. Naming the invented argument verbatim is deliberate: the next agent who greps for it now finds the answer instead of nothing.

## ⚠ Writing this doc broke the docs build — MDX evaluates braces

The first version of this page quoted that clarification inline, with escaped backticks nested inside a backtick span. Markdown ends an inline code span at the **first** backtick, so the nesting failed and the braces were exposed to MDX, which evaluates `{ ... }` as a JSX expression:

```text
[ERROR] ReferenceError: section is not defined
[ERROR] [build] Caught error rendering /llms-full.txt: ReferenceError: section is not defined
```

That aborts the **entire** corpus build — every agent's `docs:rebuild`, not just yours — and the failure surfaces far from its cause, during static route generation.

Two rules follow. Quote any argument-shaped text containing braces in a **fenced** block, which is fully literal, rather than an inline span with nested backticks. And when a build fails, do not pipe it through `tail`: that discards the real error and leaves only npm boilerplate. Redirect to a file you own and read it.
