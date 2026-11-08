/**
 * Reference runtime for the Avivi agent kernel.
 *
 * Valid goals still plan, route, authorize, and complete as before.
 * Invalid configuration and unsafe authority paths fail closed.
 *
 * The kernel decides status only. It does not execute tools, persist the
 * audit log, or survive a process restart. Hosts execute an action only
 * after `complete` returns status `complete`.
 */

export type AgentRisk = "read" | "internal_write" | "external_write" | "money" | "privileged";

export type KernelMode = "live" | "demo";

export type EvidencePolicy = "any_verified" | "all_verified";

export type KeywordMatch = "substring" | "token";

/** Risks that must stay behind an approval gate. */
export const GATED_RISKS: readonly AgentRisk[] = Object.freeze([
  "external_write",
  "money",
  "privileged",
]);

export interface AgentDefinition {
  id: string;
  purpose: string;
  keywords: readonly string[];
  capabilities: readonly string[];
}

export interface CapabilityContract {
  id: string;
  risk: AgentRisk;
  externalEffect?: boolean;
}

export interface KernelAction {
  id: string;
  agentId: string;
  title: string;
  risk: AgentRisk;
  capability?: string;
  externalEffect?: boolean;
}

export interface RouteInput {
  id: string;
  agentId?: string;
  title: string;
  risk: AgentRisk;
  capability?: string;
  externalEffect?: boolean;
}

export interface Evidence {
  source: string;
  state: "verified" | "unverified" | "failed";
  ref?: string;
  checkedAt: string;
}

export interface AgentKernelConfig {
  productId: string;
  chiefAgentId: string;
  agents: readonly AgentDefinition[];
  autoAllow: readonly AgentRisk[];
  alwaysRequireApproval: readonly AgentRisk[];
  /** Defaults to live. Demo never returns `complete` for an external effect. */
  mode?: KernelMode;
  /** Defaults to any verified item, which is the original evidence rule. */
  evidencePolicy?: EvidencePolicy;
  /** Defaults to substring, which is the original keyword rule. */
  keywordMatch?: KeywordMatch;
  /**
   * Optional typed capability registry. When set, every agent capability
   * must have a contract, caller risk must match it, and a contract marked
   * as an external effect cannot be completed without evidence.
   */
  actionContracts?: readonly CapabilityContract[];
  /** In-memory audit cap. Defaults to 1000. Oldest events are dropped. */
  auditLimit?: number;
}

export interface ResolvedAgentKernelConfig {
  readonly productId: string;
  readonly chiefAgentId: string;
  readonly agents: readonly AgentDefinition[];
  readonly autoAllow: readonly AgentRisk[];
  readonly alwaysRequireApproval: readonly AgentRisk[];
  readonly mode: KernelMode;
  readonly evidencePolicy: EvidencePolicy;
  readonly keywordMatch: KeywordMatch;
  readonly actionContracts: readonly CapabilityContract[];
  readonly auditLimit: number;
}

export interface Plan {
  goal: string;
  chiefAgentId: string;
  selectedAgentIds: readonly string[];
}

export interface AuthorityDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason:
    | "explicit_approval_present"
    | "explicit_approval_required"
    | "policy_auto_allow"
    | "approval_required_by_default";
}

export interface CompleteInput {
  action: KernelAction;
  evidence?: readonly Evidence[];
  approved?: boolean;
}

export interface CompleteResult {
  status: "needs_approval" | "blocked" | "complete" | "stopped" | "demo";
  reason: string;
}

export type AuditEventType = "plan" | "route" | "authorize" | "complete" | "emergency_stop" | "resume";

export type AuditValue = string | number | boolean | null;

export interface AuditEvent {
  at: string;
  productId: string;
  type: AuditEventType;
  detail: Readonly<Record<string, AuditValue>>;
}

export interface AuditSnapshot {
  readonly events: readonly AuditEvent[];
  readonly dropped: number;
}

export interface AgentKernel {
  readonly config: ResolvedAgentKernelConfig;
  plan(goalInput: string): Plan;
  route(action: RouteInput): KernelAction;
  authorize(action: KernelAction, approved?: boolean): AuthorityDecision;
  complete(input: CompleteInput): CompleteResult;
  stop(reason?: string): void;
  resume(): void;
  isStopped(): boolean;
  audit(): AuditSnapshot;
}

