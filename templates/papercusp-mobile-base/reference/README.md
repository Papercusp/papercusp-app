# Mobile-base reference notes

This directory is neutral checked guidance, not a product starter repository.
Papercusp and SideStage remain separate conformance consumers.

`mobile-base.checks-config.example.json` demonstrates the complete typed
`mobileBase` section. A builder must replace every illustrative identity and
path with its app's recorded decision-point answers. The config carries names,
paths, and direct command argv only; it must never carry signing, service, or
provider secret values.

`tokens.example.json` demonstrates the neutral three-layer token shape. A
consumer owns the actual values, typography, assets, and brand vocabulary but
keeps deterministic Kotlin and Swift generation from one source.
