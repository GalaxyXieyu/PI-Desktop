# Desktop Remote Bridge — pi-remote/1

This opt-in loopback adapter controls **existing desktop-local sessions**. It
uses the existing AgentHost, Rust host-core, and desktop handlers. It has no
MCP transport, controller, catalog, or generic IPC/RPC forwarding route. It
neither creates sessions nor configures providers. RACP-WS remains unchanged.

## Activation and security

Set `PI_DESKTOP_REMOTE_CONTROL=1`. `PI_DESKTOP_REMOTE_PORT` defaults to `37124`;
`0` requests an ephemeral test port. Bind only `127.0.0.1`. After successful
backend boot and bind, write `<dataDir>/remote-control.json` atomically with
owner-only permissions:

```json
{"active":true,"protocol":"pi-remote/1","url":"http://127.0.0.1:37124","token":"<64 lowercase hex characters>","pid":12345}
```

Every request, including SSE, requires `Authorization: Bearer <token>`.
Only the listener's `127.0.0.1:port` or `localhost:port` Host is accepted. An
Origin, if present, must be the matching loopback HTTP origin. Tokens in query
parameters are forbidden; there is no browser cookie authentication or CORS
permission. The token rotates with the server instance. Shutdown disconnects
streams, removes subscriptions, closes HTTP connections, and removes discovery
only if it still belongs to this instance. Expose only through an authenticated
external Gateway/tunnel; never bind this adapter publicly.

## HTTP contract

All paths begin `/v1/remote`. Success is `{result: ...}`; errors are
`{error: CODE}`. Invalid input is 400, bad authentication/origin is 401,
state/identity conflicts are 409, and unavailable/failed runtime is 502.

| Method | Path | Result / input |
| --- | --- | --- |
| GET | `/capabilities` | `{protocol:'pi-remote/1',ready:true}` |
| GET | `/sessions` | `{sessions: SessionSummary[]}` including title, source=`desktop`, permissionMode |
| GET | `/sessions/:id/history` | `{session: SessionDetail}` with UiMessage messages, messageStart, hasMoreBefore, permissionMode |
| GET | `/sessions/:id/snapshot` | Snapshot below |
| GET | `/sessions/:id/events` | Authenticated SSE below |
| POST | `/sessions/:id/messages` | `{commandId:UUID,content}` → `{accepted:true,turnId}` |
| POST | `/sessions/:id/stop` | `{commandId:UUID,turnId}` → `{requested:true,turnId}` |
| POST | `/sessions/:id/approvals/:requestId/respond` | `{commandId,type:'permission'|'plan',revision,confirm:true,decision}` |
| POST | `/sessions/:id/inputs/:requestId/respond` | `{commandId,revision,confirm:true,answers}` |

History query: `messageBefore` is a nonnegative safe integer (exclusive physical
cursor); `messageLimit` is 1–100 (default 50); `contentLimit` is 1–16384 (default
16384). Invalid values fail, not silently coerce. History uses the renderer's
existing `session.get` numeric paging shape, not RACP item IDs.

Snapshot:

```text
{sessionId, session:{id,title,permissionMode,...},
 status:{sessionId,isRunning,currentTurnId?,pendingToolConfirmations?},
 messages:UiMessage[], items:Pending[], cursor:{epoch,sequence}}
Pending = {type:'permission'|'ask'|'plan', requestId,
           revision:<SHA256 hex>, details:<original request/proposal>}
```

Snapshots include a bounded transcript tail plus live runtime text reconstructed
with `applyMessageUpdate`; they do not wait for final transcript persistence.
Pending details retain the Host's `ToolPermissionRequest.argsPreview`, complete
`AskToolRequest` options, or `PlanProposal.markdown` and identity/version. The
Host's existing args-preview truncation remains; no additional summary replaces
review details. SHA256 covers canonical type, requestId and details. At most 32
pending items / 512 KiB are returned; larger sets fail closed, never silently
truncate approval details. Snapshot tails are capped at 100 messages with
16384 content characters each; the total response/frame ceiling is 4 MiB.

Commands are deduplicated by UUID within the server epoch. Same session, route,
and canonical body returns the original in-flight or completed outcome; changing
any of these conflicts (`COMMAND_CONFLICT`). At 10000 commands the instance
refuses new commands rather than evicting idempotency history. Failed command
outcomes are remembered too; a genuinely new attempt needs a new UUID.

Messages require an explicit stored Ask session (not `inherit`). AgentHost
checks admission, the prompt adapter forwards `requiredPermissionMode:'ask'`,
and Rust rechecks before opening the durable turn. It installs a turn-local Ask
ceiling even when the session was already Ask. Session/global mode changes,
subagent permission scopes, and session tool grants cannot widen that turn.
Local low-risk/scratch exceptions and Plan/Goal hard denials remain unchanged.
Stop targets the exact active turn in both Main and sidecar; never stop whichever
turn happens to be active after a stale request arrives.