const RISKS = new Set<string>(["read", "internal_write", "external_write", "money", "privileged"]);
const GATED = new Set<string>(GATED_RISKS);
const DEFAULT_AUDIT_LIMIT = 1000;
const MAX_AUDIT_LIMIT = 10_000;
const MAX_GOAL_CHARS = 500;

function fail(code: string): never {
  throw new Error(code);
}

function isRisk(value: string): value is AgentRisk {
  return RISKS.has(value);
}

function assertNonBlank(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") fail(code);
}

function uniqueRisks(risks: readonly AgentRisk[]): readonly AgentRisk[] {
  return Object.freeze([...new Set(risks)]);
}

function freezeAgent(agent: AgentDefinition): AgentDefinition {
  return Object.freeze({
    id: agent.id,
    purpose: agent.purpose.trim(),
    keywords: Object.freeze(agent.keywords.map((keyword) => keyword.trim())),
    capabilities: Object.freeze(agent.capabilities.map((capability) => capability.trim())),
  });
}

function normalizeAgents(agents: readonly AgentDefinition[]): readonly AgentDefinition[] {
  if (!Array.isArray(agents) || agents.length === 0) fail("agents_required");
  const seen = new Set<string>();
  const frozen = agents.map((agent) => {
    if (agent === null || typeof agent !== "object") fail("agent_invalid");
    assertNonBlank(agent.id, "agent_id_required");
    if (seen.has(agent.id)) fail("duplicate_agent_id");
    seen.add(agent.id);
    assertNonBlank(agent.purpose, "agent_purpose_required");
    if (!Array.isArray(agent.keywords)) fail("agent_keywords_required");
    if (!Array.isArray(agent.capabilities)) fail("agent_capabilities_required");
    for (const keyword of agent.keywords) {
      if (typeof keyword !== "string") fail("invalid_keyword");
      if (keyword.trim() === "") fail("empty_keyword");
    }
    for (const capability of agent.capabilities) {
      if (typeof capability !== "string") fail("invalid_capability");
      if (capability.trim() === "") fail("empty_capability");
    }
    return freezeAgent(agent);
  });
  return Object.freeze(frozen);
}

function normalizeContracts(
  contracts: readonly CapabilityContract[] | undefined,
  agents: readonly AgentDefinition[],
): readonly CapabilityContract[] {
  if (contracts === undefined) return Object.freeze([]);
  if (!Array.isArray(contracts)) fail("invalid_action_contracts");
  const seen = new Set<string>();
  const frozen = contracts.map((contract) => {
    if (contract === null || typeof contract !== "object") fail("invalid_action_contracts");
    assertNonBlank(contract.id, "capability_id_required");
    const id = contract.id.trim();
    if (seen.has(id)) fail("duplicate_capability");
    seen.add(id);
    if (typeof contract.risk !== "string" || !isRisk(contract.risk)) fail("invalid_risk");
    if (contract.externalEffect !== undefined && typeof contract.externalEffect !== "boolean") {
      fail("invalid_external_effect");
    }
    const normalized: CapabilityContract = { id, risk: contract.risk };
    if (contract.externalEffect !== undefined) normalized.externalEffect = contract.externalEffect;
    return Object.freeze(normalized);
  });
  for (const agent of agents) {
    for (const capability of agent.capabilities) {
      if (!seen.has(capability)) fail("capability_without_contract");
    }
  }
  return Object.freeze(frozen);
}

