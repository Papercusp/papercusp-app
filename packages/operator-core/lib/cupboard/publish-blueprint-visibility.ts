/**
 * publish-blueprint-visibility.ts — publish-time gate that a blueprint is
 * EXPLICITLY marked for the public Cupboard before it can be listed
 * (cupboard-full-dogfood-2026-07-10 P-002 durable guardrail).
 *
 * The bundled blueprint set mixes user-facing harnesses (coding, research, …)
 * with internal infrastructure, coordination-study arms, learning loops, and
 * benchmarks that must NEVER appear on the public Cupboard. Before this gate
 * there was no code authority for that distinction — `POST /cupboard/publish-
 * blueprint` would list ANY blueprint the operator could resolve, so "which set
 * is public" lived only in an operator's head. Publishing to the public Cupboard
 * is irreversible (an outward-facing listing), so a one-time human judgement is
 * the wrong control: it re-litigates every publish and rots.
 *
 * This gate makes the curation intent a MACHINE-CHECKED, in-repo marker: a
 * blueprint is publishable to the public Cupboard only when its own
 * `blueprint.yaml` declares `visibility: public`. Absent or anything else ⇒
 * INTERNAL — fail-closed, so nothing is published by accident and a typo
 * (`visibility: pubic`) refuses rather than leaks.
 *
 * Pure — it reads the ALREADY-PARSED raw manifest (the publish route parses
 * blueprint.yaml with `parseYaml`, not through `BlueprintSchema`, so an
 * undeclared key survives) — so it is unit-testable without fs/network. Marking
 * the confirmed-public set `visibility: public` in the canonical blueprint.yaml
 * files (the `libs/papercusp` submodule) is the SEPARATE curation step; this file
 * is only the enforcement.
 */

export type BlueprintVisibility = 'public' | 'internal';

export class BlueprintVisibilityError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BlueprintVisibilityError';
  }
}

/**
 * The curation-intent visibility of a raw parsed blueprint manifest. Returns
 * 'public' ONLY for an exact `visibility: 'public'`; absent, non-string, or any
 * other value ⇒ 'internal' (fail-closed — the safe default is never-public).
 */
export function readBlueprintVisibility(manifest: unknown): BlueprintVisibility {
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    if ((manifest as Record<string, unknown>).visibility === 'public') return 'public';
  }
  return 'internal';
}

/**
 * Assert a blueprint is publishable to the PUBLIC Cupboard: its manifest must
 * explicitly declare `visibility: public`. Throws `BlueprintVisibilityError(422)`
 * otherwise — so the publish is refused rather than leaking an internal blueprint
 * (infra / coordination-study arm / learning loop / benchmark) onto the public
 * listing. Returns the resolved visibility ('public') on success.
 */
export function assertBlueprintVisibilityPublishable(id: string, manifest: unknown): BlueprintVisibility {
  const visibility = readBlueprintVisibility(manifest);
  if (visibility !== 'public') {
    throw new BlueprintVisibilityError(
      `blueprint "${id}" is not marked \`visibility: public\` in its blueprint.yaml — ` +
        `publishing to the public Cupboard requires an explicit public marker ` +
        `(an internal or unmarked blueprint is never auto-published)`,
      422,
    );
  }
  return visibility;
}
