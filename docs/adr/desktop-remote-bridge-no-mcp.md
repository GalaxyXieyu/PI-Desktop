# ADR: Desktop loopback Remote Bridge is independent of MCP

- Status: Accepted for the explicitly authorized opt-in desktop integration
- Scope: `pi-remote/1`; additive to ADR 0205, not a replacement for RACP-WS

## Context

The Gateway/mobile client needs the desktop's existing UiMessage transcript,
original runtime event envelopes, and reviewable Host-owned interactive cards.
The local MCP catalog is not a remote session authority and does not stream
these events. RACP summaries alone omit original tool args and plan Markdown.
The previous narrower per-turn mode parameter stopped at a sidecar stub, leaving
host tool evaluation susceptible to a subsequent stored permission-mode change.

## Decision

Use a separately opted-in loopback REST/SSE binding in Electron Main. Reuse
AgentHost admission, runtime state, original input requests, and the existing
desktop prompt/stop/permission/plan handlers. Rust remains the persistence and
permission authority and opens no network socket. No second agent, generic RPC
route, MCP import, or public session/provider creation is introduced.

Rust `session.beginTurn` validates and installs an explicit process-local turn
ceiling under the existing permission owner while holding the host state lock.
Tool execution and permission evaluation clamp after session/global/subagent
resolution. Explicit Ask turns do not consume session-wide grants. Ending a
matching turn removes its ceiling; the existing startup fence prevents durable
running turns from resuming after a process restart. No schema migration is
needed. Approved plan execution also pins its reviewed target permission mode.

The transport keeps only bounded connection state, command deduplication, and
event cursors; AgentHost owns the live transcript tail. A reconnect subscribes
before snapshot reads and drops buffered events already represented at the cut.
No polling generates agent deltas. Original pending details are bounded as a
whole and rejected when too large, rather than silently shortened for approval.

## Alternatives and consequences

- Extending MCP was rejected: it couples a local automation catalog to a remote
  session contract and cannot satisfy native original-event streaming.
- Exporting arbitrary IPC/host RPC was rejected: it exposes configuration,
  secrets, and unrelated desktop capabilities to the remote token.
- A standalone second runtime was rejected: turn, approval and persistence
  ownership would diverge from the desktop.
- Reusing only RACP wire summaries was rejected for this client: it loses
  original UiMessage and interactive-card detail. The existing AgentHost hub
  remains an internal source for transitions.

The bridge adds a bearer-authenticated local attack surface and bounded
in-memory epoch state. It is off by default, loopback-only, Host/Origin checked,
and never a public deployment endpoint. A separate Gateway must supply remote
identity and routing. An app restart rotates the token and epoch; clients must
reconcile through a snapshot. RACP-WS and unrelated MCP functionality remain
unchanged. See the executable contract in
[desktop-remote-bridge](../spec/03-runtime/desktop-remote-bridge.md).
