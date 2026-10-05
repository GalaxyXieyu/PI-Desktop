use super::*;
use crate::sessions;
use serde_json::json;

fn write(db: &Database, session: &str, turn: &str, items: Value) -> TodoSnapshot {
    let input = normalize_input(&json!({"todos":items})).unwrap();
    replace_for_turn(db, session, Some(turn), &input).unwrap()
}

#[test]
fn step_id_round_trip_defaults_and_validation() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
    let snapshot = write(
        &db,
        &session.id,
        &turn,
        json!([
            {"content":"First","status":"pending","stepId":" Step-1._ "},
            {"content":"Second","status":"pending"}
        ]),
    );
    assert_eq!(get(&db, &session.id).unwrap().unwrap(), snapshot);
    let wire = serde_json::to_value(&snapshot.todos).unwrap();
    assert_eq!(wire[0]["stepId"], "Step-1._");
    assert!(wire[1].get("stepId").is_none());
    assert_eq!(
        serde_json::from_value::<Vec<TodoItem>>(wire).unwrap(),
        snapshot.todos
    );
    drop(db);
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    assert_eq!(get(&db, &session.id).unwrap().unwrap(), snapshot);

    for id in [
        json!(null),
        json!(3),
        json!([]),
        json!(""),
        json!("-first"),
        json!("has space"),
        json!("中文"),
        json!("a".repeat(65)),
    ] {
        let error =
            normalize_input(&json!({"todos":[{"content":"x","status":"pending","stepId":id}]}))
                .unwrap_err()
                .to_string();
        assert!(error.contains("todos[0].stepId"), "{error}");
    }
    assert!(normalize_input(
        &json!({"todos":[{"content":"x","status":"pending","stepId":"a".repeat(64)}]})
    )
    .is_ok());
    let error = normalize_input(&json!({"todos":[
        {"content":"x","status":"pending","stepId":"same"},
        {"content":"y","status":"pending","stepId":" same "}
    ]}))
    .unwrap_err()
    .to_string();
    assert!(error.contains("todos[1].stepId"), "{error}");
}

#[test]
fn carry_over_uses_exact_unique_content_and_respects_explicit_claims() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
    write(
        &db,
        &session.id,
        &turn,
        json!([
            {"content":"Keep","status":"pending","stepId":"keep"},
            {"content":"Changed","status":"pending","stepId":"changed"},
            {"content":"Ambiguous","status":"pending","stepId":"ambiguous"},
            {"content":"Ambiguous","status":"pending"},
            {"content":"Claimed elsewhere","status":"pending","stepId":"claimed"},
            {"content":"Duplicate new","status":"pending","stepId":"duplicate"}
        ]),
    );
    let snapshot = write(
        &db,
        &session.id,
        &turn,
        json!([
            {"content":"Keep","status":"completed"},
            {"content":"Changed content","status":"pending"},
            {"content":"Ambiguous","status":"pending"},
            {"content":"Claimed elsewhere","status":"pending"},
            {"content":"Explicit claim","status":"pending","stepId":"claimed"},
            {"content":"Duplicate new","status":"pending"},
            {"content":"Duplicate new","status":"pending"}
        ]),
    );
    assert_eq!(
        snapshot
            .todos
            .iter()
            .map(|item| item.step_id.as_deref())
            .collect::<Vec<_>>(),
        vec![
            Some("keep"),
            None,
            None,
            None,
            Some("claimed"),
            Some("duplicate"),
            None
        ]
    );
    assert_eq!(snapshot.todos[0].status, "completed");
    assert_eq!(snapshot.revision, 2);
    assert_eq!(get(&db, &session.id).unwrap().unwrap(), snapshot);
}
