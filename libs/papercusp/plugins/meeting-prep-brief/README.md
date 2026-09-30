# Meeting prep brief trigger pack

This first-party starter packages one upcoming-calendar-event trigger and one private briefing
plan. The plan treats the canonical Calendar event as mandatory and Personal Vault context as
optional/default-deny. It delivers through the owner's durable notification surfaces with a stable
dedupe key.

The manifest declares the shared Google Workspace read scopes, canonical `calendar-event` input,
lead-time/style inputs, and a conservative storm policy. Cupboard installation is inert: the
installer connects their own account, reviews the generated binding, and arms it explicitly.
