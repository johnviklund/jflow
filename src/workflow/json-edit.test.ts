import { describe, expect, it } from "vitest";

import { setJsonValue } from "./json-edit.js";

const TEXT = `{
  "decisions": {
    "escalate": { "version": 2, "authority": "binding", "basis": "D44." }
  },
  "policy": {
    "escalate": {
      "thresholds": { "confidence": 0.95 },
      "basis": "Placeholder \\"quoted\\"."
    },
    "validate": {
      "thresholds": {
        "confidence": 0.9
      },
      "basis": "Placeholder."
    }
  },
  "list": [1, { "a": "}" }]
}
`;

function changedLines(before: string, after: string): string[] {
  const old = before.split("\n");
  return after.split("\n").filter((line, index) => line !== old[index]);
}

describe("setJsonValue", () => {
  it("replaces one value and leaves every other character as it was", () => {
    const after = setJsonValue(TEXT, ["policy", "escalate", "thresholds", "confidence"], 0.8);

    expect(JSON.parse(after).policy.escalate.thresholds.confidence).toBe(0.8);
    expect(changedLines(TEXT, after)).toEqual(['      "thresholds": { "confidence": 0.8 },']);
  });

  it("replaces a string holding escapes, and a value in a one-line object", () => {
    let after = setJsonValue(TEXT, ["policy", "escalate", "basis"], "Lowered by P-1.");
    after = setJsonValue(after, ["decisions", "escalate", "version"], 3);

    expect(JSON.parse(after).policy.escalate.basis).toBe("Lowered by P-1.");
    expect(changedLines(TEXT, after)).toEqual([
      '    "escalate": { "version": 3, "authority": "binding", "basis": "D44." }',
      '      "basis": "Lowered by P-1."',
    ]);
  });

  it("adds a missing key at the end of its object, in the object's own layout", () => {
    const inline = setJsonValue(TEXT, ["policy", "escalate", "thresholds", "confidence:fix-failed"], 0.8);
    const multiline = setJsonValue(TEXT, ["policy", "validate", "thresholds", "confidence:testability"], 0.7);

    expect(JSON.parse(inline).policy.escalate.thresholds).toEqual({ confidence: 0.95, "confidence:fix-failed": 0.8 });
    expect(changedLines(TEXT, inline)).toEqual(['      "thresholds": { "confidence": 0.95, "confidence:fix-failed": 0.8 },']);
    expect(JSON.parse(multiline).policy.validate.thresholds).toEqual({ confidence: 0.9, "confidence:testability": 0.7 });
    expect(multiline).toContain('        "confidence": 0.9,\n        "confidence:testability": 0.7\n      },');
  });

  it("refuses a path whose parent is missing or is not an object", () => {
    expect(() => setJsonValue(TEXT, ["policy", "guess", "basis"], "x")).toThrow(/policy\.guess/);
    expect(() => setJsonValue(TEXT, ["list", "a"], 1)).toThrow(/list/);
  });
});
