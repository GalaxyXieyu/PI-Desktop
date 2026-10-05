import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

// Drive the hook scheduler explicitly, as in todo-recovery.test.mjs. Only React
// scheduling is substituted; store selection, request ownership and API routing
// are production code. Host reads are the external boundary.
async function harness(t) {
  let state;
  const ref = { current: undefined };
  let effect;
  let mounted;
  globalThis.__planReadHooks = {
    useState: () => [state, (value) => { state = value; }],
    useRef: () => ref,
    useEffect: (run, deps) => { effect = { run, deps }; },
  };
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, logLevel: "silent",
    plugins: [{ name: "plan-read-scheduler", enforce: "pre", transform(source, id) {
      if (!id.endsWith("/use-plan-proposal.ts")) return;
      return source.replace('import { useEffect, useRef, useState } from "react";',
        'const { useEffect, useRef, useState } = globalThis.__planReadHooks;');
    } }],
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { usePlanProposal } = await server.ssrLoadModule("/src/features/plan/use-plan-proposal.ts");
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const { api } = await server.ssrLoadModule("/src/lib/api.ts");
  // Keep React's real dispatcher by invoking the hook from an SSR probe below.
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const requests = [];
  const originalGet = api.getPlan;
  api.getPlan = (input) => new Promise((resolve, reject) => requests.push({ input, resolve, reject }));
  const render = (sessionId, proposalId) => {
    Object.assign(useAppStore.getInitialState(), useAppStore.getState());
    let result;
    function Probe() { result = usePlanProposal(sessionId, proposalId); return null; }
    renderToStaticMarkup(createElement(Probe));
    if (!mounted || !effect.deps.every((dep, index) => Object.is(dep, mounted.deps[index]))) {
      mounted?.cleanup?.();
      mounted = { ...effect, cleanup: effect.run() };
    }
    return result;
  };
  t.after(async () => {
    mounted?.cleanup?.();
    api.getPlan = originalGet;
    delete globalThis.__planReadHooks;
    await server.close();
  });
  const set = (value) => useAppStore.setState(value);
  set({ sessions: [{ id: "a", source: "local" }, { id: "b", source: "local" }, { id: "r", source: "remote" }], pendingPlans: {}, planCheckpoints: {} });
  return { set, render, requests, settle: async () => { await Promise.resolve(); await Promise.resolve(); }, unmount: () => mounted?.cleanup?.() };
}

test("plan read loads once, ignores stale responses, and exposes errors", async (t) => {
  const h = await harness(t);
  assert.equal(h.render("a", "p").loading, true);
  h.render("a", "p");
  assert.equal(h.requests.length, 1);
  h.render("b", "q");
  assert.equal(h.requests.length, 2);
  h.requests[0].resolve({ proposal: { id: "p", sessionId: "a" } });
  await h.settle();
  assert.equal(h.render("b", "q").proposal, undefined);
  h.requests[1].resolve({ proposal: { id: "q", sessionId: "b", title: "Loaded" } });
  await h.settle();
  assert.equal(h.render("b", "q").proposal.title, "Loaded");
  h.render("a", "bad");
  h.requests[2].reject(new Error("Host offline"));
  await h.settle();
  assert.equal(h.render("a", "bad").failed, true);
  h.render("a", "bad");
  assert.equal(h.requests.length, 3);
});

test("store data wins over pending reads and remote sessions never fetch", async (t) => {
  const h = await harness(t);
  assert.equal(h.render("r", "p").failed, true);
  assert.equal(h.requests.length, 0);
  const proposal = { id: "p", sessionId: "r", status: "pending" };
  h.set({ pendingPlans: { r: proposal } });
  assert.equal(h.render("r", "p").proposal, proposal);
  assert.equal(h.requests.length, 0);
  h.render("a", "p");
  const approved = { id: "p", sessionId: "a", status: "approved" };
  h.set({ planCheckpoints: { a: approved } });
  assert.equal(h.render("a", "p").proposal, approved);
  h.requests[0].resolve({ proposal: { ...approved, status: "pending" } });
  await h.settle();
  assert.equal(h.render("a", "p").proposal, approved);
  h.render("b", "q");
  h.unmount();
  h.requests[1].resolve({ proposal: { id: "q", sessionId: "b" } });
  await h.settle();
  assert.equal(h.render("b", "q").proposal, undefined);
});

test("matching checkpoints skip reads and wrong-identity host replies fail closed", async (t) => {
  const h = await harness(t);
  const proposal = { id: "p", sessionId: "a", status: "pending" };
  h.set({ planCheckpoints: { a: proposal } });
  assert.equal(h.render("a", "p").proposal, proposal);
  assert.equal(h.requests.length, 0);
  h.render("b", "q");
  h.requests[0].resolve({ proposal });
  await h.settle();
  const result = h.render("b", "q");
  assert.equal(result.proposal, undefined);
  assert.equal(result.failed, true);
});
