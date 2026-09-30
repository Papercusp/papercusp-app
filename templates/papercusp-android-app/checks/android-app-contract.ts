import {
  COMPONENT_CATALOG,
  composeTemplates,
  validateTemplateAgainstCatalog,
  validateTemplateSet,
  type TemplateManifest,
} from "@papercusp/template-kit";

export const ANDROID_APP_TEMPLATE_ID = "papercusp-android-app";
export const ANDROID_APP_REQUIRED_TEMPLATES = [
  {
    id: ANDROID_APP_TEMPLATE_ID,
    version: "0.1.0",
    scope: "app",
    category: "app",
  },
  {
    id: "papercusp-mobile-base",
    version: "0.1.0",
    scope: "aspect",
    category: "shell",
  },
  {
    id: "papercusp-android-shell",
    version: "0.1.0",
    scope: "aspect",
    category: "shell",
  },
] as const;

const sorted = (values: readonly string[]): string[] => [...values].sort();
const sameStrings = (
  actual: readonly string[],
  expected: readonly string[],
): boolean =>
  JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function expectedDecisionPointAnswerKeys(
  manifests: readonly TemplateManifest[],
): string[] {
  return sorted(
    manifests.flatMap((manifest) =>
      manifest.decisionPoints.map(
        (decision) => `${manifest.id}:${decision.id}`,
      ),
    ),
  );
}

export function validateAndroidAppComposition(
  manifests: readonly TemplateManifest[],
): string[] {
  const errors: string[] = [];
  const ids = manifests.map((manifest) => manifest.id);
  const expectedIds = ANDROID_APP_REQUIRED_TEMPLATES.map((entry) => entry.id);
  if (!sameStrings(ids, expectedIds)) {
    errors.push(
      `composition.templateYamls: must resolve exactly ${expectedIds.join(", ")}`,
    );
  }

  const byId = new Map<string, TemplateManifest>();
  for (const manifest of manifests) {
    if (byId.has(manifest.id)) {
      errors.push(
        `composition.templateYamls: duplicate template '${manifest.id}'`,
      );
    }
    byId.set(manifest.id, manifest);
    const against = validateTemplateAgainstCatalog(manifest, COMPONENT_CATALOG);
    errors.push(...against.errors.map((error) => `${manifest.id}: ${error}`));
  }

  for (const expected of ANDROID_APP_REQUIRED_TEMPLATES) {
    const manifest = byId.get(expected.id);
    if (!manifest) continue;
    if (manifest.version !== expected.version) {
      errors.push(`${expected.id}: required exact version ${expected.version}`);
    }
    if (manifest.scope !== expected.scope) {
      errors.push(`${expected.id}: required scope ${expected.scope}`);
    }
    if (manifest.category !== expected.category) {
      errors.push(`${expected.id}: required category ${expected.category}`);
    }
  }

  const root = byId.get(ANDROID_APP_TEMPLATE_ID);
  const expectedRequires = ANDROID_APP_REQUIRED_TEMPLATES.slice(1).map(
    ({ id, version }) => `${id}@${version}`,
  );
  if (root) {
    const actualRequires = (root.requires ?? []).map(
      ({ id, version }) => `${id}@${version}`,
    );
    if (!sameStrings(actualRequires, expectedRequires)) {
      errors.push(
        `${ANDROID_APP_TEMPLATE_ID}.requires: must be exactly ${expectedRequires.join(", ")}`,
      );
    }
    if (root.components.length !== 0 || root.contracts.length !== 0) {
      errors.push(
        `${ANDROID_APP_TEMPLATE_ID}: thin app root must own no components or contracts`,
      );
    }
  }

  const set = validateTemplateSet([...manifests]);
  errors.push(...set.errors.map((error) => `template set: ${error}`));

  if (errors.length === 0) {
    const result = composeTemplates([...manifests]);
    errors.push(...result.errors.map((error) => `composition: ${error}`));
    if (result.composition) {
      if (result.composition.appTemplateId !== ANDROID_APP_TEMPLATE_ID) {
        errors.push(`composition: root app must be ${ANDROID_APP_TEMPLATE_ID}`);
      }
      const expectedChecks = sorted(
        manifests.flatMap((manifest) =>
          manifest.checks.map((check) => `${manifest.id}:${check.id}`),
        ),
      );
      const actualChecks = sorted(
        result.composition.checks.map(
          (check) => `${check.templateId}:${check.item.id}`,
        ),
      );
      if (!sameStrings(actualChecks, expectedChecks)) {
        errors.push("composition: additive check union is incomplete");
      }
    }
  }

  return errors;
}

// A decision point is satisfied by an ANSWER, not by a token that stands in
// for one. "unknown" / "TBD" / "n/a" are exactly what a hurried builder writes,
// and a non-empty-string rule accepts every one of them — so the answer record
// reads GREEN while nothing was actually decided.
const PLACEHOLDER_ANSWERS: ReadonlySet<string> = new Set([
  "fixme",
  "n/a",
  "na",
  "nil",
  "none",
  "null",
  "pending",
  "placeholder",
  "tba",
  "tbc",
  "tbd",
  "tk",
  "to be decided",
  "to be determined",
  "todo",
  "unanswered",
  "undecided",
  "unknown",
  "unspecified",
  "xxx",
]);

export function isPlaceholderAnswer(answer: string): boolean {
  const trimmed = answer.trim();
  // No letter or digit anywhere ("-", "???", "…") is never an answer.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) {
    return true;
  }
  const normalized = trimmed
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/[\s._/\\-]+/gu, " ")
    .trim();
  return (
    PLACEHOLDER_ANSWERS.has(normalized) ||
    PLACEHOLDER_ANSWERS.has(normalized.replace(/\s+/gu, ""))
  );
}

export function validateDecisionPointAnswers(
  manifests: readonly TemplateManifest[],
  value: unknown,
): string[] {
  if (!isRecord(value)) {
    return ["composition.decisionPointAnswers: required object"];
  }
  const errors: string[] = [];
  const expected = expectedDecisionPointAnswerKeys(manifests);
  const expectedSet = new Set(expected);
  for (const key of expected) {
    const answer = value[key];
    if (typeof answer !== "string" || answer.trim() === "") {
      errors.push(
        `composition.decisionPointAnswers.${key}: required non-empty answer`,
      );
    } else if (isPlaceholderAnswer(answer)) {
      errors.push(
        `composition.decisionPointAnswers.${key}: placeholder answer "${answer.trim()}" does not decide this point`,
      );
    }
  }
  for (const key of Object.keys(value).sort()) {
    if (!expectedSet.has(key)) {
      errors.push(
        `composition.decisionPointAnswers.${key}: unknown decision point`,
      );
    }
  }
  return errors;
}
