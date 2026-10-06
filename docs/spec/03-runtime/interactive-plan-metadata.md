# Interactive Plan metadata — host contract (protocol 12, schema 22)

This additive host contract preserves immutable Markdown artifacts. A submission
without metadata has the same proposal/execution wire shape and artifact bytes
as before. Structured metadata is stored only in SQLite, never appended to the
artifact. Goal submissions do not support metadata.

Decision record: [ADR interactive-plan-structured-revision](../../adr/interactive-plan-structured-revision.md).

## Submission and reads

`plans.submit` accepts optional `steps` and `design`. JSON null is absent.
Non-null metadata on `kind: "goal"` fails with `PLAN_METADATA_UNSUPPORTED`.
Validation runs before artifact publication or approval insertion. Validation
errors have the form `<CODE> <path>: <reason>` with `PLAN_STEPS_INVALID` or
`PLAN_DESIGN_INVALID`; cycles include the cycle path.

- Steps are an array of at most 24 objects. Empty means no metadata.
- Each step has `id`, `title`, optional `detail`, and `dependsOn` (missing
  defaults to `[]`). Unknown keys are rejected.
- IDs are trimmed, unique and case-sensitive, 1–64 ASCII characters matching
  `[A-Za-z0-9][A-Za-z0-9._-]*`.
- Titles are trimmed, 1–200 Unicode characters, without U+0000–001F or U+007F.
- Details are trimmed, at most 2000 Unicode characters, without NUL. Newlines
  are allowed; empty details are omitted.
- Dependencies are trimmed and reference at most 24 existing other IDs, without duplicates,
  self-reference, or cycles.
- Normalized serialized steps are limited to 64 KiB of UTF-8 JSON.

Design accepts only `framework`, `componentLibrary`, `styleKeywords`,
`fontSystem`, and `colorSystem`; nested unknown keys are also rejected.

- Framework/library are trimmed and lowercased; empty is omitted. Non-empty
  values are at most 40 characters matching `[a-z0-9][a-z0-9.+/_-]*`.
- Style keywords are at most 12 trimmed strings, each 1–40 Unicode characters,
  with no control characters and no case-insensitive duplicates.
- Font system requires a trimmed `fontFamily` of 1–120 Unicode characters
  without control characters. Optional heading/subheading/body levels require
  a `size` matching `\d{1,2}px` in 10–72px and an integer `weight` from 100 to
  900 in multiples of 100.
- Color system accepts primary/background/text/functional groups, each at most
  eight exact `#RRGGBB` strings, normalized to uppercase. Invalid colors report
  `use #RRGGBB`.
- Empty keyword/color groups are omitted; an empty color system is omitted.
  A design with all fields absent becomes `{}`. Normalized design JSON is
  limited to 16 KiB.

`plans.get { sessionId, proposalId }` expires pending approvals first and returns
`{ proposal }` for any status. Missing proposals or session mismatches both
return `PLAN_NOT_FOUND`. `plans.pending` continues returning pending proposals
with their optional metadata. Submission audit adds only `stepCount` and
`hasDesign`, not structured text.

## Storage and execution projection

Schema 22 adds nullable TEXT columns `steps_json`, `design_json`,
`resolved_steps_json`, and `resolved_design_json` to `plan_approvals`.
Submitted `[]` and `{}` are stored as NULL. Proposal serialization omits NULL
fields (`steps`, `design`, `resolvedSteps`, `resolvedDesign`). Corrupt metadata
is omitted on read with a warning that does not expose plan text.

Execution `steps` and `design` use resolved metadata when non-NULL, otherwise
submitted metadata. Effective empty values are omitted.

## Approval revisions and checklist seeding

`plans.resolve` accepts optional `revisedSteps` and `revisedDesign`; JSON null
is absent. Reject with either non-null revision fails with
`PLAN_INVALID_ARGUMENT`; a stored Goal proposal with revisions fails with
`PLAN_METADATA_UNSUPPORTED`. The host normalizes revisions before opening the
approval transaction, using the submission validators. Omitted revisions keep
submitted metadata; explicit `[]` / `{}` clears are stored verbatim as normalized
JSON rather than NULL.

A replay succeeds without writes only when action, permission mode, and both
normalized revisions match the stored resolution. Omitted equals NULL, not an
explicit clear. Any mismatch returns `PLAN_APPROVAL_CONFLICT`.

Artifact verification still precedes approval. One transaction records status,
execution queue identity and revisions, changes the session to Agent, and seeds
the checklist when effective steps are non-empty. Seeding increments
`todo_revision`, stamps `todo_updated_at`, and replaces rows in step order with
title as content, `pending` status, `medium` priority, and step ID. It requires
no running turn. Empty effective steps leave existing rows and revision untouched.
Any seeding failure rolls back the entire approval. The approval audit adds only
`revisedSteps` / `revisedDesign` booleans and `seededTodos` count, never metadata text.

