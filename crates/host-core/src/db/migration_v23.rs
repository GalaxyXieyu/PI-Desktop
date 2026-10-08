use super::{create_migration_backup, Connection, Context, Path, Result};

pub(crate) fn migrate_v22_to_v23(conn: &Connection, path: &Path) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version == 23 {
        return Ok(());
    }
    let backup = create_migration_backup(conn, path, 22)?;
    let tx = conn.unchecked_transaction()?;
    for (table, column, declaration) in [
        ("plan_approvals", "steps_json", "TEXT"),
        ("plan_approvals", "design_json", "TEXT"),
        ("plan_approvals", "resolved_steps_json", "TEXT"),
        ("plan_approvals", "resolved_design_json", "TEXT"),
        (
            "session_todo",
            "step_id",
            "TEXT CHECK (step_id IS NULL OR (length(step_id) BETWEEN 1 AND 64))",
        ),
    ] {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            [table, column],
            |row| row.get(0),
        )?;
        if !exists {
            // All identifiers and declarations above are host-owned constants.
            tx.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {declaration};"
            ))?;
        }
    }
    // Early dev builds stamped the plan columns as v22 without the upstream
    // session-list index. Repair both v22 shapes in the same transaction.
    tx.execute_batch(
        "DROP INDEX IF EXISTS idx_sessions_updated;
         CREATE INDEX IF NOT EXISTS idx_sessions_updated_id ON sessions(updated_at DESC, id DESC);",
    )?;
    tx.pragma_update(None, "user_version", 23i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v22 to v23 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db::{migration_backup_path, Database},
        sessions,
    };

    fn assert_columns(conn: &Connection) {
        for (table, column) in [
            ("plan_approvals", "steps_json"),
            ("plan_approvals", "design_json"),
            ("plan_approvals", "resolved_steps_json"),
            ("plan_approvals", "resolved_design_json"),
            ("session_todo", "step_id"),
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM pragma_table_info(?1) WHERE name = ?2",
                    [table, column],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "{table}.{column}");
        }
    }

    fn assert_current_schema(conn: &Connection) {
        assert_columns(conn);
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            23
        );
        assert_session_index(conn);
    }

    fn assert_session_index(conn: &Connection) {
        let old_index: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_updated')",
            [], |row| row.get(0),
        ).unwrap();
        assert!(!old_index);
        let mut stmt = conn.prepare(
            "SELECT name, desc FROM pragma_index_xinfo('idx_sessions_updated_id') WHERE key = 1 ORDER BY seqno",
        ).unwrap();
        let columns = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            columns,
            vec![("updated_at".into(), true), ("id".into(), true)]
        );
    }

    #[test]
    fn fresh_database_has_v23_columns_and_step_id_constraint() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        assert_current_schema(db.conn());
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        for id in ["", &"a".repeat(65)] {
            assert!(db.conn().execute("INSERT INTO session_todo (session_id, position, content, status, updated_at, step_id) VALUES (?1, 0, 'task', 'pending', 1, ?2)", [&session.id, id]).is_err());
        }
    }

    #[test]
    fn upstream_v22_rows_survive_migration_and_second_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        let session =
            sessions::create_session(&db, Some("Existing".into()), None, None, None, None).unwrap();
        db.conn().execute("INSERT INTO plan_approvals (request_id, session_id, turn_id, tool_call_id, plan_json, status, created_at, updated_at) VALUES ('proposal', ?1, 'turn', 'call', 'exact markdown', 'rejected', 1, 1)", [&session.id]).unwrap();
        db.conn().execute("INSERT INTO session_todo (session_id, position, content, status, updated_at) VALUES (?1, 0, 'Existing task', 'pending', 1)", [&session.id]).unwrap();
        drop(db);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "ALTER TABLE plan_approvals DROP COLUMN steps_json;
            ALTER TABLE plan_approvals DROP COLUMN design_json;
            ALTER TABLE plan_approvals DROP COLUMN resolved_steps_json;
            ALTER TABLE plan_approvals DROP COLUMN resolved_design_json;
            ALTER TABLE session_todo DROP COLUMN step_id;
            PRAGMA user_version = 22;",
        )
        .unwrap();
        assert_session_index(&conn);
        drop(conn);
        let db = Database::open(&path).unwrap();
        assert_current_schema(db.conn());
        let row: (String, Option<String>, Option<String>, Option<String>, Option<String>) = db.conn().query_row("SELECT plan_json, steps_json, design_json, resolved_steps_json, resolved_design_json FROM plan_approvals WHERE request_id = 'proposal'", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).unwrap();
        assert_eq!(row, ("exact markdown".into(), None, None, None, None));
        let row: (String, Option<String>) = db
            .conn()
            .query_row("SELECT content, step_id FROM session_todo", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(row, ("Existing task".into(), None));
        migrate_v22_to_v23(db.conn(), &path).unwrap();
        assert_current_schema(db.conn());
        let backup_path = migration_backup_path(&path, 22);
        assert!(backup_path.exists());
        let backup = Connection::open(backup_path).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            22
        );
        // A version-only downgrade exercises probes on the already-v23 shape.
        db.conn().pragma_update(None, "user_version", 22).unwrap();
        migrate_v22_to_v23(db.conn(), &path).unwrap();
        assert_current_schema(db.conn());
    }

    #[test]
    fn old_dev_v22_preserves_metadata_and_repairs_session_index() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let steps = r#"[{"id":"s1","title":"Existing task","dependsOn":[]}]"#;
        let design = r#"{"framework":"react"}"#;
        db.conn().execute(
            "INSERT INTO plan_approvals (request_id, session_id, turn_id, tool_call_id, plan_json, status, created_at, updated_at, steps_json, design_json, resolved_steps_json, resolved_design_json)
             VALUES ('proposal', ?1, 'turn', 'call', 'exact markdown', 'rejected', 1, 1, ?2, ?3, '[]', '{}')",
            [&session.id, steps, design],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO session_todo (session_id, position, content, status, updated_at, step_id) VALUES (?1, 0, 'Existing task', 'pending', 1, 's1')",
            [&session.id],
        ).unwrap();
        db.conn()
            .execute_batch(
                "DROP INDEX idx_sessions_updated_id;
             CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
             PRAGMA user_version = 22;",
            )
            .unwrap();
        drop(db);

        let db = Database::open(&path).unwrap();
        assert_current_schema(db.conn());
        migrate_v22_to_v23(db.conn(), &path).unwrap();
        assert_current_schema(db.conn());
        let row: (String, String, String, String, String) = db.conn().query_row(
            "SELECT plan_json, steps_json, design_json, resolved_steps_json, resolved_design_json FROM plan_approvals WHERE request_id = 'proposal'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).unwrap();
        assert_eq!(
            row,
            (
                "exact markdown".into(),
                steps.into(),
                design.into(),
                "[]".into(),
                "{}".into()
            )
        );
        let row: (String, String) = db
            .conn()
            .query_row("SELECT content, step_id FROM session_todo", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(row, ("Existing task".into(), "s1".into()));
        let backup_path = migration_backup_path(&path, 22);
        assert!(backup_path.exists());
        let backup = Connection::open(backup_path).unwrap();
        assert_columns(&backup);
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            22
        );
        let old_index: bool = backup.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_updated')",
            [], |row| row.get(0),
        ).unwrap();
        assert!(old_index);
    }
}
