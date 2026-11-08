import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAgentKernel,
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createMemoryStopSwitch,
  type AgentKernel,
  type AgentKernelConfig,
  type AgentRisk,
  type Evidence,
  type KernelAction,
  type KernelAdapters,
} from "../blueprints/agent-kernel.ts";

const verified: Evidence = {
  source: "email-provider",
  state: "verified",
  ref: "msg_123",
  checkedAt: "2026-11-08T00:00:00.000Z",
};

function billingConfig(overrides: Partial<AgentKernelConfig> = {}): AgentKernelConfig {
  return {
    productId: "billing",
    chiefAgentId: "chief",
    agents: [
      { id: "chief", purpose: "Own the user goal", keywords: ["overview"], capabilities: ["route"] },
      {
        id: "billing",
        purpose: "Invoices and refunds",
        keywords: ["invoice", "refund"],
        capabilities: ["create_invoice", "refund_payment"],
      },
      { id: "support", purpose: "Customer email", keywords: ["email"], capabilities: ["send_email"] },
    ],
    autoAllow: ["read", "internal_write"],
    alwaysRequireApproval: ["external_write", "money", "privileged"],
    ...overrides,
  };
}

function billingKernel(overrides: Partial<AgentKernelConfig> = {}, adapters?: KernelAdapters): AgentKernel {
  return createAgentKernel(billingConfig(overrides), adapters);
}

function contractedKernel(overrides: Partial<AgentKernelConfig> = {}): AgentKernel {
  return billingKernel({
    actionContracts: [
      { id: "route", risk: "read" },
      { id: "create_invoice", risk: "external_write", externalEffect: true },
      { id: "refund_payment", risk: "money", externalEffect: true },
      { id: "send_email", risk: "external_write", externalEffect: true },
    ],
    ...overrides,
  });
}

describe("planning", () => {
  it("selects the chief first and matches whole keywords regardless of case", () => {
    const kernel = billingKernel();
    assert.deepEqual(kernel.plan("  Email the INVOICE  "), {
      goal: "Email the INVOICE",
      chiefAgentId: "chief",
      selectedAgentIds: ["chief", "billing", "support"],
    });
    assert.deepEqual(kernel.plan("overview").selectedAgentIds, ["chief"]);
    assert.deepEqual(kernel.plan("unrelated request").selectedAgentIds, ["chief"]);
  });

  it("defaults to whole-word keywords and can opt into the old substring rule", () => {
    const config = billingConfig({
      agents: [
        { id: "chief", purpose: "Own the user goal", keywords: [], capabilities: ["route"] },
        { id: "billing", purpose: "Payments", keywords: ["pay", "a.b"], capabilities: ["refund_payment"] },
      ],
    });
    const token = createAgentKernel(config);
    assert.equal(token.config.keywordMatch, "token");
    assert.equal(token.config.evidencePolicy, "all_verified");
    assert.deepEqual(token.plan("payment").selectedAgentIds, ["chief"]);
    assert.deepEqual(token.plan("please pay now").selectedAgentIds, ["chief", "billing"]);
    assert.deepEqual(token.plan("please pay.").selectedAgentIds, ["chief", "billing"]);
    assert.deepEqual(token.plan("axb").selectedAgentIds, ["chief"]);
    assert.deepEqual(token.plan("use a.b today").selectedAgentIds, ["chief", "billing"]);

    const substring = createAgentKernel({ ...config, keywordMatch: "substring" });
    assert.deepEqual(substring.plan("payment").selectedAgentIds, ["chief", "billing"]);
    assert.deepEqual(substring.plan("xa.bx").selectedAgentIds, ["chief", "billing"]);
    assert.deepEqual(substring.plan("axb").selectedAgentIds, ["chief"]);
  });

  it("matches padded keywords after trimming, and rejects a blank keyword", () => {
    const kernel = billingKernel({
      agents: [
        { id: "chief", purpose: "Own the user goal", keywords: [], capabilities: ["route"] },
        { id: "billing", purpose: "Invoices", keywords: [" invoice "], capabilities: ["create_invoice"] },
      ],
    });
    assert.deepEqual(kernel.plan("invoice").selectedAgentIds, ["chief", "billing"]);
    assert.throws(
      () => billingKernel({
        agents: [
          { id: "chief", purpose: "Own the user goal", keywords: [], capabilities: ["route"] },
          { id: "billing", purpose: "Invoices", keywords: [""], capabilities: ["create_invoice"] },
        ],
      }),
      { message: "empty_keyword" },
    );
  });

  it("rejects an empty goal", () => {
    const kernel = billingKernel();
    assert.throws(() => kernel.plan("   "), { message: "goal_required" });
    assert.throws(() => kernel.plan(undefined as unknown as string), { message: "goal_required" });
  });
});

