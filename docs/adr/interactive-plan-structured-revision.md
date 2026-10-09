# ADR interactive-plan-structured-revision: Interactive Plan structured revision

- Status: Accepted for implementation
- Date: 2026-10-04
- Amends: ADR 0053, ADR 0312
- Amended by: ADR plan-body-approval-revision (approval may also revise the Markdown body)
- Related: ADR 0053, ADR 0312, ADR 0124
- Protocol: v12
- Storage schema: v23

## Context

ADR 0053 approves one immutable, byte-verified Markdown artifact with only
`title` / `question` as structured fields, and approve/reject plus a
permission mode as the only answers. The user cannot correct a plan's step
breakdown or UI design at approval time; the only revision path is reject and
resubmit, which costs a full model round-trip and a new artifact.

Interactive plan views in other coding agents show the demand: the plan
document pairs Markdown with an editable structured task list (id, content,
dependencies) and a UI design spec (framework, component library, style
keywords, typography, color groups), and "Build" executes the edited
structure. Such designs typically keep the structured data in a separate
plan file next to a user-editable Markdown mirror and a diff baseline, edited
through a rich-text editor.

That shape is rejected here:

- **Mutable plan files.** The host would re-read, re-parse, and rewrite plan
  files after approval, breaking ADR 0053's hash-verified artifact and its
  approval identity, and two sequential file writes (Markdown plus
  structured data) are not atomic, so a diff baseline could drift during
  execution.
- **Frontmatter or annotated Markdown inside the artifact.** Structured data
  in the artifact would need parsing, escaping, and disambiguation after
  human edits, and approval-time rewrites would change artifact bytes.
- **A rich-text editor.** The plan document body stays read-only and the
  existing Markdown renderer already renders it, while the structured
  editors are plain forms. A rich-text dependency adds Markdown round-trip,
  undo, and paste machinery without helping the approval transaction, DAG
  validation, or the design form.

## Decision

### 1. Structured metadata beside the immutable artifact

`plans.submit` (Plan kind only) accepts optional `steps` and `design`
alongside the unchanged Markdown input:

```ts
type PlanStep = { id: string; title: string; detail?: string; dependsOn: string[] };
type PlanDesignSpec = {
  framework?: string;            // free slug, e.g. "react"
  componentLibrary?: string;     // free slug, e.g. "shadcn"
  styleKeywords?: string[];
  fontSystem?: { fontFamily: string; heading?; subheading?; body? };
  colorSystem?: { primary?; background?; text?; functional? };
};
```

The host is the authoritative validator (bounded steps, unique step ids,
existing/acyclic `dependsOn`, `#RRGGBB` colors, px sizes, 100–900 weights,
64 KiB / 16 KiB JSON caps); `packages/shared` ships a TypeScript mirror with
identical rules so the renderer and Main validate before any host call.
Validation runs before the artifact is written: an invalid submission creates
neither file nor row. Artifact bytes are never appended or rewritten; the
model mirrors the steps/design as ordinary human-readable Markdown sections,
and structured data lives only in new `plan_approvals` JSON columns
(`steps_json`, `design_json`). This amends ADR 0053's "no structured step
schema" statement without touching its artifact, hash, and epoch rules.

Omitted or empty semantics are fixed: omitted `steps` or `[]` mean "no
steps" (NULL column); a `design` whose every field is absent normalizes to
`{}` and is stored as NULL. A proposal without metadata keeps the exact
legacy wire shape, artifact bytes, prompt instruction, and UI.

Goal submissions reject either field with `PLAN_METADATA_UNSUPPORTED`; the
`SubmitGoal` tool schema is byte-identical to the pre-ADR contract.

### 2. Approval resolves a structured revision

`plans.resolve` (approve) accepts optional `revisedSteps` / `revisedDesign`.
Omitted keeps the submitted value; `[]` / `{}` explicitly clear it and are
stored verbatim as normalized JSON in `resolved_steps_json` /
`resolved_design_json` (NULL when no revision was carried). Reject with
either revision fails with `PLAN_INVALID_ARGUMENT`; a stored Goal proposal
with revisions fails with `PLAN_METADATA_UNSUPPORTED`.

The effective contract is the resolved metadata when non-NULL, otherwise the
submitted metadata; effective empty values behave as absent (no checklist
seeding, no execution injection). A replay of an already-approved proposal
succeeds without writes only when the action, permission mode, and both
normalized revisions equal the stored resolution (omitted equals NULL, not an
explicit clear); any mismatch fails with `PLAN_APPROVAL_CONFLICT`.

Artifact verification still precedes approval. One transaction records the
status, `resolved_*_json`, and queued execution, switches the session to
Agent with the selected permission mode, and seeds the checklist (below).
Revisions are normalized and validated before the transaction opens. The
approval audit records only `revisedSteps` / `revisedDesign` booleans and a
`seededTodos` count — never metadata text, so plan content cannot leak into
logs; the submission audit likewise records only `stepCount` / `hasDesign`.

### 3. Approval-time checklist seeding and step identity

This amends ADR 0312's "TodoWrite is the only checklist writer": the Plan
approval transaction is a second, host-owned writer. When the effective steps
are non-empty, the same approval transaction replaces the session checklist
with one row per step — content = title, `pending`, `medium` priority,
`step_id` = step id, in step order — incrementing `todo_revision` and
stamping `todo_updated_at` as TodoWrite does. No running turn is required
(approval happens between turns); a seeding failure rolls back the entire
approval. Empty effective steps leave the checklist untouched (legacy
behaviour). After commit the RPC layer emits `todos.changed` with the new
committed snapshot; an idempotent replay never re-seeds.

