# Subagent activity design proposal

Status: awaiting user review. This is a standalone HTML prototype with authored
snapshots, not a production implementation or a runtime test fixture.

## Preview

From the request worktree, serve the design directory:

```sh
python3 -m http.server 4319 --bind 127.0.0.1 --directory designs
```

Open <http://127.0.0.1:4319/subagent-activity/index.html>. Stop the server with
Ctrl+C. The page is self-contained and requires no dependency installation,
external assets, credentials, or provider calls.

## Design decision

Use an open task group in the transcript instead of nested cards. Keep the
existing neutral visual language, with color reserved for meaningful status.

- Single delegation: one compact task row without a branching connector.
- Two or three peers: aligned columns when the conversation is wider than 580px.
- Four peers or a narrower conversation: a vertical sibling list. Connectors
  express group membership, never ordering or child-to-child dependencies.
- Task title first; executor, state, duration and latest activity second. Model,
  complete task requirements and execution details belong in the detail view.
- Stable source order; independent outcomes. Failure highlights only the failed
  task and its summary count, not the entire group.
- User-owned disclosure. Finishing must not collapse content being read.

## Production integration boundaries

Preserve the current work-panel subagent tabs. The prototype inspector and its
narrow-screen placement illustrate information hierarchy, not a new routing
contract. Reuse renderer primitives and i18n when implementing this design.

Only use a parallel label when runtime evidence establishes concurrency.
Consecutive Task calls alone do not prove it. Keep neutral task grouping as a
fallback; never infer dependencies, percentage completion or remaining time.

Use runtime timestamps, stable delegation identity and authoritative outcomes.
Creating is distinct from running; timeout, aborted, stopped and denied are
not successful completion. Use the actual task text with safe wrapping rather
than requiring generated short titles. Runtime text must not be interpolated
into HTML as the fixed, trusted design fixtures are here.

Current implementation references:

- [Transcript delegation view](../../apps/desktop/src/features/chat/transcript/SubagentDetail.tsx)
- [Task row and detail entry](../../apps/desktop/src/features/chat/transcript/ToolRow.tsx)
- [Outcome and topology helpers](../../apps/desktop/src/lib/subagent-topology.ts)
- [Bounded delegation ADR](../../docs/adr/0062-bounded-subagents-behind-a-task-tool.md)

## Validation performed

Browser interactions exercised all eight scenario selections: single, two,
three and four tasks, completed, partial failure, other terminal outcomes, and
creating. Inspected the desktop and narrow dark layouts. DOM geometry checks
found no horizontal overflow in the checked two/three/four-task, partial-failure,
terminal and completed views, including a 390px viewport. Narrow mode uses a
vertical list; desktop two-task mode uses equal columns.

Clicked a task to inspect its detail, verified the failure explanation, and
used Escape to close it. Focus returned to the originating task and scrolled
it into view on the narrow layout. Collapsing the group hid the task list while
retaining its status summary. The completed snapshot remained expanded.

The design detector ran in degraded regex mode because optional parser
packages were unavailable. It reported a crowded type scale; the prototype
now uses 12/14/15/18px text sizes. No dependency install or second detector run
was performed. Screenshots had browser-emulation framing artifacts; DOM
measurements supplemented visual inspection.

Not run: production component tests, Electron E2E, live providers, real event
stream updates, screen-reader testing, or a complete contrast audit. The scope
is an isolated design artifact. Live transitions, long translated content,
restored-history disclosure and actual work-panel resizing remain integration
acceptance work, not validated product behavior.
