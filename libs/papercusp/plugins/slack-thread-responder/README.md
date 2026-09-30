# Slack thread responder trigger pack

This first-party starter packages one Slack mention trigger and one reusable plan target. The
target replies only through `slack:respond-in-thread`, whose server resolves the source, channel,
thread, and credential from the durable trigger run. The workflow can shape response tone, but it
cannot redirect the reply.

The manifest declares the Socket Mode connection scopes (including `chat:write`), canonical
`chat-message` input, bounded storm policy, and snapshot-safe connection semantics. Cupboard
installation only discovers the pack; connection, instantiation, and arming remain explicit.
