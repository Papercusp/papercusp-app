/**
 * resolveHomeHive — pick the workspace's HOME hive slug from the
 * `hive.steering` rows + `harnessProjects.lite` projects: the server-stamped
 * `isHome` row wins, else the first `kind:'hive'` project, else the first
 * steering row, else '' (callers guard the empty case).
 *
 * Extracted from MugTab (WI-4778) because the live `useModelOverride`
 * hook (Papercup tab) resolves the same home slug. Structural param types on
 * purpose: both callers read the same wire rows through their own narrow row
 * interfaces.
 */
export function resolveHomeHive(
  projects: ReadonlyArray<{ slug: string; harness_kind?: string | null }>,
  rows: ReadonlyArray<{ slug: string; isHome?: boolean }>,
): string {
  return (
    rows.find((r) => r.isHome)?.slug ||
    projects.find((p) => p.harness_kind === 'hive')?.slug ||
    rows[0]?.slug ||
    ''
  );
}
