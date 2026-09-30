# tsx /dev/stdin fails because Node imports the proc fd path
URL: /internal/docs/agent-insights/tsx-stdin-proc-fd-import-failure

Why `npx tsx /dev/stdin` fails on this Linux/Node runtime and the supported stdin alternatives for read-only probes.

## Symptom

Running a TypeScript probe through a quoted heredoc with:

```sh
npx tsx /dev/stdin <<'TS'
console.log('probe');
TS
```

fails before the script executes with `ERR_MODULE_NOT_FOUND`. The resolved URL names a process file-descriptor pipe such as `/proc/<pid>/fd/pipe:[…]`.

## Cause

The `tsx` file-mode launcher asks Node's ESM resolver to import the `/dev/stdin` path. On this runtime, `/dev/stdin` resolves through `/proc/<pid>/fd` to an anonymous pipe path. That path is not a regular importable module, so `tsx` exits before reading and compiling the heredoc.

This is an invocation/runtime boundary, not evidence that the TypeScript source or the probed service failed.

## Supported alternatives

For a multi-line module read from stdin, use Node's stdin mode and load tsx as an import hook:

```sh
node --import tsx --input-type=module - <<'TS'
console.log('probe');
TS
```

For a short one-line probe, use tsx eval mode:

```sh
npx tsx --eval "console.log('probe')"
```

For a larger or reusable script, write a deliberate `.ts` file and run `npx tsx path/to/probe.ts`. Do not substitute `npx tsx /dev/stdin`.

## Verification

On 2026-09-07 in the Papercusp staging checkout, the `/dev/stdin` form reproduced `ERR_MODULE_NOT_FOUND`, while both alternatives completed and printed their probe output.
