# 14. What Papercusp is NOT
URL: /internal/docs/spec/what-not



Borrowed-discipline-from-Paperclip — what we explicitly refuse to be:

NotWhy

Not opinionated about the org structure of installs"Company with CEO and reports" is one valid shape. Pipelines, swarms, tournaments, single-agent loops are other valid shapes. Plugins decide.
Not a chatbot frameworkRoles have jobs, not chat windows. Conversational interfaces can ship as plugins on top.
Not tied to a specific LLM providerReference runtime uses Claude. Spec is provider-agnostic; adapters can swap.
Not an agent framework in the build-an-agent senseAgents are just role prompts + the harness contract. We don't ship an "agent class hierarchy" — that's per-install.
Not a workflow builder (no DAGs)Orchestrator decisions are dynamic; static DAGs are the failure mode we're avoiding.
Not opinionated about the domainCoding, marketing, research, ops, support — same substrate. The harness contract doesn't care.
