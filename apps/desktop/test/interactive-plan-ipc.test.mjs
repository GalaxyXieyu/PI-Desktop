import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

function load(relative, imports, globals = {}) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", ...Object.keys(globals), outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
    return imports[id];
  }, module.exports, module, ...Object.values(globals));
  return module.exports;
}
const decoder = load("../../../packages/host-runtime/src/plan-execution.ts", { "@pi-desktop/shared": shared });
const { registerAgentIpc } = load("../electron/main/ipc/agent-ipc.ts", {
  "@pi-desktop/shared": shared,
  "@pi-desktop/host-runtime": decoder,
  "@pi-desktop/agent-runtime": {},
  "../composer-mcp": {},
  "../oauth": {},
  "../prompt-attachments": {},
  "../session-references": {},
  "../prompt-enhancement-timeout": {},
});
const legacy = {
  proposalId: "p", sessionId: "s", turnId: "t", toolCallId: "tc",
  action: "approve", version: 1, targetPermissionMode: "ask",
};
const steps = [{ id: "first", title: "First", dependsOn: [] }];
const design = { framework: "react", colorSystem: { primary: ["#AABBCC"] } };
const execution = {
  id: "e", proposalId: "p", sessionId: "s", kind: "plan", title: "Plan",
  plan: "# Plan", question: "Build?", artifact: { relativePath: ".pi/plan/p.md", sha256: "hash", sizeBytes: 6 },
  targetPermissionMode: "ask", state: "queued", steps, design,
};
const proposal = { id: "p", sessionId: "s", steps, design, resolvedSteps: [], resolvedDesign: {} };
function harness() {
  const handlers = new Map();
  const calls = [];
  const dispatched = [];
  registerAgentIpc({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => ({ call: async (method, params) => {
      calls.push({ method, params });
      return method === "plans.get" ? { proposal } : { proposal, execution };
    } }),
    getSidecar: () => null,
    getAgentHostBridge: () => null,
    dispatchApprovedPlan: async (value) => { dispatched.push(value); },
    dispatchExecutionForProposal: async () => assert.fail("unexpected execution fallback"),
  });
  return { handlers, calls, dispatched, resolve: handlers.get(shared.IPC.invoke.plansResolve) };
}

test("approval forwards normalized revisions and retains effective metadata for dispatch", async () => {
  const { resolve, calls, dispatched } = harness();
  await resolve({ ...legacy, revisedSteps: [{ id: " first ", title: " First ", detail: " " }],
    revisedDesign: { framework: " REACT ", colorSystem: { primary: ["#aabbcc"] } }, revisedMarkdown: "# Edited\n",
    targetModel: { providerId: " fast ", modelId: " flash " }, extra: true });
  assert.deepEqual(calls, [{ method: "plans.resolve", params: { ...legacy, revisedSteps: steps, revisedDesign: design,
    revisedMarkdown: "# Edited\n", targetModel: { providerId: "fast", modelId: "flash" } } }]);
  assert.deepEqual(dispatched, [execution]);
});

test("legacy approval wire params stay byte-identical and explicit clears stay present", async () => {
  const { resolve, calls } = harness();
  await resolve(legacy);
  assert.equal(JSON.stringify(calls[0].params), JSON.stringify(legacy));
  await resolve({ ...legacy, revisedSteps: [], revisedDesign: {} });
  assert.deepEqual(calls[1].params, { ...legacy, revisedSteps: [], revisedDesign: {} });
});

test("legacy rejection never dispatches execution", async () => {
  const { resolve, calls, dispatched } = harness();
  const request = { ...legacy, action: "reject" };
  await resolve(request);
  const { targetPermissionMode: _mode, ...params } = request;
  assert.deepEqual(calls, [{ method: "plans.resolve", params }]);
  assert.deepEqual(dispatched, []);
});

test("invalid and rejected revisions fail before any host call", async () => {
  const { resolve, calls } = harness();
  for (const [revision, code] of [
    [{ revisedSteps: null }, "PLAN_STEPS_INVALID"],
    [{ revisedSteps: [{ id: "x", title: "X", dependsOn: ["x"] }] }, "PLAN_STEPS_INVALID"],
    [{ revisedDesign: { colorSystem: { text: ["red"] } } }, "PLAN_DESIGN_INVALID"],
    [{ revisedDesign: null }, "PLAN_DESIGN_INVALID"],
    [{ revisedMarkdown: 42 }, "PLAN_INVALID_ARGUMENT"],
    [{ targetModel: { providerId: "fast" } }, "PLAN_INVALID_ARGUMENT"],
    [{ targetModel: null }, "PLAN_INVALID_ARGUMENT"],
  ]) await assert.rejects(resolve({ ...legacy, ...revision }), { errorCode: code });
  for (const revision of [{ revisedSteps: [] }, { revisedDesign: {} }, { revisedSteps: null }, { revisedMarkdown: "# Edited" },
    { targetModel: { providerId: "fast", modelId: "flash" } }]) {
    await assert.rejects(resolve({ ...legacy, action: "reject", ...revision }), { errorCode: "PLAN_INVALID_ARGUMENT" });
  }
  assert.deepEqual(calls, []);
});

test("plansGet validates string identities and whitelists only host read fields", async () => {
  const { handlers, calls } = harness();
  const get = handlers.get(shared.IPC.invoke.plansGet);
  assert.equal(typeof get, "function");
  assert.equal(shared.IPC_WHITELIST.has(shared.IPC.invoke.plansGet), true);
  for (const input of [undefined, null, {}, { sessionId: 1, proposalId: "p" },
    { sessionId: "s", proposalId: [] }, { sessionId: " ", proposalId: "p" }, { sessionId: "s", proposalId: "" }]) {
    await assert.rejects(get(input), { errorCode: "PLAN_INVALID_ARGUMENT" });
  }
  assert.deepEqual(calls, []);
  await get({ sessionId: " s ", proposalId: " p ", extra: true });
  assert.deepEqual(calls, [{ method: "plans.get", params: { sessionId: "s", proposalId: "p" } }]);
});

test("renderer get/approve/events preserve metadata through the real preload allowlist", async () => {
  const { handlers, dispatched } = harness();
  let bridge;
  const listeners = new Map();
  load("../electron/preload/index.ts", {
    electron: {
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: {
        invoke: async (channel, ...args) => ({ ok: true, data: await handlers.get(channel)(...args) }),
        on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel) => listeners.delete(channel),
      }, webUtils: {},
    }, "@pi-desktop/shared/protocol": shared,
  });
  const { api } = load("../src/lib/api.ts", { "@pi-desktop/shared": shared, "./plan-history": {} }, { window: { piDesktop: bridge } });
  assert.deepEqual(await api.getPlan({ sessionId: "s", proposalId: "p" }), { proposal });
  await api.resolvePlan({ ...legacy, revisedSteps: steps, revisedDesign: design });
  assert.deepEqual(dispatched, [execution]);
  let event;
  const unsubscribe = api.onPlansChanged((value) => { event = value; });
  listeners.get(shared.IPC.event.plansChanged)({}, { sessionId: "s", proposal, execution });
  assert.deepEqual(event.proposal, proposal);
  assert.deepEqual(event.execution, execution);
  unsubscribe();
});