After commit, `plans.resolve` emits the existing `plans.changed` notification and,
only if this call seeded rows, a `todos.changed` committed snapshot with exactly
the TodoWrite payload shape. Idempotent replay never re-seeds or re-emits
`todos.changed`. No internal seeding marker is added to the JSON result.

## TodoWrite step identity

Todo items accept optional `stepId`: a trimmed string using the same ID grammar
and length limit as plan steps. Non-string, malformed, or duplicate IDs fail
validation with an error naming `todos[i].stepId`. Omitted IDs remain absent on
the wire. Reads and writes persist `session_todo.step_id`.

Before replacing rows, TodoWrite reads the previous checklist inside the same
transaction. An item omitting `stepId` inherits it only when exactly one previous
item has identical normalized content and that item's ID is not claimed by
another new item. Explicit new IDs take precedence regardless of position;
carry-over never assigns one ID twice. Changed or ambiguous content does not
inherit identity. Existing Agent-mode and running-turn authorization is unchanged.

Schema 22 also adds nullable `session_todo.step_id` with a 1–64 character length
constraint when non-NULL. Fresh databases include it; the backed-up,
transactional v21→v22 migration probes columns before adding them and preserves
existing rows. The v20→v21→v22 chain remains supported.

## Renderer document review

The approval bar offers a secondary document entry for both Plan and Goal
proposals. Plans with structured metadata show task/design summary chips and
use the review-and-edit label. The entry opens a session-scoped `plan:<id>` work
panel tab; the artifact opener and chat links to the artifact open the same tab
(D647), and the approval controls are unchanged.
Tab sanitization, reordering, deduplication, and session switching retain this
resource like other work-panel resources.

The SubmitPlan plan history card — the read-only transcript card rendered for
SubmitPlan tool results — also offers a View plan button when its result payload
contains a proposal with string `id` and `title`. The button opens the
proposal's session-scoped tab (falling back to the active session when the
result has no string session ID), without toggling the card's disclosure. The
entry remains available after Build and transcript reload; SubmitGoal cards,
Read rows, topology rows, and results without a valid proposal do not gain it.

The read-only document shows title, status, overview, immutable Markdown, and
non-empty design/tasks sections. Design includes keyword chips, font previews,
hex-labeled color swatches, framework, and component library; on wide panels
the design panel is a compact two-column grid. Dependencies show
the referenced task's index and title. Approved documents use resolved metadata
when present, including explicit empty revisions. Legacy proposals add no empty
Design or Tasks sections.

Matching session checkpoints/pending proposals take precedence over one fallback
`plans.get` read. Identity changes invalidate in-flight results. Remote sessions
render store data only, with a read-only note, and never issue `plans.get`.
Loading and unavailable states are localized.

A standalone renderer draft store retains pending structured edits by
`sessionId:proposalId:version`, independently of tab lifetime. Its pure reducer
prevents dependency cycles and removes deleted dependency references. Revision
projection normalizes through shared validators and sends only changed parts;
explicit clears remain `[]` / `{}`. Resolution discards the draft. The plan
tab's editor and revision submission UI, shared Build/Reject controls, and
editing interactions are built on this model; live Electron coverage is
`E2E-PLAN-interactive-tab-edit-build-progress`.

## Renderer progress and dependency graph

The Tasks section defaults to List and offers a shared List/Graph segmented
control in pending and approved views. Both list variants show dependency chips
with the referenced step's index and title. Graph renders the current pending
draft, or the effective steps after resolution, as a read-only SVG DAG: stable
topological columns, rounded nodes, directed Bézier edges, horizontal overflow,
and an accessible task/stage summary plus an ordered-list fallback. The graph
scales to the work panel: it switches to a vertical one-column layout
automatically when the panel is narrower than the horizontal layout needs, and
offers a Horizontal/Vertical toggle plus zoom out / Fit / zoom in controls.
Long labels are truncated visually; full titles remain available.

Approved steps derive live progress from the session checklist: explicit step IDs
match first, then exact trimmed titles match todos without an ID, consuming each
todo at most once. Unmatched steps display pending. Only completed steps count
in `n / m done`; cancelled steps remain in the total. The count and execution
badge (queued/running/completed/interrupted) remain visible in both views.
Status circles and graph nodes do not write checklist state; user ticking is
intentionally unavailable to avoid racing TodoWrite's whole-list replacement.
Plans without effective steps gain no progress or graph section.

## Verification

Rust tests cover validation/normalization, migration of existing approval and
checklist rows, submit→pending→approve/reject→get, session mismatch, validation
before filesystem writes, exact legacy/artifact bytes, corrupt-column recovery,
and effective metadata precedence. Revision tests cover approve→seed→queue/claim,
explicit clears, normalized replay conflicts, validation refusal, artifact
verification and unchanged bytes/hash, atomic rollback on injected INSERT failure,
TodoWrite identity carry-over, and committed RPC notifications. Live UI editing
is covered by `E2E-PLAN-interactive-tab-edit-build-progress`.