function resolveConfig(input: AgentKernelConfig): ResolvedAgentKernelConfig {
  if (input === null || typeof input !== "object") fail("config_required");
  assertNonBlank(input.productId, "product_id_required");
  assertNonBlank(input.chiefAgentId, "chief_agent_missing");
  if (!Array.isArray(input.autoAllow)) fail("auto_allow_required");
  if (!Array.isArray(input.alwaysRequireApproval)) fail("always_require_approval_required");

  const agents = normalizeAgents(input.agents);
  if (!agents.some((agent) => agent.id === input.chiefAgentId)) fail("chief_agent_missing");
  if (!agents.some((agent) => agent.id !== input.chiefAgentId)) fail("specialist_required");

  for (const risk of input.autoAllow) {
    if (typeof risk !== "string" || !isRisk(risk)) fail("invalid_risk");
    if (GATED.has(risk)) fail("unsafe_auto_allow");
  }
  for (const risk of input.alwaysRequireApproval) {
    if (typeof risk !== "string" || !isRisk(risk)) fail("invalid_risk");
  }
  for (const risk of input.autoAllow) {
    if (input.alwaysRequireApproval.includes(risk)) fail("policy_conflict");
  }

  const mode = input.mode ?? "live";
  if (mode !== "live" && mode !== "demo") fail("invalid_mode");
  const evidencePolicy = input.evidencePolicy ?? "any_verified";
  if (evidencePolicy !== "any_verified" && evidencePolicy !== "all_verified") fail("invalid_evidence_policy");
  const keywordMatch = input.keywordMatch ?? "substring";
  if (keywordMatch !== "substring" && keywordMatch !== "token") fail("invalid_keyword_match");

  const auditLimit = input.auditLimit ?? DEFAULT_AUDIT_LIMIT;
  if (!Number.isInteger(auditLimit) || auditLimit < 1 || auditLimit > MAX_AUDIT_LIMIT) fail("invalid_audit_limit");

  return Object.freeze({
    productId: input.productId,
    chiefAgentId: input.chiefAgentId,
    agents,
    autoAllow: uniqueRisks(input.autoAllow),
    alwaysRequireApproval: uniqueRisks(input.alwaysRequireApproval),
    mode,
    evidencePolicy,
    keywordMatch,
    actionContracts: normalizeContracts(input.actionContracts, agents),
    auditLimit,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileMatcher(keyword: string, mode: KeywordMatch): (goalLower: string) => boolean {
  const lower = keyword.toLowerCase();
  if (mode === "substring") return (goalLower) => goalLower.includes(lower);
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(lower)}(?=$|[^\\p{L}\\p{N}])`, "u");
  return (goalLower) => pattern.test(goalLower);
}

function redact(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-access-key]")
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "[redacted-token]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "[redacted-token]");
}

function tracedGoal(goal: string): string {
  const clean = redact(goal);
  return clean.length > MAX_GOAL_CHARS ? `${clean.slice(0, MAX_GOAL_CHARS)}…` : clean;
}

function isUsableVerified(item: unknown): boolean {
  if (item === null || typeof item !== "object") return false;
  const evidence = item as Partial<Evidence>;
  if (evidence.state !== "verified") return false;
  if (typeof evidence.source !== "string" || evidence.source.trim() === "") return false;
  if (typeof evidence.checkedAt !== "string" || Number.isNaN(Date.parse(evidence.checkedAt))) return false;
  return true;
}

function requiresEvidence(action: KernelAction): boolean {
  return action.externalEffect === true || action.risk === "external_write";
}

function effectiveRisk(action: KernelAction): AgentRisk {
  if (action.externalEffect === true && (action.risk === "read" || action.risk === "internal_write")) {
    return "external_write";
  }
  return action.risk;
}

function copyAction(action: KernelAction, overrides: Partial<KernelAction> = {}): KernelAction {
  const next: KernelAction = {
    id: action.id,
    agentId: action.agentId,
    title: action.title,
    risk: overrides.risk ?? action.risk,
  };
  const capability = overrides.capability ?? action.capability;
  if (capability !== undefined) next.capability = capability;
  if (overrides.externalEffect !== undefined) next.externalEffect = overrides.externalEffect;
  else if (action.externalEffect !== undefined) next.externalEffect = action.externalEffect;
  return next;
}

/**
 * Create an isolated kernel for one product.
 * Instances do not share audit, stop state, or policy.
 */
export function createAgentKernel(configInput: AgentKernelConfig): AgentKernel {
  const config = resolveConfig(configInput);
  const agents = new Map(config.agents.map((agent) => [agent.id, agent]));
  const contracts = new Map(config.actionContracts.map((contract) => [contract.id, contract]));
  const keywordIndex = config.agents
    .filter((agent) => agent.id !== config.chiefAgentId)
    .map((agent) => ({
      id: agent.id,
      matchers: agent.keywords.map((keyword) => compileMatcher(keyword, config.keywordMatch)),
    }));

  const events: AuditEvent[] = [];
  let dropped = 0;
  let stopped = false;
  let stopReason = "emergency_stop";

  function record(type: AuditEventType, detail: Record<string, AuditValue>): void {
    events.push(Object.freeze({
      at: new Date().toISOString(),
      productId: config.productId,
      type,
      detail: Object.freeze({ ...detail }),
    }));
    while (events.length > config.auditLimit) {
      events.shift();
      dropped += 1;
    }
  }

  function bindContract(action: KernelAction): KernelAction {
    if (contracts.size === 0) return action;
    if (action === null || typeof action !== "object") fail("action_required");
    if (typeof action.capability !== "string" || action.capability.trim() === "") fail("capability_required");
    const capability = action.capability.trim();
    const contract = contracts.get(capability);
    if (!contract) fail("unknown_capability_contract");
    if (action.risk !== contract.risk) fail("action_contract_mismatch");
    const agent = typeof action.agentId === "string" ? agents.get(action.agentId) : undefined;
    if (!agent || !agent.capabilities.includes(capability)) fail("capability_mismatch");
    if (contract.externalEffect === true && action.externalEffect !== true) {
      return copyAction(action, { capability, externalEffect: true });
    }
    if (capability !== action.capability) return copyAction(action, { capability });
    return action;
  }

  function assertAction(action: KernelAction): void {
    if (action === null || typeof action !== "object") fail("action_required");
    assertNonBlank(action.id, "action_id_required");
    if (typeof action.agentId !== "string" || action.agentId.trim() === "") fail("agent_id_required");
    if (!agents.has(action.agentId)) fail("agent_not_found");
    assertNonBlank(action.title, "action_title_required");
    if (typeof action.risk !== "string" || !isRisk(action.risk)) fail("invalid_risk");
    if (action.externalEffect !== undefined && typeof action.externalEffect !== "boolean") {
      fail("invalid_external_effect");
    }
  }

  function assertRouteShape(action: RouteInput): void {
    if (action === null || typeof action !== "object") fail("action_required");
    assertNonBlank(action.id, "action_id_required");
    assertNonBlank(action.title, "action_title_required");
    if (typeof action.risk !== "string" || !isRisk(action.risk)) fail("invalid_risk");
    if (action.externalEffect !== undefined && typeof action.externalEffect !== "boolean") {
      fail("invalid_external_effect");
    }
    if (action.capability !== undefined && typeof action.capability !== "string") fail("invalid_capability");
  }

  function plan(goalInput: string): Plan {
    if (typeof goalInput !== "string" || goalInput.trim() === "") fail("goal_required");
    const goal = goalInput.trim();
    const lower = goal.toLowerCase();
    const selected = keywordIndex
      .filter((agent) => agent.matchers.some((matches) => matches(lower)))
      .map((agent) => agent.id);
    const result: Plan = Object.freeze({
      goal,
      chiefAgentId: config.chiefAgentId,
      selectedAgentIds: Object.freeze([config.chiefAgentId, ...selected]),
    });
    record("plan", {
      chiefAgentId: result.chiefAgentId,
      selectedAgentIds: result.selectedAgentIds.join(","),
      goalChars: goal.length,
      goal: tracedGoal(goal),
    });
    return result;
  }

  function route(action: RouteInput): KernelAction {
    assertRouteShape(action);
    const capability = typeof action.capability === "string" ? action.capability.trim() : undefined;
    if (action.capability !== undefined && !capability) fail("empty_capability");

    let specialist: AgentDefinition | undefined;
    if (action.agentId !== undefined) {
      if (typeof action.agentId !== "string" || !agents.has(action.agentId)) fail("agent_not_found");
      specialist = agents.get(action.agentId);
      if (capability && specialist && !specialist.capabilities.includes(capability)) fail("capability_mismatch");
    } else if (capability) {
      specialist = config.agents.find((agent) => agent.capabilities.includes(capability));
      if (!specialist && contracts.size > 0) fail("unknown_capability_contract");
      specialist ??= agents.get(config.chiefAgentId);
    } else if (contracts.size > 0) {
      fail("capability_required");
    } else {
      specialist = agents.get(config.chiefAgentId);
    }
    if (!specialist) fail("chief_agent_missing");

    const routed: KernelAction = {
      id: action.id,
      agentId: specialist.id,
      title: action.title.trim(),
      risk: action.risk,
    };
    if (capability) routed.capability = capability;
    if (action.externalEffect !== undefined) routed.externalEffect = action.externalEffect;
    const bound = bindContract(routed);
    record("route", {
      actionId: bound.id,
      agentId: bound.agentId,
      risk: bound.risk,
      capability: bound.capability ?? "",
    });
    return bound;
  }

  function authorize(action: KernelAction, approved?: boolean): AuthorityDecision {
    if (approved !== undefined && typeof approved !== "boolean") fail("invalid_approval");
    const bound = bindContract(action);
    assertAction(bound);
    const risk = effectiveRisk(bound);
    const isApproved = approved === true;
    let decision: AuthorityDecision;
    if (config.alwaysRequireApproval.includes(risk)) {
      decision = isApproved
        ? { allowed: true, requiresApproval: false, reason: "explicit_approval_present" }
        : { allowed: false, requiresApproval: true, reason: "explicit_approval_required" };
    } else if (config.autoAllow.includes(risk)) {
      decision = { allowed: true, requiresApproval: false, reason: "policy_auto_allow" };
    } else {
      decision = isApproved
        ? { allowed: true, requiresApproval: false, reason: "explicit_approval_present" }
        : { allowed: false, requiresApproval: true, reason: "approval_required_by_default" };
    }
    record("authorize", {
      actionId: bound.id,
      agentId: bound.agentId,
      risk,
      declaredRisk: bound.risk,
      externalEffect: bound.externalEffect === true,
      allowed: decision.allowed,
      reason: decision.reason,
    });
    return Object.freeze(decision);
  }

  function readEvidence(evidence: readonly Evidence[] | undefined): readonly Evidence[] {
    if (evidence === undefined) return [];
    if (!Array.isArray(evidence)) fail("invalid_evidence");
    return evidence;
  }

  function evidenceSatisfied(action: KernelAction, evidence: readonly Evidence[]): boolean {
    if (!requiresEvidence(action)) return true;
    if (config.evidencePolicy === "all_verified") {
      return evidence.length > 0 && evidence.every((item) => isUsableVerified(item));
    }
    return evidence.some((item) => isUsableVerified(item));
  }

  function finish(
    action: KernelAction,
    result: CompleteResult,
    evidence: readonly Evidence[] = [],
  ): CompleteResult {
    record("complete", {
      actionId: action.id,
      status: result.status,
      reason: result.reason,
      evidenceCount: evidence.length,
      verifiedCount: evidence.filter((item) => isUsableVerified(item)).length,
    });
    return Object.freeze(result);
  }

  function complete(input: CompleteInput): CompleteResult {
    if (input === null || typeof input !== "object") fail("action_required");
    const action = bindContract(input.action);
    assertAction(action);
    if (stopped) return finish(action, { status: "stopped", reason: stopReason });

    const authority = authorize(action, input.approved);
    if (!authority.allowed) return finish(action, { status: "needs_approval", reason: authority.reason });

    const evidence = readEvidence(input.evidence);
    if (!evidenceSatisfied(action, evidence)) {
      const reason = config.evidencePolicy === "all_verified" && evidence.length > 0
        ? "evidence_not_fully_verified"
        : "external_effect_requires_verified_evidence";
      return finish(action, { status: "blocked", reason }, evidence);
    }
    if (config.mode === "demo" && requiresEvidence(action)) {
      return finish(action, { status: "demo", reason: "demo_mode_not_live" }, evidence);
    }
    return finish(action, { status: "complete", reason: "verified_or_internal" }, evidence);
  }

  function stop(reason = "emergency_stop"): void {
    if (typeof reason !== "string" || reason.trim() === "") fail("stop_reason_required");
    stopped = true;
    stopReason = reason.trim().slice(0, 200);
    record("emergency_stop", { reason: stopReason });
  }

  function resume(): void {
    if (!stopped) return;
    stopped = false;
    record("resume", {});
  }

  function audit(): AuditSnapshot {
    return Object.freeze({
      events: Object.freeze(events.slice()),
      dropped,
    });
  }

  return Object.freeze({
    config,
    plan,
    route,
    authorize,
    complete,
    stop,
    resume,
    isStopped: () => stopped,
    audit,
  });
}
