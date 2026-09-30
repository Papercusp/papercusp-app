/** Package-owned JS artifacts: plain Node and installed OMP need no TS loader. */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The esbuild options for both native MCP artifacts, reading sources under
 * `root` (a checkout path ending in '/') and writing into `outDir`.
 *
 * Exported so the public PUI packager (apps/tui/scripts/bundle-psu.mjs) builds
 * the SAME two artifacts from a committed generation instead of restating these
 * options (D-031). esbuild is imported only when this file runs as a script, so
 * the packager can load it from an exported source tree with no node_modules.
 */
export function nativeBuilds(root, outDir = root + 'packages/omp-plugin/dist/') {
  const common = { bundle: true, platform: 'node', target: 'node20', packages: 'bundle', logLevel: 'warning' };
  return [
    {
      ...common, entryPoints: [root + 'packages/operator-core/lib/agent-mcp-client.ts'],
      outfile: outDir + 'native-client.cjs', format: 'cjs',
    },
    {
      ...common, entryPoints: [root + 'packages/omp-plugin/src/native-extension.ts'],
      outfile: outDir + 'native-extension.mjs', format: 'esm',
      banner: { js: "import { createRequire as createNativeRequire } from 'node:module'; const require = createNativeRequire(import.meta.url);" },
    },
  ];
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  const { build } = await import('esbuild');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const options of nativeBuilds(root)) await build(options);
}
