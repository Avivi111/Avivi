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