describe("routing", () => {
  it("preserves capability routing, explicit agents, and chief fallback", () => {
    const kernel = billingKernel();
    const input = {
      id: "act_email",
      title: " Send status ",
      risk: "external_write" as const,
      capability: "send_email",
      externalEffect: true,
    };
    const routed = kernel.route(input);
    assert.equal("agentId" in input, false);
    assert.equal(routed.agentId, "support");
    assert.equal(routed.title, "Send status");

    const explicit = kernel.route({
      id: "act_bill",
      title: "Create invoice",
      risk: "external_write",
      agentId: "billing",
      capability: "create_invoice",
    });
    assert.equal(explicit.agentId, "billing");

    const fallback = kernel.route({
      id: "act_free",
      title: "Think",
      risk: "read",
      capability: "not-a-capability",
    });
    assert.equal(fallback.agentId, "chief");
    assert.equal(fallback.capability, "not-a-capability");
  });

  it("uses the first listed owner when several agents share a capability", () => {
    const kernel = billingKernel({
      agents: [
        { id: "chief", purpose: "Own the user goal", keywords: [], capabilities: ["route", "shared"] },
        { id: "billing", purpose: "Invoices", keywords: ["invoice"], capabilities: ["shared"] },
      ],
    });
    assert.equal(kernel.route({ id: "1", title: "Shared", risk: "read", capability: "shared" }).agentId, "chief");
    assert.equal(
      kernel.route({ id: "2", title: "Shared", risk: "read", agentId: "billing", capability: "shared" }).agentId,
      "billing",
    );
  });

  it("rejects an unknown agent and a capability the named agent does not own", () => {
    const kernel = billingKernel();
    assert.throws(
      () => kernel.route({ id: "1", title: "T", risk: "read", agentId: "missing" }),
      { message: "agent_not_found" },
    );
    assert.throws(
      () => kernel.route({
        id: "1",
        title: "T",
        risk: "external_write",
        agentId: "support",
        capability: "create_invoice",
      }),
      { message: "capability_mismatch" },
    );
  });
});

