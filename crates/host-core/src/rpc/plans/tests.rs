use super::super::handle_request;
use super::*;
use crate::sessions;

async fn fixture(kind: &str) -> (tempfile::TempDir, Arc<Mutex<AppState>>, Value) {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db,
        None,
        Some(kind.into()),
        None,
        None,
        Some(dir.path().to_string_lossy().into_owned()),
    )
    .unwrap();
    let turn = sessions::begin_turn(&app.db, &session.id, None, None).unwrap();
    let params = json!({"sessionId":session.id,"turnId":turn,"toolCallId":"call","kind":kind,"title":"Plan","markdown":"  # Exact\r\nbody\n","question":"Proceed?"});
    (dir, Arc::new(Mutex::new(app)), params)
}

async fn call(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    handle_request(state.clone(), method, params, mpsc::unbounded_channel().0).await
}

#[tokio::test]
async fn resolving_seeds_committed_todos_and_emits_both_notifications_once() {
    let (_dir, state, mut input) = fixture("plan").await;
    input["steps"] = json!([{"id":"original","title":"Original"}]);
    let submitted = call(&state, "plans.submit", input.clone()).await.unwrap();
    {
        let st = state.lock().await;
        sessions::end_turn(
            &st.db,
            input["turnId"].as_str().unwrap(),
            "completed",
            None,
            None,
            false,
        )
        .unwrap();
    }
    let resolve = json!({
        "sessionId":input["sessionId"], "turnId":input["turnId"], "toolCallId":"call",
        "proposalId":submitted["proposal"]["id"], "action":"approve", "targetPermissionMode":"ask",
        "revisedSteps":[{"id":"revised","title":"Revised"}], "revisedDesign":{"framework":"vue"}
    });
    let (tx, mut rx) = mpsc::unbounded_channel();
    let result = handle_request(state.clone(), "plans.resolve", resolve.clone(), tx.clone())
        .await
        .unwrap();
    let mut events = Vec::<Value>::new();
    while let Ok(raw) = rx.try_recv() {
        events.push(serde_json::from_str(&raw).unwrap());
    }
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["method"], "plans.changed");
    assert_eq!(events[0]["params"]["proposal"], result["proposal"]);
    assert_eq!(events[1]["method"], "todos.changed");
    let snapshot = call(&state, "todos.get", json!({"sessionId":input["sessionId"]}))
        .await
        .unwrap();
    assert_eq!(events[1]["params"], snapshot);
    assert_eq!(snapshot["revision"], 1);
    assert_eq!(
        snapshot["todos"],
        json!([{"content":"Revised","status":"pending","priority":"medium","stepId":"revised"}])
    );
    assert_eq!(
        result["execution"]["steps"],
        result["proposal"]["resolvedSteps"]
    );
    assert_eq!(result["execution"]["design"], json!({"framework":"vue"}));
    assert!(result.get("seededTodos").is_none());
    let replay = handle_request(state.clone(), "plans.resolve", resolve, tx)
        .await
        .unwrap();
    assert_eq!(replay, result);
    let replay_event: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(replay_event["method"], "plans.changed");
    assert!(rx.try_recv().is_err());
    assert_eq!(
        call(&state, "todos.get", json!({"sessionId":input["sessionId"]}))
            .await
            .unwrap(),
        snapshot
    );
}

#[tokio::test]
async fn metadata_submission_pending_resolution_and_get_user_path() {
    for action in ["approve", "reject"] {
        let (dir, state, mut input) = fixture("plan").await;
        input["steps"] = json!([{"id":" first ","title":" First step ","detail":" "},{"id":"second","title":"Second","dependsOn":["first"]}]);
        input["design"] = json!({"framework":" React ","colorSystem":{"primary":["#abcdef"]}});
        let submitted = call(&state, "plans.submit", input.clone()).await.unwrap();
        let proposal = &submitted["proposal"];
        assert_eq!(
            proposal["steps"],
            json!([{"id":"first","title":"First step","dependsOn":[]},{"id":"second","title":"Second","dependsOn":["first"]}])
        );
        assert_eq!(
            proposal["design"],
            json!({"framework":"react","colorSystem":{"primary":["#ABCDEF"]}})
        );
        assert_eq!(
            std::fs::read(
                dir.path()
                    .join(proposal["artifact"]["relativePath"].as_str().unwrap())
            )
            .unwrap(),
            input["markdown"].as_str().unwrap().as_bytes()
        );
        let pending = call(
            &state,
            "plans.pending",
            json!({"sessionId":input["sessionId"]}),
        )
        .await
        .unwrap();
        assert_eq!(pending["plans"][0], *proposal);
        {
            let st = state.lock().await;
            let row: (String, String) = st
                .db
                .conn()
                .query_row(
                    "SELECT steps_json, design_json FROM plan_approvals",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&row.0).unwrap(),
                proposal["steps"]
            );
            assert_eq!(
                serde_json::from_str::<Value>(&row.1).unwrap(),
                proposal["design"]
            );
            let audit: String = st
                .db
                .conn()
                .query_row(
                    "SELECT payload_json FROM audit_log WHERE kind = 'plan_submitted'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let audit: Value = serde_json::from_str(&audit).unwrap();
            assert_eq!(audit["stepCount"], 2);
            assert_eq!(audit["hasDesign"], true);
            assert!(audit.get("steps").is_none() && audit.get("design").is_none());
        }
        let resolved = call(&state, "plans.resolve", json!({"sessionId":input["sessionId"],"turnId":input["turnId"],"toolCallId":"call","proposalId":proposal["id"],"action":action,"targetPermissionMode":"ask"})).await.unwrap();
        let fetched = call(
            &state,
            "plans.get",
            json!({"sessionId":input["sessionId"],"proposalId":proposal["id"]}),
        )
        .await
        .unwrap();
        assert_eq!(fetched["proposal"], resolved["proposal"]);
        assert_eq!(
            fetched["proposal"]["status"],
            if action == "approve" {
                "approved"
            } else {
                "rejected"
            }
        );
        if action == "approve" {
            assert_eq!(resolved["execution"]["steps"], proposal["steps"]);
            assert_eq!(resolved["execution"]["design"], proposal["design"]);
        }
        for params in [
            json!({"sessionId":"other","proposalId":proposal["id"]}),
            json!({"sessionId":input["sessionId"],"proposalId":"missing"}),
        ] {
            assert_eq!(
                call(&state, "plans.get", params)
                    .await
                    .unwrap_err()
                    .data
                    .unwrap()["errorCode"],
                "PLAN_NOT_FOUND"
            );
        }
    }
}

