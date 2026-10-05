/**
 * Cross-language contract fixture for plan metadata normalization.
 *
 * `test-fixtures/plan-metadata-cases.json` is shared with the Rust host-core
 * metadata tests (crates/host-core/src/plans/metadata): every case must
 * produce the same acceptance decision, normalized value, and error
 * code/path in these TypeScript validators and in the Rust authority.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validatePlanDesign } from "./plan-design.js";
import { validatePlanSteps } from "./plan-steps.js";

type FixtureCase = {
  name: string;
  kind: "steps" | "design";
  input: unknown;
  ok: boolean;
  normalized?: unknown;
  code?: string;
  path?: string;
};

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-fixtures",
  "plan-metadata-cases.json",
);
const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureCase[];

describe("plan metadata cross-language fixture", () => {
  it("keeps a structurally valid fixture shared with the Rust host tests", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    expect(new Set(cases.map((fixture) => fixture.kind))).toEqual(new Set(["steps", "design"]));
    for (const fixture of cases) {
      expect(typeof fixture.name).toBe("string");
      expect(typeof fixture.ok).toBe("boolean");
      if (fixture.ok) expect("normalized" in fixture).toBe(true);
      else expect("code" in fixture).toBe(true);
    }
  });

  it.each(cases)("$kind: $name", (fixture) => {
    const result = fixture.kind === "steps" ? validatePlanSteps(fixture.input) : validatePlanDesign(fixture.input);
    if (fixture.ok) {
      expect(result).toEqual({ ok: true, value: fixture.normalized });
      return;
    }
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`Expected "${fixture.name}" to be rejected`);
    expect(result.code).toBe(fixture.code);
    if (fixture.path !== undefined) expect(result.path).toBe(fixture.path);
  });
});
