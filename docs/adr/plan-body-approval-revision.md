# ADR plan-body-approval-revision: Edit the Plan body and choose the execution model at approval

- Status: Accepted for implementation
- Date: 2026-10-06
- Amends: ADR 0053, ADR interactive-plan-structured-revision
- Related: D650, D651
- Protocol: v12 (unchanged; additive optional request field)
- Storage schema: v22 (unchanged)

## Context

ADR interactive-plan-structured-revision lets the user correct a pending
Plan's steps and design at approval, but the Markdown body stays the
immutable artifact the agent submitted. Users read that body in the Plan tab
and expect to fix a sentence or a table cell in place; the only path was
rejecting the plan and waiting for a full replan.

## Decision

### 1. The pending Plan body is a WYSIWYG draft

While a local Plan proposal is pending, the Plan tab renders the body in a
lazily loaded tiptap editor (StarterKit, GFM tables, `@tiptap/markdown`).
Edits live in the existing per-proposal draft next to steps and design, and
Reset restores the submitted body. The editor reports the submitted bytes
until its serialized content differs from the serialized submission, so an
unedited body never produces a revision. Soft line breaks load as spaces
(their CommonMark rendering) so ProseMirror does not turn them into hard
breaks. Goal contracts and remote sessions stay read-only.

### 2. Approval publishes the edited body as a new artifact

`plans.resolve` approve accepts optional `revisedMarkdown: string`. Reject
with it fails with `PLAN_INVALID_ARGUMENT`; a blank or non-string value fails
with `PLAN_INVALID_ARGUMENT`; a stored Goal fails with
`PLAN_METADATA_UNSUPPORTED`; a body over the submission limit fails with
`PLAN_MARKDOWN_TOO_LARGE`. A body byte-identical to the submission is no
revision.

After verifying the submitted artifact, the host publishes the edited body
with the same writer and naming rules as a submission, then one transaction
points the approval row's body and artifact columns at the new file, records
the artifact write, and adds `revisedMarkdown` plus the submitted artifact
identity (path, hash, size; never text) to the approval audit. If the
transaction fails, the new file is removed. No artifact is ever rewritten:
the submitted file stays on disk byte-for-byte.

Execution descriptors already carry the row's body and artifact, so the
agent executes the edited body without a runtime change. A replay succeeds
without writes when the body now equals the stored one.

### 3. Approval may switch the session's execution model

Users often plan with a strong model and execute with a faster one, but
session configuration is gated while a proposal is pending, so the model
could only change after execution had already started. `plans.resolve`
approve (Plan or Goal) accepts optional
`targetModel: { providerId, modelId }`. Reject with it, or a value whose
trimmed ids are not both nonempty strings, fails with
`PLAN_INVALID_ARGUMENT` and changes nothing.

The approval transaction that already switches the session to Agent mode
and the target permission mode also sets the session's provider and model,
so the execution launch resolves the chosen model and the session keeps it
afterwards. Like `session.configure`, the host stores the ids without a
catalog check; an unusable model fails at launch with the existing
provider errors. The audit adds `executionModel` (ids only, or null). The
approval row does not store the model, so a replay of an approved proposal
returns the stored resolution without comparing or writing it.

The Build menu lists the models the composer offers (enabled providers with
credentials, image-generation models excluded) under the permission modes.
The choice is remembered in renderer local storage like the approval mode;
a remembered model that is no longer configured, or that equals the
session's model, sends no `targetModel`. Remote sessions do not offer it.

## Alternatives considered

- **Keep the body immutable and route edits through the composer.** Already
  available (D649), but it costs a model round-trip for a one-word fix.
- **Store the edited body in a new column beside the submitted one.** Keeps
  both on the row, but needs a schema migration and a second body field in
  every reader; the audit and the retained file already preserve the
  submission.
- **Change the model with `session.configure` before approving.** Blocked
  by the pending gate, and a separate call could race the approval; one
  transaction keeps mode, permission, and model consistent.
- **Bump the protocol.** Host and renderer ship and update together, and the
  fields are additive; a renderer paired with an older v12 host outside a
  packaged build would approve the unedited body on the planning model. Accepted as a development
  only risk.

## Consequences

- The approved row describes what the agent executes; the submitted body is
  recoverable from the audit identity and the retained artifact file.
- Serialization normalizes formatting of edited bodies (table padding, blank
  lines, escaping such as `\_`); rendering is unchanged.
- The editor adds a lazily loaded renderer chunk; the main bundle is
  unchanged.
- After execution the session stays on the execution model; the user
  switches back in the composer when planning again.

## Related docs

- `docs/spec/03-runtime/interactive-plan-metadata.md`
- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/03-runtime/06-host-rpc-protocol.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