#[tokio::test]
async fn invalid_metadata_does_not_publish_or_persist() {
    for (kind, key, value, code) in [
        (
            "plan",
            "steps",
            json!([{"id":"a","title":"A","dependsOn":["b"]},{"id":"b","title":"B","dependsOn":["a"]}]),
            "PLAN_STEPS_INVALID",
        ),
        (
            "plan",
            "design",
            json!({"colorSystem":{"primary":["red"]}}),
            "PLAN_DESIGN_INVALID",
        ),
        ("goal", "steps", json!([]), "PLAN_METADATA_UNSUPPORTED"),
        ("goal", "design", json!({}), "PLAN_METADATA_UNSUPPORTED"),
    ] {
        let (dir, state, mut input) = fixture(kind).await;
        input[key] = value;
        let error = call(&state, "plans.submit", input).await.unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], code);
        assert!(!dir.path().join(".pi").exists());
        let st = state.lock().await;
        assert_eq!(
            st.db
                .conn()
                .query_row("SELECT count(*) FROM plan_approvals", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[tokio::test]
async fn empty_omitted_and_null_metadata_preserve_legacy_shape_and_bytes() {
    for metadata in [
        json!({}),
        json!({"steps":[],"design":{}}),
        json!({"steps":null,"design":null}),
    ] {
        let (dir, state, mut input) = fixture("plan").await;
        input
            .as_object_mut()
            .unwrap()
            .extend(metadata.as_object().unwrap().clone());
        let result = call(&state, "plans.submit", input.clone()).await.unwrap();
        let proposal = &result["proposal"];
        for key in ["steps", "design", "resolvedSteps", "resolvedDesign"] {
            assert!(proposal.get(key).is_none());
        }
        assert_eq!(
            std::fs::read(
                dir.path()
                    .join(proposal["artifact"]["relativePath"].as_str().unwrap())
            )
            .unwrap(),
            input["markdown"].as_str().unwrap().as_bytes()
        );
        let st = state.lock().await;
        let nulls: bool = st.db.conn().query_row("SELECT steps_json IS NULL AND design_json IS NULL AND resolved_steps_json IS NULL AND resolved_design_json IS NULL FROM plan_approvals", [], |r| r.get(0)).unwrap();
        assert!(nulls);
    }
}

#[tokio::test]
async fn get_expires_pending_and_corrupt_metadata_does_not_hide_proposal() {
    let (_dir, state, input) = fixture("plan").await;
    let result = call(&state, "plans.submit", input.clone()).await.unwrap();
    {
        let st = state.lock().await;
        st.db.conn().execute_batch("UPDATE plan_approvals SET expires_at = 1, steps_json = '{bad', design_json = '[]', resolved_steps_json = 'null', resolved_design_json = '{bad';").unwrap();
    }
    let result = call(
        &state,
        "plans.get",
        json!({"sessionId":input["sessionId"],"proposalId":result["proposal"]["id"]}),
    )
    .await
    .unwrap();
    assert_eq!(result["proposal"]["status"], "expired");
    for key in ["steps", "design", "resolvedSteps", "resolvedDesign"] {
        assert!(result["proposal"].get(key).is_none());
    }
}

#[tokio::test]
async fn effective_resolved_metadata_wins_including_explicit_empty() {
    let (_dir, state, mut input) = fixture("plan").await;
    input["steps"] = json!([{"id":"a","title":"Original"}]);
    input["design"] = json!({"framework":"react"});
    let result = call(&state, "plans.submit", input.clone()).await.unwrap();
    call(&state, "plans.resolve", json!({"sessionId":input["sessionId"],"turnId":input["turnId"],"toolCallId":"call","proposalId":result["proposal"]["id"],"action":"approve","targetPermissionMode":"ask"})).await.unwrap();
    {
        let st = state.lock().await;
        st.db.conn().execute_batch("UPDATE plan_approvals SET resolved_steps_json = '[{\"id\":\"b\",\"title\":\"Revised\",\"dependsOn\":[]}]', resolved_design_json = '{\"framework\":\"vue\"}';").unwrap();
    }
    let queued = call(&state, "plans.queuedExecutions", json!({}))
        .await
        .unwrap();
    assert_eq!(queued["executions"][0]["steps"][0]["id"], "b");
    assert_eq!(queued["executions"][0]["design"]["framework"], "vue");
    {
        let st = state.lock().await;
        st.db.conn().execute_batch("UPDATE plan_approvals SET resolved_steps_json = '[]', resolved_design_json = '{}';").unwrap();
    }
    let queued = call(&state, "plans.queuedExecutions", json!({}))
        .await
        .unwrap();
    assert!(queued["executions"][0].get("steps").is_none());
    assert!(queued["executions"][0].get("design").is_none());
}
