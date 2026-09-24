import { afterEach, describe, expect, it } from "vitest";

import { readRecord } from "../project/records.js";
import { listTraces } from "../jev/traces.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { decideConflict, raiseConflict } from "./conflicts.js";

const harnesses: ProjectHarness[] = [];

function harness(): ProjectHarness {
  const created = createProjectHarness({ state: { specificationAccepted: true, planAccepted: true } });
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const now = "2026-09-24T10:00:00Z";

describe("conflicts", () => {
  it("escalates a consequential conflict to the developer without consulting Jev", () => {
    const h = harness();

    const result = raiseConflict(
      h.root,
      { summary: "the review asks for a CLI flag the specification excludes", touches: ["requirements", "scope"] },
      { now },
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: {
        conflict: { id: "C1", kind: "consequential", status: "awaiting-developer", touches: ["requirements", "scope"] },
        askHuman: { kind: "human-ask", reasons: [expect.stringContaining("CLI flag")] },
      },
    });
    expect(listTraces(h.root)).toEqual([]);
    expect(readRecord(h.root, "conflicts")).toMatchObject({ kind: "present", record: { conflicts: [{ id: "C1" }] } });
  });

  it("resolves an ordinary technical disagreement by investigation and records it", () => {
    const h = harness();

    const result = raiseConflict(
      h.root,
      {
        summary: "implementer and reviewer disagree on whether the parser handles CRLF",
        touches: [],
        investigation: { finding: "it does; a CRLF fixture passes", evidence: ["src/parse.test.ts:40"], conclusive: true },
      },
      { now },
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: {
        conflict: {
          kind: "technical",
          status: "resolved",
          resolution: { by: "investigation", note: "it does; a CRLF fixture passes", evidence: ["src/parse.test.ts:40"] },
        },
      },
    });
    expect(result.ok && result.outcome.askHuman).toBeUndefined();
  });

  it("asks the developer when investigation is inconclusive", () => {
    const h = harness();

    const result = raiseConflict(
      h.root,
      {
        summary: "two retry strategies both pass the tests",
        touches: [],
        investigation: { finding: "benchmarks are within noise", evidence: ["bench.txt"], conclusive: false },
      },
      { now },
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: { conflict: { kind: "technical", status: "awaiting-developer" }, askHuman: { kind: "human-ask" } },
    });
  });

  it("refuses a technical disagreement raised without an investigation", () => {
    const h = harness();

    expect(raiseConflict(h.root, { summary: "tabs or spaces", touches: [] }, { now })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("investigat"),
    });
    expect(readRecord(h.root, "conflicts").kind).toBe("absent");
  });

  it("records the developer's decision on an escalated conflict in their words", () => {
    const h = harness();
    raiseConflict(h.root, { summary: "scope change", touches: ["scope"] }, { now });

    expect(decideConflict(h.root, "C1", { note: "", now })).toMatchObject({ ok: false });
    expect(decideConflict(h.root, "C1", { note: "keep the flag out", now })).toMatchObject({
      ok: true,
      outcome: { conflict: { status: "resolved", resolution: { by: "developer", note: "keep the flag out" } } },
    });
    expect(decideConflict(h.root, "C1", { note: "again", now })).toMatchObject({ ok: false });
  });
});
