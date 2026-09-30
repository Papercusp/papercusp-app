/**
 * Multi-template composition semantics (plan app-templates-2026-07-04 P-014;
 * owner directive: ONE app = a composition of MANY templates).
 *
 * Two distinct validations:
 *
 * - `validateTemplateSet(entries)` — REGISTRY-level anti-rot over the whole
 *   template set (the analog of validateCatalog for components): every entry
 *   parses, ids are unique, and every composesWith reference resolves within
 *   the set. Dangling refs are how a registry rots.
 *
 * - `composeTemplates(templates)` — resolve ONE app's chosen template
 *   selection into a `TemplateComposition`. This is the machine half of the
 *   composition rules the design doc states (§Composition):
 *     · exactly ONE ROOT scope:'app' template per composition (two whole-app
 *       scaffolds cannot both own an app). P-022: an app template MAY require
 *       another app template as its BASE — a required base app joins the
 *       composition without owning it; only an app no other app in the
 *       selection requires is a root, and there must be exactly one. (No
 *       REFERENCE pair uses this today: the one that did was retired when the
 *       four app roots collapsed into papercusp-app, whose `agents` decision
 *       point layers the judgment plane as an ASPECT instead. The rule stays —
 *       it is what makes a base app expressible at all.);
 *     · component pins must be CONSISTENT — the same catalog component pinned
 *       at two different versions across the selection is a conflict, never
 *       silently resolved;
 *     · everything composes ADDITIVELY as a tagged union — components are
 *       deduped, while blueprints/contracts/decisionPoints/checks keep their
 *       source template id. **The checks union is the load-bearing rule: an
 *       app built from N templates must pass ALL N templates' checks.**
 *
 * v1 scope (owner decision): schema support + these semantics + manual
 * composition documented in each GUIDE. Automated composition TOOLING (the
 * materializer walking composesWith, prompting per decision point) is v1.1 —
 * this module stays pure so that tooling can sit on top of it unchanged.
 * `composesWith` is a design-affinity declaration, not a dependency edge: a
 * composition may include templates that never name each other.
 */
import type {
  TemplateCheck,
  TemplateComponentRef,
  TemplateDecisionPoint,
  TemplateManifest,
  TemplateMust,
  TemplateScope,
} from "./template-manifest.js";
import {
  isOptionalSelect,
  selectingDecisionPoints,
  validateTemplateManifest,
} from "./template-manifest.js";

/** An item of the additive union, tagged with the template that contributed it. */
export interface ComposedFrom<T> {
  templateId: string;
  item: T;
}

/** The resolved result of composing one selection of templates. */
export interface TemplateComposition {
  /** Template ids in the composition, in input order. */
  templateIds: string[];
  /** 'app' when the selection contains an app-scope template, else 'aspect'. */
  scope: TemplateScope;
  /**
   * The ROOT app-scope template when present — the one app no other app in
   * the selection requires (P-022: a required BASE app is a member but never
   * the owner).
   */
  appTemplateId?: string;
  /** Deduped union of component refs (pins verified consistent across the set). */
  components: TemplateComponentRef[];
  /** Additive union — each entry keeps its source template. */
  blueprints: ComposedFrom<string>[];
  contracts: ComposedFrom<string>[];
  decisionPoints: ComposedFrom<TemplateDecisionPoint>[];
  /**
   * THE union-of-checks: an app built from this composition is done only when
   * every entry here is green. Check ids are unique per-template, not
   * per-composition — key by (templateId, check.id).
   */
  checks: ComposedFrom<TemplateCheck>[];
  /** Additive union of structured MUSTs (P-002) — each keeps its source template. */
  musts: ComposedFrom<TemplateMust>[];
}

/**
 * Registry-level validation of a whole template set: every entry validates as
 * a TemplateManifest, ids are unique, and every composesWith reference
 * resolves to a template id in the set. Returns EVERY problem.
 *
 * `allowExternalComposesWith` relaxes ONLY the composesWith-resolution leg,
 * for validating a materialized app's CHOSEN subset (WI-2881): composesWith
 * is descriptive affinity — an aspect legitimately names apps the chosen set
 * does not include (e.g. the data/ui aspects name papercusp-tauri-desktop-shell inside
 * a web-only composition). Default STRICT is the registry mode, where a
 * dangling ref is rot (a typo'd or deleted template id must fail loudly).
 * `requires` stays a HARD edge in both modes.
 */