describe("authority and evidence", () => {
  it("preserves auto-allow for read and internal work", () => {
    const kernel = billingKernel();
    const read = kernel.route({ id: "list", title: "List invoices", risk: "read", agentId: "billing" });
    assert.deepEqual(kernel.authorize(read), {
      allowed: true,
      requiresApproval: false,
      reason: "policy_auto_allow",
    });
    assert.deepEqual(kernel.complete({ action: read }), {
      status: "complete",
      reason: "verified_or_internal",
    });

    const note = kernel.route({ id: "note", title: "Record note", risk: "internal_write", agentId: "billing" });
    assert.equal(kernel.complete({ action: note }).status, "complete");
  });

  it("requires approval for risks that are in neither list", () => {
    const kernel = billingKernel({
      autoAllow: ["read"],
      alwaysRequireApproval: ["external_write", "money", "privileged"],
    });
    const note = kernel.route({ id: "note", title: "Record note", risk: "internal_write", agentId: "billing" });
    assert.equal(kernel.authorize(note).reason, "approval_required_by_default");
    assert.equal(kernel.complete({ action: note, approved: true }).status, "complete");
  });

  it("preserves approval before evidence, and blocks external completion without usable evidence", () => {
    const kernel = billingKernel();
    const action = kernel.route({
      id: "act_email",
      title: "Send status email",
      risk: "external_write",
      capability: "send_email",
      externalEffect: true,
    });

    assert.equal(kernel.complete({ action, evidence: [verified] }).status, "needs_approval");
    assert.equal(kernel.complete({ action, approved: true }).reason, "external_effect_requires_verified_evidence");
    assert.equal(
      kernel.complete({ action, approved: true, evidence: [{ ...verified, state: "unverified" }] }).status,
      "blocked",
    );
    assert.equal(
      kernel.complete({ action, approved: true, evidence: [{ ...verified, state: "failed" }] }).status,
      "blocked",
    );
    assert.equal(
      kernel.complete({ action, approved: true, evidence: [{ ...verified, source: "   " }] }).status,
      "blocked",
    );
    assert.equal(
      kernel.complete({ action, approved: true, evidence: [{ ...verified, checkedAt: "not-a-date" }] }).status,
      "blocked",
    );
    assert.deepEqual(kernel.complete({ action, approved: true, evidence: [verified] }), {
      status: "complete",
      reason: "verified_or_internal",
    });
  });

  it("treats a failed read-back as a veto unless the host opts into any verified item", () => {
    const kernel = billingKernel();
    const action = kernel.route({
      id: "act_email",
      title: "Send status email",
      risk: "external_write",
      capability: "send_email",
      externalEffect: true,
    });
    const mixed = [verified, { ...verified, state: "failed" as const, source: "mailbox" }];
    assert.equal(
      kernel.complete({ action, approved: true, evidence: mixed }).reason,
      "evidence_not_fully_verified",
    );

    const loose = billingKernel({ evidencePolicy: "any_verified" });
    const looseAction = loose.route({
      id: "act_email",
      title: "Send status email",
      risk: "external_write",
      capability: "send_email",
      externalEffect: true,
    });
    assert.equal(loose.complete({ action: looseAction, approved: true, evidence: mixed }).status, "complete");
  });

  it("fails closed when a read action is actually an external effect", () => {
    const kernel = billingKernel();
    const action = kernel.route({
      id: "hook",
      title: "Post the webhook",
      risk: "read",
      externalEffect: true,
      agentId: "support",
      capability: "send_email",
    });
    assert.equal(kernel.authorize(action).reason, "explicit_approval_required");
    assert.equal(kernel.complete({ action, approved: true }).status, "blocked");
    assert.equal(kernel.complete({ action, approved: true, evidence: [verified] }).status, "complete");
  });

  it("requires evidence for external_write even when the flag was left off", () => {
    const kernel = billingKernel();
    const action: KernelAction = {
      id: "send",
      agentId: "support",
      title: "Send status email",
      risk: "external_write",
    };
    assert.equal(kernel.complete({ action, approved: true }).status, "blocked");
    assert.equal(kernel.complete({ action, approved: true, evidence: [verified] }).status, "complete");
  });

  it("blocks unclassified money and privileged actions, and allows a contracted internal one", () => {
    const kernel = billingKernel();
    const money = kernel.route({
      id: "ledger",
      title: "Record internal adjustment",
      risk: "money",
      agentId: "billing",
    });
    const privileged = kernel.route({
      id: "role",
      title: "Change a role",
      risk: "privileged",
      agentId: "billing",
    });
    assert.equal(kernel.authorize(money).allowed, false);
    assert.equal(
      kernel.complete({ action: money, approved: true }).reason,
      "money_or_privileged_requires_external_effect_or_contract",
    );
    assert.equal(
      kernel.complete({ action: privileged }).reason,
      "money_or_privileged_requires_external_effect_or_contract",
    );

    const external = kernel.route({
      id: "refund",
      title: "Refund invoice",
      risk: "money",
      externalEffect: true,
      capability: "refund_payment",
    });
    assert.equal(kernel.complete({ action: external, approved: true }).reason, "external_effect_requires_verified_evidence");
    assert.equal(kernel.complete({ action: external, approved: true, evidence: [verified] }).status, "complete");

    const classified = billingKernel({
      agents: [
        { id: "chief", purpose: "Own the user goal", keywords: [], capabilities: ["route"] },
        { id: "billing", purpose: "Invoices", keywords: ["invoice"], capabilities: ["adjust_ledger"] },
      ],
      actionContracts: [
        { id: "route", risk: "read" },
        { id: "adjust_ledger", risk: "money", externalEffect: false },
      ],
    });
    const ledger = classified.route({
      id: "ledger",
      title: "Record internal adjustment",
      risk: "money",
      capability: "adjust_ledger",
    });
    assert.equal(classified.complete({ action: ledger, approved: true }).status, "complete");
  });

  it("rejects a non-boolean approval", () => {
    const kernel = billingKernel();
    const action = kernel.route({ id: "list", title: "List invoices", risk: "money", agentId: "billing" });
    assert.throws(
      () => kernel.authorize(action, "yes" as unknown as boolean),
      { message: "invalid_approval" },
    );
  });
});

