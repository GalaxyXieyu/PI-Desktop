use super::*;
use crate::todos;
use serde_json::Value;

struct Fixture {
    dir: tempfile::TempDir,
    db: Database,
    proposal: PlanProposal,
    before: todos::TodoSnapshot,
}

impl Fixture {
    fn new(kind: &str, steps: Option<&Value>, design: Option<&Value>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        let before = todos::replace_for_turn(
            &db, &session.id, Some(&turn),
            &todos::normalize_input(&json!({"todos":[{"content":"Existing checklist","status":"completed","stepId":"existing"}]})).unwrap(),
        ).unwrap();
        PlanManager
            .enter(&db, &session.id, &turn, "enter", kind)
            .unwrap();
        let proposal = PlanManager
            .submit(
                &db,
                PlanSubmitParams {
                    workspace_root: dir.path(),
                    session_id: &session.id,
                    turn_id: &turn,
                    tool_call_id: "submit",
                    kind,
                    title: "Plan",
                    markdown: "  # Exact\r\nbody\n",
                    question: "Proceed?",
                    steps,
                    design,
                },
            )
            .unwrap();
        sessions::end_turn(&db, &turn, "completed", None, None, false).unwrap();
        Self {
            dir,
            db,
            proposal,
            before,
        }
    }

    fn resolve(
        &self,
        action: &str,
        steps: Option<&Value>,
        design: Option<&Value>,
    ) -> Result<PlanResolution> {
        PlanManager.resolve(
            &self.db,
            PlanResolveParams {
                workspace_root: Some(self.dir.path()),
                proposal_id: &self.proposal.id,
                session_id: &self.proposal.session_id,
                turn_id: &self.proposal.turn_id,
                tool_call_id: &self.proposal.tool_call_id,
                version: Some(self.proposal.version),
                action,
                target_permission_mode: Some("ask"),
                revised_steps: steps,
                revised_design: design,
            },
        )
    }

    fn snapshot(&self) -> todos::TodoSnapshot {
        todos::get(&self.db, &self.proposal.session_id)
            .unwrap()
            .unwrap()
    }

    fn assert_unchanged(&self) {
        assert_eq!(
            get_proposal(&self.db, &self.proposal.id).unwrap().unwrap(),
            self.proposal
        );
        assert_eq!(
            sessions::session_mode(&self.db, &self.proposal.session_id)
                .unwrap()
                .as_deref(),
            Some(self.proposal.kind.as_str())
        );
        assert_eq!(self.snapshot(), self.before);
        assert!(PlanManager
            .queued_executions(&self.db, None)
            .unwrap()
            .is_empty());
    }
}

fn steps() -> Value {
    json!([{"id":"a","title":"First"},{"id":"b","title":"Second","dependsOn":["a"]}])
}

#[test]
fn approval_revisions_persist_seed_and_preserve_artifact_bytes() {
    let f = Fixture::new(
        KIND_PLAN,
        Some(&steps()),
        Some(&json!({"framework":"react"})),
    );
    let revised_steps = json!([{"id":" revised ","title":" Revised title "},{"id":"last","title":"Last","dependsOn":["revised"]}]);
    let revised_design = json!({"framework":" Vue ","colorSystem":{"primary":["#abcdef"]}});
    let expected_steps = metadata::normalize_steps(&revised_steps).unwrap();
    let expected_design = metadata::normalize_design(&revised_design).unwrap();
    let artifact = f.proposal.artifact.as_ref().unwrap();
    let path = f.dir.path().join(&artifact.relative_path);
    let bytes = fs::read(&path).unwrap();
    let result = f
        .resolve("approve", Some(&revised_steps), Some(&revised_design))
        .unwrap();
    assert!(result.seeded_todos);
    assert_eq!(result.proposal.resolved_steps, Some(expected_steps.clone()));
    assert_eq!(
        result.proposal.resolved_design,
        Some(expected_design.clone())
    );
    assert_eq!(result.proposal.steps, f.proposal.steps);
    assert_eq!(result.proposal.design, f.proposal.design);
    let wire = serde_json::to_value(&result).unwrap();
    assert!(wire.get("seededTodos").is_none());
    assert_eq!(wire["proposal"]["resolvedSteps"], json!(expected_steps));
    assert_eq!(wire["proposal"]["resolvedDesign"], json!(expected_design));
    let execution = result.execution.unwrap();
    assert_eq!(execution.steps, Some(expected_steps.clone()));
    assert_eq!(execution.design, Some(expected_design.clone()));
    let stored = get_proposal(&f.db, &f.proposal.id).unwrap().unwrap();
    assert_eq!(stored, result.proposal);
    let raw: (String, String) =
        f.db.conn()
            .query_row(
                "SELECT resolved_steps_json, resolved_design_json FROM plan_approvals",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&raw.0).unwrap(),
        json!(expected_steps)
    );
    assert_eq!(
        serde_json::from_str::<Value>(&raw.1).unwrap(),
        json!(expected_design)
    );
    let snapshot = f.snapshot();
    assert_eq!(snapshot.revision, f.before.revision + 1);
    assert!(snapshot.updated_at > 0);
    assert_eq!(
        json!(snapshot.todos),
        json!([
            {"content":"Revised title","status":"pending","priority":"medium","stepId":"revised"},
            {"content":"Last","status":"pending","priority":"medium","stepId":"last"}
        ])
    );
    assert_eq!(fs::read(path).unwrap(), bytes);
    assert_eq!(hex::encode(Sha256::digest(&bytes)), artifact.sha256);
    assert_eq!(stored.artifact.as_ref(), Some(artifact));
    assert_eq!(
        sessions::session_mode(&f.db, &f.proposal.session_id)
            .unwrap()
            .as_deref(),
        Some("agent")
    );
    let audit: String =
        f.db.conn()
            .query_row(
                "SELECT payload_json FROM audit_log WHERE kind = 'plan_approval_resolved'",
                [],
                |row| row.get(0),
            )
            .unwrap();
    let audit: Value = serde_json::from_str(&audit).unwrap();
    assert_eq!(audit["revisedSteps"], true);
    assert_eq!(audit["revisedDesign"], true);
    assert_eq!(audit["seededTodos"], 2);
    assert!(!audit.to_string().contains("Revised title"));
    assert!(!audit.to_string().contains("#ABCDEF"));

    // Execution consumers (queue and claim) see the same approved contract.
    assert_eq!(
        PlanManager.queued_executions(&f.db, None).unwrap(),
        vec![execution.clone()]
    );
    let claimed = PlanManager.claim_execution(&f.db, &execution.id).unwrap();
    assert_eq!(claimed.steps, execution.steps);
    assert_eq!(claimed.design, execution.design);
}

