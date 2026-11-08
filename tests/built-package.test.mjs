import assert from "node:assert/strict";
import test from "node:test";
import { createAgentKernel } from "../dist/agent-kernel.js";

test("built package blocks unverified external completion", () => {
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
  const action = kernel.route({
    id: "act_email",
    title: "Send status email",
    risk: "external_write",
    capability: "send_email",
    externalEffect: true,
  });
  assert.equal(kernel.complete({ action, approved: true }).status, "blocked");
  assert.equal(
    kernel.complete({
      action,
      approved: true,
      evidence: [{
        source: "email-provider",
        state: "verified",
        checkedAt: "2026-11-08T00:00:00.000Z",
      }],
    }).status,
    "complete",
  );
});
