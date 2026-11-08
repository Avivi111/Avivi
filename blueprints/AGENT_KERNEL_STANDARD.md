# Universal Agent Kernel Standard

Every new Avivi product starts with one visible assistant and a hidden specialist workforce.

## User contract

The user talks to one product assistant. The user does not choose agents.

Goal → Chief → specialists → Authority → tool/action → Evidence → Verification → Outcome.

## Required runtime pieces

1. Chief/router — owns the user goal and selects specialists.
2. Specialist registry — product-specific agents and capabilities.
3. Tool/action registry — every real capability has a typed action contract.
4. Authority — read/internal work may be automatic; external writes, spend and privileged changes are gated.
5. Evidence — external side effects cannot be called complete without provider or system read-back.
6. Verification — completion is a verified state, not a model statement.
7. Audit — every route, approval, execution and verification is traceable.
8. Emergency stop — owner can stop autonomous execution.
9. Product isolation — DB, auth, secrets, memory, provider tokens and audit stay product-specific.

## Two modes

### Operate
The assistant uses product capabilities to deliver outcomes for the user.

### Build
The same kernel can power a development agent, but production mutation remains behind repository/deployment permissions and review gates. Build mode must never silently widen end-user authority.

## New app rule

A new app is not considered started until it has:
- one Chief,
- at least one specialist,
- an Authority policy,
- an Evidence/Verification contract,
- a tool registry,
- a clear list of external actions requiring approval.

Never ship a chat-only facade that claims work was completed without a real executor and evidence.

## Reference kernel

`blueprints/agent-kernel.ts` is the executable form of this standard. `createAgentKernel` enforces:

- one chief and at least one specialist
- unique agent ids, and no blank keywords or capabilities
- `external_write`, `money`, and `privileged` cannot be auto-allowed
- a risk cannot be both auto-allowed and always-approval
- an unknown agent id is rejected instead of silently rerouted
- a named agent cannot be given a capability it does not own
- a read or internal action marked as an external effect is authorized as an external write
- `external_write` and external effects cannot complete without usable verified evidence
- the default evidence rule is that every supplied item must be verified
- `money` and `privileged` actions cannot complete unless they are external effects or named by an action contract
- demo mode cannot return `complete` for external actions
- an emergency stop blocks new completion
- plan, route, authorization, completion, stop, and resume are appended through an audit-log adapter

The kernel does not execute tools. A status of `complete` means the host may record the outcome, not that a provider was called inside the kernel.

Keyword matching defaults to whole words (`token`). Set `keywordMatch: "substring"` when an existing configuration depended on fragment matches such as `pay` inside `payment`. Evidence defaults to `all_verified` because a failed read-back leaves the outcome unverified. Set `evidencePolicy: "any_verified"` only for the older "one verified item is enough" rule.

Optional `actionContracts` make capability risk and external effect authoritative, so a caller cannot downgrade them. A contract is also the explicit classification for an internal money or privileged change.

`createAgentKernel(config, adapters)` accepts a stop switch, an audit log, and an idempotency store. The reference adapters in `blueprints/memory-adapters.ts` are process-local. Production hosts supply durable implementations. An idempotency key lets a repeated `complete` return `replayed: true` instead of looking like a second effect. The host still has to skip the provider call.
