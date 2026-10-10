import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEventEnvelope, PlanProposal, SessionDetail, SessionSummary, ToolPermissionRequest, AskToolRequest } from "@pi-desktop/shared";
import { IPC } from "@pi-desktop/shared";
import type { AgentHostBridge } from "./agent-host-bridge.js";
import { RemoteAttachments, RemoteAttachmentError } from "./remote-attachments.js";

const PROTOCOL = "pi-remote/1";
const MAX_BYTES = 1_048_576;
const MAX_PENDING_BYTES = 524_288;
const MAX_MESSAGES = 100;
const CONTENT_LIMIT = 16_384;
const principal = { subject: "desktop-remote", roles: ["owner"] as ["owner"], pairedDevice: false };
const supportedEvents = new Set([
  "agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end",
  "user_message_persisted", "tool_start", "tool_update", "tool_end", "tool_permission_request",
  "asktool_request", "planning_state", "status", "usage", "error", "compaction_start", "compaction_end",
]);

type Host = { call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> };
export type RemotePending = { type: "permission" | "ask" | "plan"; requestId: string; revision: string; details: ToolPermissionRequest | AskToolRequest | PlanProposal };
type Cursor = { epoch: string; sequence: number };
type Frame = { name: "agent" | "pending" | "status"; data: unknown; cursor: Cursor };
type Channel = { sequence: number; version: number; listeners: Set<(frame: Frame) => void>; close: () => void; refresh: Promise<void> };
type RemoteModel = { id: string; name?: string; supportsVision?: boolean; supportsReasoning?: boolean; supportedThinkingLevels?: string[] };
type RemoteProvider = { id: string; name: string; models: RemoteModel[] };
type Options = {
  dataDir: string;
  bridge: AgentHostBridge;
  getHost: () => Host | null;
  invoke: (channel: string, args: readonly unknown[]) => Promise<unknown>;
  port?: number;
  log?: (message: string, error: unknown) => void;
};

