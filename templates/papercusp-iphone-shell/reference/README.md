# iPhone-shell reference notes

This directory is neutral checked guidance, not a product starter repository.
Papercusp and SideStage remain separate conformance consumers.

`iphone-shell.checks-config.example.json` demonstrates the complete
`iphoneShell` section. Replace every illustrative identity, path, command,
privacy declaration, and selected capability with the materialization answers.
The assertion commands are deliberately direct argv; a consumer may route
them through its Makefile or repository scripts as long as stable
assertion/leg coverage and outcomes remain intact.

The example selects local Mac execution and names signing inputs but carries no
values. A Linux consumer may instead choose `remote-host` with a named executor
alias; the config must never embed its username, address, port, key path, or
credential. Team identities, signing certificates, profiles, APNs material,
service credentials, and provider tokens are injected outside the repository.
Generated evidence, projects, bindings, static libraries, XCFrameworks, result
bundles, archives, and exports are build output, not template source.
