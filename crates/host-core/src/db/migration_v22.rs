use super::{create_migration_backup, Connection, Context, Path, Result};

pub(crate) fn migrate_v21_to_v22(conn: &Connection, path: &Path) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version == 22 {
        return Ok(());
    }
    let backup = create_migration_backup(conn, path, 21)?;
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
    tx.pragma_update(None, "user_version", 22i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v21 to v22 migration; backup {} remains",
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

    #[test]
    fn fresh_database_has_v22_columns_and_step_id_constraint() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        assert_columns(db.conn());
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        for id in ["", &"a".repeat(65)] {
            assert!(db.conn().execute("INSERT INTO session_todo (session_id, position, content, status, updated_at, step_id) VALUES (?1, 0, 'task', 'pending', 1, ?2)", [&session.id, id]).is_err());
        }
    }

    #[test]
    fn real_v21_rows_survive_migration_and_second_run() {
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
            PRAGMA user_version = 21;",
        )
        .unwrap();
        drop(conn);
        let db = Database::open(&path).unwrap();
        assert_columns(db.conn());
        let row: (String, Option<String>, Option<String>, Option<String>, Option<String>) = db.conn().query_row("SELECT plan_json, steps_json, design_json, resolved_steps_json, resolved_design_json FROM plan_approvals WHERE request_id = 'proposal'", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).unwrap();
        assert_eq!(row, ("exact markdown".into(), None, None, None, None));
        let row: (String, Option<String>) = db
            .conn()
            .query_row("SELECT content, step_id FROM session_todo", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(row, ("Existing task".into(), None));
        migrate_v21_to_v22(db.conn(), &path).unwrap();
        assert_columns(db.conn());
        let backup = Connection::open(migration_backup_path(&path, 21)).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            21
        );
        // A version-only downgrade exercises probes on the already-v22 shape.
        db.conn().pragma_update(None, "user_version", 21).unwrap();
        migrate_v21_to_v22(db.conn(), &path).unwrap();
        assert_columns(db.conn());
    }
}
