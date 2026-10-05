use super::*;
use serde_json::json;

#[test]
fn steps_normalize_and_round_trip() {
    let steps = normalize_steps(&json!([
        {"id":" a ","title":" First 🦀 ","detail":" \n ","dependsOn":[]},
        {"id":"b","title":"Second","detail":" detail\ntext ","dependsOn":[" a "]}
    ]))
    .unwrap();
    let expected = json!([
        {"id":"a","title":"First 🦀","dependsOn":[]},
        {"id":"b","title":"Second","detail":"detail\ntext","dependsOn":["a"]}
    ]);
    assert_eq!(serde_json::to_value(&steps).unwrap(), expected);
    assert_eq!(normalize_steps(&expected).unwrap(), steps);
    assert!(normalize_steps(&json!([])).unwrap().is_empty());
    assert!(normalize_steps(&json!([{"id":"a","title":"🦀".repeat(200)}])).is_ok());
}

#[test]
fn steps_reject_invalid_shapes_fields_and_graphs() {
    for (value, path) in [
        (json!({}), "steps"),
        (json!([{"id":"a","title":"ok","extra":1}]), "steps[0].extra"),
        (json!([{"id":"-a","title":"ok"}]), "steps[0].id"),
        (json!([{"id":"a","title":" \n "}]), "steps[0].title"),
        (json!([{"id":"a","title":"line\nbreak"}]), "steps[0].title"),
        (json!([{"id":"a","title":"x\u{007f}"}]), "steps[0].title"),
        (
            json!([{"id":"a","title":"ok","detail":"x\0y"}]),
            "steps[0].detail",
        ),
        (
            json!([{"id":"a","title":"ok","detail":null}]),
            "steps[0].detail",
        ),
        (
            json!([{"id":"a","title":"ok","dependsOn":null}]),
            "steps[0].dependsOn",
        ),
        (
            json!([{"id":"a","title":"ok","dependsOn":["a"]}]),
            "steps[0].dependsOn[0]",
        ),
        (
            json!([{"id":"a","title":"ok","dependsOn":["x"]}]),
            "steps[0].dependsOn[0]",
        ),
        (
            json!([{"id":"a","title":"ok"},{"id":"a","title":"duplicate"}]),
            "steps[1].id",
        ),
        (
            json!([{"id":"a","title":"ok"},{"id":"b","title":"ok","dependsOn":["a","a"]}]),
            "steps[1].dependsOn[1]",
        ),
    ] {
        let error = normalize_steps(&value).unwrap_err().to_string();
        assert!(
            error.starts_with(&format!("PLAN_STEPS_INVALID {path}:")),
            "{error}"
        );
    }
    let error = normalize_steps(&json!([
        {"id":"a","title":"A","dependsOn":["b"]},
        {"id":"b","title":"B","dependsOn":["a"]}
    ]))
    .unwrap_err()
    .to_string();
    assert!(error.contains("a -> b -> a"));
    assert!(error.contains("steps[1].dependsOn[0]"));
    assert!(normalize_steps(&json!([{"id":"a","title":"ok","detail":" ".repeat(70000)}])).is_ok());
}

#[test]
fn step_limits_include_normalized_utf8_and_json_escaping() {
    let make = |count: usize, detail: String| -> Value {
        Value::Array(
            (0..count)
                .map(|i| json!({"id":format!("s{i}"),"title":"ok","detail":detail}))
                .collect(),
        )
    };
    assert!(normalize_steps(&make(24, "x".repeat(2000))).is_ok());
    assert!(normalize_steps(&make(25, "".into())).is_err());
    assert!(normalize_steps(&make(1, "x".repeat(2001))).is_err());
    for detail in ["🦀".repeat(2000), "\u{0001}".repeat(2000)] {
        let error = normalize_steps(&make(24, detail)).unwrap_err().to_string();
        assert!(error.contains("65536 bytes"));
    }
}

#[test]
fn design_normalizes_optional_groups_and_round_trips() {
    let design = normalize_design(&json!({
        "framework":" React ","componentLibrary":" SHADCN/UI ",
        "styleKeywords":[" Calm ", "Modern"],
        "fontSystem":{"fontFamily":" Inter ","heading":{"size":"24px","weight":600.0}},
        "colorSystem":{"primary":["#aAbBcc"],"text":[]}
    }))
    .unwrap();
    let expected = json!({
        "framework":"react","componentLibrary":"shadcn/ui","styleKeywords":["Calm","Modern"],
        "fontSystem":{"fontFamily":"Inter","heading":{"size":"24px","weight":600}},
        "colorSystem":{"primary":["#AABBCC"]}
    });
    assert_eq!(serde_json::to_value(&design).unwrap(), expected);
    assert_eq!(normalize_design(&expected).unwrap(), design);
    assert!(normalize_design(&json!({"framework":" ".repeat(17000)}))
        .unwrap()
        .is_empty());
    for value in [
        json!({}),
        json!({"framework":" ","componentLibrary":"","styleKeywords":[],"colorSystem":{"primary":[]}}),
    ] {
        let design = normalize_design(&value).unwrap();
        assert!(design.is_empty());
        assert_eq!(serde_json::to_value(design).unwrap(), json!({}));
    }
}

#[test]
fn design_rejects_unknown_keys_invalid_colors_fonts_and_limits() {
    for value in [
        json!(null),
        json!([]),
        json!({"extra":1}),
        json!({"framework":null}),
        json!({"framework":"has spaces"}),
        json!({"framework":"a".repeat(41)}),
        json!({"styleKeywords":["Calm","calm"]}),
        json!({"styleKeywords":[""]}),
        json!({"styleKeywords":["x\ny"]}),
        json!({"styleKeywords":vec!["x";13]}),
        json!({"fontSystem":{}}),
        json!({"fontSystem":{"fontFamily":"x","extra":1}}),
        json!({"fontSystem":{"fontFamily":"x","body":{"size":"9px","weight":400}}}),
        json!({"fontSystem":{"fontFamily":"x","body":{"size":"73px","weight":400}}}),
        json!({"fontSystem":{"fontFamily":"x","body":{"size":"010px","weight":400}}}),
        json!({"fontSystem":{"fontFamily":"x","body":{"size":"12px","weight":450}}}),
        json!({"colorSystem":{"extra":[]}}),
        json!({"colorSystem":{"primary":vec!["#123456";9]}}),
    ] {
        assert!(
            normalize_design(&value)
                .unwrap_err()
                .to_string()
                .starts_with("PLAN_DESIGN_INVALID design"),
            "{value}"
        );
    }
    for color in ["#abc", "red", "rgba(0,0,0,1)", " #123456", "#GG0000"] {
        let error = normalize_design(&json!({"colorSystem":{"primary":[color]}}))
            .unwrap_err()
            .to_string();
        assert!(error.contains("design.colorSystem.primary[0]: use #RRGGBB"));
    }
    // Valid design field caps currently make the global byte cap unreachable;
    // keep its serializer-based guard covered independently.
    assert!(Validator("PLAN_DESIGN_INVALID")
        .byte_cap(&"x".repeat(16384), "design", 16384)
        .is_err());
}