describe("demo mode and emergency stop", () => {
  it("never marks an evidenced external action complete in demo mode", () => {
    const kernel = billingKernel({ mode: "demo" });
    const action = kernel.route({
      id: "act_email",
      title: "Send status email",
      risk: "external_write",
      capability: "send_email",
      externalEffect: true,
    });
    assert.equal(kernel.complete({ action, evidence: [verified] }).status, "needs_approval");
    assert.equal(kernel.complete({ action, approved: true }).status, "blocked");
    assert.deepEqual(kernel.complete({ action, approved: true, evidence: [verified] }), {
      status: "demo",
      reason: "demo_mode_not_live",
    });

    const read = kernel.route({ id: "list", title: "List invoices", risk: "read", agentId: "billing" });
    assert.equal(kernel.complete({ action: read }).status, "complete");
  });

  it("stops completion and keeps planning available", () => {
    const kernel = billingKernel();
    const action = kernel.route({
      id: "act_email",
      title: "Send status email",
      risk: "external_write",
      capability: "send_email",
      externalEffect: true,
    });
    kernel.stop("owner pressed stop");
    assert.equal(kernel.isStopped(), true);
    assert.equal(kernel.plan("send an invoice").chiefAgentId, "chief");
    assert.equal(kernel.authorize(action, true).allowed, true);
    assert.deepEqual(kernel.complete({ action, approved: true, evidence: [verified] }), {
      status: "stopped",
      reason: "owner pressed stop",
    });
    kernel.resume();
    assert.equal(kernel.isStopped(), false);
    assert.equal(kernel.complete({ action, approved: true, evidence: [verified] }).status, "complete");
  });

  it("does not share stop or audit state across products", () => {
    const first = billingKernel({ productId: "billing" });
    const second = billingKernel({ productId: "support" });
    first.stop();
    const action = second.route({ id: "list", title: "List invoices", risk: "read", agentId: "billing" });
    assert.equal(second.isStopped(), false);
    assert.equal(second.complete({ action }).status, "complete");
    assert.equal(first.audit().events.some((event) => event.productId === "support"), false);
    assert.ok(second.audit().events.every((event) => event.productId === "support"));
  });
});