`session_todo` gains a nullable `step_id` column (1–64 characters, the plan
step id grammar, unique within a write). TodoWrite items accept an optional
`stepId` with the same grammar, and the host carries identity over: an item
that omits `stepId` inherits it only when exactly one previous item has
identical normalized content and that id is not claimed by another new item.
Seeded rows therefore keep their plan linkage across TodoWrite's
whole-list replacements.

### 4. Execution instruction precedence

The approved-plan execution instruction is unchanged byte-for-byte without
effective metadata. With it, after `</approved-plan-markdown>` the builder
appends `<approved-steps>` and `<design-constraints>` JSON sections
(`<`, `>`, `&` escaped) that state they are the user's approved revision and
take precedence over any Steps or Design section mirrored in the Markdown,
that the session checklist is already seeded from the steps and each item's
`stepId` must be kept when updating it with TodoWrite, that work follows
`dependsOn` order, and that design constraints apply to UI work. The runtime
returns `PLAN_STEPS_INVALID` / `PLAN_DESIGN_INVALID` /
`PLAN_METADATA_UNSUPPORTED` as recoverable tool errors (no `terminate`) so
the model can fix the structured field and resubmit in the same turn;
workspace and IO failures keep terminating the turn as before.

### 5. Read path and renderer surface

A new read RPC `plans.get { sessionId, proposalId }` returns `{ proposal }`
for any status after expiring pending approvals; a session mismatch or
unknown proposal is `PLAN_NOT_FOUND`. The renderer opens a work-panel tab of
a new `plan` kind (`plan:<proposalId>`, resource = proposal id, label =
title) from a "view / edit plan" entry on the approval bar; the bar itself
and the artifact opener stay. Before approval the tab edits a draft of
steps/design — only the structured fields; a Markdown body change is a new
submission with a new artifact (ADR 0053 unchanged) — and submits the revision
inline with approve; after approval it is a read-only contract view of the
effective metadata with per-step status matched from the session checklist.

The steps panel offers a List / Graph toggle shared by the pending draft and
the approved view. List rows show dependency chips that name each referenced
step's index and title. Graph is a hand-written SVG dependency DAG (stable
topological layers, rounded nodes, directed edges, accessible list fallback):
it renders the live draft while the plan is being edited and, after approval,
the effective steps with per-step progress. The graph is container-aware: it
scales to the work panel, switches to a vertical one-column layout
automatically when the panel is narrower than the horizontal layout needs,
and provides a Horizontal/Vertical toggle plus zoom out / Fit / zoom in
controls. The design spec panel is a compact two-column grid on wide panels.

Electron Main validates present revisions with the shared validators and
forwards only normalized values; invalid metadata throws before host I/O. The
host-runtime execution decoder fails closed on malformed present metadata
rather than silently dropping the revision.

Remote RACP sessions stay read-only for structure: Main's remote backend
throws `PLAN_REVISION_UNSUPPORTED` before any remote I/O when revisions are
present, and `plans.get` is unsupported remotely, so the UI never edits
structure it cannot apply. Plan and Goal continue to require a persisted
project workspace (ADR 0124); metadata does not broaden that boundary.

### 6. Versioning

Protocol v12 and storage schema v23 carry the Interactive Plan change. The
handshake still requires exact version equality, so a mixed v11/v12 pair
refuses to boot instead of silently dropping the approved structure. Schema
v23 adds the four `plan_approvals` columns and `session_todo.step_id` in one
backed-up, transactional, idempotent v22→v23 migration (`pi.sqlite.v22.bak`,
column probes, `PRAGMA user_version = 23` last); the v20→v21→v22→v23 chain
remains supported. Upstream v22 owns the session-list index migration. Early
dev builds also used v22 for plan columns, so v23 preserves their metadata
and idempotently applies the upstream index replacement as well.

## Explicitly not done

- **User ticking checklist items during execution.** User ticks and
  TodoWrite's whole-list replacement would need a two-way revision CAS;
  execution-time checklist writes stay TodoWrite-only. Future work.
- **Auto-opening the Plan tab.** The approval bar remains the prompt
  surface; the tab opens on demand.

## Consequences

### Positive

- The user can correct structure at approval without another model
  round-trip, while every artifact stays byte-verified and immutable.
- The seeded checklist, the execution instruction, and the approved revision
  are committed by one transaction, so the agent executes what was approved.
- Plans without metadata behave byte-for-byte as before on the wire, in
  storage, and in the UI.

### Tradeoffs and compatibility

- Old app with a new database: the schema is newer, so the old app refuses
  to serve it, exactly as for every schema bump. New app with an old
  database migrates additively with a backup.
- Legacy rows have NULL metadata columns and render exactly as before; wire
  fields are omitted when NULL.
- `session_todo` now has two writers (TodoWrite and the approval
  transaction). Seeding runs between turns and replaces the whole list, so
  an unseeded session's checklist semantics are unchanged.
- Field-by-field payload rebuilds (the Electron IPC allowlist, the
  host-runtime execution decoder, the remote backend) could silently drop
  revisions; each hop now validates and forwards them or fails closed.

## Related docs

- `docs/spec/03-runtime/interactive-plan-metadata.md`
- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/03-runtime/04-data-storage.md`
- `docs/spec/03-runtime/06-host-rpc-protocol.md`
- `docs/spec/03-runtime/08-error-codes.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- ADR 0053, ADR 0312, ADR 0124
