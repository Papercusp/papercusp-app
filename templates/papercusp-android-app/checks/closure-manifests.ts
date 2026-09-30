/**
 * Resolve the exact-closure manifests for the app-scope root checks.
 *
 * The shipped `checks/` directory runs in TWO contexts and must behave
 * differently in each:
 *
 *  - IN-REPO (`templates/papercusp-android-app/checks/`): every required
 *    template is a SIBLING directory, so the canonical manifests resolve and
 *    every leg — including the repo-only fixture leg that validates the
 *    committed neutral reference record — runs exactly as authored.
 *
 *  - MATERIALIZED APP: `templates:new-app` overlays ONLY this root directory
 *    into the new app, so there are no template siblings. A repo-only leg has
 *    no subject there and must SKIP with a stated reason rather than crash
 *    with ENOENT (EI-21110451200329856: a shipped `../../papercusp-*` path is
 *    exactly the "private source-tree assumption" these templates promise not
 *    to make).
 *
 * The predicate is deliberately TRI-STATE so the in-repo guarantee is never
 * weakened by this fix:
 *
 *   all siblings present  -> `repo`         (run everything, as today)
 *   no siblings present   -> `materialized` (skip the repo-only leg)
 *   SOME present          -> throw          (genuine repo breakage)
 *
 * A plain "skip when the file is missing" would silently downgrade a deleted
 * canonical manifest into a green run. The partial case therefore stays hard.
 */
import {
  parseTemplateManifest,
  type TemplateManifest,
} from "@papercusp/template-kit";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

export type ClosureContext =
  | { kind: "repo"; manifests: TemplateManifest[] }
  | { kind: "materialized"; manifests: null; reason: string };

const readManifest = (path: string): TemplateManifest =>
  parseTemplateManifest(parse(readFileSync(path, "utf8")));

/**
 * @param rootYamlPath   this root's own `template.yaml` (always present).
 * @param siblingYamlPaths the required dependency manifests as SIBLING paths.
 */
export function resolveSiblingClosure(
  rootYamlPath: string,
  siblingYamlPaths: string[],
): ClosureContext {
  const missing = siblingYamlPaths.filter((path) => !existsSync(path));

  if (missing.length === 0) {
    return {
      kind: "repo",
      manifests: [rootYamlPath, ...siblingYamlPaths].map(readManifest),
    };
  }

  if (missing.length === siblingYamlPaths.length) {
    return {
      kind: "materialized",
      manifests: null,
      reason:
        "no template siblings resolve, so this is a materialized app rather " +
        "than the templates repo. Point composition.templateYamls at the " +
        "retained template-manifests/ via TEMPLATE_CHECKS_CONFIG to run the " +
        "configured closure leg.",
    };
  }

  throw new Error(
    "papercusp-android-app closure is only PARTIALLY resolvable: " +
      `${siblingYamlPaths.length - missing.length} of ${siblingYamlPaths.length} ` +
      `sibling manifests resolved, missing ${missing.join(", ")}. ` +
      "In the templates repo every required manifest must exist; this is a " +
      "repo breakage, not a materialized-app context.",
  );
}