#[test]
fn omitted_or_null_revisions_seed_submitted_steps() {
    for revision in [None, Some(Value::Null)] {
        let f = Fixture::new(KIND_PLAN, Some(&steps()), None);
        let result = f
            .resolve("approve", revision.as_ref(), revision.as_ref())
            .unwrap();
        assert!(result.seeded_todos);
        assert_eq!(result.execution.unwrap().steps, f.proposal.steps);
        assert!(result.proposal.resolved_steps.is_none());
        assert!(result.proposal.resolved_design.is_none());
        assert_eq!(f.snapshot().revision, f.before.revision + 1);
        assert_eq!(
            f.snapshot()
                .todos
                .iter()
                .map(|item| item.step_id.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("a"), Some("b")]
        );
    }
}

#[test]
fn explicit_clears_and_legacy_approval_leave_checklist_untouched() {
    for clear in [true, false] {
        let f = if clear {
            Fixture::new(
                KIND_PLAN,
                Some(&steps()),
                Some(&json!({"framework":"react"})),
            )
        } else {
            Fixture::new(KIND_PLAN, None, None)
        };
        let empty_steps = json!([]);
        let empty_design = json!({});
        let result = f
            .resolve(
                "approve",
                clear.then_some(&empty_steps),
                clear.then_some(&empty_design),
            )
            .unwrap();
        assert!(!result.seeded_todos);
        assert_eq!(f.snapshot(), f.before);
        let execution = serde_json::to_value(result.execution.unwrap()).unwrap();
        assert!(execution.get("steps").is_none());
        assert!(execution.get("design").is_none());
        let proposal = serde_json::to_value(result.proposal).unwrap();
        if clear {
            assert_eq!(proposal["resolvedSteps"], empty_steps);
            assert_eq!(proposal["resolvedDesign"], empty_design);
            let raw: (String, String) =
                f.db.conn()
                    .query_row(
                        "SELECT resolved_steps_json, resolved_design_json FROM plan_approvals",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .unwrap();
            assert_eq!(raw, ("[]".into(), "{}".into()));
        } else {
            for key in ["steps", "design", "resolvedSteps", "resolvedDesign"] {
                assert!(proposal.get(key).is_none());
            }
        }
    }
}

#[test]
fn replay_compares_normalized_revisions_without_reseeding_or_auditing() {
    let f = Fixture::new(KIND_PLAN, Some(&steps()), None);
    let revision = json!([{"id":" a ","title":" First "}]);
    let design = json!({"framework":" React "});
    let first = f
        .resolve("approve", Some(&revision), Some(&design))
        .unwrap();
    let snapshot = f.snapshot();
    let same_steps = json!([{"id":"a","title":"First","dependsOn":[]}]);
    let same_design = json!({"framework":"react"});
    let replay = f
        .resolve("approve", Some(&same_steps), Some(&same_design))
        .unwrap();
    assert!(!replay.seeded_todos);
    assert_eq!(replay.proposal, first.proposal);
    assert_eq!(replay.execution, first.execution);
    for (steps, design) in [
        (Some(steps()), Some(same_design.clone())),
        (Some(same_steps), Some(json!({}))),
        (None, None),
    ] {
        assert_eq!(
            f.resolve("approve", steps.as_ref(), design.as_ref())
                .unwrap_err()
                .to_string(),
            "PLAN_APPROVAL_CONFLICT"
        );
    }
    assert_eq!(f.snapshot(), snapshot);
    let audits: i64 =
        f.db.conn()
            .query_row(
                "SELECT count(*) FROM audit_log WHERE kind = 'plan_approval_resolved'",
                [],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(audits, 1);
}

#[test]
fn partial_revision_preserves_the_other_submitted_field() {
    let f = Fixture::new(
        KIND_PLAN,
        Some(&steps()),
        Some(&json!({"framework":"react"})),
    );
    let result = f
        .resolve("approve", None, Some(&json!({"framework":"vue"})))
        .unwrap();
    assert_eq!(result.execution.as_ref().unwrap().steps, f.proposal.steps);
    assert_eq!(
        result
            .execution
            .unwrap()
            .design
            .unwrap()
            .framework
            .as_deref(),
        Some("vue")
    );
    assert!(result.seeded_todos);

    let f = Fixture::new(
        KIND_PLAN,
        Some(&steps()),
        Some(&json!({"framework":"react"})),
    );
    let result = f.resolve("approve", Some(&json!([])), None).unwrap();
    let execution = result.execution.unwrap();
    assert!(execution.steps.is_none());
    assert_eq!(execution.design, f.proposal.design);
    assert_eq!(f.snapshot(), f.before);
}

#[test]
fn explicit_empty_revision_replay_is_not_equivalent_to_omission() {
    let f = Fixture::new(KIND_PLAN, Some(&steps()), None);
    let first = f
        .resolve("approve", Some(&json!([])), Some(&json!({})))
        .unwrap();
    let replay = f
        .resolve("approve", Some(&json!([])), Some(&json!({"framework":" "})))
        .unwrap();
    assert_eq!(replay.proposal, first.proposal);
    assert!(!replay.seeded_todos);
    assert_eq!(
        f.resolve("approve", None, None).unwrap_err().to_string(),
        "PLAN_APPROVAL_CONFLICT"
    );
    assert_eq!(f.snapshot(), f.before);
}

#[test]
fn invalid_or_unsupported_revisions_leave_approval_and_checklist_unchanged() {
    for (kind, action, steps, design, code) in [
        (
            KIND_PLAN,
            "approve",
            Some(
                json!([{"id":"a","title":"A","dependsOn":["b"]},{"id":"b","title":"B","dependsOn":["a"]}]),
            ),
            None,
            "PLAN_STEPS_INVALID",
        ),
        (
            KIND_PLAN,
            "approve",
            None,
            Some(json!({"colorSystem":{"primary":["red"]}})),
            "PLAN_DESIGN_INVALID",
        ),
        (
            KIND_PLAN,
            "reject",
            Some(json!([])),
            None,
            "PLAN_INVALID_ARGUMENT",
        ),
        (
            KIND_PLAN,
            "reject",
            None,
            Some(json!({})),
            "PLAN_INVALID_ARGUMENT",
        ),
        (
            KIND_GOAL,
            "approve",
            Some(json!([])),
            None,
            "PLAN_METADATA_UNSUPPORTED",
        ),
        (
            KIND_GOAL,
            "approve",
            None,
            Some(json!({})),
            "PLAN_METADATA_UNSUPPORTED",
        ),
    ] {
        let f = Fixture::new(kind, None, None);
        let error = f
            .resolve(action, steps.as_ref(), design.as_ref())
            .unwrap_err()
            .to_string();
        assert!(error.starts_with(code), "{error}");
        f.assert_unchanged();
    }
}

#[test]
fn seed_failure_rolls_back_session_approval_revision_and_rows() {
    let f = Fixture::new(KIND_PLAN, Some(&steps()), None);
    f.db.conn().execute_batch("CREATE TEMP TRIGGER fail_seed BEFORE INSERT ON session_todo WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, 'injected seed failure'); END;").unwrap();
    assert!(f
        .resolve("approve", Some(&steps()), Some(&json!({})))
        .unwrap_err()
        .to_string()
        .contains("injected seed failure"));
    f.assert_unchanged();
    let audits: i64 =
        f.db.conn()
            .query_row(
                "SELECT count(*) FROM audit_log WHERE kind = 'plan_approval_resolved'",
                [],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(audits, 0);
}

#[test]
fn revisions_do_not_bypass_artifact_verification() {
    let f = Fixture::new(KIND_PLAN, Some(&steps()), None);
    fs::write(
        f.dir
            .path()
            .join(&f.proposal.artifact.as_ref().unwrap().relative_path),
        "tampered",
    )
    .unwrap();
    assert!(f.resolve("approve", Some(&steps()), None).is_err());
    f.assert_unchanged();
}
