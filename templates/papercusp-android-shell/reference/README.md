# Android-shell reference notes

This directory is neutral checked guidance, not a product starter repository.
Papercusp and SideStage remain separate conformance consumers.

`android-shell.checks-config.example.json` demonstrates the complete
`androidShell` section. Replace every illustrative identity, path, command,
permission, and selected capability with the materialization answers. The
assertion commands are deliberately direct argv; a consumer may route them
through its Makefile or repository scripts as long as the stable assertion/leg
coverage and outcomes remain intact.

The example names signing inputs but carries no values. Release keystores,
passwords, aliases, service payloads, and provider credentials are injected
outside the repository. Generated evidence, bindings, native libraries, APKs,
AABs, and Gradle reports are build output, not template source.
