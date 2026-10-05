import { deepStrictEqual } from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { assert, assertToolSuccess, expectRpcError, shortJson } from "./assert.mjs";
import { withScenario } from "./fixture.mjs";
import { enterPlan, resolveParams, resolvePlan, submitPlan, verifyArtifact } from "./plan.mjs";
import { beginTurn, createSession, endTurn } from "./session.mjs";
import { waitFor } from "./wait.mjs";

const title = "Interactive plan contract";
const question = "Build the approved revision?";
const markdown = "\n  # Interactive plan\r\n\n- Original Markdown stays unchanged.  \n\n  ";
const steps = [
  { id: "setup", title: "Set up project", dependsOn: [] },
  { id: "old-ui", title: "Build old UI", dependsOn: ["setup"] },
  { id: "verify", title: "Verify result", dependsOn: ["old-ui"] },
];
const design = {
  framework: "react",
  componentLibrary: "shadcn",
  styleKeywords: ["Minimal"],
  fontSystem: { fontFamily: "Inter" },
  colorSystem: { primary: ["#ABCDEF"] },
};
const revisedSteps = [
  steps[0],
  { id: "new-ui", title: "Build replacement UI", dependsOn: ["setup"] },
  { ...steps[2], dependsOn: ["new-ui"] },
];
const revisedDesign = {
  ...design,
  componentLibrary: "mui",
  styleKeywords: ["Calm", "Accessible"],
  fontSystem: { fontFamily: "Roboto" },
  colorSystem: { primary: ["#123ABC"] },
};
const revision = { revisedSteps, revisedDesign };

async function getProposal(ctx, proposal) {
  const result = await ctx.host.call("plans.get", {
    sessionId: proposal.sessionId, proposalId: proposal.id,
  });
  assert(result.proposal, shortJson(result));
  return result.proposal;
}

async function getTodos(ctx, sessionId) {
  return ctx.host.call("todos.get", { sessionId });
}

function todoEvents(ctx, sessionId) {
  return ctx.host.matchingNotifications("todos.changed", (note) => note.params?.sessionId === sessionId);
}

async function pendingPlan(ctx, metadata = {}, seedChecklist = false) {
  const session = await createSession(ctx.host, ctx.workspace, title, "agent");
  const turnId = await beginTurn(ctx.host, session.id);
  if (seedChecklist) {
    const toolCallId = "ip-seed-checklist";
    const result = await ctx.host.call("tools.execute", {
      sessionId: session.id, turnId, toolCallId, toolName: "TodoWrite", mode: "agent",
      args: { todos: [{ content: "Keep existing work", status: "in_progress", priority: "high" }] },
    });
    assertToolSuccess(result, toolCallId);
    const snapshot = await getTodos(ctx, session.id);
    deepStrictEqual(snapshot.todos, [{ content: "Keep existing work", status: "in_progress", priority: "high" }]);
  }
  await enterPlan(ctx.host, session.id, turnId, "ip-enter");
  const proposal = await submitPlan(ctx.host, session.id, turnId, `ip-submit-${session.id}`, title, markdown, question, metadata);
  // Approval happens between turns: seeding must not require a running turn.
  await endTurn(ctx.host, turnId);
  return proposal;
}

async function approve(ctx, proposal, changes = {}) {
  return ctx.host.call("plans.resolve", { ...resolveParams(proposal, "approve", "ask"), ...changes });
}

async function assertSeeded(ctx, proposal, before, effectiveSteps) {
  const snapshot = await getTodos(ctx, proposal.sessionId);
  assert(snapshot.sessionId === proposal.sessionId, shortJson(snapshot));
  assert(snapshot.revision === before.revision + 1, "approval must advance checklist revision once");
  deepStrictEqual(snapshot.todos, effectiveSteps.map((step) => ({
    content: step.title, status: "pending", priority: "medium", stepId: step.id,
  })));
  await waitFor(() => todoEvents(ctx, proposal.sessionId).length > 0, 5_000, "committed plan checklist notification");
  deepStrictEqual(todoEvents(ctx, proposal.sessionId).map((note) => note.params), [snapshot]);
  return snapshot;
}

async function assertExecution(ctx, resolved, effectiveSteps, effectiveDesign) {
  assert(resolved.proposal?.status === "approved", shortJson(resolved));
  assert(resolved.execution?.state === "queued", shortJson(resolved));
  const sessionId = resolved.proposal.sessionId;
  const queued = await ctx.host.call("plans.queuedExecutions", { sessionId });
  deepStrictEqual(queued.executions, [resolved.execution]);
  const claimed = await ctx.host.call("plans.claimExecution", { executionId: resolved.execution.id });
  assert(claimed.execution?.state === "running", shortJson(claimed));
  for (const execution of [resolved.execution, claimed.execution]) {
    if (effectiveSteps === undefined) assert(!Object.hasOwn(execution, "steps"), "empty effective steps must be omitted");
    else deepStrictEqual(execution.steps, effectiveSteps);
    if (effectiveDesign === undefined) assert(!Object.hasOwn(execution, "design"), "empty effective design must be omitted");
    else deepStrictEqual(execution.design, effectiveDesign);
    assert(execution.plan === markdown, "execution changed the approved Markdown");
  }
  await ctx.host.call("plans.finishExecution", { executionId: resolved.execution.id, status: "completed" });
  const current = await ctx.host.call("session.get", { id: sessionId });
  assert(current.session?.mode === "agent", shortJson(current));
}