describe("audit", () => {
  it("records plan, route, authorization, and completion without evidence payloads", () => {
    const kernel = billingKernel();
    kernel.plan("Send an invoice");
    const action = kernel.route({
      id: "act_email",
      title: "Send status email",
      risk: "external_write",
      capability: "send_email",
      externalEffect: true,
    });
    kernel.complete({ action, approved: true, evidence: [verified] });
    assert.deepEqual(
      kernel.audit().events.map((event) => event.type),
      ["plan", "route", "authorize", "complete"],
    );
    const plan = kernel.audit().events[0];
    assert.ok(plan);
    assert.equal(plan.detail.goal, "Send an invoice");
    const completion = kernel.audit().events[3];
    assert.ok(completion);
    assert.equal(completion.detail.verifiedCount, 1);
    assert.equal(JSON.stringify(completion.detail).includes("msg_123"), false);
  });

  it("redacts pasted secrets in the goal and caps retained events", () => {
    const kernel = billingKernel({ auditLimit: 2 });
    const accessKey = "AKIA" + "IOSFODNN7EXAMPLE";
    const token = "ghp_" + "abcdefghijklmnopqrstuvwxyz";
    kernel.plan("a".repeat(600));
    kernel.plan(`use ${accessKey} and ${token} please`);
    const snapshot = kernel.audit();
    const truncated = snapshot.events[0];
    const secretEvent = snapshot.events[1];
    assert.ok(truncated);
    assert.ok(secretEvent);
    assert.equal(truncated.detail.goalChars, 600);
    assert.equal(typeof truncated.detail.goal, "string");
    assert.equal((truncated.detail.goal as string).length, 501);
    assert.equal(JSON.stringify(secretEvent).includes(accessKey), false);
    assert.equal(JSON.stringify(secretEvent).includes(token), false);
    assert.match(String(secretEvent.detail.goal), /\[redacted-access-key\]/);
    assert.match(String(secretEvent.detail.goal), /\[redacted-token\]/);

    kernel.plan("latest goal");
    const capped = kernel.audit();
    assert.equal(capped.dropped, 1);
    assert.equal(capped.events.length, 2);
    assert.equal(capped.events[1]?.detail.goal, "latest goal");
  });

  it("returns a snapshot the caller cannot append to", () => {
    const kernel = billingKernel();
    kernel.plan("invoice");
    assert.throws(() => {
      (kernel.audit().events as Array<unknown>).push({});
    });
  });

  it("redacts private text and drops the goal when a host redactor throws", () => {
    const kernel = billingKernel();
    const email = "person@example.com";
    const phone = "+14155550100";
    const card = "4242" + "4242" + "4242" + "4242";
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"signaturevalue"}`;
    kernel.plan(`Email ${email}, call ${phone}, card ${card}, password=correct-horse, ${jwt}`);
    const goal = String(kernel.audit().events[0]?.detail.goal);
    assert.match(goal, /\[redacted-email\]/);
    assert.match(goal, /\[redacted-phone\]/);
    assert.match(goal, /\[redacted-card\]/);
    assert.match(goal, /password=\[redacted-secret\]/);
    assert.match(goal, /\[redacted-token\]/);
    assert.equal(goal.includes(email), false);
    assert.equal(goal.includes(phone), false);
    assert.equal(goal.includes(card), false);
    assert.equal(goal.includes("correct-horse"), false);
    assert.equal(goal.includes(jwt), false);

    const custom = billingKernel({}, {
      redact(text: string) {
        return text.replaceAll("Project Falcon", "[redacted-private]");
      },
    });
    custom.plan("Project Falcon needs an invoice");
    assert.equal(JSON.stringify(custom.audit()).includes("Project Falcon"), false);
    assert.match(String(custom.audit().events[0]?.detail.goal), /\[redacted-private\]/);

    const failing = billingKernel({}, {
      redact() {
        throw new Error("boom");
      },
    });
    failing.plan("secret plan about the invoice");
    assert.equal(failing.audit().events[0]?.detail.goal, "[redaction-failed]");
    assert.equal(JSON.stringify(failing.audit()).includes("secret plan"), false);
  });
});

describe("action contracts", () => {
  it("applies an external-effect contract when the caller omits the flag", () => {
    const kernel = contractedKernel();
    const action = kernel.route({
      id: "act_email",
      title: "Send status email",
      risk: "external_write",
      capability: "send_email",
    });
    assert.equal(action.externalEffect, true);
    assert.equal(kernel.complete({ action, approved: true }).status, "blocked");
    assert.equal(kernel.complete({ action, approved: true, evidence: [verified] }).status, "complete");
  });

  it("rejects a downgraded risk, an unknown capability, and a swapped agent", () => {
    const kernel = contractedKernel();
    assert.throws(
      () => kernel.route({ id: "1", title: "Send", risk: "read", capability: "send_email" }),
      { message: "action_contract_mismatch" },
    );
    assert.throws(
      () => kernel.route({ id: "1", title: "Send", risk: "external_write", capability: "missing" }),
      { message: "unknown_capability_contract" },
    );
    assert.throws(
      () => kernel.route({ id: "1", title: "Send", risk: "external_write", agentId: "support" }),
      { message: "capability_required" },
    );
    const action = kernel.route({
      id: "act_email",
      title: "Send status email",
      risk: "external_write",
      capability: "send_email",
    });
    action.agentId = "billing";
    assert.throws(
      () => kernel.complete({ action, approved: true, evidence: [verified] }),
      { message: "capability_mismatch" },
    );
  });

  it("requires a contract for every capability once the registry is enabled", () => {
    assert.throws(
      () => contractedKernel({
        actionContracts: [{ id: "route", risk: "read" }],
      }),
      { message: "capability_without_contract" },
    );
  });
});

describe("configuration integrity", () => {
  it("rejects unsafe or ambiguous policy and an incomplete roster", () => {
    for (const risk of ["external_write", "money", "privileged"] as const) {
      assert.throws(() => billingKernel({ autoAllow: [risk] }), { message: "unsafe_auto_allow" });
    }
    assert.throws(
      () => billingKernel({
        autoAllow: ["read"],
        alwaysRequireApproval: ["read", "external_write", "money", "privileged"],
      }),
      { message: "policy_conflict" },
    );
    assert.throws(
      () => billingKernel({
        agents: [{ id: "chief", purpose: "Own the user goal", keywords: [], capabilities: ["route"] }],
      }),
      { message: "specialist_required" },
    );
    assert.throws(
      () => billingKernel({
        agents: [
          { id: "chief", purpose: "Own the user goal", keywords: [], capabilities: ["route"] },
          { id: "chief", purpose: "Duplicate", keywords: ["invoice"], capabilities: ["create_invoice"] },
        ],
      }),
      { message: "duplicate_agent_id" },
    );
    assert.throws(() => billingKernel({ chiefAgentId: "missing" }), { message: "chief_agent_missing" });
    assert.throws(() => billingKernel({ mode: "LIVE" as unknown as "live" }), { message: "invalid_mode" });
  });

  it("copies and freezes policy so a caller cannot widen authority later", () => {
    const autoAllow: AgentRisk[] = ["read"];
    const billing = {
      id: "billing",
      purpose: "Invoices",
      keywords: ["invoice"],
      capabilities: ["create_invoice"],
    };
    const kernel = createAgentKernel({
      ...billingConfig(),
      autoAllow,
      alwaysRequireApproval: ["external_write", "money", "privileged"],
      agents: [
        { id: "chief", purpose: "Own the user goal", keywords: ["overview"], capabilities: ["route"] },
        billing,
        { id: "support", purpose: "Customer email", keywords: ["email"], capabilities: ["send_email"] },
      ],
    });
    autoAllow.push("internal_write");
    billing.keywords.push("zzzz");
    const note = kernel.route({ id: "note", title: "Record note", risk: "internal_write", agentId: "billing" });
    assert.equal(kernel.authorize(note).reason, "approval_required_by_default");
    assert.deepEqual(kernel.plan("zzzz").selectedAgentIds, ["chief"]);
    assert.throws(() => {
      (kernel.config.autoAllow as AgentRisk[]).push("money");
    });
    assert.throws(() => {
      (kernel.config.agents[1]?.keywords as string[]).push("secret");
    });
  });
});

describe("persistence adapters", () => {
  function emailAction(kernel: AgentKernel): KernelAction {
    return kernel.route({
      id: "act_email",
      title: "Send status email",
      risk: "external_write",
      capability: "send_email",
      externalEffect: true,
    });
  }

  it("replays a completed action for the same idempotency key and rejects a different action", () => {
    const kernel = billingKernel();
    const action = emailAction(kernel);
    const first = kernel.complete({
      action,
      approved: true,
      evidence: [verified],
      idempotencyKey: " email-1 ",
    });
    assert.equal(first.status, "complete");
    assert.equal(first.replayed, undefined);

    const replay = kernel.complete({ action, approved: true, idempotencyKey: "email-1" });
    assert.deepEqual(replay, { status: "complete", reason: "verified_or_internal", replayed: true });

    const other = kernel.route({
      id: "act_other",
      title: "Send another email",
      risk: "external_write",
      capability: "send_email",
      externalEffect: true,
    });
    assert.throws(
      () => kernel.complete({ action: other, approved: true, evidence: [verified], idempotencyKey: "email-1" }),
      { message: "idempotency_key_reused" },
    );
    assert.equal(kernel.complete({ action, idempotencyKey: "email-1" }).status, "needs_approval");
  });

  it("does not replay a completion while the stop switch is engaged", () => {
    const kernel = billingKernel();
    const action = emailAction(kernel);
    kernel.complete({ action, approved: true, evidence: [verified], idempotencyKey: "email-2" });
    kernel.stop();
    const stopped = kernel.complete({ action, approved: true, idempotencyKey: "email-2" });
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.replayed, undefined);
  });

  it("shares a stop switch, audit log, and idempotency store across kernels", () => {
    const stopSwitch = createMemoryStopSwitch();
    const auditLog = createMemoryAuditLog(10);
    const idempotency = createMemoryIdempotencyStore();
    const adapters = { stopSwitch, auditLog, idempotency };
    const first = billingKernel({ productId: "billing" }, adapters);
    const second = billingKernel({ productId: "support" }, adapters);
    const action = emailAction(first);
    first.complete({ action, approved: true, evidence: [verified], idempotencyKey: "shared-email" });
    const replay = second.complete({ action, approved: true, idempotencyKey: "shared-email" });
    assert.equal(replay.replayed, true);
    assert.equal(first.audit().events.length, second.audit().events.length);
    assert.ok(first.audit().events.some((event) => event.productId === "support"));

    first.stop("halt both");
    assert.equal(second.isStopped(), true);
    const read = second.route({ id: "list", title: "List invoices", risk: "read", agentId: "billing" });
    assert.equal(second.complete({ action: read }).reason, "halt both");
  });

  it("lets a supplied audit log own retention", () => {
    const kernel = billingKernel({ auditLimit: 50 }, { auditLog: createMemoryAuditLog(1) });
    kernel.plan("one");
    kernel.plan("two");
    assert.equal(kernel.audit().dropped, 1);
    assert.equal(kernel.audit().events[0]?.detail.goal, "two");
  });

  it("keeps the first idempotency record", () => {
    const store = createMemoryIdempotencyStore();
    const first = {
      fingerprint: "a",
      result: { status: "complete" as const, reason: "verified_or_internal" },
    };
    const second = {
      fingerprint: "b",
      result: { status: "blocked" as const, reason: "external_effect_requires_verified_evidence" },
    };
    assert.equal(store.putIfAbsent("k", first).inserted, true);
    const again = store.putIfAbsent("k", second);
    assert.equal(again.inserted, false);
    assert.equal(again.record.fingerprint, "a");
    assert.equal(store.get("missing"), undefined);
  });
});
