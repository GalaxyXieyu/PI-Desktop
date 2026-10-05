use super::plan_error;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

mod design;
mod steps;

pub(crate) use design::normalize_design;
pub(crate) use steps::{normalize_steps, valid_step_id};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanStep {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanDesign {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framework: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_library: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub style_keywords: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_system: Option<PlanFontSystem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_system: Option<PlanColorSystem>,
}

impl PlanDesign {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanFontSystem {
    pub font_family: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<PlanFontLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subheading: Option<PlanFontLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<PlanFontLevel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanFontLevel {
    pub size: String,
    pub weight: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanColorSystem {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub primary: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub background: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub text: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub functional: Vec<String>,
}

struct Validator(&'static str);

impl Validator {
    fn error(&self, path: &str, reason: &str) -> anyhow::Error {
        plan_error(&format!("{} {path}: {reason}", self.0))
    }

    fn object<'a>(
        &self,
        value: &'a Value,
        path: &str,
        keys: &[&str],
    ) -> Result<&'a Map<String, Value>> {
        let object = value
            .as_object()
            .ok_or_else(|| self.error(path, "must be an object"))?;
        for key in object.keys() {
            if !keys.contains(&key.as_str()) {
                return Err(self.error(&format!("{path}.{key}"), "unknown key"));
            }
        }
        Ok(object)
    }

    fn string(&self, value: &Value, path: &str) -> Result<String> {
        // Match ECMAScript String.trim, including BOM but not U+0085.
        let value = value
            .as_str()
            .ok_or_else(|| self.error(path, "must be a string"))?;
        Ok(value.trim_matches(|c: char| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')).to_owned())
    }

    fn text(&self, value: &Value, path: &str, max: usize) -> Result<String> {
        let text = self.string(value, path)?;
        if text.is_empty() || text.chars().count() > max {
            return Err(self.error(path, &format!("must contain 1..={max} characters")));
        }
        if text.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}') {
            return Err(self.error(path, "must not contain control characters"));
        }
        Ok(text)
    }

    fn array<'a>(&self, value: &'a Value, path: &str, max: usize) -> Result<&'a Vec<Value>> {
        let array = value
            .as_array()
            .ok_or_else(|| self.error(path, "must be an array"))?;
        if array.len() > max {
            return Err(self.error(path, &format!("must contain at most {max} items")));
        }
        Ok(array)
    }

    fn byte_cap(&self, value: &impl Serialize, path: &str, max: usize) -> Result<()> {
        if serde_json::to_vec(value)?.len() > max {
            return Err(self.error(
                path,
                &format!("normalized JSON must not exceed {max} bytes"),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
