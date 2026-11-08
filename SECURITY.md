# Security

The Avivi kernel is a decision gate for one product process. It does not authenticate users, store secrets, call providers, or persist data.

## Report a vulnerability

Use GitHub private vulnerability reporting on this repository. Please include a failing test or a minimal configuration that shows the authority or evidence gate accepting work it should block.

Do not open a public issue for an unfixed bypass.

## Invariants that must not weaken

- Gated risks (`external_write`, `money`, `privileged`) cannot be auto-allowed.
- `money` and `privileged` actions cannot complete without `externalEffect` or an action contract that classifies them.
- External effects and `external_write` actions cannot reach status `complete` without usable verified evidence. The default policy requires every supplied evidence item to be verified.
- Demo mode cannot report external actions as live-complete.
- An unknown agent is not silently given the action.
- Policy objects returned by the kernel are frozen copies.
- Emergency stop blocks completion, including replay of an already stored completion.
- Audit records decisions and evidence counts, not evidence payloads. Stored text is truncated. Built-in redaction covers private keys, common tokens, secret assignments, emails, phone numbers, SSNs, and Luhn-valid card numbers. Names and product-specific phrases need the host `redact` function. If that function throws, the text is replaced with `[redaction-failed]` and the original is not stored.

## What this does not protect

A host can ignore a `blocked` or `needs_approval` result and call a provider anyway. The kernel cannot stop that. A host that sees `replayed: true` must skip the provider call. The kernel does not perform it.

The reference stop switch, audit log, and idempotency store are process-local. Production adapters must persist them. The memory idempotency store must not be used for real money movement across processes.

Secret scanning in CI covers private-key headers and a few credential prefixes in tracked files. Enable GitHub secret scanning and push protection on the repository as well. That setting is an owner action. Dependency review runs through `npm audit` in CI.

## Supply chain

CI checks out code with read-only permissions and persistent credentials disabled. GitHub Actions are pinned to commit SHAs. Dependabot tracks npm and Actions weekly. The package is marked private so it is not published by accident.
