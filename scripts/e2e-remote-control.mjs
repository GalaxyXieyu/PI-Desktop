// Local-only production Desktop/Host/sidecar smoke. No MCP and no paid provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Host } from "./e2e/host.mjs";
const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "apps/desktop/package.json"));
const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "desktop-remote-e2e-"));
const dataDir = join(dir, "data");
const projectPath = join(dir, "project");
await mkdir(projectPath, { recursive: true });
let child;
let output = "";
let requests = 0;
let passed = false;
const provider = createServer(async (req, res) => {
  if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  requests++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  chunk({ role: "assistant" }); chunk({ content: "REMOTE_BRIDGE_" });
  setTimeout(() => { chunk({ content: "PRODUCTION_OK" }); chunk({}, "stop"); res.end("data: [DONE]\n\n"); }, 150);
});
provider.listen(0, "127.0.0.1"); await once(provider, "listening");
const host = new Host(join(root, "target/debug/pi-desktop-host-core"), dataDir);
let controller;
async function until(read, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Timed out: ${label}`);
}
try {
  await host.start();
  const { provider: account } = await host.call("providers.create", {
    name: "Local remote fixture", type: "openai_compatible", protocol: "openai_compatible",
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiStyle: "chat_completions", authKind: "none",
    defaultModelId: "fixture-model", models: [{ id: "fixture-model", contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off"] }],
  });
  const { session } = await host.call("session.create", { title: "Remote production smoke", mode: "agent", projectPath });
  await host.call("session.configure", { id: session.id, mode: "agent", permissionMode: "ask", thinkingLevel: "off", providerId: account.id, modelId: "fixture-model" });
  const settings = await host.call("settings.get");
  await host.call("settings.set", { ...settings, autoGenerateTitle: false, onboardingDismissed: true });
  await host.stop();
  const env = { ...process.env, PI_DESKTOP_DATA_DIR: dataDir, PI_DESKTOP_REMOTE_CONTROL: "1", PI_DESKTOP_REMOTE_PORT: "0", PI_DESKTOP_HOST_BIN: join(root, "target/debug/pi-desktop-host-core"), ELECTRON_RENDERER_URL: "" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PI_DESKTOP_MCP_CONTROL;
  child = spawn(require("electron"), [join(root, "apps/desktop"), `--user-data-dir=${join(dir, "profile")}`], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const info = await until(async () => {
    try { return JSON.parse(await readFile(join(dataDir, "remote-control.json"), "utf8")); } catch { if (child.exitCode !== null) throw new Error(`Desktop exited ${child.exitCode}`); return null; }
  }, "remote discovery");
  const headers = { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" };
  const base = `${info.url}/v1/remote`;
  const list = await (await fetch(`${base}/sessions`, { headers })).json();
  assert.ok(list.result.sessions.some(item => item.id === session.id));
  controller = new AbortController();
  const response = await fetch(`${base}/sessions/${session.id}/events`, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let buffer = ""; const events = [];
  const consume = (async () => {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += new TextDecoder().decode(value);
      for (;;) {
        const end = buffer.indexOf("\n\n"); if (end < 0) break;
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const name = /^event: (.+)$/m.exec(block)?.[1];
        if (name) events.push({ name, data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) });
      }
    }
  })().catch(error => { if (!controller.signal.aborted) throw error; });
  await until(() => events.length > 0, "snapshot"); assert.equal(events[0].name, "snapshot");
  const command = { commandId: randomUUID(), content: "Reply with REMOTE_BRIDGE_PRODUCTION_OK." };
  const route = `${base}/sessions/${session.id}/messages`;
  const sent = await fetch(route, { headers, method: "POST", body: JSON.stringify(command) });
  const accepted = await sent.json(); assert.equal(sent.status, 200, JSON.stringify(accepted));
  const repeated = await (await fetch(route, { headers, method: "POST", body: JSON.stringify(command) })).json();
  assert.deepEqual(repeated, accepted);
  const ended = await until(() => events.find(frame => frame.name === "agent" && ["agent_end", "error"].includes(frame.data.event.type)), "runtime completion");
  assert.equal(ended.data.event.type, "agent_end", JSON.stringify(ended));
  const final = events.findLast(frame => frame.name === "agent" && frame.data.event.type === "message_end" && frame.data.event.message.role === "assistant");
  assert.equal(final?.data.event.message.content, "REMOTE_BRIDGE_PRODUCTION_OK");
  const snapshot = await (await fetch(`${base}/sessions/${session.id}/snapshot`, { headers })).json();
  assert.ok(snapshot.result.messages.some(message => message.content === "REMOTE_BRIDGE_PRODUCTION_OK"));
  assert.equal(requests, 1, "deduplicated command must not call the provider twice");
  assert.ok(events.some(frame => frame.name === "agent" && frame.data.event.type === "message_update"));
  controller.abort(); await consume;
  passed = true;
  console.log("PASS production Electron -> existing Host/sidecar -> fake loopback model -> original remote SSE; no MCP; one provider request");
} catch (error) {
  await writeFile(join(dir, "desktop.log"), output);
  console.error(`Evidence: ${dir}/desktop.log`);
  throw error;
} finally {
  controller?.abort();
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 3000))]); if (child.exitCode === null) child.kill("SIGKILL"); }
  await host.stop(); provider.closeAllConnections(); await new Promise(r => provider.close(r));
  if (passed) await rm(dir, { recursive: true, force: true });
}
