# Security

The Avivi kernel is a decision gate for one product process. It does not authenticate users, store secrets, call providers, or persist data.

## Report a vulnerability

Use GitHub private vulnerability reporting on this repository. Please include a failing test or a minimal configuration that shows the authority or evidence gate accepting work it should block.

Do not open a public issue for an unfixed bypass.

## Invariants that must not weaken

- Gated risks (`external_write`, `money`, `privileged`) cannot be auto-allowed.
- External effects and `external_write` actions cannot reach status `complete` without usable verified evidence.
- Demo mode cannot report those actions as live-complete.
- An unknown agent is not silently given the action.
- Policy objects returned by the kernel are frozen copies.
- Emergency stop blocks completion.
- Audit records decisions and evidence counts, not evidence payloads. Goals are truncated and common pasted credentials are redacted. The log can still contain private user text.

## What this does not protect

A host can ignore a `blocked` or `needs_approval` result and call a provider anyway. The kernel cannot stop that. Money movement without `externalEffect` or an action contract is treated as an internal write after approval; hosts must classify provider calls as external.

In-memory stop, audit, and the absence of an idempotency store are not multi-instance controls. Product databases have to provide those before external actions run in production.

Secret scanning in CI covers private-key headers and a few credential prefixes in tracked files. Enable GitHub secret scanning and push protection on the repository as well. Dependency review runs through `npm audit` in CI.

## Supply chain

CI checks out code with read-only permissions and persistent credentials disabled. GitHub Actions are pinned to commit SHAs. Dependabot tracks npm and Actions weekly. The package is marked private so it is not published by accident.
