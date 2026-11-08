/**
 * Reference runtime for the Avivi agent kernel.
 *
 * The kernel decides status only. It does not execute tools. Hosts execute
 * an action only after `complete` returns status `complete`.
 *
 * Stop, audit, and idempotency go through adapters. The default adapters are
 * process-local. Pass durable adapters before production traffic.
 */

import {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createMemoryStopSwitch,
  type AuditLog,
  type IdempotencyRecord,
  type IdempotencyStore,
  type StopSwitch,
} from "./memory-adapters.ts";

export {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createMemoryStopSwitch,
  type AuditLog,
  type IdempotencyPut,
  type IdempotencyRecord,
  type IdempotencyStore,
  type StopSwitch,
} from "./memory-adapters.ts";

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
  /**
   * Defaults to `all_verified`. A failed read-back vetoes completion.
   * Set `any_verified` only when extra unverified notes ride along with one good read-back.
   */
  evidencePolicy?: EvidencePolicy;
  /**
   * Defaults to `token`, so a short keyword does not match inside another word.
   * Set `substring` to keep the previous fragment-matching rule.
   */
  keywordMatch?: KeywordMatch;
  /**
   * Optional typed capability registry. When set, every agent capability
   * must have a contract, caller risk must match it, and a contract marked
   * as an external effect cannot be completed without evidence.
   */
  actionContracts?: readonly CapabilityContract[];
  /**
   * Cap for the default memory audit log. Defaults to 1000.
   * Ignored when `adapters.auditLog` is provided; that log owns retention.
   */
  auditLimit?: number;
}

export interface KernelAdapters {
  stopSwitch?: StopSwitch;
  auditLog?: AuditLog;
  idempotency?: IdempotencyStore;
  /**
   * Extra redaction applied to text before the built-in audit redaction.
   * Throw to drop the text instead of writing it. The thrown message is not stored.
   */
  redact?: (text: string) => string;
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
  /**
   * Caller-owned key for one intended effect. A second `complete` with the
   * same key and the same action returns the stored result with `replayed: true`.
   * The kernel does not perform the side effect. Hosts must skip it when `replayed` is true.
   */
  idempotencyKey?: string;
}

export interface CompleteResult {
  status: "needs_approval" | "blocked" | "complete" | "stopped" | "demo";
  reason: string;
  replayed?: boolean;
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
  const evidencePolicy = input.evidencePolicy ?? "all_verified";
  if (evidencePolicy !== "any_verified" && evidencePolicy !== "all_verified") fail("invalid_evidence_policy");
  const keywordMatch = input.keywordMatch ?? "token";
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

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const current = digits.charCodeAt(index) - 48;
    if (current < 0 || current > 9) return false;
    let value = current;
    if (doubleDigit) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

/** Redact credentials and common private text before it is written to an audit log. */
export function redactAuditText(value: string): string {
  const withoutKeys = value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/\bhttps?:\/\/[^:\s/@]+:[^@\s/]+@/gi, (match) => `${match.slice(0, match.indexOf(":"))}://[redacted-userinfo]@`)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-token]")
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, "Bearer [redacted-token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-access-key]")
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "[redacted-token]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "[redacted-token]")
    .replace(
      /\b(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*(?:"[^"\n]+"|'[^'\n]+'|\S+)/gi,
      (_match, name: string) => `${name}=[redacted-secret]`,
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted-ssn]")
    .replace(/\+\d{8,15}\b/g, "[redacted-phone]")
    .replace(/\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[redacted-phone]");
  return withoutKeys.replace(/\b(?:\d[ -]?){13,19}\b/g, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19 || !passesLuhn(digits)) return match;
    return "[redacted-card]";
  });
}

