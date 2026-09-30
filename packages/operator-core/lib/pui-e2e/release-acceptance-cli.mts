/**
 * CLI for the installed-TUI release stage (P-012 / D-018); see
 * apps/tui/scripts/release-acceptance.sh for usage. Exit 0 = accepted,
 * 1 = refused (the acceptance file names every reason), 2 = could not run.
 */
import { runReleaseAcceptance, type RealLeg } from './release-acceptance-run';

const USAGE = `Usage: apps/tui/scripts/release-acceptance.sh --archive <pui-*.tar.gz> --advertise '<platform>:<backend>' ... [options]

  --archive <f>        candidate archive from apps/tui/scripts/package-release.sh
  --advertise <p:b>    a combination this candidate will advertise, e.g. 'Linux x86_64:Claude'
                       (repeatable; names come from apps/tui/PUBLIC_RELEASE_UX.md)
  --real <b>[:<model>] add a real-engine leg (claude | codex | omp). Pin the model
                       (D-012); omit it only for omp under PUI_REAL_ACCOUNT=auto (D-013)
  PUI_REAL_ACCOUNT=auto requires PUI_NATIVE_ACCOUNT_CATALOG=<absolute-json-path> before any
                       installed tests run. Supply a current accounts:list snapshot
                       containing accounts with id/provider metadata only.
  --test-filter <re>   vitest -t pattern (partial runs; a release leaves it unset)
  --out <f>            verdict file (default <archive>.acceptance.json)
  --work <dir>         scratch directory (default a fresh temp dir)

Prints one line \`PUI_RELEASE_ACCEPTANCE {json}\`.`;

const args = process.argv.slice(2);
const options: Parameters<typeof runReleaseAcceptance>[0] = { archive: '', advertise: [], real: [] };
for (let i = 0; i < args.length; i++) {
  const [flag, inline] = args[i].split(/=(.*)/s, 2);
  const value = () => inline ?? args[++i] ?? '';
  switch (flag) {
    case '--archive': options.archive = value(); break;
    case '--advertise': {
      const cell = value();
      const at = cell.lastIndexOf(':');
      options.advertise.push({ platform: cell.slice(0, at), backend: cell.slice(at + 1) });
      break;
    }
    case '--real': {
      const [backend, model] = value().split(':', 2);
      options.real!.push({ backend, ...(model ? { model } : {}) } satisfies RealLeg);
      break;
    }
    case '--test-filter': options.testFilter = value(); break;
    case '--out': options.out = value(); break;
    case '--work': options.work = value(); break;
    case '-h': case '--help': console.log(USAGE); process.exit(0);
    default: console.error(`unknown argument: ${args[i]}\n\n${USAGE}`); process.exit(2);
  }
}
if (!options.archive) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const { verdict, out, legs } = await runReleaseAcceptance(options);
  console.log(`PUI_RELEASE_ACCEPTANCE ${JSON.stringify({
    ok: verdict.ok, out, archiveSha256: verdict.candidate.archiveSha256, legs, refusals: verdict.refusals,
  })}`);
  process.exit(verdict.ok ? 0 : 1);
} catch (error) {
  console.error(`release-acceptance: ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