Permission decisions are only `allow-once` or `deny`. Plan decisions are only
`approve` or `reject`; approval selects Ask, and approved execution pins that
reviewed ceiling. Re-read pending identity/revision before dispatch; existing
Host handlers arbitrate removal and plan version. Ask inputs are claimed
synchronously by AgentHost so concurrent desktop/remote answers cannot dispatch
twice. Stale/removed requests fail with `STALE_REQUEST` or the Host conflict.

## SSE

Every connection starts with named `snapshot` carrying the Snapshot object.
Then named `agent` carries the original `AgentEventEnvelope` (including runtime
sessionId/turnId/event/ts and existing nesting metadata), named `pending` carries
`{sessionId,items}`, and named `status` carries `{sessionId,status}`.

The adapter subscribes before asynchronous snapshot reads, buffers events, and
cuts at `{epoch,sequence}`. Buffered events at/before the snapshot cut are not
reapplied; later events follow it. Reconnection always takes a fresh snapshot,
including when Last-Event-ID is supplied. IDs are `epoch:sequence`. Original
runtime message start/update/end events are never synthesized by polling.
Pending/status refresh is driven by AgentHost transitions, not a timer.
Supported original events: agent/turn start/end, message start/update/end,
user_message_persisted, tool start/update/end/permission request, asktool_request,
planning_state, status, usage, error, compaction start/end. No arbitrary renderer
broadcast or unrelated session is forwarded.

Heartbeats are comments every 10 seconds. Initial buffers are at most 512 frames
or 1 MiB; a slow socket (`write` returns false), oversized frame, or failed
pending refresh disconnects, requiring a new snapshot. Channels are bounded to
256 per instance and HTTP connections to 64.

## Isolated integration harness (no public create)

Build the candidate with the existing installed toolchain (no install):

```sh
node scripts/build-remote-control.mjs --check --desktop
cargo build -p host-core --offline
node scripts/e2e-remote-control.mjs
node --test --test-timeout=20000 apps/desktop/test/remote-control.test.mjs
cargo test -p host-core remote_control_tests --offline
cargo test -p host-core remote_ceiling_tests --offline
```

The scoped build script pins workspace resolution to this worktree because
shared node_modules symlinks can otherwise select another checkout's dist.
Outputs: `packages/{shared,i18n,plugin-sdk,agent-runtime,agent-host,host-runtime,voice-runtime,racp}/dist`,
`apps/desktop/out/{main,preload,renderer}`, `target/debug/pi-desktop-host-core`.
The unpackaged desktop loads `packages/agent-runtime/dist/sidecar.js`.
`scripts/e2e-remote-control.mjs` seeds an isolated Host, boots real Electron,
calls a fake loopback model through the production sidecar, and verifies
snapshot-first SSE, original message updates/final text and duplicate-command
suppression with MCP disabled. It does not use Playwright or the user's profile.

Before launching Electron, use `scripts/e2e/host.mjs`'s `Host` against a new
scratch `dataDir` and project. **Never open the user's profile or share the
SQLite directory with an already-running desktop.** Start a local fake provider
HTTP server implementing OpenAI chat-completions streaming. Seed via Host RPC:

```js
await host.start();
const { provider } = await host.call('providers.create', {
  name: 'Remote fixture', type: 'openai_compatible', protocol: 'openai_compatible',
  authKind: 'none',
  baseUrl: 'http://127.0.0.1:FAKE_PORT/v1', defaultModelId: 'fixture-model',
  apiStyle: 'chat_completions',
  models: [{id:'fixture-model',contextWindow:128000,maxTokens:4096,thinkingLevels:['off']}]
});
const { session } = await host.call('session.create', {
  title: 'Remote fixture', mode: 'agent', projectPath: isolatedProject
});
await host.call('session.configure', {
  id: session.id, mode: 'agent', permissionMode: 'ask', thinkingLevel: 'off',
  providerId: provider.id, modelId: 'fixture-model'
});
await host.stop();
```

Launch the built Electron with `PI_DESKTOP_DATA_DIR=<same isolated dataDir>`,
`PI_DESKTOP_REMOTE_CONTROL=1`, `PI_DESKTOP_REMOTE_PORT=0`, and
`PI_DESKTOP_HOST_BIN=<candidate target/debug/pi-desktop-host-core>`. Keep
`PI_DESKTOP_MCP_CONTROL` unset. Read remote discovery, select the seeded session
through `/sessions`, and drive only REST/SSE. There is intentionally no public
session/provider creation route. The Node HTTP suite uses real Rust state but a
runtime test port; it is not proof of Android/Gateway or full Electron/model
acceptance.

The mobile stop endpoint interrupts the exact active turn immediately through
`agentAbort`, rather than waiting for a provider stream to finish gracefully.
A stale target still fails without touching a newer turn.