async function artifactEntries(ctx) {
  try {
    return await readdir(join(ctx.workspace, ".pi", "plan"), { recursive: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function assertSubmissionUntouched(ctx, sessionId) {
  deepStrictEqual(await artifactEntries(ctx), [], "invalid submission published an artifact");
  const pending = await ctx.host.call("plans.pending", { sessionId });
  deepStrictEqual(pending.plans, [], "invalid submission wrote a pending proposal");
  assert(pending.state === "planning", shortJson(pending));
}

async function normalizedSubmission(ctx) {
  const proposal = await pendingPlan(ctx, {
    steps: [
      { id: " setup ", title: " Set up project ", detail: "  " },
      { id: "old-ui", title: " Build old UI ", dependsOn: [" setup "] },
      steps[2],
    ],
    design: {
      framework: " React ", componentLibrary: " SHADCN ", styleKeywords: [" Minimal "],
      fontSystem: { fontFamily: " Inter " },
      colorSystem: { primary: ["#abcdef"], background: [], text: [], functional: [] },
    },
  });
  const fetched = await getProposal(ctx, proposal);
  const pending = await ctx.host.call("plans.pending", { sessionId: proposal.sessionId });
  deepStrictEqual(fetched, proposal);
  deepStrictEqual(pending.plans, [proposal]);
  deepStrictEqual(fetched.steps, steps);
  deepStrictEqual(fetched.design, design);
  assert(!Object.hasOwn(fetched, "resolvedSteps") && !Object.hasOwn(fetched, "resolvedDesign"), "pending plan has a revision");
  await verifyArtifact(ctx, fetched, markdown, title, question);
  await resolvePlan(ctx.host, proposal, "reject");
  return "submit/get/pending normalized; artifact bytes and hash unchanged";
}

async function invalidSubmission(ctx) {
  const session = await createSession(ctx.host, ctx.workspace, title, "plan");
  const turnId = await beginTurn(ctx.host, session.id);
  const input = { sessionId: session.id, turnId, toolCallId: "ip-invalid", kind: "plan", title, markdown, question };
  await expectRpcError(() => ctx.host.call("plans.submit", {
    ...input,
    steps: [{ id: "a", title: "A", dependsOn: ["b"] }, { id: "b", title: "B", dependsOn: ["a"] }],
  }), ["PLAN_STEPS_INVALID"]);
  await assertSubmissionUntouched(ctx, session.id);
  await expectRpcError(() => ctx.host.call("plans.submit", {
    ...input, steps, design: { colorSystem: { primary: ["#abc"] } },
  }), ["PLAN_DESIGN_INVALID"]);
  await assertSubmissionUntouched(ctx, session.id);
  await endTurn(ctx.host, turnId);
  return "cycle and invalid color refused before artifact/proposal publication";
}

async function goalMetadata(ctx) {
  const session = await createSession(ctx.host, ctx.workspace, title, "agent");
  const turnId = await beginTurn(ctx.host, session.id);
  await ctx.host.call("plans.enter", { sessionId: session.id, turnId, toolCallId: "ip-goal-enter", kind: "goal" });
  await expectRpcError(() => ctx.host.call("plans.submit", {
    sessionId: session.id, turnId, toolCallId: "ip-goal-submit", kind: "goal", title, markdown, question, steps,
  }), ["PLAN_METADATA_UNSUPPORTED"]);
  await assertSubmissionUntouched(ctx, session.id);
  await endTurn(ctx.host, turnId);
  return "Goal steps refused without side effects";
}

async function revisedApproval(ctx) {
  const proposal = await pendingPlan(ctx, { steps, design }, true);
  const before = await getTodos(ctx, proposal.sessionId);
  ctx.host.clearNotifications();
  const resolved = await approve(ctx, proposal, revision);
  const fetched = await getProposal(ctx, proposal);
  deepStrictEqual(fetched, resolved.proposal);
  deepStrictEqual(fetched.steps, steps);
  deepStrictEqual(fetched.design, design);
  deepStrictEqual(fetched.resolvedSteps, revisedSteps);
  deepStrictEqual(fetched.resolvedDesign, revisedDesign);
  await assertSeeded(ctx, proposal, before, revisedSteps);
  await assertExecution(ctx, resolved, revisedSteps, revisedDesign);
  await verifyArtifact(ctx, fetched, markdown, title, question);
  return "add/delete/dependency and design revisions persisted, queued/claimed, and seeded in order";
}

async function resolutionReplay(ctx) {
  const proposal = await pendingPlan(ctx, { steps, design });
  // A refused reject must leave a real pending approval intact, not merely
  // conflict with an already approved one.
  for (const changes of [{ revisedSteps }, { revisedDesign }]) {
    await expectRpcError(() => ctx.host.call("plans.resolve", {
      ...resolveParams(proposal, "reject"), ...changes,
    }), ["PLAN_INVALID_ARGUMENT"]);
    deepStrictEqual(await getProposal(ctx, proposal), proposal);
  }
  const resolved = await approve(ctx, proposal, revision);
  const snapshot = await getTodos(ctx, proposal.sessionId);
  ctx.host.clearNotifications();
  deepStrictEqual(await approve(ctx, proposal, revision), resolved);
  // Equality is on normalized revisions, not input formatting.
  deepStrictEqual(await approve(ctx, proposal, {
    revisedSteps: revisedSteps.map((step) => ({ ...step, title: ` ${step.title} ` })),
    revisedDesign: { ...revisedDesign, colorSystem: { primary: ["#123abc"] } },
  }), resolved);
  for (const changes of [
    { ...revision, revisedSteps: revisedSteps.map((step, index) => index === 0 ? { ...step, title: "Different setup" } : step) },
    { ...revision, revisedDesign: { ...revisedDesign, componentLibrary: "antd" } },
  ]) {
    await expectRpcError(() => approve(ctx, proposal, changes), ["PLAN_APPROVAL_CONFLICT"]);
  }
  deepStrictEqual(await getProposal(ctx, proposal), resolved.proposal);
  deepStrictEqual(await getTodos(ctx, proposal.sessionId), snapshot, "replay/conflict changed checklist");
  deepStrictEqual(todoEvents(ctx, proposal.sessionId), [], "replay/conflict re-emitted todos.changed");
  await assertExecution(ctx, resolved, revisedSteps, revisedDesign);
  return "identical/normalized replay stable; changed revisions conflict; reject revisions refused";
}

async function defaultApproval(ctx) {
  const proposal = await pendingPlan(ctx, { steps, design });
  const before = await getTodos(ctx, proposal.sessionId);
  ctx.host.clearNotifications();
  const resolved = await approve(ctx, proposal);
  await assertSeeded(ctx, proposal, before, steps);
  const fetched = await getProposal(ctx, proposal);
  assert(!Object.hasOwn(fetched, "resolvedSteps") && !Object.hasOwn(fetched, "resolvedDesign"), "omitted revision must stay absent");
  await assertExecution(ctx, resolved, steps, design);

  const legacy = await pendingPlan(ctx, {}, true);
  const legacyBefore = await getTodos(ctx, legacy.sessionId);
  ctx.host.clearNotifications();
  const legacyResolved = await approve(ctx, legacy);
  deepStrictEqual(await getTodos(ctx, legacy.sessionId), legacyBefore, "legacy approval touched checklist");
  deepStrictEqual(todoEvents(ctx, legacy.sessionId), [], "legacy approval emitted todos.changed");
  const legacyFetched = await getProposal(ctx, legacy);
  for (const key of ["steps", "design", "resolvedSteps", "resolvedDesign"]) {
    assert(!Object.hasOwn(legacyFetched, key), `legacy proposal added ${key}`);
  }
  await verifyArtifact(ctx, legacyFetched, markdown, title, question);
  await assertExecution(ctx, legacyResolved, undefined, undefined);
  return "omitted revision seeds submitted steps; legacy approval preserves existing checklist and wire shape";
}

async function clearedSteps(ctx) {
  const proposal = await pendingPlan(ctx, { steps, design }, true);
  const before = await getTodos(ctx, proposal.sessionId);
  ctx.host.clearNotifications();
  const resolved = await approve(ctx, proposal, { revisedSteps: [] });
  const fetched = await getProposal(ctx, proposal);
  deepStrictEqual(fetched.resolvedSteps, []);
  deepStrictEqual(fetched.steps, steps);
  deepStrictEqual(await getTodos(ctx, proposal.sessionId), before, "explicit clear touched existing checklist");
  deepStrictEqual(todoEvents(ctx, proposal.sessionId), [], "explicit clear emitted todos.changed");
  await assertExecution(ctx, resolved, undefined, design);
  await verifyArtifact(ctx, fetched, markdown, title, question);
  return "explicit [] persisted; no effective steps, no seeding, existing checklist unchanged";
}

export const interactivePlanScenarios = [
  ["E2E-PLAN-METADATA-submit-normalizes-steps-and-design", normalizedSubmission],
  ["E2E-PLAN-METADATA-invalid-submit-publishes-nothing", invalidSubmission],
  ["E2E-PLAN-METADATA-goal-rejects-structured-metadata", goalMetadata],
  ["E2E-PLAN-METADATA-approval-revision-seeds-checklist", revisedApproval],
  ["E2E-PLAN-METADATA-approval-replay-is-idempotent", resolutionReplay],
  ["E2E-PLAN-METADATA-omitted-revision-and-legacy-plans", defaultApproval],
  ["E2E-PLAN-METADATA-cleared-steps-keep-checklist", clearedSteps],
].map(([id, scenario]) => [id, (binary, tempRoot) => withScenario(id, scenario, binary, tempRoot)]);
