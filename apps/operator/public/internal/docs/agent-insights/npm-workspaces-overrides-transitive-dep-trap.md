# npm workspace overrides may not replace a workspace package's transitive dependency
URL: /internal/docs/agent-insights/npm-workspaces-overrides-transitive-dep-trap

A root npm override can leave a dependency nested under a workspace package unchanged. Verify the installed tree instead of trusting package.json; when dedupe is impossible, remove the offending package and port its thin glue against the repository's direct dependency.

## The trap

Do not assume a root `package.json` `overrides` entry has replaced a transitive
dependency used by an npm workspace package. In the Kokoro voice-node work, the
repository already depended on its chosen `@huggingface/transformers` version,
but `kokoro-js@1.2.1` continued to install its own nested
`@huggingface/transformers@3.8.1` and ONNX Runtime stack.

The nested copy was about 706 MB. It survived all of these attempts with npm
11.12.1:

* a nested override under `kokoro-js`,
* a global `@huggingface/transformers` override,
* a `$` reference to the repository's direct dependency,
* deleting the affected `package-lock.json` subtree and `node_modules` before
  reinstalling.

`npm dedupe` was not a usable escape hatch in this checkout because an unrelated
pre-existing `@papercusp/grid-core` resolution conflict stopped the command.
Repeatedly changing override syntax therefore consumed time without changing the
installed graph.

## Diagnose the installed graph, not the manifest

After every dependency-graph change, inspect the result directly:

```sh
npm ls @huggingface/transformers onnxruntime-node --all
du -sh packages/operator-core/node_modules/kokoro-js/node_modules
```

The override has not solved the problem if `npm ls` still shows a private copy
beneath the workspace dependency. A clean-looking root manifest or regenerated
lockfile is not evidence that the nested runtime disappeared.

When testing another override form, change one thing, perform the required clean
install with a writable npm cache, and compare the installed tree. Stop after the
same nested version survives a few structurally distinct forms; the next useful
step is changing the dependency boundary, not inventing more override spellings.

## Durable resolution used here

The offending package contributed only a thin, domain-free layer: text
normalization and phonemization, the voice-style table and Hugging Face voices-bin
loader, and a small `StyleTextToSpeech2Model` wrapper. The durable fix was to drop
`kokoro-js` and port that Apache-2.0-attributed glue into
`voice-node/kokoro/kokoro-tts.ts`, where it consumes the repository's existing
direct transformer/runtime dependencies.

This removes the nested dependency boundary entirely, so npm no longer has a
second transformer/ONNX stack to resolve. Preserve upstream attribution and keep
the port thin. If the glue is domain-independent, follow up by extracting it into
`libs/generic` behind a `configure*()` dependency-injection seam; that follow-up is
tracked separately because it is an architectural move, not part of dependency
deduplication.

## Rule of thumb

Use npm overrides as a request, not proof. The installed dependency tree is the
verdict. If a workspace package keeps a large incompatible private runtime and
dedupe cannot establish one version, prefer removing that package boundary (or
upgrading/forking the package) over carrying two runtimes or repeatedly rewriting
the same root override.
