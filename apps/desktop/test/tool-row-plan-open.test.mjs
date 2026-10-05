import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

// Fixtures satisfy `planSubmission`: the snapshot proposal echoes the call and
// carries the full contract fields (id, title, markdown, sessionId, kind).
const proposal = (overrides = {}) => ({
  id: "p1",
  title: "API plan",
  markdown: "# Plan\n- step\n",
  sessionId: "s1",
  toolCallId: "call-1",
  kind: "plan",
  status: "pending",
  version: 1,
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  ...overrides,
});
const message = (overrides = {}) => ({
  id: "t1",
  role: "tool",
  content: "submitted",
  status: "complete",
  createdAt: "2026-10-04T00:00:00.000Z",
  toolName: "SubmitPlan",
  toolCallId: "call-1",
  toolArgs: {},
  toolStatus: "success",
  toolResult: { details: { proposal: proposal() } },
  ...overrides,
});

async function rows(t) {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  return (value, props = {}) => ssr.render(createElement(ToolRow, { message: value, ...props }));
}

const viewPlan = /data-testid="plan-tool-view-plan"/;

test("SubmitPlan renders View plan in the history card heading", async (t) => {
  const row = await rows(t);
  const html = row(message());
  assert.match(html, viewPlan);
  assert.match(html, /plan-history-heading[\s\S]*data-testid="plan-tool-view-plan"/);
  assert.match(html, /<button[^>]*data-testid="plan-tool-view-plan"[^>]*>View plan<\/button>/);
});

test("SubmitGoal does not render View plan", async (t) => {
  const row = await rows(t);
  const html = row(message({
    toolName: "SubmitGoal",
    toolResult: { details: { proposal: proposal({ id: "g1", kind: "goal" }) } },
  }));
  assert.doesNotMatch(html, viewPlan);
});

test("Read does not render View plan even with proposal-shaped details", async (t) => {
  const row = await rows(t);
  assert.doesNotMatch(row(message({ toolName: "Read" })), viewPlan);
});

test("SubmitPlan without valid proposal details does not render View plan", async (t) => {
  const row = await rows(t);
  assert.doesNotMatch(row(message({ toolResult: undefined })), viewPlan);
  for (const value of [
    null,
    {},
    { id: 1, title: "T", markdown: "m" },
    proposal({ markdown: undefined }),
    proposal({ toolCallId: "other" }),
  ]) {
    assert.doesNotMatch(row(message({ toolResult: { details: { proposal: value } } })), viewPlan);
  }
});

test("topology rows do not render View plan", async (t) => {
  const row = await rows(t);
  assert.doesNotMatch(row(message(), { variant: "topology" }), viewPlan);
});
