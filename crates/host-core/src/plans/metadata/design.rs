use super::{PlanColorSystem, PlanDesign, PlanFontLevel, PlanFontSystem, Validator};
use anyhow::Result;
use serde_json::Value;
use std::collections::HashSet;

pub(crate) fn normalize_design(value: &Value) -> Result<PlanDesign> {
    let v = Validator("PLAN_DESIGN_INVALID");
    let obj = v.object(
        value,
        "design",
        &[
            "framework",
            "componentLibrary",
            "styleKeywords",
            "fontSystem",
            "colorSystem",
        ],
    )?;
    let slug = |key: &str| -> Result<Option<String>> {
        let Some(value) = obj.get(key) else {
            return Ok(None);
        };
        let path = format!("design.{key}");
        let text = v.string(value, &path)?.to_lowercase();
        if text.is_empty() {
            return Ok(None);
        }
        if text.len() > 40
            || !text.as_bytes()[0].is_ascii_alphanumeric()
            || !text
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".+/_-".contains(&b))
        {
            return Err(v.error(&path, "must be a lowercase slug of at most 40 characters"));
        }
        Ok(Some(text))
    };
    let mut design = PlanDesign {
        framework: slug("framework")?,
        component_library: slug("componentLibrary")?,
        ..Default::default()
    };
    if let Some(value) = obj.get("styleKeywords") {
        let mut seen = HashSet::new();
        for (i, value) in v
            .array(value, "design.styleKeywords", 12)?
            .iter()
            .enumerate()
        {
            let path = format!("design.styleKeywords[{i}]");
            let keyword = v.text(value, &path, 40)?;
            if !seen.insert(keyword.to_lowercase()) {
                return Err(v.error(&path, "duplicate keyword (case-insensitive)"));
            }
            design.style_keywords.push(keyword);
        }
    }
    if let Some(value) = obj.get("fontSystem") {
        let obj = v.object(
            value,
            "design.fontSystem",
            &["fontFamily", "heading", "subheading", "body"],
        )?;
        let level = |key: &str| -> Result<Option<PlanFontLevel>> {
            let Some(value) = obj.get(key) else {
                return Ok(None);
            };
            let path = format!("design.fontSystem.{key}");
            v.object(value, &path, &["size", "weight"])?;
            let size = value["size"]
                .as_str()
                .ok_or_else(|| v.error(&format!("{path}.size"), "must be 10..=72px"))?;
            let valid_size = size.strip_suffix("px").is_some_and(|digits| {
                (1..=2).contains(&digits.len())
                    && digits.bytes().all(|b| b.is_ascii_digit())
                    && digits.parse::<u8>().is_ok_and(|n| (10..=72).contains(&n))
            });
            if !valid_size {
                return Err(v.error(&format!("{path}.size"), "must be 10..=72px"));
            }
            let weight = value["weight"]
                .as_f64()
                .filter(|w| (100.0..=900.0).contains(w) && w % 100.0 == 0.0)
                .ok_or_else(|| {
                    v.error(
                        &format!("{path}.weight"),
                        "must be an integer multiple of 100 from 100..=900",
                    )
                })?;
            Ok(Some(PlanFontLevel {
                size: size.to_owned(),
                weight: weight as u16,
            }))
        };
        design.font_system = Some(PlanFontSystem {
            font_family: v.text(&value["fontFamily"], "design.fontSystem.fontFamily", 120)?,
            heading: level("heading")?,
            subheading: level("subheading")?,
            body: level("body")?,
        });
    }
    if let Some(value) = obj.get("colorSystem") {
        let obj = v.object(
            value,
            "design.colorSystem",
            &["primary", "background", "text", "functional"],
        )?;
        let group = |key: &str| -> Result<Vec<String>> {
            let Some(value) = obj.get(key) else {
                return Ok(Vec::new());
            };
            let path = format!("design.colorSystem.{key}");
            v.array(value, &path, 8)?
                .iter()
                .enumerate()
                .map(|(i, value)| {
                    let color = value
                        .as_str()
                        .filter(|color| {
                            color.len() == 7
                                && color.starts_with('#')
                                && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
                        })
                        .ok_or_else(|| v.error(&format!("{path}[{i}]"), "use #RRGGBB"))?;
                    Ok(color.to_ascii_uppercase())
                })
                .collect()
        };
        let colors = PlanColorSystem {
            primary: group("primary")?,
            background: group("background")?,
            text: group("text")?,
            functional: group("functional")?,
        };
        if colors != PlanColorSystem::default() {
            design.color_system = Some(colors);
        }
    }
    v.byte_cap(&design, "design", 16 * 1024)?;
    Ok(design)
}
