import { describe, expect, it } from "vitest";

import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { CUED_ACTIONS, resolveRequest } from "./request.js";

const pkg = loadShippedWorkflowPackage();

describe("resolveRequest by name", () => {
  it.each(pkg.actions.map((action) => action.name))(
    "resolves the action name %s to that action",
    (name) => {
      expect(resolveRequest(name, pkg)).toEqual({ kind: "action", action: name, matchedBy: "name" });
    },
  );

  it.each([
    "/implement",
    "jflow implement",
    "Implement",
    "  implement  ",
    "run implement",
    "implement the progress bar",
    "implement error handling",
  ])("resolves %j to the named action, whatever follows the name", (text) => {
    expect(resolveRequest(text, pkg)).toEqual({
      kind: "action",
      action: "implement",
      matchedBy: "name",
    });
  });

  it("covers every cued action in the shipped package", () => {
    const names = pkg.actions.map((action) => action.name);
    for (const cued of CUED_ACTIONS) expect(names).toContain(cued);
    for (const name of names) expect(CUED_ACTIONS).toContain(name);
  });
});

describe("resolveRequest conversationally", () => {
  it.each([
    ["where are we with the plan?", "status"],
    ["what should I do next", "next"],
    ["what\u2019s done so far?", "status"],
    ["let's figure out what to build for the export feature", "brainstorm"],
    ["break the spec into tickets", "plan"],
    ["carry out ticket T3", "implement"],
    ["why is the build failing?", "troubleshoot"],
    ["could you look over my changes", "review"],
    ["let's finish for today", "wrap"],
    ["I changed my mind about the scope, realign the plan", "realign"],
    ["remember for later: rename the CLI", "todo"],
    ["record the lesson that vitest needs isolate off", "learn"],
  ])("resolves %j to %s", (text, action) => {
    expect(resolveRequest(text, pkg)).toEqual({ kind: "action", action, matchedBy: "phrase" });
  });

  it("asks which action was meant when a request fits more than one", () => {
    const result = resolveRequest("should I review or implement the plan?", pkg);

    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    // Every named action is a candidate, "plan" included: the request may
    // mean any of them and the developer, not the helper, says which.
    expect(result.candidates).toEqual(["plan", "implement", "review"]);
    expect(result.question).toBe("Which action did you mean: plan or implement or review?");
  });

  it("asks rather than guessing when two action names are given", () => {
    const result = resolveRequest("should I troubleshoot or review?", pkg);

    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.candidates).toEqual(["troubleshoot", "review"]);
  });

  it("reports an unrecognised request with the available actions", () => {
    const result = resolveRequest("make me a sandwich", pkg);

    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.message).toContain("brainstorm");
    expect(result.message).toContain("status");
  });

  it("does not let overlapping cues make one action outrank another it ties with", () => {
    const result = resolveRequest("for later: look over this", pkg);

    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.candidates).toEqual(["review", "todo"]);
  });

  it("reports an empty request as unknown", () => {
    expect(resolveRequest("   ", pkg).kind).toBe("unknown");
  });
});
