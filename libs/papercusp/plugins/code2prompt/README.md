# @papercupai/code2prompt

Diff-aware reviewer prompts via the [code2prompt](https://github.com/mufeedvh/code2prompt) Rust CLI.

This is a **first-party Papercusp tool plugin**. Two functions (`diff` and `pack`) projected onto HTTP + MCP transports.

## Why this exists

Repomix gives you "the whole project as one document." That's right when you want broad context. The reviewer role usually wants something narrower: **what changed since the last accepted feature**, plus a specific prompt template (code review, security audit, refactor planning).

`code2prompt.diff` produces exactly that: git diff output plus a templated header, ready to feed to a reviewing model.

| Tool | When to use |
|---|---|
| `repomix.pack` | "Give me the project so I can answer a one-shot question" |
| `code2prompt.diff` | "Review what changed since `<base>`" |
| `code2prompt.pack` | "Build a structured prompt over the project" (templated, not raw) |

## Prerequisites

Install the code2prompt binary:

```bash
cargo install code2prompt
```

The plugin checks for it on PATH and surfaces a clear error if missing. Override the binary name in per-harness config if you installed under a different name.

## Templates

Three built-in templates are prepended to the diff/pack output:

| Template | Header |
|---|---|
| `code-review` | "Review the following diff for correctness, clarity, and maintainability…" |
| `security-audit` | "Audit the following code for security vulnerabilities…" |
| `refactor-prep` | "Analyze the following code and produce a refactor plan…" |
| `none` | (no header — raw diff/pack output) |

`diff` defaults to `code-review`; `pack` defaults to `none`.

## Usage

### Reviewer agent (MCP)

```json
{
  "tool": "code2prompt.diff",
  "input": {
    "base": "abc123def4",
    "template": "code-review",
    "format": "markdown"
  }
}
```

If `base` is omitted, falls back to the per-harness `defaultBase` config (default `main`). The orchestrator typically passes `harness.last_accepted_feature_sha` for "review what changed since the last accepted feature."

### Architect/debugger via curl

```bash
curl -X POST http://localhost:3070/api/plugins/code2prompt/diff \
  -H "content-type: application/json" \
  -H "x-papercusp-workspace: default" \
  -H "x-papercusp-harness: sheets" \
  -H "x-papercusp-role: architect" \
  -H "x-papercusp-run: <runId>" \
  -H "x-papercusp-spawn: <spawnId>" \
  -d '{"base":"main","template":"refactor-prep"}'
```

## Per-role quotas

| Tool | Role | Quota |
|---|---|---|
| `diff` | reviewer | 5 / run |
| `diff` | architect | 3 / run |
| `diff` | debugger | 5 / run |
| `pack` | reviewer | 3 / run |
| `pack` | architect | 5 / run |

Workers and validators don't have access; they shouldn't be reviewing/refactoring.

## Configuration

Per-harness settings at `<stateDir>/plugins/@papercupai_code2prompt/config.json`:

```json
{
  "binary": "code2prompt",
  "defaultBase": "main",
  "inlineThresholdChars": 50000
}
```

## Output policy

Same hybrid as Repomix:
- **<50,000 chars (configurable):** returned inline as text content
- **≥50,000 chars:** written to `<stateDir>/scratch/code2prompt-{diff,pack}-<sha>-<ts>.{md,xml}`, metadata returned

Diff outputs are usually small enough to inline; full project packs may overflow.
