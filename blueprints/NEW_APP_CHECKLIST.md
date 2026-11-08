# New App Agent Checklist

Before feature work expands, define:

- Product Chief: one user-facing assistant.
- Specialists: only roles that own real capabilities.
- Capability map: exact tool/API/function each specialist can call.
- Read vs write vs money vs privileged risk.
- Approval boundary for every external effect.
- Evidence source for every external effect.
- Verification/read-back step.
- Idempotency strategy for writes.
- Emergency stop.
- Audit trail.
- Product-isolated auth, secrets, database and memory.
- Demo behavior that is explicitly labeled demo and never presented as LIVE.
- A test proving external actions cannot be marked complete without verified evidence.

UI principle: one prompt to the user; complexity stays behind the product.

Before production traffic, also confirm:

- Accessibility: the single prompt is keyboard operable, named, and readable in high contrast. Errors are text, not color alone.
- Kernel safety: gated risks are not auto-allowed. Money and privileged actions have `externalEffect` or an action contract.
- Keyword matching: the default is `token`. Set `substring` only when a keyword is intentionally a fragment.
- Evidence: the default is `all_verified`. A failed read-back vetoes completion.
- Action contracts: every real capability has a risk and an external-effect flag. Do not let the model invent a lower risk.
- Durability: pass durable `StopSwitch`, `AuditLog`, and `IdempotencyStore` adapters. The bundled memory adapters are the single-process reference, not the production store.
- Idempotency: external writes pass `idempotencyKey` into a store whose `putIfAbsent` is backed by a uniqueness constraint.
- Audit text: product-specific private phrases are covered with the `redact` adapter. Built-in redaction covers credentials, emails, phone numbers, and card numbers.
- Demo: demo mode is labeled demo and cannot mark external work complete.