export class RemoteControlError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 409) { super(code); this.code = code; this.status = status; }
}
function fail(code: string, status = 409): never { throw new RemoteControlError(code, status); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function revision(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function pending(type: RemotePending["type"], requestId: string, details: RemotePending["details"]): RemotePending {
  return { type, requestId, revision: revision({ type, requestId, details }), details };
}
function integer(query: URLSearchParams, key: string, fallback: number, maximum: number, minimum = 1): number {
  const raw = query.get(key);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return fail("INVALID_ARGUMENT", 400);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return fail("INVALID_ARGUMENT", 400);
  return value;
}
function localSession(session: SessionSummary): boolean {
  return (!session.source || session.source === "desktop") && !session.id.startsWith("native-pi:") && !session.id.startsWith("remote:");
}

/** Dedicated loopback adapter. No generic invoke route, MCP catalog, or second runtime. */
export class RemoteControlServer {
  private readonly options: Options;
  private readonly epoch = randomUUID();
  private readonly token = randomBytes(32).toString("hex");
  private readonly server = createServer((req, res) => { void this.route(req, res); });
  private readonly channels = new Map<string, Channel>();
  private readonly streams = new Set<ServerResponse>();
  private readonly commands = new Map<string, { hash: string; result: Promise<unknown> }>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly attachments: RemoteAttachments;
  private url = "";
  private closed = false;

  constructor(options: Options) {
    this.options = options;
    this.attachments = new RemoteAttachments(options.dataDir, Date.now, error => options.log?.("remote attachment cleanup failed", error));
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.server.maxConnections = 64;
  }

  async start() {
    const port = this.options.port ?? 37124;
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail("INVALID_PORT", 400);
    await mkdir(this.options.dataDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => { this.server.off("error", reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === "string" || address.address !== "127.0.0.1") { await this.stop(); fail("BIND_FAILED", 502); }
    this.url = `http://127.0.0.1:${address.port}`;
    const record = { active: true, protocol: PROTOCOL, url: this.url, token: this.token, pid: process.pid };
    const path = join(this.options.dataDir, "remote-control.json");
    const temp = `${path}.${this.epoch}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      await chmod(temp, 0o600);
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      await this.stop();
      throw error;
    }
    this.attachments.start();
    return record;
  }

  async stop(): Promise<void> {
    this.closed = true;
    for (const res of this.streams) res.destroy();
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    await Promise.allSettled(this.operations.values());
    await this.attachments.stop();
    const path = join(this.options.dataDir, "remote-control.json");
    try {
      const current = JSON.parse(await readFile(path, "utf8"));
      if (current.token === this.token) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.options.log?.("remote discovery cleanup failed", error);
    }
  }

  private host(): Host { return this.options.getHost() ?? fail("AGENT_UNAVAILABLE", 502); }
  private cursor(channel: Channel): Cursor { return { epoch: this.epoch, sequence: channel.sequence }; }
  private emit(channel: Channel, name: Frame["name"], data: unknown) {
    const frame = { name, data, cursor: { epoch: this.epoch, sequence: ++channel.sequence } };
    for (const listener of channel.listeners) listener(frame);
  }

  private channel(sessionId: string): Channel {
    const existing = this.channels.get(sessionId);
    if (existing) return existing;
    if (this.channels.size >= 256) fail("SESSION_LIMIT", 409);
    const channel: Channel = { sequence: 0, version: 0, listeners: new Set(), close: () => {}, refresh: Promise.resolve() };
    this.channels.set(sessionId, channel);
    const offRuntime = this.options.bridge.onRuntimeEvent(sessionId, envelope => {
      if (!supportedEvents.has(envelope.event.type)) return;
      channel.version++;
      this.emit(channel, "agent", envelope);
      if (envelope.event.type === "status") this.emit(channel, "status", { sessionId, status: envelope.event.status });
    });
    const offState = this.options.bridge.onSessionEvent(sessionId, event => {
      channel.version++;
      if (/^(approval\.|input\.|turn\.(completed|failed|interrupted|started)|session\.changed)/.test(event.kind)) {
        // Event-driven reads only. Serializing preserves transition delivery;
        // a failure resynchronizes by disconnecting rather than guessing state.
        channel.refresh = channel.refresh.then(async () => {
          const items = await this.pending(sessionId);
          if (this.closed) return;
          this.emit(channel, "pending", { sessionId, items });
          this.emit(channel, "status", { sessionId, status: this.options.bridge.agentHost.liveSession(sessionId).status });
        }).catch(error => {
          this.options.log?.("remote pending refresh failed", error);
          for (const listener of channel.listeners) listener({ name: "pending", data: null, cursor: this.cursor(channel) });
        });
      }
    });
    channel.close = () => { offRuntime(); offState(); channel.listeners.clear(); };
    return channel;
  }

  async history(sessionId: string, query = new URLSearchParams()) {
    const messageLimit = integer(query, "messageLimit", 50, MAX_MESSAGES);
    const contentLimit = integer(query, "contentLimit", CONTENT_LIMIT, CONTENT_LIMIT);
    const messageBefore = query.has("messageBefore") ? integer(query, "messageBefore", 0, Number.MAX_SAFE_INTEGER, 0) : undefined;
    const { session } = await this.host().call<{ session?: SessionDetail }>("session.get", {
      id: sessionId, messageLimit, contentLimit, ...(messageBefore !== undefined ? { messageBefore } : {}),
    });
    if (!session || !localSession(session)) fail("SESSION_NOT_FOUND", 409);
    return { session: { ...session, source: "desktop" as const, messages: session.messages ?? [], messageStart: session.messageStart ?? 0, hasMoreBefore: session.hasMoreBefore ?? false } };
  }

  private async pending(sessionId: string): Promise<RemotePending[]> {
    const host = this.host();
    const [permissions, plans] = await Promise.all([
      host.call<{ requests: Array<ToolPermissionRequest & { createdAt?: string; expiresAt?: string }> }>("permissions.pending", { sessionId }),
      host.call<{ plans: PlanProposal[] }>("plans.pending", { sessionId }),
    ]);
    const asks = this.options.bridge.agentHost.pendingInputRequests(sessionId);
    const items = [
      ...(permissions.requests ?? []).filter(item => item.sessionId === sessionId).map(({ createdAt: _created, expiresAt: _expires, ...item }) => pending("permission", item.requestId, item)),
      ...asks.map(({ original }) => pending("ask", original.requestId, original)),
      ...(plans.plans ?? []).filter(item => item.sessionId === sessionId && item.status === "pending").map(item => pending("plan", item.id, item)),
    ];
    // Never truncate approval details silently: an unreviewable request cannot
    // be approved remotely. The local desktop remains able to resolve it.
    if (items.length > 32 || Buffer.byteLength(JSON.stringify(items)) > MAX_PENDING_BYTES) fail("PENDING_TOO_LARGE", 502);
    return items;
  }

  async snapshot(sessionId: string) {
    const channel = this.channel(sessionId);
    // Capture live state after awaited reads. Retry only if an owner event
    // crossed the pending read, never poll to manufacture stream events.
    for (let attempt = 0; attempt < 16; attempt++) {
      const before = channel.version;
      const { session: detail } = await this.history(sessionId);
      const items = await this.pending(sessionId);
      if (before !== channel.version) continue;
      const live = this.options.bridge.agentHost.liveSession(sessionId);
      const messages = new Map(detail.messages.map(message => [message.id, message]));
      for (const message of live.messages) messages.set(message.id, message);
      const { messages: _messages, ...session } = detail;
      return {
        sessionId, session, status: { ...live.status, pendingToolConfirmations: items.filter(item => item.type === "permission").length },
        messages: [...messages.values()].slice(-MAX_MESSAGES).map(message => ({ ...message, content: message.content.slice(0, CONTENT_LIMIT) })),
        items, cursor: this.cursor(channel),
      };
    }
    return fail("RESYNC_REQUIRED", 409);
  }

  private command(sessionId: string, action: string, body: Record<string, unknown>, run: () => Promise<unknown>) {
    const id = body.commandId;
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) fail("INVALID_COMMAND_ID", 400);
    const hash = revision({ sessionId, action, body });
    const old = this.commands.get(id);
    if (old) { if (old.hash !== hash) fail("COMMAND_CONFLICT"); return old.result; }
    if (this.commands.size >= 10_000) fail("COMMAND_LIMIT");
    const previous = this.operations.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => { if (this.closed) fail("SHUTTING_DOWN", 502); return run(); });
    this.operations.set(sessionId, result);
    this.commands.set(id, { hash, result });
    void result.finally(() => { if (this.operations.get(sessionId) === result) this.operations.delete(sessionId); }).catch(() => undefined);
    return result;
  }

  private async respond(sessionId: string, requestId: string, action: string, body: Record<string, unknown>) {
    if (body.confirm !== true || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision)) fail("CONFIRMATION_REQUIRED", 400);
    const expectedType = action === "inputs" ? "ask" : body.type;
    if (action === "approvals" && expectedType !== "permission" && expectedType !== "plan") fail("INVALID_ARGUMENT", 400);
    const item = (await this.pending(sessionId)).find(item => item.requestId === requestId && item.type === expectedType);
    if (this.closed) fail("SHUTTING_DOWN", 502);
    if (!item || item.revision !== body.revision) fail("STALE_REQUEST");
    if (item.type === "ask") {
      if (!Array.isArray(body.answers) || body.answers.some(answer => answer !== null && (!Array.isArray(answer) || answer.some(value => typeof value !== "string")))) fail("INVALID_ARGUMENT", 400);
      const current = this.options.bridge.agentHost.pendingInputRequests(sessionId).find(entry => entry.original.requestId === requestId);
      if (!current || pending("ask", requestId, current.original).revision !== body.revision) fail("STALE_REQUEST");
      const result = await this.options.bridge.resolveAskByRequestId({ sessionId, requestId, answers: body.answers as Array<string[] | null> });
      if (!result) fail("STALE_REQUEST");
      return result;
    }
    if (item.type === "permission") {
      if (body.decision !== "allow-once" && body.decision !== "deny") fail("INVALID_ARGUMENT", 400);
      return this.options.invoke(IPC.invoke.toolResolvePermission, [{ requestId, decision: body.decision }]);
    }
    if (body.decision !== "approve" && body.decision !== "reject") fail("INVALID_ARGUMENT", 400);
    const plan = item.details as PlanProposal;
    return this.options.invoke(IPC.invoke.plansResolve, [{ proposalId: requestId, sessionId, turnId: plan.turnId, toolCallId: plan.toolCallId, version: plan.version, action: body.decision, targetPermissionMode: "ask" }]);
  }

  private async projects(): Promise<{ projects: Array<{ id: string; name: string; path: string }> }> {
    this.host();
    const result = await this.options.invoke(IPC.invoke.projectList, []) as { projects: Array<{ id: string; name: string; path: string }> };
    return { projects: result.projects.map(({ id, name, path }) => ({ id, name, path })) };
  }

  private async models(): Promise<{ providers: RemoteProvider[] }> {
    this.host();
    const { providers } = await this.options.invoke(IPC.invoke.providersList, []) as { providers: Array<{ id: string; name: string; enabled?: boolean }> };
    return { providers: await Promise.all(providers.filter(provider => provider.enabled !== false).map(async provider => {
      const { models } = await this.options.invoke(IPC.invoke.providersListModels, [{ providerId: provider.id, source: "cache" }]) as { models: Array<{ modelId: string; displayName?: string; supportsVision?: boolean; supportsReasoning?: boolean; reasoning?: boolean; capabilities?: string[]; modalities?: { input?: string[] }; supportedThinkingLevels?: string[] }> };
      return { id: provider.id, name: provider.name, models: models.map(model => ({
        id: model.modelId, ...(model.displayName ? { name: model.displayName } : {}),
        supportsVision: model.supportsVision ?? model.modalities?.input?.includes("image") ?? model.capabilities?.includes("vision") ?? false,
        supportsReasoning: model.supportsReasoning ?? model.reasoning ?? false,
        supportedThinkingLevels: model.supportedThinkingLevels ?? ["off"],
      })) };
    })) };
  }

  private async knownModel(providerId: unknown, modelId: unknown, thinkingLevel?: unknown) {
    if (typeof providerId !== "string" || !providerId || typeof modelId !== "string" || !modelId) fail("INVALID_ARGUMENT", 400);
    const provider = (await this.models()).providers.find(provider => provider.id === providerId);
    if (!provider) fail("PROVIDER_NOT_FOUND");
    const model = provider.models.find(model => model.id === modelId);
    if (!model) fail("MODEL_NOT_FOUND");
    if (thinkingLevel !== undefined && (typeof thinkingLevel !== "string" || !model.supportedThinkingLevels?.includes(thinkingLevel))) fail("UNSUPPORTED_THINKING_LEVEL", 400);
    return model;
  }

  private async createSession(body: Record<string, unknown>) {
    if (Object.keys(body).some(key => !["commandId", "title", "projectId", "providerId", "modelId"].includes(key))) fail("INVALID_ARGUMENT", 400);
    return this.command("remote-create", "create", body, async () => {
      const projectId = body.projectId;
      if (projectId !== undefined && ((typeof projectId !== "string" && typeof projectId !== "number") || projectId === "" || (typeof projectId === "number" && (!Number.isSafeInteger(projectId) || projectId <= 0)))) fail("INVALID_ARGUMENT", 400);
      if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > 200 || /[\u0000-\u001f\u007f]/.test(body.title))) fail("INVALID_ARGUMENT", 400);
      const project = projectId === undefined ? undefined : (await this.projects()).projects.find(project => String(project.id) === String(projectId));
      if (projectId !== undefined && !project) fail("PROJECT_NOT_FOUND");
      if (body.providerId !== undefined || body.modelId !== undefined) await this.knownModel(body.providerId, body.modelId);
      const result = await this.options.invoke(IPC.invoke.sessionCreate, [{ ...(body.title !== undefined ? { title: body.title } : {}), ...(project ? { projectPath: project.path } : {}), mode: "agent", ...(body.providerId ? { providerId: body.providerId, modelId: body.modelId } : {}) }]) as { session?: SessionSummary };
      if (!result.session || !localSession(result.session)) fail("SESSION_NOT_FOUND");
      // Explicit Ask never inherits a global permission setting.
      const configured = await this.options.invoke(IPC.invoke.sessionConfigure, [result.session.id, { mode: "agent", permissionMode: "ask", providerId: body.providerId, modelId: body.modelId }]) as { session: SessionSummary };
      return { session: { ...configured.session, source: "desktop" } };
    });
  }

  private authorized(req: IncomingMessage) {
    const expected = new URL(this.url);
    if (req.socket.remoteAddress !== "127.0.0.1" && req.socket.remoteAddress !== "::ffff:127.0.0.1") fail("UNAUTHORIZED", 401);
    if (req.headers.host !== expected.host && req.headers.host !== `localhost:${expected.port}`) fail("INVALID_HOST", 400);
    if (req.headers.origin && req.headers.origin !== this.url && req.headers.origin !== `http://localhost:${expected.port}`) fail("INVALID_ORIGIN", 401);
    const auth = req.headers.authorization ?? "";
    const expectedAuth = `Bearer ${this.token}`;
    if (Buffer.byteLength(auth) !== Buffer.byteLength(expectedAuth) || !timingSafeEqual(Buffer.from(auth), Buffer.from(expectedAuth))) fail("UNAUTHORIZED", 401);
  }

  private async body(req: IncomingMessage, maximum = MAX_BYTES): Promise<Record<string, unknown>> {
    if (!req.headers["content-type"]?.startsWith("application/json")) fail("INVALID_CONTENT_TYPE", 400);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > maximum) fail("BODY_TOO_LARGE", 400); chunks.push(chunk); }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("INVALID_JSON", 400); }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_ARGUMENT", 400);
    return value as Record<string, unknown>;
  }

  private json(res: ServerResponse, status: number, data: unknown) {
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text) > MAX_BYTES * 4) fail("RESPONSE_TOO_LARGE", 502);
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(text);
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    try {
      this.authorized(req);
      if (this.closed) fail("SHUTTING_DOWN", 502);
      const url = new URL(req.url ?? "/", this.url);
      if (url.searchParams.has("token") || url.searchParams.has("access_token")) fail("INVALID_ARGUMENT", 400);
      if (url.origin !== this.url) fail("INVALID_ARGUMENT", 400);
      if (req.method === "GET" && url.pathname === "/v1/remote/capabilities") {
        const health = await this.options.bridge.runtimeStatus();
        return this.json(res, 200, { result: { protocol: PROTOCOL, ready: health.hostReady && health.sidecarReady, ...health,
          capabilities: { projects: health.hostReady, models: health.hostReady, sessionCreate: health.hostReady, sessionModel: health.hostReady, attachments: health.hostReady, messages: health.hostReady && health.sidecarReady, events: health.hostReady && health.sidecarReady } } });
      }
      if (req.method === "GET" && url.pathname === "/v1/remote/projects") return this.json(res, 200, { result: await this.projects() });
      if (req.method === "GET" && url.pathname === "/v1/remote/models") return this.json(res, 200, { result: await this.models() });
      if (req.method === "POST" && url.pathname === "/v1/remote/sessions/create") return this.json(res, 200, { result: await this.createSession(await this.body(req)) });
      if (req.method === "GET" && url.pathname === "/v1/remote/sessions") {
        const { sessions } = await this.host().call<{ sessions: SessionSummary[] }>("session.list");
        return this.json(res, 200, { result: { sessions: sessions.filter(localSession).map(session => ({ ...session, source: "desktop" })) } });
      }
      const match = /^\/v1\/remote\/sessions\/([^/]+)\/(history|snapshot|events|messages|model|attachments|stop|approvals\/([^/]+)\/respond|inputs\/([^/]+)\/respond)$/.exec(url.pathname);
      if (!match) fail("NOT_FOUND", 400);
      const sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.length > 512) fail("INVALID_ARGUMENT", 400);
      const action = match[2]!;
      if (req.method === "GET") {
        if (action === "history") return this.json(res, 200, { result: await this.history(sessionId, url.searchParams) });
        if (action === "snapshot") return this.json(res, 200, { result: await this.snapshot(sessionId) });
        if (action === "events") return await this.events(sessionId, req, res);
      }
      if (req.method !== "POST" || ["history", "snapshot", "events"].includes(action)) fail("INVALID_METHOD", 400);
      const body = await this.body(req, action === "attachments" ? 6 * MAX_BYTES : MAX_BYTES);
      const allowed = action === "messages" ? ["commandId", "content", "attachmentIds"]
        : action === "model" ? ["commandId", "providerId", "modelId", "thinkingLevel"]
        : action === "attachments" ? ["name", "mediaType", "data"]
        : action === "stop" ? ["commandId", "turnId"]
        : match[3] ? ["commandId", "type", "revision", "confirm", "decision"]
        : ["commandId", "revision", "confirm", "answers"];
      if (Object.keys(body).some(key => !allowed.includes(key))) fail("INVALID_ARGUMENT", 400);
      if (action === "attachments") {
        await this.history(sessionId, new URLSearchParams({ messageLimit: "1" }));
        return this.json(res, 200, { result: await this.attachments.upload(sessionId, body) });
      }
      const result = await this.command(sessionId, action, body, async () => {
        const { session } = await this.history(sessionId, new URLSearchParams({ messageLimit: "1" }));
        if (this.closed) fail("SHUTTING_DOWN", 502);
        this.channel(sessionId);
        if (action === "model") {
          await this.knownModel(body.providerId, body.modelId, body.thinkingLevel);
          if (this.options.bridge.agentHost.liveSession(sessionId).status.isRunning) fail("AGENT_BUSY");
          // Configure requires mode. Preserve the stored mode and omit permission
          // changes; the existing Host handler owns idle/plan admission.
          const configured = await this.options.invoke(IPC.invoke.sessionConfigure, [sessionId, { mode: session.mode, providerId: body.providerId, modelId: body.modelId, ...(body.thinkingLevel !== undefined ? { thinkingLevel: body.thinkingLevel } : {}) }]) as { session: SessionSummary };
          return { session: { ...configured.session, source: "desktop" } };
        }
        if (action === "messages") {
          if (typeof body.content !== "string" || body.content.length > 65_536) fail("INVALID_ARGUMENT", 400);
          const ids = body.attachmentIds ?? [];
          if (!body.content.trim() && (!Array.isArray(ids) || !ids.length)) fail("INVALID_ARGUMENT", 400);
          let supportsVision = false;
          if (Array.isArray(ids) && ids.length) {
            // Existing enrichment resolves inherited defaults and exact bindings.
            const current = await this.options.invoke(IPC.invoke.sessionGet, [{ id: sessionId, messageLimit: 1 }]) as { session?: SessionSummary };
            supportsVision = current.session?.supportsVision === true;
          }
          const lease = await this.attachments.acquire(sessionId, ids, supportsVision);
          let accepted = false;
          try {
            const result = await this.options.bridge.agentHost.startTurn(principal, { sessionId, admission: "reject_if_busy", input: { text: body.content, ...(lease.attachments.length ? { attachments: lease.attachments } : {}) }, context: { requestId: body.commandId as string } });
            accepted = true;
            return { accepted: true, turnId: result.turn.id };
          } finally { await lease.release(accepted); }
        }
        if (action === "stop") {
          if (typeof body.turnId !== "string" || !body.turnId) fail("INVALID_ARGUMENT", 400);
          // Main compares the exact active ID synchronously; sidecar checks
          // the same ID again before aborting the active provider stream.
          const result = await this.options.bridge.stopWorkSession({ sessionId, expectedTurnId: body.turnId, urgency: "immediate" });
          if (result.status !== "requested") fail("STALE_TURN");
          return { requested: true, turnId: body.turnId };
        }
        return this.respond(sessionId, decodeURIComponent((match[3] ?? match[4])!), match[3] ? "approvals" : "inputs", body);
      });
      this.json(res, 200, { result });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof URIError) { this.json(res, 400, { error: "INVALID_ARGUMENT" }); return; }
      const code = error instanceof RemoteControlError || error instanceof RemoteAttachmentError ? error.code : (error as { errorCode?: string; code?: string; data?: { errorCode?: string } }).data?.errorCode ?? (error as { errorCode?: string }).errorCode ?? (error as { code?: string }).code ?? "RUNTIME_ERROR";
      const status = error instanceof RemoteControlError || error instanceof RemoteAttachmentError ? error.status : /INVALID|CONFIRM/.test(code) ? 400 : /BUSY|CONFLICT|STALE|NOT_FOUND|EXPIRED|FORBIDDEN/.test(code) ? 409 : 502;
      if (status === 502) this.options.log?.("remote request failed", error);
      this.json(res, status, { error: code });
    }
  }

  private async events(sessionId: string, req: IncomingMessage, res: ServerResponse) {
    const channel = this.channel(sessionId);
    let buffering = true;
    let bytes = 0;
    let closed = false;
    const buffer: Frame[] = [];
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      channel.listeners.delete(listener);
      this.streams.delete(res);
      res.destroy();
    };
    const send = (name: string, data: unknown, cursor: Cursor) => {
      if (closed) return;
      const text = `id: ${cursor.epoch}:${cursor.sequence}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      if (Buffer.byteLength(text) > MAX_BYTES * 4 || !res.write(text)) close();
    };
    const listener = (frame: Frame) => {
      if (frame.data === null) { close(); return; }
      if (buffering) {
        bytes += Buffer.byteLength(JSON.stringify(frame));
        if (bytes > MAX_BYTES || buffer.length >= 512) { close(); return; }
        buffer.push(frame);
      } else send(frame.name, frame.data, frame.cursor);
    };
    // Subscribe before any await, and snapshot at a sequence cut. Everything
    // at/before the cut is already reflected in the snapshot, never reapplied.
    channel.listeners.add(listener);
    this.streams.add(res);
    res.once("close", close);
    req.once("aborted", close);
    try {
      const snapshot = await this.snapshot(sessionId);
      if (closed) return;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      send("snapshot", snapshot, snapshot.cursor);
      buffering = false;
      for (const frame of buffer) if (frame.cursor.sequence > snapshot.cursor.sequence) send(frame.name, frame.data, frame.cursor);
      buffer.length = 0;
      if (!closed) heartbeat = setInterval(() => { if (!res.write(": heartbeat\n\n")) close(); }, 10_000);
      heartbeat?.unref();
    } catch (error) {
      channel.listeners.delete(listener);
      this.streams.delete(res);
      throw error;
    }
  }
}
