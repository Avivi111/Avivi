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

Valid success paths are unchanged:

- a non-empty goal selects the chief, then specialists whose keywords match
- keyword matching is a case-insensitive substring unless `keywordMatch` is `"token"`
- `read` and `internal_write` may be auto-allowed
- every other risk needs an explicit `approved: true`
- an external effect needs at least one verified evidence item with a source and a parseable `checkedAt`
- approval is checked before evidence

These paths fail closed:

- blank keywords are rejected, because an empty keyword matches every goal
- an unknown agent id is rejected instead of being routed to someone else
- a named agent cannot be assigned a capability it does not own
- `external_write`, `money`, and `privileged` cannot be put in `autoAllow`
- a risk cannot appear in both `autoAllow` and `alwaysRequireApproval`
- a read or internal action flagged `externalEffect` is authorized as an external write
- `external_write` requires evidence even if `externalEffect` was left unset
- verified evidence with a blank source or an unparseable time does not count
- only the boolean `true` counts as approval
- the kernel's copy of the policy is frozen, so mutating the caller's arrays later cannot widen authority
- `mode: "demo"` can exercise the approval and evidence gates, and still cannot return `complete` for external work
- `stop()` blocks new completion until `resume()`
- plan, route, authorize, complete, stop, and resume are written to an in-memory audit log
- goals stored in the audit are truncated and obvious pasted credentials are redacted

Set `evidencePolicy: "all_verified"` when a failed read-back must veto an otherwise verified one. The default remains any verified item.

Set `actionContracts` when a capability's risk and external effect should come from the product, not from the caller. With contracts enabled, every agent capability needs a contract, the caller's risk must match, and a contracted external effect cannot be omitted.

## What hosts still own

The kernel is per process and in memory.

- Persist the audit log. It can contain user goals. Treat it as sensitive. The kernel keeps at most `auditLimit` events (default 1000) and then drops the oldest.
- Persist the emergency stop. `stop()` does not cross processes or restarts.
- Give external writes a uniqueness key in the product database. This kernel does not implement durable idempotency, because a lossy in-memory key would be unsafe for money movement.
- Keep database, auth, secrets, memory, provider tokens, and audit product-specific.
- Set `externalEffect` or an action contract on money and privileged work that leaves the product. An approved money action with no external effect can still complete without provider evidence; that path is only for an internal ledger change.
- Execute the tool only after status `complete`. Calling `complete` again does not mean the side effect was skipped; the kernel never performs it.

## Development

```sh
npm ci
npm run typecheck
npm test
```

`npm test` builds `dist/`, runs the TypeScript tests, and runs the built-package smoke test. CI also runs `npm run audit:deps`.

Node's type stripping is experimental on the test command. The published entry is the built JavaScript.

## License

No license is set. The copyright holder reserves all rights. Do not treat this public repository as open source until a license is added.
