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
    runningTurn: null,
  });
});

test("turnRunning is reported and is strictly a boolean", () => {
  const runtime = { conversationId: "x", dashboardUrl: "u", dashboardName: null };
  // strictEqual, not equal: a truthy non-boolean (a string, an object) must not
  // pass here - the client branches on this value.
  assert.strictEqual(describeActiveConversation(runtime, true).turnRunning, true);
  assert.strictEqual(describeActiveConversation(runtime, undefined).turnRunning, false);
  assert.strictEqual(describeActiveConversation(runtime, "yes").turnRunning, true);
  assert.strictEqual(typeof describeActiveConversation(runtime, 1).turnRunning, "boolean");
});

test("the in-flight turn is reported with its id and question", () => {
  const runtime = { conversationId: "c1", dashboardUrl: "u", dashboardName: null };
  const out = describeActiveConversation(runtime, true, { id: "turn-9", question: "Which publisher leads?" });
  assert.deepEqual(out.runningTurn, { id: "turn-9", question: "Which publisher leads?" });
});

test("runningTurn is null when no turn is in flight, and never undefined", () => {
  const runtime = { conversationId: "c1", dashboardUrl: "u", dashboardName: null };
  const out = describeActiveConversation(runtime, false);
  assert.strictEqual(out.runningTurn, null);
  assert.ok("runningTurn" in out, "key must survive JSON serialization");
});

test("a turn with no recorded question still reports its id", () => {
  // The id is what makes the event-bus subscription possible; a missing
  // question must not cost us that.
  const runtime = { conversationId: "c1", dashboardUrl: "u", dashboardName: null };
  const out = describeActiveConversation(runtime, true, { id: "turn-9" });
  assert.strictEqual(out.runningTurn.id, "turn-9");
  assert.strictEqual(out.runningTurn.question, null);
});

test("a missing dashboard name is null, not undefined", () => {
  const runtime = { conversationId: "x", dashboardUrl: "u" };
  const out = describeActiveConversation(runtime, false);
  assert.equal(out.dashboardName, null);
  assert.ok("dashboardName" in out);
});
