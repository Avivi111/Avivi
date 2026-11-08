# Avivi

Avivi products give a person one assistant. Behind that assistant, a chief routes the goal to specialists. The user does not pick agents.

This repository is the reference kernel and the checklist for starting a new Avivi app. It is the authority and evidence gate: a goal is not complete because a model said so. External work is complete only after approval, when that approval is required, and after usable verified evidence.

There is no hosted product, account system, database, or user interface in this repository yet.

## Contract

```text
Goal → Chief → specialists → Authority → tool/action → Evidence → Verification → Outcome
```

`blueprints/agent-kernel.ts` implements the decision half of that path. The kernel does not execute tools. A host calls a provider only after `complete` returns status `complete`, then passes the provider read-back back in as evidence.

The operating rule is in [blueprints/AGENT_KERNEL_STANDARD.md](blueprints/AGENT_KERNEL_STANDARD.md). The new-app checklist is in [blueprints/NEW_APP_CHECKLIST.md](blueprints/NEW_APP_CHECKLIST.md).

## Quick start

Node.js 22.18 or newer.

```ts
import { createAgentKernel } from "./blueprints/agent-kernel.ts";

const kernel = createAgentKernel({
  productId: "billing",
  chiefAgentId: "chief",
  agents: [
    { id: "chief", purpose: "Own the user goal", keywords: [], capabilities: ["route"] },
    { id: "support", purpose: "Customer email", keywords: ["email"], capabilities: ["send_email"] },
  ],
  autoAllow: ["read", "internal_write"],
  alwaysRequireApproval: ["external_write", "money", "privileged"],
});

const plan = kernel.plan("Email the customer");
const action = kernel.route({
  id: "act_email",
  title: "Send status email",
  risk: "external_write",
  capability: "send_email",
  externalEffect: true,
});

kernel.complete({ action, approved: true });
// { status: "blocked", reason: "external_effect_requires_verified_evidence" }

kernel.complete({
  action,
  approved: true,
  evidence: [{
    source: "email-provider",
    state: "verified",
    ref: "msg_123",
    checkedAt: new Date().toISOString(),
  }],
});
// { status: "complete", reason: "verified_or_internal" }
```

`npm run build` emits `dist/agent-kernel.js` for a plain Node import. The blueprint file remains the source of truth to copy into a new app.

## Safety invariants

The success path is:

- a non-empty goal selects the chief, then specialists whose keywords match as whole words
- keyword matching is case-insensitive. The default is `token`. Set `keywordMatch: "substring"` to keep the previous rule, where `pay` also matches `payment`
- `read` and `internal_write` may be auto-allowed
- every other risk needs an explicit `approved: true`
- an external effect needs every supplied evidence item to be verified, each with a source and a parseable `checkedAt`. Set `evidencePolicy: "any_verified"` only when an extra unverified note is attached beside one good read-back
- approval is checked before evidence
- `money` and `privileged` actions need `externalEffect: true` or an action contract. A contract is how a product explicitly classifies an internal ledger or privilege change

These paths fail closed:

- blank keywords are rejected, because an empty keyword matches every goal
- an unknown agent id is rejected instead of being routed to someone else
- a named agent cannot be assigned a capability it does not own
- `external_write`, `money`, and `privileged` cannot be put in `autoAllow`
- a risk cannot appear in both `autoAllow` and `alwaysRequireApproval`
- a read or internal action flagged `externalEffect` is authorized as an external write
- `external_write` requires evidence even if `externalEffect` was left unset
- `money` and `privileged` actions with neither `externalEffect` nor a matching action contract return `money_or_privileged_requires_external_effect_or_contract`
- verified evidence with a blank source or an unparseable time does not count
- a failed or unverified evidence item blocks completion under the default `all_verified` policy
- only the boolean `true` counts as approval
- the kernel's copy of the policy is frozen, so mutating the caller's arrays later cannot widen authority
- `mode: "demo"` can exercise the approval and evidence gates, and still cannot return `complete` for external work
- the emergency stop, `stop()`, blocks new completion until `resume()`
- plan, route, authorize, complete, stop, and resume are written to the audit log
- text written to the audit is truncated. Credentials, emails, phone numbers, payment card numbers, SSNs, and secret assignments are redacted. A host `redact` function can cover product-specific private text. If that function throws, the text is dropped

## Defaults changed

Kernels created without an explicit `keywordMatch` now use `token`. Kernels created without an explicit `evidencePolicy` now use `all_verified`. Set the previous values on an existing configuration that depended on them:

```ts
keywordMatch: "substring",
evidencePolicy: "any_verified",
```

`all_verified` is the default because a failed provider read-back means the outcome is not verified. One successful item does not erase a failed one.

## Adapters

Stop, audit, and idempotency are interfaces. `createMemoryStopSwitch`, `createMemoryAuditLog`, and `createMemoryIdempotencyStore` are the reference adapters. They are process-local. Pass durable implementations to `createAgentKernel(config, adapters)` before production traffic. `auditLimit` applies only to the default memory audit log.

```ts
const kernel = createAgentKernel(config, {
  stopSwitch,
  auditLog,
  idempotency,
  redact(text) {
    return text.replaceAll("Project Falcon", "[redacted-private]");
  },
});
```

Pass `idempotencyKey` on `complete` for an external write. A repeat with the same key and the same action returns the stored result with `replayed: true`. The kernel still does not perform the side effect. Skip the provider call when `replayed` is true. A durable store has to implement `putIfAbsent` with a uniqueness constraint. The memory store does not survive a restart.

## What hosts still own

- Replace the memory adapters with durable ones before external actions run in production. Treat the audit log as sensitive.
- Keep database, auth, secrets, memory, provider tokens, and audit product-specific.
- Execute the tool only after status `complete`.
- Choose a license. `LICENSE` is a proposal and an all-rights-reserved placeholder, not a grant.

## Development

```sh
npm ci
npm run typecheck
npm test
```

`npm test` builds `dist/`, runs the TypeScript tests, and runs the built-package smoke test. CI also runs `npm run audit:deps`.

Node's type stripping is experimental on the test command. The published entry is the built JavaScript.

## License

`LICENSE` is a clearly marked proposal for the owner. Until the owner replaces it, all rights are reserved. The file is not an open-source grant and it is not legal advice.
