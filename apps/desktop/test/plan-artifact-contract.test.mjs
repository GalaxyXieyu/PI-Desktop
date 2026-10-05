import { readMainSourceSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRoot = (relativePath) =>
  readFile(new URL(`../../../${relativePath}`, import.meta.url), "utf8");
const readDesktop = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("Plan and Goal artifact runtime uses the terminating submit contract", async () => {
  const [runtime, submission, sidecar, main] = await Promise.all([
    readRoot("packages/agent-runtime/src/runtime.ts"),
    readRoot("packages/agent-runtime/src/plan-submission.ts"),
    readRoot("packages/agent-runtime/src/sidecar.ts"),
    readMainSourceSync(),
  ]);

  // One kind-keyed table names both submit tools, so Plan and Goal cannot drift.
  assert.match(runtime, /SUBMIT_TOOL_NAMES: Record<ProposalKind, string> = \{\s*plan: "SubmitPlan",\s*goal: "SubmitGoal",/);
  assert.match(runtime, /const name = SUBMIT_TOOL_NAMES\[kind\]/);
  assert.match(runtime, /parameters: submitToolParameters\(kind\)/);
  assert.match(submission, /title: Type\.String/);
  assert.match(submission, /markdown: Type\.String/);
  assert.match(submission, /question: Type\.String/);
  assert.match(runtime, /terminate: true/);
  assert.doesNotMatch(runtime, /ExitPlanMode/);
  assert.match(sidecar, /agent\.executeApprovedPlan/);
  assert.match(main, /plans\.queuedExecutions/);
  assert.match(main, /plans\.claimExecution/);
  assert.match(main, /plans\.finishExecution/);
  assert.match(main, /createNotification/);
  assert.match(main, /event\.toolName === "SubmitGoal"/);

  const resolveStart = main.indexOf("handle(IPC.invoke.plansResolve");
  const resolveSource = main.slice(resolveStart, main.indexOf("handle(IPC.invoke.pluginList", resolveStart));
  assert.match(resolveSource, /if \(action === "approve"\)/);
  assert.match(resolveSource, /if \(action === "approve"\) \{\s*const execution = executionFromResponse\(result\);\s*if \(execution\) \{\s*void dispatchApprovedPlan\(execution\)/);
});

test("Electron retains the stable Plan IPC names and protocol v12", async () => {
  const [protocol, main] = await Promise.all([
    readRoot("packages/shared/src/protocol.ts"),
    readMainSourceSync(),
  ]);

  assert.match(protocol, /PROTOCOL_VERSION = 12/);
  assert.match(protocol, /SCHEMA_VERSION = 16/);
  assert.match(protocol, /plansPending:/);
  assert.match(protocol, /plansResolve:/);
  assert.match(protocol, /plansChanged:/);
  assert.match(main, /IPC\.invoke\.plansPending/);
  assert.match(main, /IPC\.invoke\.plansResolve/);
});
