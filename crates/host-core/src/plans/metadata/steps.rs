use super::{PlanStep, Validator};
use anyhow::Result;
use serde_json::Value;
use std::collections::HashSet;

pub(crate) fn valid_step_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

pub(crate) fn normalize_steps(value: &Value) -> Result<Vec<PlanStep>> {
    let v = Validator("PLAN_STEPS_INVALID");
    let items = v.array(value, "steps", 24)?;
    let mut steps = Vec::with_capacity(items.len());
    let mut ids = HashSet::new();
    for (i, item) in items.iter().enumerate() {
        let path = format!("steps[{i}]");
        let obj = v.object(item, &path, &["id", "title", "detail", "dependsOn"])?;
        let id_path = format!("{path}.id");
        let id = v.string(&item["id"], &id_path)?;
        if !valid_step_id(&id) {
            return Err(v.error(
                &id_path,
                "must match [A-Za-z0-9][A-Za-z0-9._-]* and contain 1..=64 characters",
            ));
        }
        if !ids.insert(id.clone()) {
            return Err(v.error(&id_path, "duplicate step id"));
        }
        let title = v.text(&item["title"], &format!("{path}.title"), 200)?;
        let detail = obj
            .get("detail")
            .map(|value| {
                let path = format!("{path}.detail");
                let text = v.string(value, &path)?;
                if text.chars().count() > 2000 || text.contains('\0') {
                    return Err(v.error(&path, "must contain at most 2000 characters and no NUL"));
                }
                Ok(text)
            })
            .transpose()?
            .filter(|text| !text.is_empty());
        let mut depends_on = Vec::new();
        if let Some(value) = obj.get("dependsOn") {
            let path = format!("{path}.dependsOn");
            for (j, value) in v.array(value, &path, 24)?.iter().enumerate() {
                let dependency = v.string(value, &format!("{path}[{j}]"))?;
                depends_on.push(dependency);
            }
        }
        steps.push(PlanStep {
            id,
            title,
            detail,
            depends_on,
        });
    }
    for (i, step) in steps.iter().enumerate() {
        let mut seen = HashSet::new();
        for (j, dependency) in step.depends_on.iter().enumerate() {
            let path = format!("steps[{i}].dependsOn[{j}]");
            let reason = if dependency == &step.id {
                Some("self-reference")
            } else if !ids.contains(dependency) {
                Some("unknown step")
            } else if !seen.insert(dependency) {
                Some("duplicate dependency")
            } else {
                None
            };
            if let Some(reason) = reason {
                return Err(v.error(
                    &path,
                    &format!("step {:?}: {reason} {dependency:?}", step.id),
                ));
            }
        }
    }
    let mut visited = HashSet::new();
    for i in 0..steps.len() {
        visit(i, &steps, &mut visited, &mut Vec::new(), &v)?;
    }
    v.byte_cap(&steps, "steps", 64 * 1024)?;
    Ok(steps)
}

fn visit(
    i: usize,
    steps: &[PlanStep],
    visited: &mut HashSet<usize>,
    stack: &mut Vec<usize>,
    v: &Validator,
) -> Result<()> {
    if visited.contains(&i) {
        return Ok(());
    }
    stack.push(i);
    for (j, dependency) in steps[i].depends_on.iter().enumerate() {
        if let Some(index) = steps.iter().position(|step| &step.id == dependency) {
            if let Some(start) = stack.iter().position(|&item| item == index) {
                let mut cycle: Vec<_> = stack[start..]
                    .iter()
                    .map(|&item| steps[item].id.as_str())
                    .collect();
                cycle.push(dependency);
                return Err(v.error(
                    &format!("steps[{i}].dependsOn[{j}]"),
                    &format!("cycle: {}", cycle.join(" -> ")),
                ));
            }
            visit(index, steps, visited, stack, v)?;
        }
    }
    stack.pop();
    visited.insert(i);
    Ok(())
}
