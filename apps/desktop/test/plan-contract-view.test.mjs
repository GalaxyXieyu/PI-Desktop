import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const step = (id, title, dependsOn = []) => ({ id, title, dependsOn });
const diamond = [
  step("a", "Prepare"),
  step("b", "Implement", ["a"]),
  step("c", "Verify", ["a"]),
  step("d", "Ship", ["b", "c"]),
];
const approved = {
  id: "p", sessionId: "s", version: 1, kind: "plan", status: "approved",
  title: "Ship feature", question: "Ready to build?", markdown: "Plan body.",
  executionState: "running",
  steps: [step("a", "Prepare"), step("b", "Implement", ["a"]), step("c", "Verify", ["a"])],
};
const todos = {
  s: {
    sessionId: "s", revision: 1, updatedAt: 0,
    todos: [
      { content: "Prepare", status: "completed", priority: "medium", stepId: "a" },
      { content: "Implement", status: "in_progress", priority: "medium", stepId: "b" },
    ],
  },
};

test("PlanFlowchart renders one node and edge per step/dependency with an accessible summary", async (t) => {
  const ssr = await slotSsr(t);
  const { PlanFlowchart } = await ssr.load("/src/components/plan/PlanFlowchart.tsx");
  const html = ssr.render(createElement(PlanFlowchart, { steps: diamond }));
  assert.equal((html.match(/data-testid="plan-flowchart-node"/g) ?? []).length, 4);
  assert.equal((html.match(/data-testid="plan-flowchart-edge"/g) ?? []).length, 4);
  assert.match(html, /data-testid="plan-flowchart"/);
  assert.match(html, /data-step-id="a" data-status="pending"/);
  assert.match(html, /role="img" aria-label="4 tasks in 3 stages"/);
  // Arrow marker and cubic bezier edges.
  assert.match(html, /<marker/);
  assert.match(html, /d="M \d+ \d+ C \d+ \d+, \d+ \d+, \d+ \d+"/);
  // Full titles stay available through <title> and the hidden ordered list.
  assert.equal((html.match(/<title>/g) ?? []).length, 4);
  const fallback = html.match(/<ol class="plan-flowchart-fallback">([\s\S]*?)<\/ol>/);
  assert.ok(fallback);
  for (const title of ["Prepare", "Implement", "Verify", "Ship"]) assert.ok(fallback[1].includes(title));
  // Long titles are ellipsized in the node label but kept in <title>.
  const long = ssr.render(createElement(PlanFlowchart, {
    steps: [step("a", "A very long task title that can never fit inside a node")],
  }));
  assert.match(long, /…/);
  assert.match(long, /<title>A very long task title that can never fit inside a node<\/title>/);
});

test("the approved contract shows live checklist progress, status circles and dependency chips", async (t) => {
  const ssr = await slotSsr(t);
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const { PlanTab } = await ssr.load("/src/components/workpanel/PlanTab.tsx");
  const previous = { ...useAppStore.getState() };
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({
    activeSessionId: "s", sessions: [{ id: "s", source: "local" }],
    pendingPlans: {}, planCheckpoints: { s: approved }, sessionTodos: todos,
  });
  const render = () => {
    Object.assign(useAppStore.getInitialState(), useAppStore.getState());
    return ssr.render(createElement(PlanTab, { sessionId: "s", proposalId: "p" }));
  };
  const html = render();
  // Progress line and execution badge.
  assert.match(html, /data-testid="plan-progress"/);
  assert.match(html, /data-testid="plan-progress-step" data-step-id="a" data-status="completed"/);
  assert.match(html, /1 \/ 3 done/);
  assert.match(html, />Running</);
  // Per-step status circles, no click handlers to tick items.
  assert.match(html, /class="plan-step-status plan-step-status--completed" role="img" aria-label="Completed"/);
  assert.match(html, /plan-step-status--in_progress/);
  assert.match(html, /plan-step-status--pending/);
  assert.equal((html.match(/plan-step-status--/g) ?? []).length, 3);
  // Dependency chips resolve to index + title.
  assert.match(html, /data-testid="plan-step-deps"/);
  assert.match(html, /Depends on/);
  assert.match(html, /1\. Prepare/);
  // The Tasks section carries the List / Graph toggle.
  assert.match(html, /data-testid="plan-view-toggle"/);
  assert.match(html, /aria-label="Tasks view"/);
  assert.match(html, />List</);
  assert.match(html, />Graph</);
  // A live todo update re-derives the progress on the next render.
  useAppStore.setState({
    sessionTodos: {
      s: { ...todos.s, todos: [...todos.s.todos, { content: "Verify", status: "completed", priority: "medium", stepId: "c" }] },
    },
  });
  const updated = render();
  assert.match(updated, /2 \/ 3 done/);
  assert.equal((updated.match(/plan-step-status--completed/g) ?? []).length, 2);
});

test("pending and step-less plans keep the previous behaviour", async (t) => {
  const ssr = await slotSsr(t);
  const { PlanDocument } = await ssr.load("/src/components/plan/PlanDocument.tsx");
  const render = (proposal) => ssr.render(createElement(PlanDocument, { proposal }));
  const pending = render({ ...approved, status: "pending", executionState: undefined });
  // No progress line or status circles before approval.
  assert.doesNotMatch(pending, /done<\/|plan-step-status--|>Running</);
  assert.match(pending, /aria-label="Tasks view"/);
  const legacy = render({
    id: "p", sessionId: "s", version: 1, kind: "plan", status: "approved",
    title: "Plain", question: "Ok?", markdown: "Body", executionState: "completed",
  });
  assert.doesNotMatch(legacy, /aria-label="Tasks"|done/);
});
