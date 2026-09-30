/** Parse repeated/comma-separated `--files value` and `--files=value` flags. */
export function parseFilesArgs(argv = process.argv.slice(2)) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const raw = arg === '--files'
      ? argv[++i]
      : arg?.startsWith('--files=')
        ? arg.slice('--files='.length)
        : null;
    if (raw == null) continue;
    for (const file of raw.split(',')) {
      const normalized = file.trim().replaceAll('\\', '/').replace(/^\.\//, '');
      if (normalized) out.push(normalized);
    }
  }
  return [...new Set(out)];
}

/** Select exact available basenames requested through `--files`. */
export function selectExplicitBasenames(argv, available) {
  const hasFlag = argv.some((arg) => arg === '--files' || arg.startsWith('--files='));
  if (!hasFlag) return null;
  const requested = parseFilesArgs(argv);
  if (requested.length === 0) throw new Error('--files requires at least one path');
  const known = new Set(available);
  return [...new Set(requested.map((path) => {
    const basename = path.split('/').at(-1);
    if (!basename || !known.has(basename)) {
      throw new Error(`--files path is not a migration artifact in the live SQL directory: ${path}`);
    }
    return basename;
  }))];
}
