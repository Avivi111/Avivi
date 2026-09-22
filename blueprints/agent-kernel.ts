export type AgentRisk = "read" | "internal_write" | "external_write" | "money" | "privileged";

export interface AgentDefinition {
  id: string;
  purpose: string;
  keywords: readonly string[];
  capabilities: readonly string[];
}

export interface KernelAction {
  id: string;
  agentId: string;
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
}

export function createAgentKernel(config: AgentKernelConfig) {
  const agents = new Map(config.agents.map((agent) => [agent.id, agent]));

  function plan(goalInput: string) {
    const goal = goalInput.trim();
    if (!goal) throw new Error("goal_required");
    const lower = goal.toLocaleLowerCase();
    const selected = config.agents
      .filter((agent) => agent.id !== config.chiefAgentId)
      .filter((agent) => agent.keywords.some((keyword) => lower.includes(keyword.toLocaleLowerCase())))
      .map((agent) => agent.id);
    return {
      goal,
      chiefAgentId: config.chiefAgentId,
      selectedAgentIds: [...new Set([config.chiefAgentId, ...selected])],
    };
  }

  function route(action: Omit<KernelAction, "agentId"> & { agentId?: string }): KernelAction {
    const requested = action.agentId ? agents.get(action.agentId) : undefined;
    const specialist =
      requested ??
      config.agents.find((agent) => action.capability && agent.capabilities.includes(action.capability)) ??
      agents.get(config.chiefAgentId);
    if (!specialist) throw new Error("chief_agent_missing");
    return { ...action, agentId: specialist.id };
  }

  function authorize(action: KernelAction, approved = false) {
    if (config.alwaysRequireApproval.includes(action.risk)) {
      return approved
        ? { allowed: true, requiresApproval: false, reason: "explicit_approval_present" }
        : { allowed: false, requiresApproval: true, reason: "explicit_approval_required" };
    }
    if (config.autoAllow.includes(action.risk)) {
      return { allowed: true, requiresApproval: false, reason: "policy_auto_allow" };
    }
    return approved
      ? { allowed: true, requiresApproval: false, reason: "explicit_approval_present" }
      : { allowed: false, requiresApproval: true, reason: "approval_required_by_default" };
  }

  function complete(input: { action: KernelAction; evidence?: Evidence[]; approved?: boolean }) {
    const authority = authorize(input.action, input.approved);
    if (!authority.allowed) return { status: "needs_approval" as const, reason: authority.reason };
    if (input.action.externalEffect && !(input.evidence ?? []).some((item) => item.state === "verified")) {
      return { status: "blocked" as const, reason: "external_effect_requires_verified_evidence" };
    }
    return { status: "complete" as const, reason: "verified_or_internal" };
  }

  return { config, plan, route, authorize, complete };
}
