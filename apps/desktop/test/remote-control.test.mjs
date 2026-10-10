import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { request as httpRequest } from "node:http";
register(new URL("./helpers/remote-control-import-hooks.mjs", import.meta.url));
const { RemoteControlServer } = await import("../electron/main/remote-control.ts");
const { createAgentHostBridge } = await import("../electron/main/agent-host-bridge.ts");
const { IPC } = await import("@pi-desktop/shared");
const { Host } = await import("../../../scripts/e2e/host.mjs");
const { preparePromptAttachments, appendPromptFallbackPaths } = await import("../electron/main/prompt-attachments.ts");
const { RemoteAttachments, REMOTE_ATTACHMENT_TTL } = await import("../electron/main/remote-attachments.ts");

async function fixture(t) {
  const dataDir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "remote-control-"));
  const workspace = join(dataDir, "project");
  await mkdir(workspace);
  const host = new Host(resolve("../../target/debug/pi-desktop-host-core"), dataDir);
  await host.start();
  const { workspace: project } = await host.call("workspace.set", { path: workspace });
  const { provider } = await host.call("providers.create", { name: "Local catalog", type: "openai_compatible", protocol: "openai_compatible", authKind: "none", baseUrl: "http://127.0.0.1:1/v1", defaultModelId: "text-model", models: [{ id: "text-model", contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off"] }, { id: "vision-model", contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off"], modalities: { input: ["text", "image"], output: ["text"] } }] });
  const { session } = await host.call("session.create", { title: "Remote fixture", projectPath: workspace, mode: "agent" });
  await host.call("session.configure", { id: session.id, mode: "agent", permissionMode: "ask" });
  const calls = [];
  let bridge;
  let beforePrompt = async () => {};
  let beforeRead = async () => {};
  const wrapped = { async call(method, params) { await beforeRead(method, params); return host.call(method, params); } };
  let sidecarReady = true;
  let hostReady = true;
  const getHost = () => hostReady ? wrapped : null;
  const enriched = async result => {
    if (result.session) result.session.supportsVision = result.session.modelId === "vision-model";
    return result;
  };
  const invoke = async (channel, args) => {
    const [req, config] = args;
    calls.push({ channel, req });
    if (channel === IPC.invoke.agentPrompt) {
      await beforePrompt();
      const { turnId } = await host.call("session.beginTurn", { sessionId: req.sessionId, permissionMode: req.permissionMode, requiredPermissionMode: req.requiredPermissionMode });
      const detail = (await host.call("session.get", { id: req.sessionId, messageLimit: 1 })).session;
      const prepared = await preparePromptAttachments(dataDir, req.sessionId, detail.projectPath, req.attachments ?? [], detail.modelId === "vision-model", req.content);
      if (prepared.length) {
        await host.call("session.appendMessage", { sessionId: req.sessionId, message: { id: randomUUID(), role: "user", content: req.content, status: "complete", createdAt: new Date().toISOString(), attachments: prepared.map(item => item.message) } });
        calls.at(-1).prepared = prepared;
        calls.at(-1).modelContent = appendPromptFallbackPaths(req.content, prepared);
      }
      bridge.ingest({ sessionId: req.sessionId, turnId, ts: Date.now(), event: { type: "agent_start" } });
      return { accepted: true, turnId };
    }
    if (channel === IPC.invoke.agentStop) return { requested: bridge.agentHost.liveSession(req.sessionId).status.currentTurnId === req.turnId };
    if (channel === IPC.invoke.agentAbort) return { aborted: bridge.agentHost.liveSession(req.sessionId).status.currentTurnId === req.turnId };
    if (channel === IPC.invoke.toolResolvePermission) { const result = await host.call("permissions.resolve", req); bridge.settleApproval(req.requestId, { decision: req.decision }); return result; }
    if (channel === IPC.invoke.askToolResolve) return { ok: true };
    if (channel === IPC.invoke.plansResolve) return host.call("plans.resolve", req);
    if (channel === IPC.invoke.agentGetStatus) { if (!sidecarReady) throw new Error("sidecar unavailable"); return { status: { sessionId: req, isRunning: false } }; }
    if (channel === IPC.invoke.projectList) return host.call("projects.list");
    if (channel === IPC.invoke.providersList) return host.call("providers.list", { includeDisabled: true });
    if (channel === IPC.invoke.providersListModels) {
      assert.equal(req.source, "cache");
      return { models: [{ modelId: "text-model", displayName: "Text", supportsVision: false, supportsReasoning: false, supportedThinkingLevels: ["off"] }, { modelId: "vision-model", displayName: "Vision", supportsVision: true, supportsReasoning: false, supportedThinkingLevels: ["off"] }] };
    }
    if (channel === IPC.invoke.sessionCreate) return enriched(await host.call("session.create", req));
    if (channel === IPC.invoke.sessionConfigure) return enriched(await host.call("session.configure", { id: req, ...config }));
    if (channel === IPC.invoke.sessionGet) return enriched(await host.call("session.get", req));
    throw new Error(`unexpected ${channel}`);
  };
  bridge = createAgentHostBridge({ invoke, channels: IPC.invoke, getHost, log() {} });
  const server = new RemoteControlServer({ dataDir, bridge, getHost, invoke, port: 0 });
  const info = await server.start();
  t.after(async () => { await server.stop(); await host.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" };
  const api = async (path, body, extra = {}) => {
    const response = await fetch(`${info.url}/v1/remote${path}`, { headers: { ...headers, ...extra }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const path = `/sessions/${session.id}`;
  const send = content => api(`${path}/messages`, { commandId: randomUUID(), content });
  const emit = (turnId, event, sessionId = session.id) => bridge.ingest({ sessionId, turnId, event, ts: Date.now() });
  return { server, host, bridge, api, send, path, emit, info, session, calls, dataDir, project, provider,
    setSidecarReady: value => { sidecarReady = value; }, setHostReady: value => { hostReady = value; },
    setBeforePrompt: fn => { beforePrompt = fn; }, setBeforeRead: fn => { beforeRead = fn; } };
}

async function sse(info, path) {
  const controller = new AbortController();
  const response = await fetch(`${info.url}/v1/remote${path}/events`, { headers: { Authorization: `Bearer ${info.token}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let buffer = "";
  return { close() { controller.abort(); }, async next() {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const text = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const name = /^event: (.+)$/m.exec(text)?.[1];
        if (!name) continue;
        return { name, data: JSON.parse(/^data: (.+)$/m.exec(text)[1]) };
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE ended");
      buffer += new TextDecoder().decode(chunk.value);
    }
  } };
}
const msg = (id, content, status = "streaming") => ({ id, role: "assistant", content, status, createdAt: new Date().toISOString() });

test("loopback auth/discovery, numeric history, exact remote envelope, shutdown", async t => {
  const f = await fixture(t);
  assert.match(f.info.token, /^[a-f0-9]{64}$/);
  assert.equal((await stat(join(f.dataDir, "remote-control.json"))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, "remote-control.json"))), f.info);
  assert.equal((await f.api("/capabilities")).body.result.ready, true);
  assert.equal((await f.api("/sessions", null, { Authorization: "Bearer no" })).status, 401);
  assert.equal((await f.api("/sessions", null, { Origin: "https://evil.example" })).status, 401);
  const invalidHost = await new Promise(resolve => {
    httpRequest(`${f.info.url}/v1/remote/sessions`, { headers: { Host: "evil.example", Authorization: `Bearer ${f.info.token}` } }, res => { res.resume(); resolve(res.statusCode); }).end();
  });
  assert.equal(invalidHost, 400);
  const listed = (await f.api("/sessions")).body.result.sessions;
  assert.equal(listed[0].title, "Remote fixture"); assert.equal(listed[0].source, "desktop"); assert.equal(listed[0].permissionMode, "ask");
  for (let i = 0; i < 5; i++) await f.host.call("session.appendMessage", { sessionId: f.session.id, message: msg(`m${i}`, "long content", "complete") });
  const page = (await f.api(`${f.path}/history?messageBefore=3&messageLimit=2&contentLimit=4`)).body.result.session;
  assert.equal(page.messageStart, 1); assert.equal(page.hasMoreBefore, true); assert.equal(page.messages.length, 2);
  assert.equal((await f.api(`${f.path}/history?messageLimit=-1`)).status, 400);
  assert.equal((await f.api(`${f.path}/history?messageBefore=no`)).status, 400);
  assert.equal((await f.api("/sessions", { commandId: randomUUID() })).status, 400);
  await f.server.stop();
  await assert.rejects(readFile(join(f.dataDir, "remote-control.json")), { code: "ENOENT" });
});

test("dedupe concurrent prompts; conflict, busy, stale stop and authority-mode race", async t => {
  const f = await fixture(t);
  const body = { commandId: randomUUID(), content: "hello" };
  const [a, b] = await Promise.all([f.api(`${f.path}/messages`, body), f.api(`${f.path}/messages`, body)]);
  assert.equal(a.status, 200); assert.deepEqual(a, b);
  assert.equal(f.calls.filter(c => c.channel === IPC.invoke.agentPrompt).length, 1);
  const turnId = a.body.result.turnId;
  assert.equal((await f.api(`${f.path}/messages`, { ...body, content: "different" })).body.error, "COMMAND_CONFLICT");
  assert.equal((await f.send("another")).status, 409);
  assert.equal((await f.api(`${f.path}/stop`, { commandId: randomUUID(), turnId: "old" })).body.error, "STALE_TURN");
  assert.equal((await f.api(`${f.path}/stop`, { commandId: randomUUID(), turnId })).status, 200);
  assert.equal(f.calls.at(-1).channel, IPC.invoke.agentAbort, "mobile stop interrupts the current provider stream immediately");
  // Public configure correctly rejects changes during a running turn. Rust
  // owner tests additionally force a stored-mode race to verify the ceiling.
  await assert.rejects(f.host.call("session.configure", { id: f.session.id, mode: "agent", permissionMode: "auto" }), { errorCode: "PLAN_CONFIGURATION_BLOCKED" });
  const evaluation = await f.host.call("permissions.evaluate", { sessionId: f.session.id, toolName: "Write", args: { path: "test.txt" } });
  assert.equal(evaluation.decision, null, "real Rust Ask ceiling survives desktop auto change");
  await f.host.call("session.endTurn", { turnId }); f.emit(turnId, { type: "agent_end", messageIds: [] });
  await f.host.call("session.configure", { id: f.session.id, mode: "agent", permissionMode: "auto" });
  const auto = await f.send("auto session"); assert.equal(auto.status, 200);
  assert.equal(f.calls.findLast(c => c.channel === IPC.invoke.agentPrompt).req.permissionMode, "ask");
  await f.host.call("session.endTurn", { turnId: auto.body.result.turnId }); f.emit(auto.body.result.turnId, { type: "agent_end", messageIds: [] });
  await f.host.call("session.configure", { id: f.session.id, mode: "agent", permissionMode: "ask" });
  f.setBeforePrompt(() => f.host.call("session.configure", { id: f.session.id, mode: "agent", permissionMode: "auto" }));
  assert.equal((await f.send("race")).status, 200, "stored-mode changes cannot widen the requested per-turn ceiling");
  const raced = await f.host.call("permissions.evaluate", { sessionId: f.session.id, toolName: "Write", args: { path: "test.txt" } });
  assert.equal(raced.decision, null);
});

test("snapshot-first SSE reconstructs delta-only live text, session isolation and reconnect cut", async t => {
  const f = await fixture(t);
  const turnId = (await f.send("hello")).body.result.turnId;
  f.emit(turnId, { type: "message_start", message: msg("live", "") });
  f.emit(turnId, { type: "message_update", message: msg("live", ""), deltaText: "hello", stream: "delta" });
  const stream = await sse(f.info, f.path); t.after(() => stream.close());
  const first = await stream.next(); assert.equal(first.name, "snapshot");
  assert.equal(first.data.messages.find(m => m.id === "live").content, "hello");
  f.emit("other", { type: "agent_start" }, "other-session");
  f.emit(turnId, { type: "message_update", message: msg("live", "hello world"), deltaText: " world" });
  const next = await stream.next(); assert.equal(next.name, "agent"); assert.equal(next.data.sessionId, f.session.id); assert.equal(next.data.event.type, "message_update");
  stream.close();
  let once = false;
  f.setBeforeRead(async method => { if (method === "session.get" && !once) { once = true; f.emit(turnId, { type: "message_end", message: msg("live", "final during read", "complete") }); } });
  const again = await sse(f.info, f.path); t.after(() => again.close());
  const restored = await again.next(); assert.equal(restored.name, "snapshot");
  assert.equal(restored.data.messages.find(m => m.id === "live").content, "final during read");
  assert.ok(restored.data.cursor.sequence > first.data.cursor.sequence);
});

test("real Host pending permission details, stale revisions and duplicate answers", async t => {
  const f = await fixture(t);
  const turnId = (await f.send("permission")).body.result.turnId;
  const stream = await sse(f.info, f.path); t.after(() => stream.close()); await stream.next();
  const call = f.host.call("tools.execute", { sessionId: f.session.id, turnId, toolCallId: "write-1", toolName: "Write", args: { path: "test.txt", content: "sensitive reviewed text" }, mode: "agent" });
  let notification;
  for (let i = 0; i < 100; i++) {
    notification = f.host.notifications.find(n => n.method === "permissions.request");
    if (notification) break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(notification); f.emit(turnId, { type: "tool_permission_request", request: notification.params });
  let pendingEvent;
  for (let i = 0; i < 8; i++) { const frame = await stream.next(); if (frame.name === "pending" && frame.data.items.length) { pendingEvent = frame; break; } }
  assert.ok(pendingEvent);
  const item = pendingEvent.data.items[0]; assert.equal(item.type, "permission");
  assert.equal(item.details.argsPreview.content, "sensitive reviewed text");
  const response = { commandId: randomUUID(), type: "permission", revision: item.revision, confirm: true, decision: "deny" };
  const route = `${f.path}/approvals/${item.requestId}/respond`;
  assert.equal((await f.api(route, { ...response, commandId: randomUUID(), revision: "0".repeat(64) })).body.error, "STALE_REQUEST");
  const [a, b] = await Promise.all([f.api(route, response), f.api(route, response)]);
  assert.equal(a.status, 200); assert.deepEqual(a, b); assert.equal((await call).errorCode, "TOOL_DENIED");
  assert.equal((await f.api(route, { ...response, commandId: randomUUID() })).body.error, "STALE_REQUEST");
  const ask = { requestId: "ask-1", sessionId: f.session.id, toolCallId: "ask-tool", questions: [{ question: "Which?", options: ["A", "B"] }] };
  f.emit(turnId, { type: "asktool_request", request: ask });
  const snap = (await f.api(`${f.path}/snapshot`)).body.result;
  const askItem = snap.items.find(i => i.type === "ask"); assert.deepEqual(askItem.details, ask);
  const answer = { commandId: randomUUID(), revision: askItem.revision, confirm: true, answers: [["A"]] };
  const responses = await Promise.all([f.api(`${f.path}/inputs/ask-1/respond`, answer), f.api(`${f.path}/inputs/ask-1/respond`, { ...answer, commandId: randomUUID() })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.calls.filter(c => c.channel === IPC.invoke.askToolResolve).length, 1);
});

for (const kind of ["plan", "goal"]) test(`${kind} snapshot preserves Markdown and Host identities; stale/duplicate decisions fail closed`, async t => {
  const f = await fixture(t);
  const turnId = (await f.send("plan")).body.result.turnId;
  await f.host.call("plans.enter", { sessionId: f.session.id, turnId, toolCallId: "enter", requestedMode: "agent", kind });
  const markdown = "# Reviewed plan\n\n- Keep **exact** Markdown.\n";
  const { proposal } = await f.host.call("plans.submit", { sessionId: f.session.id, turnId, toolCallId: "submit", kind, title: "Review", markdown, question: "Approve?" });
  await f.host.call("session.endTurn", { turnId }); f.emit(turnId, { type: "agent_end", messageIds: [] });
  const snap = (await f.api(`${f.path}/snapshot`)).body.result;
  const item = snap.items.find(item => item.type === "plan");
  assert.equal(item.details.kind, kind);
  assert.equal(item.requestId, proposal.id); assert.equal(item.details.markdown, markdown); assert.equal(item.details.turnId, turnId);
  const path = `${f.path}/approvals/${proposal.id}/respond`;
  const body = { commandId: randomUUID(), type: "plan", revision: item.revision, decision: "approve", confirm: true };
  assert.equal((await f.api(path, { ...body, commandId: randomUUID(), confirm: false })).status, 400);
  assert.equal((await f.api(path, { ...body, commandId: randomUUID(), revision: "a".repeat(64) })).status, 409);
  const accepted = await f.api(path, body); assert.equal(accepted.status, 200);
  const stored = await f.host.call("plans.get", { sessionId: f.session.id, proposalId: proposal.id });
  assert.equal(stored.proposal.targetPermissionMode, "ask"); assert.equal(stored.proposal.markdown, markdown);
  assert.deepEqual(await f.api(path, body), accepted);
  assert.equal((await f.api(path, { ...body, commandId: randomUUID() })).status, 409);
});

test("SSE disconnects on backpressure and runtime errors remain original envelopes", async t => {
  const f = await fixture(t);
  const turnId = (await f.send("stream")).body.result.turnId;
  const stream = await sse(f.info, f.path); t.after(() => stream.close()); await stream.next();
  const error = { code: "TEST_PROVIDER_FAILURE", message: "fixture error", retriable: false };
  f.emit(turnId, { type: "error", error });
  let found;
  for (let i = 0; i < 4; i++) { const frame = await stream.next(); if (frame.name === "agent") { found = frame; break; } }
  assert.equal(found.data.event.error.message, "fixture error");
  // Force the real ServerResponse backpressure branch, without waiting for OS
  // socket buffers to fill nondeterministically.
  const response = [...f.server.streams][0];
  const originalWrite = response.write;
  response.write = () => false;
  f.emit(turnId, { type: "message_end", message: msg("blocked", "not queued", "complete") });
  response.write = originalWrite;
  await new Promise(r => setTimeout(r, 20));
  assert.equal(f.server.streams.size, 0);
});

test("an owner input resolution during snapshot read is not resurrected", async t => {
  const f = await fixture(t);
  const turnId = (await f.send("ask")).body.result.turnId;
  const request = { requestId: "racing-ask", sessionId: f.session.id, toolCallId: "ask", questions: [{ question: "Continue?", options: ["Yes"] }] };
  f.emit(turnId, { type: "asktool_request", request });
  let once = false;
  f.setBeforeRead(async method => {
    if (method === "permissions.pending" && !once) {
      once = true;
      await f.bridge.resolveAskByRequestId({ sessionId: f.session.id, requestId: request.requestId, answers: [["Yes"]] });
    }
  });
  const stream = await sse(f.info, f.path); t.after(() => stream.close());
  const first = await stream.next(); assert.equal(first.name, "snapshot");
  assert.deepEqual(first.data.items, []);
});

test("cross-session UUID reuse, unsupported authority fields and oversized pending fail closed", async t => {
  const f = await fixture(t);
  const command = { commandId: randomUUID(), content: "hello" };
  const first = await f.api(`${f.path}/messages`, command);
  assert.equal(first.status, 200);
  assert.equal((await f.api("/sessions/another/messages", command)).body.error, "COMMAND_CONFLICT");
  assert.equal((await f.api(`${f.path}/messages`, { ...command, commandId: randomUUID(), permissionMode: "auto" })).status, 400);
  assert.equal((await f.api(`${f.path}/events`, null, { Authorization: "Bearer invalid" })).status, 401);
  assert.equal((await f.api(`${f.path}/history?token=invalid`)).status, 400);
  const turnId = first.body.result.turnId;
  f.emit(turnId, { type: "asktool_request", request: { requestId: "oversized", sessionId: f.session.id, toolCallId: "ask", questions: [{ question: "x".repeat(530_000), options: ["yes"] }] } });
  const snapshot = await f.api(`${f.path}/snapshot`);
  assert.equal(snapshot.status, 502); assert.equal(snapshot.body.error, "PENDING_TOO_LARGE");
});


test("remote messages preserve agent/plan/goal and stored permissions while pinning per-turn Ask", async t => {
  const f = await fixture(t);
  for (const mode of ["agent", "plan", "goal"]) for (const permissionMode of ["inherit", "ask", "accept-edits", "auto"]) {
    const { session } = await f.host.call("session.create", { title: `${mode}-${permissionMode}`, mode });
    await f.host.call("session.configure", { id: session.id, mode, permissionMode });
    const response = await f.api(`/sessions/${session.id}/messages`, { commandId: randomUUID(), content: "hello without a project" });
    assert.equal(response.status, 200, `${mode}/${permissionMode}: ${JSON.stringify(response.body)}`);
    const request = f.calls.findLast(c => c.channel === IPC.invoke.agentPrompt).req;
    assert.equal(request.permissionMode, "ask");
    assert.equal(request.requiredPermissionMode, undefined);
    const { session: after } = await f.host.call("session.get", { id: session.id });
    assert.equal(after.mode, mode); assert.equal(after.permissionMode, permissionMode);
    const decision = await f.host.call("permissions.evaluate", { sessionId: session.id, toolName: "Write", args: { path: "test.txt" } });
    if (mode === "agent") assert.equal(decision.decision, null, "stored Auto must not bypass remote Ask");
    else assert.equal(decision.decision, "deny", "Plan/Goal restrictions remain authoritative");
    await f.host.call("session.endTurn", { turnId: response.body.result.turnId });
    f.emit(response.body.result.turnId, { type: "agent_end", messageIds: [] }, session.id);
  }
});


test("create an unbound conversation, choose an existing model, and send without changing mode", async t => {
  const f = await fixture(t);
  const response = await f.api("/sessions/create", { commandId: randomUUID(), title: "Unbound conversation" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const id = response.body.result.session.id;
  assert.equal(response.body.result.session.mode, "agent");
  assert.ok(!response.body.result.session.projectPath);
  const selected = await f.api(`/sessions/${id}/model`, { commandId: randomUUID(), providerId: f.provider.id, modelId: "text-model" });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  for (const content of ["hello", "second turn"]) {
    const sent = await f.api(`/sessions/${id}/messages`, { commandId: randomUUID(), content });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await f.host.call("session.endTurn", { turnId: sent.body.result.turnId });
    f.emit(sent.body.result.turnId, { type: "agent_end", messageIds: [] }, id);
  }
});
