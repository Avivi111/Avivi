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
- Kernel safety: gated risks are not auto-allowed. The reference kernel rejects that configuration.
- Keyword matching: set `keywordMatch: "token"` unless a substring keyword is deliberate.
- Action contracts: every real capability has a risk and an external-effect flag. Do not let the model invent a lower risk.
- Durability: emergency stop and audit are stored outside process memory. The reference kernel keeps both in memory only.
- Idempotency: external writes use a uniqueness key in the product database. The reference kernel does not provide durable idempotency.
- Demo: demo mode is labeled demo and cannot mark external work complete.
