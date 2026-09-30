/**
 * Judge for `apps/tui/PUBLIC_RELEASE_UX.md`'s composer file/attachment claims.
 *
 * The doc says, at :315-319 and again in the acceptance table at :384:
 *
 * > When the composer is focused, @ opens a project-scoped file/attachment
 * > picker. Every selected attachment is shown above the draft by
 * > project-relative path, kind, and stable reference. Removing an attachment
 * > does not alter the file. Cross-project and unreadable paths are refused
 * > with the reason; PUI never falls back to a similarly named file.
 *
 * # Why this pin exists
 *
 * That paragraph described NOTHING for as long as it has existed. Measured
 * 2026-09-11 over the whole `apps/tui` tree: zero `Char('@')` handlers, zero
 * composer attachment state, zero cross-project refusal logic. The prose was
 * detailed enough — project-relative path, kind, stable reference, refusal
 * with the reason, no similar-name fallback — to read like a description of
 * working code, which is exactly what made it expensive: a doc is a CLAIM
 * about code, never evidence of it.
 *
 * So this file pins the four promises to source, and the sibling `.test.ts`
 * carries fixture controls that MUST fail. Once the live assertion goes green
 * it stops being evidence that the detector works at all — the controls are
 * what keep it falsifiable.
 */

/** Cut a Rust source at its `#[cfg(test)]` module: fixtures are not the claim. */
export function stripRustTests(src: string): string {
  const at = src.indexOf('#[cfg(test)]');
  return at === -1 ? src : src.slice(0, at);
}

/**
 * The body of a top-level `fn`, from its signature to the next column-0 `}`.
 *
 * Deliberately not a brace-counter: Rust format strings carry `{}` pairs, and a
 * counter that has to understand string literals is a second thing to get
 * wrong. A top-level item always closes at column 0.
 */
export function sliceTopLevelFn(src: string, signature: string): string | null {
  const start = src.indexOf(signature);
  if (start === -1) return null;
  const end = src.indexOf('\n}', start);
  return end === -1 ? src.slice(start) : src.slice(start, end + 2);
}

/** The body of a method inside an `impl`, closing at its 4-space `}`. */
export function sliceMethod(src: string, signature: string): string | null {
  const start = src.indexOf(signature);
  if (start === -1) return null;
  const end = src.indexOf('\n    }', start);
  return end === -1 ? src.slice(start) : src.slice(start, end + 6);
}

export interface PickerClaimsInput {
  /** `apps/tui/src/app.rs` */
  appRs: string;
  /** `apps/tui/src/ui.rs` */
  uiRs: string;
  /** `apps/tui/src/file_picker.rs` */
  pickerRs: string;
}

export interface PickerClaimsVerdict {
  ok: boolean;
  violations: string[];
  /** How many `KeyCode::Char('@')` arms exist outside tests. */
  atHandlerCount: number;
}

const FS_MUTATIONS = ['remove_file', 'remove_dir', 'fs::write', 'File::create'];

/** Resolution helpers that would turn a refusal into a same-named substitute. */
const NAME_LOOKUPS = ['read_dir', 'file_name(', 'list_project_files'];

export function judgeComposerPickerClaims(input: PickerClaimsInput): PickerClaimsVerdict {
  const violations: string[] = [];
  const appRs = stripRustTests(input.appRs);
  const uiRs = stripRustTests(input.uiRs);
  const pickerRs = stripRustTests(input.pickerRs);

  // ── Claim 1: "@ opens a picker", and only from the composer ───────────────
  const atSites = appRs.match(/KeyCode::Char\('@'\)/g) ?? [];
  if (atSites.length === 0) {
    violations.push(
      "PUBLIC_RELEASE_UX.md:315 promises `@` opens a file picker, but apps/tui has no KeyCode::Char('@') handler.",
    );
  }
  if (!/KeyCode::Char\('@'\)\s*=>\s*self\.open_file_picker\(\)/.test(appRs)) {
    violations.push(
      "The `@` arm must call self.open_file_picker(); no handler wires `@` to the picker.",
    );
  }
  // More than one entry point is how a composer-scoped key silently becomes a
  // global one — the doc scopes it to "when the composer is focused".
  if (atSites.length > 1) {
    violations.push(
      `PUBLIC_RELEASE_UX.md:315 scopes \`@\` to the focused composer, but ${atSites.length} KeyCode::Char('@') handlers exist; a second one is reachable outside the composer.`,
    );
  }

  // ── Claim 2: attachments are shown ABOVE the draft ────────────────────────
  const rowsAt = uiRs.indexOf('app.attachments.rows()');
  // The renderer grew from a single draft Line into one Line per logical draft
  // row. Keep both source shapes recognizable: the claim is about ordering, not
  // about which ratatui collection method happens to render the editor.
  const draftAt = [
    uiRs.indexOf('composer_lines.push(Line::from(Span::styled(ctext'),
    uiRs.indexOf("composer_lines.extend(ctext.split('\\n').enumerate().map("),
  ].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? -1;
  if (rowsAt === -1) {
    violations.push(
      'PUBLIC_RELEASE_UX.md:316 promises every attachment is shown above the draft, but ui.rs never renders app.attachments.rows().',
    );
  } else if (draftAt === -1) {
    violations.push('Could not locate the composer draft row in ui.rs; the above-the-draft claim is unverifiable.');
  } else if (rowsAt > draftAt) {
    violations.push(
      'PUBLIC_RELEASE_UX.md:316 requires attachments ABOVE the draft, but ui.rs pushes them after the draft row.',
    );
  }

  // ── Claim 3: "Removing an attachment does not alter the file" ─────────────
  const remove = sliceMethod(pickerRs, 'pub fn remove(&mut self, reference: &str)');
  if (!remove) {
    violations.push('Attachments::remove is missing; the removal claim has no implementation to pin.');
  } else {
    for (const mutation of FS_MUTATIONS) {
      if (remove.includes(mutation)) {
        violations.push(
          `PUBLIC_RELEASE_UX.md:317 says removing an attachment does not alter the file, but Attachments::remove calls ${mutation}.`,
        );
      }
    }
  }
  for (const mutation of FS_MUTATIONS) {
    if (pickerRs.includes(mutation)) {
      violations.push(
        `The picker module must never write to the filesystem, but it calls ${mutation} outside tests.`,
      );
    }
  }

  // ── Claim 4: refusal with the reason, and NO similar-name fallback ────────
  const attach = sliceTopLevelFn(pickerRs, 'pub fn attach(');
  if (!attach) {
    violations.push('file_picker::attach is missing; the refusal claim has no implementation to pin.');
  } else {
    if (!attach.includes('canonicalize')) {
      violations.push(
        'PUBLIC_RELEASE_UX.md:318 requires cross-project paths to be refused, but attach() never canonicalises — a lexical compare admits `..` traversal.',
      );
    }
    if (!attach.includes('starts_with')) {
      violations.push('attach() never range-checks the candidate against the project root.');
    }
    for (const lookup of NAME_LOOKUPS) {
      if (attach.includes(lookup)) {
        violations.push(
          `PUBLIC_RELEASE_UX.md:319 says PUI never falls back to a similarly named file, but attach() calls ${lookup} — a name lookup can substitute a same-named in-project file for a refused one.`,
        );
      }
    }
  }
  if (!/pub fn reason\(&self\)/.test(pickerRs)) {
    violations.push(
      'PUBLIC_RELEASE_UX.md:318 requires refusals to carry the reason, but Refusal has no reason() accessor.',
    );
  }

  return { ok: violations.length === 0, violations, atHandlerCount: atSites.length };
}
