//! Approval-only revisions preserve explicit clears and never mutate artifacts.
use super::*;
use serde_json::Value;

pub(super) struct Revision {
    steps: Option<Vec<PlanStep>>,
    design: Option<PlanDesign>,
    pub steps_json: Option<String>,
    pub design_json: Option<String>,
}

impl Revision {
    pub fn normalize(
        action: &str,
        kind: &str,
        steps: Option<&Value>,
        design: Option<&Value>,
    ) -> Result<Self> {
        let steps = steps.filter(|value| !value.is_null());
        let design = design.filter(|value| !value.is_null());
        if steps.is_some() || design.is_some() {
            if action == "reject" {
                return Err(plan_error("PLAN_INVALID_ARGUMENT"));
            }
            if kind == KIND_GOAL {
                return Err(plan_error("PLAN_METADATA_UNSUPPORTED"));
            }
        }
        let steps = steps.map(metadata::normalize_steps).transpose()?;
        let design = design.map(metadata::normalize_design).transpose()?;
        Ok(Self {
            steps_json: steps.as_ref().map(serde_json::to_string).transpose()?,
            design_json: design.as_ref().map(serde_json::to_string).transpose()?,
            steps,
            design,
        })
    }

    pub fn matches(&self, proposal: &PlanProposal) -> bool {
        self.steps == proposal.resolved_steps && self.design == proposal.resolved_design
    }

    pub fn seed_todos(
        &self,
        tx: &rusqlite::Transaction<'_>,
        proposal: &PlanProposal,
        action: &str,
    ) -> Result<usize> {
        let steps = self.steps.as_ref().or(proposal.steps.as_ref());
        if let Some(steps) = steps.filter(|steps| action == "approve" && !steps.is_empty()) {
            crate::todos::seed_from_plan_tx(tx, &proposal.session_id, steps)?;
            return Ok(steps.len());
        }
        Ok(0)
    }
}
