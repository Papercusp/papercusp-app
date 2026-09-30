/**
 * Copy for the re-embed confirmation dialog.
 *
 * The worker is delta-only: it excludes canonical memories that already have a
 * vector in the target profile, so the confirmation must not imply destructive
 * replacement of existing target vectors.
 */
export function reembedConfirmationBody(to: string): string {
  return (
    `This may take 30s-5min depending on size. Existing "${to}" target vectors are retained and skipped; ` +
    `only memories missing a "${to}" vector are embedded.`
  );
}