export function validateTemplateSet(
  entries: unknown[],
  opts?: { allowExternalComposesWith?: boolean },
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();
  const manifests: TemplateManifest[] = [];
  entries.forEach((e, i) => {
    const v = validateTemplateManifest(e);
    if (!v.ok) {
      errors.push(...v.errors.map((msg) => `entry[${i}]: ${msg}`));
      return;
    }
    const m = e as TemplateManifest;
    if (ids.has(m.id)) errors.push(`entry[${i}]: duplicate template id '${m.id}'`);
    ids.add(m.id);
    manifests.push(m);
  });
  const byId = new Map(manifests.map((m) => [m.id, m]));
  for (const m of manifests) {
    if (!opts?.allowExternalComposesWith) {
      for (const ref of m.composesWith) {
        if (!ids.has(ref)) errors.push(`'${m.id}' composesWith unknown template '${ref}'`);
      }
    }
    // requires is a HARD pinned edge (P-015): the target must exist in the set
    // AND its current version must match the pin — a mismatched pin is rot.
    for (const req of m.requires ?? []) {
      const target = byId.get(req.id);
      if (!target) {
        errors.push(`'${m.id}' requires unknown template '${req.id}'`);
      } else if (target.version !== req.version) {
        errors.push(
          `'${m.id}' requires '${req.id}@${req.version}' but the set has ${target.version} (stale pin — update the requirer or the target)`,
        );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Expand a selection of ROOT templates to its full requires-CLOSURE against a
 * registry (P-015: `requires` is a hard pinned dependency, so composing an
 * app template pulls its requirements in automatically; the checks union then
 * covers the closure). Pure + deterministic: dependencies come before their
 * dependents, each template appears once, root order is otherwise preserved.
 * Errors on an unknown ref, a version-mismatched pin, or a requires cycle.
 */
export function resolveRequiresClosure(
  roots: TemplateManifest[],
  registry: TemplateManifest[],
): { ok: boolean; errors: string[]; templates: TemplateManifest[] } {
  const errors: string[] = [];
  const byId = new Map(registry.map((m) => [m.id, m]));
  for (const r of roots) if (!byId.has(r.id)) byId.set(r.id, r);

  const ordered: TemplateManifest[] = [];
  const done = new Set<string>();
  const inStack = new Set<string>();

  const visit = (m: TemplateManifest, chain: string[]): void => {
    if (done.has(m.id)) return;
    if (inStack.has(m.id)) {
      errors.push(`requires cycle: ${[...chain, m.id].join(" → ")}`);
      return;
    }
    inStack.add(m.id);
    for (const req of m.requires ?? []) {
      const target = byId.get(req.id);
      if (!target) {
        errors.push(`'${m.id}' requires unknown template '${req.id}' (not in the registry)`);
        continue;
      }
      if (target.version !== req.version) {
        errors.push(
          `'${m.id}' requires '${req.id}@${req.version}' but the registry has ${target.version} (stale pin)`,
        );
        continue;
      }
      visit(target, [...chain, m.id]);
    }
    inStack.delete(m.id);
    done.add(m.id);
    ordered.push(m);
  };

  for (const r of roots) visit(r, []);
  return { ok: errors.length === 0, errors, templates: errors.length === 0 ? ordered : [] };
}

/** What one selecting decision point was answered with (D-001). */
export interface ResolvedSelection {
  /** The selecting decision point's id (`target`). */
  decisionPointId: string;
  /** The template that declared it — the same tagging the composition uses. */
  templateId: string;
  /** The chosen option values, in declaration order. */
  values: string[];
}

/**
 * Expand a ROOT plus its ANSWERS into the full template list (D-001).
 *
 * `resolveRequiresClosure` answers "what does this root always pull in";
 * this answers "what does this root pull in GIVEN these choices" — the
 * selecting decision points (`target`, `agents`) are resolved against
 * `answers`, their chosen options' templates join the roots, and the whole set
 * is re-expanded through the same requires closure. Nested selects are
 * followed to a fixpoint: a template pulled in by one answer may itself select.
 *
 * Pure + deterministic, and it never guesses: an unanswered required axis, an
 * unknown option value, or several values on an `arity: 'one'` axis are all
 * errors, because silently defaulting a chassis is exactly the failure the
 * selection mechanism exists to prevent.
 */
export function resolveSelection(
  root: TemplateManifest,
  answers: Record<string, string | readonly string[]>,
  registry: TemplateManifest[],
): { ok: boolean; errors: string[]; templates: TemplateManifest[]; selections: ResolvedSelection[] } {
  const errors: string[] = [];
  const selections: ResolvedSelection[] = [];
  const byId = new Map(registry.map((m) => [m.id, m]));
  if (!byId.has(root.id)) byId.set(root.id, root);

  const roots: TemplateManifest[] = [root];
  const answered = new Set<string>();

  // Fixpoint: each pass expands the closure, resolves any NEWLY visible
  // selecting decision point, and adds what it chose. Bounded by the registry
  // size — every pass that does no work exits.
  for (let pass = 0; pass <= registry.length + 1; pass += 1) {
    const closure = resolveRequiresClosure(roots, [...byId.values()]);
    if (!closure.ok) return { ok: false, errors: [...errors, ...closure.errors], templates: [], selections };

    let grew = false;
    for (const t of closure.templates) {
      for (const dp of selectingDecisionPoints(t)) {
        const key = `${t.id}#${dp.id}`;
        if (answered.has(key)) continue;
        answered.add(key);

        const rawAnswer = answers[dp.id];
        const values = rawAnswer === undefined ? [] : Array.isArray(rawAnswer) ? [...rawAnswer] : [rawAnswer as string];
        const optional = isOptionalSelect(dp.selects);
        const valid = dp.selects.options.map((o) => o.value);

        if (values.length === 0) {
          if (!optional) {
            errors.push(
              `'${t.id}' decision point '${dp.id}' is unanswered — answer one of ${valid.map((v) => `'${v}'`).join(", ")}`,
            );
          }
          continue;
        }
        if ((dp.selects.arity ?? "one") === "one" && values.length > 1) {
          errors.push(
            `'${t.id}' decision point '${dp.id}' has arity 'one' but was answered ${values.map((v) => `'${v}'`).join(", ")}`,
          );
          continue;
        }
        if (new Set(values).size !== values.length) {
          errors.push(`'${t.id}' decision point '${dp.id}': repeated answer in ${values.map((v) => `'${v}'`).join(", ")}`);
          continue;
        }

        const picked: string[] = [];
        for (const value of values) {
          const option = dp.selects.options.find((o) => o.value === value);
          if (!option) {
            errors.push(
              `'${t.id}' decision point '${dp.id}': unknown answer '${value}' — expected one of ${valid.map((v) => `'${v}'`).join(", ")}`,
            );
            continue;
          }
          picked.push(value);
          for (const ref of option.templates) {
            const target = byId.get(ref.id);
            if (!target) {
              errors.push(
                `'${t.id}' decision point '${dp.id}' option '${value}' selects unknown template '${ref.id}' (not in the registry)`,
              );
              continue;
            }
            if (target.version !== ref.version) {
              errors.push(
                `'${t.id}' decision point '${dp.id}' option '${value}' selects '${ref.id}@${ref.version}' but the registry has ${target.version} (stale pin)`,
              );
              continue;
            }
            if (!roots.some((r) => r.id === target.id)) {
              roots.push(target);
              grew = true;
            }
          }
        }
        if (picked.length > 0) selections.push({ decisionPointId: dp.id, templateId: t.id, values: picked });
      }
    }
    if (!grew) break;
  }

  if (errors.length > 0) return { ok: false, errors, templates: [], selections };
  const final = resolveRequiresClosure(roots, [...byId.values()]);
  return {
    ok: final.ok,
    errors: final.errors,
    templates: final.templates,
    selections,
  };
}

/**
 * Resolve one app's template selection into a TemplateComposition.
 * Returns EVERY problem; `composition` is null unless ok.
 */
export function composeTemplates(
  templates: TemplateManifest[],
): { ok: boolean; errors: string[]; composition: TemplateComposition | null } {
  const errors: string[] = [];
  if (templates.length === 0) {
    return { ok: false, errors: ["composition requires at least one template"], composition: null };
  }

  const seen = new Set<string>();
  for (const t of templates) {
    if (seen.has(t.id)) errors.push(`duplicate template '${t.id}' in the composition`);
    seen.add(t.id);
  }

  // P-022: an app template may REQUIRE another app template as its BASE
  // (papercusp-agentic-desktop-app layers onto papercusp-desktop-app). A base app is a member of
  // the composition but never its owner — the single ROOT app (one no other
  // app in the selection requires) owns it. Two independent roots are still
  // the "two whole-app scaffolds cannot both own an app" conflict.
  const appTemplates = templates.filter((t) => t.scope === "app");
  const baseAppIds = new Set<string>();
  for (const t of appTemplates) {
    for (const req of t.requires ?? []) {
      if (appTemplates.some((a) => a.id === req.id)) baseAppIds.add(req.id);
    }
  }
  const rootApps = appTemplates.filter((t) => !baseAppIds.has(t.id));
  if (appTemplates.length > 0 && rootApps.length !== 1) {
    errors.push(
      rootApps.length === 0
        ? `app-scope templates form a requires cycle — no root app among ${appTemplates.map((t) => `'${t.id}'`).join(", ")}`
        : `at most ONE ROOT app-scope template per composition — got ${rootApps.map((t) => `'${t.id}'`).join(", ")} (an app template may only join another's composition as its requires-BASE)`,
    );
  }

  // Closure completeness (P-015): every selected template's `requires` must be
  // satisfied WITHIN the selection, at the pinned version — an app template's
  // hard deps cannot be silently dropped from its composition. (Callers expand
  // a selection first via resolveRequiresClosure.)
  const selected = new Map(templates.map((t) => [t.id, t]));
  for (const t of templates) {
    for (const req of t.requires ?? []) {
      const target = selected.get(req.id);
      if (!target) {
        errors.push(
          `'${t.id}' requires '${req.id}@${req.version}' which is not in the composition — expand via resolveRequiresClosure`,
        );
      } else if (target.version !== req.version) {
        errors.push(
          `'${t.id}' requires '${req.id}@${req.version}' but the composition has ${target.version} (stale pin)`,
        );
      }
    }
  }

  // D-001 SELECTION SATISFACTION — the guard that replaces the hard `requires`
  // pin for an axis whose answer picks the template (chassis, agent plane).
  // Evaluated STRUCTURALLY, with no answers in hand: an option counts as chosen
  // when every template it names is present at its pinned version. That is what
  // makes it enforceable in exactly the places `requires` was — registry
  // validation and composition — which is why a `when:`-style conditional edge
  // was rejected.
  for (const t of templates) {
    for (const dp of selectingDecisionPoints(t)) {
      const chosen = dp.selects.options.filter((o) =>
        o.templates.every((r) => selected.get(r.id)?.version === r.version),
      );
      // An option naming NO templates is vacuously chosen — it is the explicit
      // "none" answer, and its presence is precisely what makes the axis
      // optional. Only NON-empty options evidence a real selection.
      const picked = chosen.filter((o) => o.templates.length > 0);

      // A named template present at the WRONG version reads as "no option
      // satisfied", which would be reported below as if the builder forgot to
      // add it. Say what actually happened instead.
      for (const o of dp.selects.options) {
        for (const r of o.templates) {
          const present = selected.get(r.id);
          if (present && present.version !== r.version) {
            errors.push(
              `'${t.id}' decision point '${dp.id}' option '${o.value}' selects '${r.id}@${r.version}' but the composition has ${present.version} (stale pin)`,
            );
          }
        }
      }

      if (picked.length === 0 && !isOptionalSelect(dp.selects)) {
        errors.push(
          `'${t.id}' decision point '${dp.id}' selects a REQUIRED template axis, but the composition satisfies none of its options (${dp.selects.options
            .map((o) => `'${o.value}'`)
            .join(", ")}) — add the chosen option's templates to the composition`,
        );
      }
      if ((dp.selects.arity ?? "one") === "one" && picked.length > 1) {
        errors.push(
          `'${t.id}' decision point '${dp.id}' has arity 'one' but the composition satisfies ${picked
            .map((o) => `'${o.value}'`)
            .join(", ")} — declare arity 'one-or-more' if answers are meant to combine`,
        );
      }
    }
  }

  // Component pin consistency: same component id at two versions = conflict.
  const pins = new Map<string, { version: string; templateId: string }>();
  const components: TemplateComponentRef[] = [];
  for (const t of templates) {
    for (const ref of t.components) {
      const prior = pins.get(ref.id);
      if (!prior) {
        pins.set(ref.id, { version: ref.version, templateId: t.id });
        components.push({ id: ref.id, version: ref.version });
      } else if (prior.version !== ref.version) {
        errors.push(
          `component pin conflict on '${ref.id}': '${prior.templateId}' pins ${prior.version}, '${t.id}' pins ${ref.version}`,
        );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, composition: null };

  const tag = <T>(templateId: string, items: readonly T[]): ComposedFrom<T>[] =>
    items.map((item) => ({ templateId, item }));

  const composition: TemplateComposition = {
    templateIds: templates.map((t) => t.id),
    scope: appTemplates.length > 0 ? "app" : "aspect",
    ...(appTemplates.length > 0 ? { appTemplateId: rootApps[0]!.id } : {}),
    components,
    blueprints: templates.flatMap((t) => tag(t.id, t.blueprints ?? [])),
    contracts: templates.flatMap((t) => tag(t.id, t.contracts)),
    decisionPoints: templates.flatMap((t) => tag(t.id, t.decisionPoints)),
    checks: templates.flatMap((t) => tag(t.id, t.checks)),
    musts: templates.flatMap((t) => tag(t.id, t.musts ?? [])),
  };
  return { ok: true, errors: [], composition };
}
