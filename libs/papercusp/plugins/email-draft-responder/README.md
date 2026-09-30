# Email draft responder trigger pack

This is the first-party example for the `triggerPack` manifest surface. It packages:

- a graph with one reusable plan target, one Gmail event binding, and no internal edges;
- a nonempty workflow input schema plus the target's canonical `email-message` input schema;
- the inbound-message filter and default storm policy; and
- explicit snapshot-safe OAuth metadata (`secret`, `shareable:false`, `snapshotPolicy:strip`, and scopes).

It is a manifest-only plugin, not a code-tool `kind:"pack"`. Cupboard installation copies it
through the existing plugin installer and invalidates the plugin host so the descriptor becomes
discoverable. Installation never arms any binding; connect/instantiate/arm remain separate steps.
Multi-target packs use additional single-target bindings joined by correlation-preserving
internal-event edges.
