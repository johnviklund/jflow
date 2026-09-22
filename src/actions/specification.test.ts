import { afterEach, describe, expect, it } from "vitest";

import { readRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import {
  acceptSpecification,
  decideSpecification,
  writeSpecification,
  type SpecificationDraft,
} from "./specification.js";

const harnesses: ProjectHarness[] = [];

function harness(...args: Parameters<typeof createProjectHarness>): ProjectHarness {
  const created = createProjectHarness(...args);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const NOW = "2026-09-22T10:00:00Z";
const LATER = "2026-09-22T11:00:00Z";

const draft: SpecificationDraft = {
  title: "CSV export",
  problem: "Users cannot get their data out.",
  scenarios: ["A user exports the current list"],
  acceptanceCriteria: ["The file opens in a spreadsheet"],
  constraints: ["No new runtime dependency"],
  exclusions: ["Scheduled exports"],
  decisions: [
    { id: "D1", statement: "UTF-8 with BOM", basis: "Excel's default" },
    { id: "D2", statement: "Semicolon separator for sv-SE" },
  ],
};

const YES = { basis: "developer said yes" };

describe("writeSpecification", () => {
  it("writes the specification as awaiting acceptance, so plan is refused with the reason", () => {
    const h = harness();

    const result = writeSpecification(h.root, draft, { now: NOW });

    expect(result.ok).toBe(true);
    const stored = readRecord(h.root, "specification");
    expect(stored).toMatchObject({
      kind: "present",
      record: {
        ...draft,
        decisions: [
          { ...draft.decisions[0], status: "proposed" },
          { ...draft.decisions[1], status: "proposed" },
        ],
        status: "awaiting-acceptance",
        writtenAt: NOW,
      },
    });
    const plan = h.runAction("plan");
    expect(plan.kind).toBe("blocked");
    if (plan.kind !== "blocked") return;
    expect(plan.resolution.unmet.map((u) => u.condition)).toEqual(["specification.accepted"]);
    expect(plan.resolution.unmet[0]?.reason).toContain("not been explicitly accepted");
  });

  it("refuses an incomplete draft with the offending paths and writes nothing", () => {
    const h = harness();

    const result = writeSpecification(h.root, { ...draft, scenarios: [] }, { now: NOW });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues?.map((issue) => issue.path)).toContain("scenarios");
    expect(readRecord(h.root, "specification").kind).toBe("absent");
  });

  it("refuses to rewrite an accepted specification; that change belongs to realign", () => {
    const h = harness();
    writeSpecification(h.root, { ...draft, decisions: [] }, { now: NOW });
    acceptSpecification(h.root, { now: LATER });

    const result = writeSpecification(h.root, { ...draft, title: "CSV and JSON export" }, { now: LATER });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("realign");
    expect(readRecord(h.root, "specification")).toMatchObject({ record: { title: "CSV export" } });
  });

  it("stores every draft decision as a proposal and never an acceptance note, whatever the draft claims", () => {
    const h = harness();
    const claiming = {
      ...draft,
      decisions: [{ id: "D1", statement: "settled", status: "confirmed" }],
      acceptanceNote: "smuggled",
      status: "accepted",
    } as unknown as SpecificationDraft;

    const result = writeSpecification(h.root, claiming, { now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.decisions).toEqual([{ id: "D1", statement: "settled", status: "proposed" }]);
    expect(result.record.status).toBe("awaiting-acceptance");
    expect(result.record).not.toHaveProperty("acceptanceNote");
  });

  it("replaces an unaccepted specification with the new draft", () => {
    const h = harness();
    writeSpecification(h.root, draft, { now: NOW });

    const result = writeSpecification(h.root, { ...draft, title: "Revised" }, { now: LATER });

    expect(result.ok).toBe(true);
    expect(readRecord(h.root, "specification")).toMatchObject({
      record: { title: "Revised", status: "awaiting-acceptance", writtenAt: LATER },
    });
  });
});

describe("decideSpecification", () => {
  it("confirms or rejects a proposal, recording the developer's words as the basis", () => {
    const h = harness();
    writeSpecification(h.root, draft, { now: NOW });

    const confirmed = decideSpecification(h.root, "D1", "confirmed", { basis: "yes, BOM" });
    const rejected = decideSpecification(h.root, "D2", "rejected", { basis: "no, comma everywhere" });

    expect(confirmed.ok).toBe(true);
    expect(rejected.ok).toBe(true);
    expect(readRecord(h.root, "specification")).toMatchObject({
      record: {
        decisions: [
          { id: "D1", status: "confirmed", basis: "yes, BOM" },
          { id: "D2", status: "rejected", basis: "no, comma everywhere" },
        ],
      },
    });
  });

  it("refuses a decision without the developer's words", () => {
    const h = harness();
    writeSpecification(h.root, draft, { now: NOW });

    const result = decideSpecification(h.root, "D1", "confirmed", { basis: "  " });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("basis");
    const stored = readRecord(h.root, "specification");
    if (stored.kind !== "present") throw new Error("specification should be present");
    expect(stored.record.decisions.map((d) => d.status)).toEqual(["proposed", "proposed"]);
  });

  it("refuses an unknown decision and a decision on an accepted specification", () => {
    const h = harness();
    writeSpecification(h.root, draft, { now: NOW });

    expect(decideSpecification(h.root, "D9", "confirmed", YES)).toMatchObject({ ok: false });
    decideSpecification(h.root, "D1", "confirmed", YES);
    decideSpecification(h.root, "D2", "rejected", YES);
    acceptSpecification(h.root, { now: LATER });

    const late = decideSpecification(h.root, "D1", "rejected", YES);
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.reason).toContain("accepted");
  });
});

describe("acceptSpecification", () => {
  it("records acceptance with the developer's words, after which plan is eligible", () => {
    const h = harness();
    writeSpecification(h.root, draft, { now: NOW });
    decideSpecification(h.root, "D1", "confirmed", YES);
    decideSpecification(h.root, "D2", "confirmed", YES);

    const result = acceptSpecification(h.root, { now: LATER, note: "yes, build exactly that" });

    expect(result.ok).toBe(true);
    expect(readRecord(h.root, "specification")).toMatchObject({
      record: { status: "accepted", acceptedAt: LATER, acceptanceNote: "yes, build exactly that" },
    });
    expect(h.runAction("plan").kind).toBe("ready");
  });

  it("refuses acceptance while a decision is still a proposal, naming it", () => {
    const h = harness();
    writeSpecification(h.root, draft, { now: NOW });
    decideSpecification(h.root, "D1", "confirmed", YES);

    const result = acceptSpecification(h.root, { now: LATER });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("D2");
    expect(result.reason).not.toContain("D1");
    expect(readRecord(h.root, "specification")).toMatchObject({
      record: { status: "awaiting-acceptance" },
    });
  });

  it("refuses acceptance when there is no specification, or it is already accepted", () => {
    const h = harness();

    expect(acceptSpecification(h.root, { now: NOW })).toMatchObject({ ok: false });
    writeSpecification(h.root, { ...draft, decisions: [] }, { now: NOW });
    acceptSpecification(h.root, { now: LATER });

    const again = acceptSpecification(h.root, { now: LATER });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toContain("already");
  });
});
