/**
 * guide-lint — referential-integrity lint over a template's PROSE
 * (template-prompt-hardening-2026-07-05 P-001).
 *
 * The kit validates template.yaml rigorously but historically treated
 * GUIDE.md / README prose as opaque text — and every major gap the greenfield
 * build rounds produced lived exactly there: a GUIDE telling the builder to
 * "copy the reference `main.rs` shape" when reference/ shipped no main.rs
 * (WI-2888), and a GUIDE naming `@papercusp/hive-app-seam` as a MUST
 * component that existed nowhere reachable (WI-2891). This module lints the
 * prose the way the manifest is linted: every load-bearing reference must
 * resolve.
 *
 * What counts as a reference (INLINE code spans only — fenced code blocks are
 * stripped first, since they quote illustrative code, not contracts):
 *   - `reference/…` `checks/…` `blueprints/…` `contracts/…` — a template-
 *     relative file or dir that must exist in the template's file list.
 *   - `@papercusp/<id>` — a package/component name that must resolve to a
 *     known component id (catalog) or an allowed infra package.
 *   - `papercusp-<id>` — a template id that must be in the known template set.
 *   - `agent-insights/<slug>` — a docs page that must be DECLARED in the
 *     template.yaml `docs:` list (prose and manifest stay in sync — the docs
 *     list is the consultation contract the materializer surfaces).
 *
 * Pure + zero-dep like the rest of the kit: the caller walks the filesystem
 * and passes the file list + prose contents (templates-dir.test.ts does this
 * for the real templates/ dir, which is what makes this anti-rot: a PR that
 * deletes a referenced file or renames a template fails the suite).
 */
import type { TemplateManifest } from "./template-manifest.js";

/** One prose file to lint, path template-relative (e.g. "GUIDE.md"). */
export interface TemplateProseFile {
  path: string;
  content: string;
}

export interface TemplateProseLintInput {
  manifest: TemplateManifest;
  /** Template-relative paths of every file that exists in the template dir. */
  files: string[];
  /** The prose to lint (GUIDE.md, reference/README.md, checks/README.md, …). */
  prose: TemplateProseFile[];
  /** Known component ids (COMPONENT_CATALOG) — targets of `@papercusp/<id>`. */
  knownComponentIds: string[];
  /** Every template id in the set — targets of `papercusp-<id>` mentions. */
  knownTemplateIds: string[];
  /**
   * Non-component `@papercusp/*` packages prose may legitimately name
   * (e.g. "template-kit"). Kept explicit so a typo'd component never hides
   * behind a broad allowlist.
   */
  allowedPackages?: string[];
}

/** Subdirs whose mention in prose is a file-existence contract. */
const FILE_REF_ROOTS = ["reference", "checks", "blueprints", "contracts"] as const;

const PACKAGE_REF = /^@papercusp\/([a-z0-9][a-z0-9-]*)(\/[^\s`]*)?$/;
const TEMPLATE_REF = /^papercusp-[a-z0-9-]+$/;
const DOC_REF = /^agent-insights\/[a-z0-9-]+$/;

/** Strip fenced code blocks (``` … ```) — they quote code, not contracts. */
function stripFences(markdown: string): string {
  return markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
}

/** Every inline code span (single-backtick, no newline inside). */
function inlineSpans(markdown: string): string[] {
  const spans: string[] = [];
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) spans.push(m[1]!.trim());
  return spans;
}

function isFileRef(span: string): boolean {
  if (span.includes(" ") || span.includes("\\")) return false;
  const root = span.split("/", 1)[0]!;
  return span.includes("/") || span.endsWith("/")
    ? (FILE_REF_ROOTS as readonly string[]).includes(root.replace(/\/$/, ""))
    : (FILE_REF_ROOTS as readonly string[]).includes(span);
}

/** A file ref resolves if it names an existing file, a dir prefix, or a glob with ≥1 match. */
function fileRefResolves(span: string, files: string[]): boolean {
  const clean = span.replace(/\/$/, "");
  if (clean.includes("*")) {
    const prefix = clean.slice(0, clean.indexOf("*"));
    return files.some((f) => f.startsWith(prefix));
  }
  return files.some((f) => f === clean || f.startsWith(`${clean}/`));
}

/**
 * Lint a template's prose files against its manifest + file list + the known
 * component/template universe. Returns EVERY problem (never throws), in
 * `path: kind '<span>' problem` form — the same loud-and-complete contract as
 * the manifest validators.
 */
export function lintTemplateProse(input: TemplateProseLintInput): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const components = new Set(input.knownComponentIds);
  const templates = new Set(input.knownTemplateIds);
  const packagesAllowed = new Set(input.allowedPackages ?? []);
  const declaredDocs = new Set(input.manifest.docs ?? []);

  for (const { path, content } of input.prose) {
    const seen = new Set<string>(); // report each dangling span once per file
    for (const span of inlineSpans(stripFences(content))) {
      if (seen.has(span)) continue;

      if (isFileRef(span)) {
        if (!fileRefResolves(span, input.files)) {
          errors.push(`${path}: file ref '${span}' does not exist in the template`);
          seen.add(span);
        }
        continue;
      }

      const pkg = PACKAGE_REF.exec(span);
      if (pkg) {
        const id = pkg[1]!;
        if (!components.has(id) && !packagesAllowed.has(id)) {
          errors.push(
            `${path}: component ref '@papercusp/${id}' resolves to no catalog component (WI-2891 class — a MUST naming a phantom component)`,
          );
          seen.add(span);
        }
        continue;
      }

      if (TEMPLATE_REF.test(span)) {
        if (!templates.has(span)) {
          errors.push(`${path}: template ref '${span}' is not a known template id`);
          seen.add(span);
        }
        continue;
      }

      if (DOC_REF.test(span)) {
        if (!declaredDocs.has(span)) {
          errors.push(
            `${path}: doc ref '${span}' is not declared in template.yaml docs: — prose and the consultation contract must not diverge`,
          );
          seen.add(span);
        }
        continue;
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