function traceText(value: string, hostRedact?: (text: string) => string): string {
  const bounded = value.length > 8_000 ? value.slice(0, 8_000) : value;
  let text = bounded;
  if (hostRedact) {
    try {
      const next = hostRedact(text);
      if (typeof next !== "string") fail("invalid_redaction");
      text = next;
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_redaction") throw error;
      return "[redaction-failed]";
    }
  }
  const clean = redactAuditText(text);
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

function assertAdapterFns(value: object, names: readonly string[], code: string): void {
  for (const name of names) {
    if (typeof (value as Record<string, unknown>)[name] !== "function") fail(code);
  }
}

/**
 * Create a kernel for one product.
 * Adapters are private to the instance unless the caller supplies shared ones.
 * The default adapters are process-local.
 */
export function createAgentKernel(configInput: AgentKernelConfig, adapters: KernelAdapters = {}): AgentKernel {
  if (adapters === null || typeof adapters !== "object" || Array.isArray(adapters)) fail("invalid_adapters");
  if (adapters.redact !== undefined && typeof adapters.redact !== "function") fail("invalid_redaction");
  if (adapters.stopSwitch !== undefined) {
    if (adapters.stopSwitch === null || typeof adapters.stopSwitch !== "object") fail("invalid_stop_switch");
    assertAdapterFns(adapters.stopSwitch, ["isStopped", "stop", "resume", "currentReason"], "invalid_stop_switch");
  }
  if (adapters.auditLog !== undefined) {
    if (adapters.auditLog === null || typeof adapters.auditLog !== "object") fail("invalid_audit_log");
    assertAdapterFns(adapters.auditLog, ["append", "snapshot"], "invalid_audit_log");
  }
  if (adapters.idempotency !== undefined) {
    if (adapters.idempotency === null || typeof adapters.idempotency !== "object") fail("invalid_idempotency_store");
    assertAdapterFns(adapters.idempotency, ["get", "putIfAbsent"], "invalid_idempotency_store");
  }

  const config = resolveConfig(configInput);
  const agents = new Map(config.agents.map((agent) => [agent.id, agent]));
  const contracts = new Map(config.actionContracts.map((contract) => [contract.id, contract]));
  const keywordIndex = config.agents
    .filter((agent) => agent.id !== config.chiefAgentId)
    .map((agent) => ({
      id: agent.id,
      matchers: agent.keywords.map((keyword) => compileMatcher(keyword, config.keywordMatch)),
    }));
  const stopSwitch = adapters.stopSwitch ?? createMemoryStopSwitch();
  const auditLog = adapters.auditLog ?? createMemoryAuditLog(config.auditLimit);
  const idempotency = adapters.idempotency ?? createMemoryIdempotencyStore();
  const hostRedact = adapters.redact;

  function record(type: AuditEventType, detail: Record<string, AuditValue>): void {
    auditLog.append(Object.freeze({
      at: new Date().toISOString(),
      productId: config.productId,
      type,
      detail: Object.freeze({ ...detail }),
    }));
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
      goal: traceText(goal, hostRedact),
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

  function isClassified(action: KernelAction): boolean {
    if (action.risk !== "money" && action.risk !== "privileged") return true;
    if (action.externalEffect === true) return true;
    const capability = action.capability?.trim();
    if (!capability) return false;
    return contracts.get(capability)?.risk === action.risk;
  }

  function finish(
    action: KernelAction,
    result: CompleteResult,
    evidence: readonly Evidence[] = [],
    replayed = false,
  ): CompleteResult {
    const finalResult = Object.freeze(replayed ? { ...result, replayed: true } : { ...result });
    record("complete", {
      actionId: action.id,
      status: finalResult.status,
      reason: finalResult.reason,
      evidenceCount: evidence.length,
      verifiedCount: evidence.filter((item) => isUsableVerified(item)).length,
      replayed,
    });
    return finalResult;
  }

  function readIdempotencyKey(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") fail("invalid_idempotency_key");
    const key = value.trim();
    return key === "" ? undefined : key;
  }

  function actionFingerprint(action: KernelAction): string {
    return [
      action.id,
      action.agentId,
      action.risk,
      action.externalEffect === true ? "1" : "0",
      action.capability ?? "",
    ].join("\0");
  }

  function replayStored(action: KernelAction, record: IdempotencyRecord): CompleteResult {
    return finish(action, record.result, [], true);
  }

  function complete(input: CompleteInput): CompleteResult {
    if (input === null || typeof input !== "object") fail("action_required");
    const action = bindContract(input.action);
    assertAction(action);
    if (stopSwitch.isStopped()) return finish(action, { status: "stopped", reason: stopSwitch.currentReason() });
    if (!isClassified(action)) {
      return finish(action, {
        status: "blocked",
        reason: "money_or_privileged_requires_external_effect_or_contract",
      });
    }

    const authority = authorize(action, input.approved);
    if (!authority.allowed) return finish(action, { status: "needs_approval", reason: authority.reason });

    const key = readIdempotencyKey(input.idempotencyKey);
    const fingerprint = actionFingerprint(action);
    if (key) {
      const existing = idempotency.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail("idempotency_key_reused");
        return replayStored(action, existing);
      }
    }

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
    const result = finish(action, { status: "complete", reason: "verified_or_internal" }, evidence);
    if (!key) return result;
    const put = idempotency.putIfAbsent(key, { fingerprint, result });
    if (put.record.fingerprint !== fingerprint) fail("idempotency_key_reused");
    if (!put.inserted) return replayStored(action, put.record);
    return result;
  }

  function stop(reason = "emergency_stop"): void {
    if (typeof reason !== "string" || reason.trim() === "") fail("stop_reason_required");
    const clean = reason.trim().slice(0, 200);
    stopSwitch.stop(clean);
    record("emergency_stop", { reason: traceText(clean, hostRedact) });
  }

  function resume(): void {
    if (!stopSwitch.isStopped()) return;
    stopSwitch.resume();
    record("resume", {});
  }

  function audit(): AuditSnapshot {
    const snapshot = auditLog.snapshot();
    if (
      snapshot === null
      || typeof snapshot !== "object"
      || !Array.isArray(snapshot.events)
      || typeof snapshot.dropped !== "number"
    ) {
      fail("invalid_audit_snapshot");
    }
    return snapshot;
  }

  return Object.freeze({
    config,
    plan,
    route,
    authorize,
    complete,
    stop,
    resume,
    isStopped: () => stopSwitch.isStopped(),
    audit,
  });
}

/** Build the process-local reference adapters. Production hosts replace these. */
export function createMemoryAdapters(auditLimit = 1000): KernelAdapters {
  return {
    stopSwitch: createMemoryStopSwitch(),
    auditLog: createMemoryAuditLog(auditLimit),
    idempotency: createMemoryIdempotencyStore(),
  };
}
