import test from "node:test";
import assert from "node:assert/strict";
import { describeActiveConversation } from "../src/activeConversation.js";

test("no runtime means no active conversation", () => {
  assert.deepEqual(describeActiveConversation(null, false), { active: false });
  assert.deepEqual(describeActiveConversation(undefined, true), { active: false });
});

test("an active runtime is described in full", () => {
  const runtime = {
    conversationId: "abc-123",
    dashboardUrl: "https://public.tableau.com/views/Book/Sheet",
    dashboardName: "Video Game Sales",
  };
  assert.deepEqual(describeActiveConversation(runtime, false), {
    active: true,
    conversationId: "abc-123",
    dashboardUrl: "https://public.tableau.com/views/Book/Sheet",
    dashboardName: "Video Game Sales",
    turnRunning: false,
  });
});

test("turnRunning is reported and always a boolean", () => {
  const runtime = { conversationId: "x", dashboardUrl: "u", dashboardName: null };
  assert.equal(describeActiveConversation(runtime, true).turnRunning, true);
  assert.equal(describeActiveConversation(runtime, undefined).turnRunning, false);
});

test("a missing dashboard name is null, not undefined", () => {
  const runtime = { conversationId: "x", dashboardUrl: "u" };
  const out = describeActiveConversation(runtime, false);
  assert.equal(out.dashboardName, null);
  assert.ok("dashboardName" in out);
});
