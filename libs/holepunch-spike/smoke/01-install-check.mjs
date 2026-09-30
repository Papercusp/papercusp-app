/**
 * smoke:install — verify each Holepunch package loads on this runtime.
 *
 * Pass = every import resolves and exposes its expected default export.
 * Fail = any import throws (missing prebuild, native compile error, ABI mismatch).
 */

const targets = [
  ['hyperswarm', 'Hyperswarm'],
  ['hyperdht', 'HyperDHT'],
  ['hypercore', 'Hypercore'],
  ['hyperbee', 'Hyperbee'],
  ['autobase', 'Autobase'],
  ['corestore', 'Corestore'],
  ['hyperdrive', 'Hyperdrive'],
  ['b4a', 'b4a'],
];

let failed = 0;
for (const [pkg, label] of targets) {
  try {
    const mod = await import(pkg);
    const def = mod.default ?? mod;
    const ok = typeof def === 'function' || typeof def === 'object';
    console.log(`${ok ? 'ok  ' : 'WARN'} ${pkg.padEnd(12)} → ${label} (${typeof def})`);
    if (!ok) failed++;
  } catch (err) {
    console.log(`FAIL ${pkg.padEnd(12)} → ${err.message}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} package(s) failed to load. Spike gate: NOT PASSED.`);
  process.exit(1);
}
console.log(`\nAll ${targets.length} packages loaded. smoke:install passed.`);
