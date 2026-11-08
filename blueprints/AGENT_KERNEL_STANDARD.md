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
- demo mode cannot return `complete` for those actions
- an emergency stop blocks new completion
- plan, route, authorization, completion, stop, and resume are appended to an in-memory audit log

The kernel does not execute tools. A status of `complete` means the host may record the outcome, not that a provider was called inside the kernel.

Keyword matching defaults to the original substring rule. New apps should set `keywordMatch: "token"` so a short keyword does not match inside another word. Optional `actionContracts` make capability risk and external effect authoritative, so a caller cannot downgrade them.

Hosts still own product isolation, a durable audit, a durable emergency stop, idempotency for writes, and read-back from the real provider. In-memory stop and audit state do not survive a restart and are not shared across processes.
