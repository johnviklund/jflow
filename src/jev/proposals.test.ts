import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeRecord, type LessonRecord } from "../project/records.js";
import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { confidenceThreshold, routeByConfidence } from "../workflow/policy.js";
import { loadShippedWorkflowPackage, loadWorkflowPackage, SHIPPED_PACKAGE_DIRECTORY } from "../workflow/package.js";
import type { JevTransport, TransportRequest } from "./client.js";
import { askEscalation } from "./escalation.js";
import { findPatterns, readObservations } from "./observations.js";
import {
  acceptProposal,
  draftProposal,
  listProposals,
  rejectProposal,
  replayProposal,
  type ProposalDependencies,
  type ProposalDraft,
} from "./proposals.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const shipped = loadShippedWorkflowPackage();
const now = "2026-09-26T10:00:00.000Z";
const threshold = confidenceThreshold(shipped, "escalate");
const above = threshold + (1 - threshold) / 2;
/** A proposed lower threshold, and a confidence between it and the shipped one: no value is asserted (D37). */
const lower = threshold / 2;
const between = (lower + threshold) / 2;

type Answer = readonly [choice: string, reason: string, confidence: number];

function jev(rules: readonly (readonly [needle: string, answer: Answer])[]): JevTransport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    sent.push(request);
    const decision = Object.keys((JSON.parse(request.body) as { questions: object }).questions)[0]!;
    const answer = rules.find(([needle]) => request.body.includes(needle))?.[1];
    if (answer === undefined) return { status: 500, body: "no scripted answer" };
    const [choice, reason, confidence] = answer;
    return {
      status: 200,
      body: JSON.stringify({
        model: "jev-1.13",
        answers: {
          [decision]: { type: "choice", choice, confidence },
          [`${decision}.reason`]: { type: "choice", choice: reason, confidence },
        },
      }),
    };
  };
  return Object.assign(transport, { sent });
}

interface Setup {
  readonly h: ProjectHarness;
  /** A copy of the shipped package that acceptance writes to; the shipped one is never touched. */
  readonly packageDirectory: string;
  readonly deps: (transport?: JevTransport, key?: boolean) => ProposalDependencies;
}

function setup(): Setup {
  const h = createProjectHarness();
  const packageDirectory = mkdtempSync(join(tmpdir(), "jflow-package-"));
  cpSync(SHIPPED_PACKAGE_DIRECTORY, packageDirectory, { recursive: true });
  cleanups.push(() => h.cleanup(), () => rmSync(packageDirectory, { recursive: true, force: true }));
  const deps = (transport: JevTransport = jev([]), key = true): ProposalDependencies => ({
    context: h.context,
    apiKey: key
      ? { status: "configured", source: "environment", key: "jev-test-key-0123456789" }
      : { status: "missing", askHuman: "Set JFLOW_JEV_API_KEY", mayProceedWithoutJev: false },
    transport,
    now: () => now,
    sleep: async () => undefined,
    packageDirectory,
  });
  return { h, packageDirectory, deps };
}

function packageFiles(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name).slice(directory.length)] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

const LESSON: LessonRecord = {
  id: "L-1",
  statement: "A first failed fix with a named next step is resolved by that step.",
  scope: "src/parser",
  evidence: [{ kind: "commit", reference: "abc1234" }],
  status: "active",
};

/** Repeated `escalate` answers at fix-failed with one reason code, one at next-ticket, and a retained lesson. */
async function recorded(s: Setup): Promise<void> {
  const deps = s.deps(jev([["fix failed", ["escalate", "uncertain", above]], ["", ["escalate", "consequential", above]]]));
  for (const ticket of ["T1", "T2", "T3"]) {
    await askEscalation(s.h.root, { kind: "fix-failed", summary: `${ticket} fix failed once`, excerpts: [] }, deps);
  }
  await askEscalation(s.h.root, { kind: "next-ticket", summary: "T4 is next", excerpts: [] }, deps);
  writeRecord(s.h.root, "lessons", { lessons: [LESSON] });
}

/** The recurring pattern's observations, as `proposal patterns` hands them to the agent. */
function patternObservations(s: Setup): readonly string[] {
  const [pattern] = findPatterns(readObservations(s.h.root, s.h.context).observations);
  if (pattern === undefined) throw new Error("no recurring pattern");
  return pattern.observations;
}

function thresholdDraft(s: Setup, change: ProposalDraft["change"]): ProposalDraft {
  return {
    decision: "escalate",
    change,
    observations: patternObservations(s),
    lessons: ["L-1"],
    rationale: "Routine first fix failures escalate although the next step is clear.",
  };
}

const QUESTION = JSON.parse(readFileSync(join(SHIPPED_PACKAGE_DIRECTORY, "questions/escalate.json"), "utf8")) as Record<string, unknown>;
const REWORDED = { ...QUESTION, prompt: `${String(QUESTION["prompt"])} A first failed fix attempt with a clear next step is routine.` };

describe("drafting a proposal from a recurring observation pattern", () => {
  it("records the proposal with its linked observations and lessons and a replay report from stored envelopes, and changes nothing", async () => {
    const s = setup();
    await recorded(s);
    const before = packageFiles(s.packageDirectory);
    const transport = jev([]);

    const result = await draftProposal(s.h.root, thresholdDraft(s, { kind: "threshold", threshold: lower, for: "fix-failed" }), s.deps(transport));

    expect(result).toMatchObject({
      ok: true,
      outcome: {
        proposal: {
          id: "P-1",
          decision: "escalate",
          status: "pending",
          change: { kind: "threshold", for: "fix-failed" },
          lessons: [{ id: "L-1", statement: LESSON.statement }],
          replay: { decision: "escalate", kind: "fix-failed", envelopes: 3, replayed: 3 },
        },
      },
    });
    if (!result.ok) return;
    expect(result.outcome.proposal.observations.map((observation) => observation.id)).toEqual(patternObservations(s));
    expect(result.outcome.proposal.observations.every((observation) => observation.kind === "escalation")).toBe(true);
    // A threshold is replayed over the stored answers alone: Jev is not asked.
    expect(transport.sent).toHaveLength(0);
    expect(packageFiles(s.packageDirectory)).toEqual(before);
    expect(listProposals(s.h.root)).toMatchObject({ ok: true, proposals: [{ id: "P-1", status: "pending" }] });
  });

  it("refuses a proposal resting on lessons alone: a lesson can only contribute to one", async () => {
    const s = setup();
    await recorded(s);

    const result = await draftProposal(
      s.h.root,
      { ...thresholdDraft(s, { kind: "threshold", threshold: lower }), observations: [] },
      s.deps(),
    );

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("observation") });
    expect(listProposals(s.h.root)).toMatchObject({ ok: true, proposals: [] });
  });

  it("refuses a proposal whose only observations belong to no decision", async () => {
    const s = setup();
    await recorded(s);
    writeRecord(s.h.root, "progress", { executionAuthorized: false, ticketChangesPresent: false, fixAttempts: { T1: 99 } });

    const result = await draftProposal(
      s.h.root,
      { ...thresholdDraft(s, { kind: "authority", authority: "binding" }), decision: "classify", observations: ["OBS-fix-limit-T1"] },
      s.deps(),
    );

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("classify") });
  });

  it("refuses unknown or foreign observations, unknown or unretained lessons, and a change that changes nothing", async () => {
    const s = setup();
    await recorded(s);
    writeRecord(s.h.root, "lessons", { lessons: [LESSON, { ...LESSON, id: "L-2", status: "candidate" }] });
    const draft = thresholdDraft(s, { kind: "threshold", threshold: lower });

    const unknown = await draftProposal(s.h.root, { ...draft, observations: ["OBS-escalation-ENV-guess"] }, s.deps());
    const foreign = await draftProposal(s.h.root, { ...draft, decision: "validate" }, s.deps());
    const lesson = await draftProposal(s.h.root, { ...draft, lessons: ["L-9"] }, s.deps());
    const candidate = await draftProposal(s.h.root, { ...draft, lessons: ["L-2"] }, s.deps());
    const same = await draftProposal(s.h.root, { ...draft, change: { kind: "threshold", threshold } }, s.deps());
    const authority = await draftProposal(s.h.root, { ...draft, change: { kind: "authority", authority: "binding" } }, s.deps());
    const answers = await draftProposal(
      s.h.root,
      { ...draft, change: { kind: "question", question: { ...REWORDED, answers: ["proceed", "escalate", "defer"] } } },
      s.deps(),
    );

    expect(unknown).toMatchObject({ ok: false, reason: expect.stringContaining("OBS-escalation-ENV-guess") });
    expect(foreign).toMatchObject({ ok: false, reason: expect.stringContaining("escalate") });
    expect(lesson).toMatchObject({ ok: false, reason: expect.stringContaining("L-9") });
    expect(candidate).toMatchObject({ ok: false, reason: expect.stringContaining("L-2") });
    expect(same).toMatchObject({ ok: false });
    expect(authority).toMatchObject({ ok: false });
    expect(answers).toMatchObject({ ok: false, reason: expect.stringContaining("answers") });
    expect(listProposals(s.h.root)).toMatchObject({ ok: true, proposals: [] });
  });
});

describe("the acceptance gate", () => {
  it("lowers the escalate threshold only on the developer's recorded acceptance, bumping the decision's version", async () => {
    const s = setup();
    await recorded(s);
    const drafted = await draftProposal(s.h.root, thresholdDraft(s, { kind: "threshold", threshold: lower }), s.deps());
    if (!drafted.ok) throw new Error(drafted.reason);
    const before = loadWorkflowPackage(s.packageDirectory);
    expect(routeByConfidence(before, "escalate", between)).toBe("ask-human");

    const unsaid = acceptProposal(s.h.root, "P-1", { note: " " }, s.deps());
    expect(unsaid).toMatchObject({ ok: false });
    expect(routeByConfidence(loadWorkflowPackage(s.packageDirectory), "escalate", between)).toBe("ask-human");

    const accepted = acceptProposal(s.h.root, "P-1", { note: "Lower it; the replay shows only routine fixes move." }, s.deps());

    expect(accepted).toMatchObject({
      ok: true,
      outcome: {
        proposal: {
          status: "accepted",
          outcome: { outcome: "accepted", by: "developer", note: "Lower it; the replay shows only routine fixes move.", decidedAt: now },
        },
      },
    });
    const after = loadWorkflowPackage(s.packageDirectory);
    expect(routeByConfidence(after, "escalate", between)).toBe("honour");
    expect(routeByConfidence(after, "escalate", between, "review-dispute")).toBe("honour");
    expect(after.decisions["escalate"]!.version).toBe(before.decisions["escalate"]!.version + 1);
    expect(after.policy["escalate"]!.basis).toContain("P-1");
    // Every other decision is as it was.
    expect({ ...after.decisions, escalate: undefined }).toEqual({ ...before.decisions, escalate: undefined });
    expect({ ...after.policy, escalate: undefined }).toEqual({ ...before.policy, escalate: undefined });
  });

  it("splits escalate by kind: a threshold for fix-failed alone, leaving every other boundary on the decision's threshold", async () => {
    const s = setup();
    await recorded(s);
    const before = readFileSync(join(s.packageDirectory, "jflow.workflow.json"), "utf8");
    await draftProposal(s.h.root, thresholdDraft(s, { kind: "threshold", threshold: lower, for: "fix-failed" }), s.deps());

    const accepted = acceptProposal(s.h.root, "P-1", { note: "Split fix-failed out." }, s.deps());

    expect(accepted).toMatchObject({ ok: true });
    const after = loadWorkflowPackage(s.packageDirectory);
    expect(routeByConfidence(after, "escalate", between, "fix-failed")).toBe("honour");
    expect(routeByConfidence(after, "escalate", between, "next-ticket")).toBe("ask-human");
    expect(routeByConfidence(after, "escalate", between)).toBe("ask-human");
    // The rest of the hand-laid-out package is untouched: only the edited lines differ.
    const beforeLines = before.split("\n");
    const changed = readFileSync(join(s.packageDirectory, "jflow.workflow.json"), "utf8")
      .split("\n")
      .filter((line, index) => line !== beforeLines[index]);
    expect(changed).toHaveLength(3);
  });

  it("refuses a proposal whose replay could not run, until it is replayed", async () => {
    const s = setup();
    await recorded(s);
    const before = packageFiles(s.packageDirectory);

    const drafted = await draftProposal(
      s.h.root,
      { ...thresholdDraft(s, { kind: "question", question: REWORDED }), lessons: [] },
      s.deps(jev([]), false),
    );
    expect(drafted).toMatchObject({ ok: true, outcome: { askHuman: expect.stringContaining("JFLOW_JEV_API_KEY"), proposal: { status: "pending" } } });
    expect(drafted.ok && drafted.outcome.proposal.replay).toBeUndefined();

    expect(acceptProposal(s.h.root, "P-1", { note: "Accept it." }, s.deps())).toMatchObject({
      ok: false,
      reason: expect.stringContaining("replay"),
    });
    expect(packageFiles(s.packageDirectory)).toEqual(before);

    const replaying = jev([["T1", ["proceed", "routine", above]], ["", ["escalate", "uncertain", above]]]);
    const replayed = await replayProposal(s.h.root, "P-1", s.deps(replaying));
    expect(replayed).toMatchObject({ ok: true, outcome: { proposal: { replay: { replayed: 4, changed: 1 } } } });
    expect(replaying.sent).toHaveLength(4);

    const accepted = acceptProposal(s.h.root, "P-1", { note: "Accept the wording." }, s.deps());

    expect(accepted).toMatchObject({ ok: true });
    const question = JSON.parse(readFileSync(join(s.packageDirectory, "questions/escalate.json"), "utf8")) as Record<string, unknown>;
    expect(question).toMatchObject({
      decision: "escalate",
      version: Number(QUESTION["version"]) + 1,
      status: "accepted",
      prompt: REWORDED.prompt,
      acceptance: { acceptedAt: now, note: expect.stringContaining("Accept the wording.") },
    });
    expect(loadWorkflowPackage(s.packageDirectory).decisions["escalate"]!.version).toBe(Number(QUESTION["version"]) + 1);
  });

  it("takes a wording that only adds plain-language descriptions as a change, and writes them on acceptance", async () => {
    const s = setup();
    await recorded(s);
    const described = { ...QUESTION, descriptions: { proceed: "Continue within the authority already granted.", escalate: "Stop and ask the developer." } };

    const drafted = await draftProposal(s.h.root, { ...thresholdDraft(s, { kind: "question", question: described }), lessons: [] }, s.deps(jev([["", ["proceed", "routine", above]]])));
    expect(drafted).toMatchObject({ ok: true, outcome: { proposal: { change: { question: { descriptions: described.descriptions } } } } });
    expect(acceptProposal(s.h.root, "P-1", { note: "Accept the descriptions." }, s.deps())).toMatchObject({ ok: true });

    const question = JSON.parse(readFileSync(join(s.packageDirectory, "questions/escalate.json"), "utf8")) as Record<string, unknown>;
    expect(question["descriptions"]).toEqual(described.descriptions);
  });

  it("refuses a proposal whose replay found nothing to replay", async () => {
    const s = setup();
    await recorded(s);
    // Calls Jev failed are observations, but no escalate was answered at review-dispute, so there is nothing to replay.
    await askEscalation(s.h.root, { kind: "other", summary: "unscripted", excerpts: [] }, s.deps(jev([])));
    const failures = readObservations(s.h.root, s.h.context).observations.filter((observation) => observation.kind === "jev-failure");

    const drafted = await draftProposal(
      s.h.root,
      { decision: "escalate", change: { kind: "threshold", threshold: lower, for: "review-dispute" }, observations: failures.map((o) => o.id), rationale: "try" },
      s.deps(),
    );

    expect(drafted).toMatchObject({ ok: true, outcome: { proposal: { replay: { nothingToReplay: expect.any(String) } } } });
    expect(acceptProposal(s.h.root, "P-1", { note: "Accept." }, s.deps())).toMatchObject({ ok: false, reason: expect.stringContaining("replay") });
  });

  it("records a rejection and changes nothing, and a decided proposal cannot be decided again", async () => {
    const s = setup();
    await recorded(s);
    const before = packageFiles(s.packageDirectory);
    await draftProposal(s.h.root, thresholdDraft(s, { kind: "threshold", threshold: lower }), s.deps());

    const rejected = rejectProposal(s.h.root, "P-1", { note: "Not yet; too few envelopes." }, { now });

    expect(rejected).toMatchObject({
      ok: true,
      outcome: { proposal: { status: "rejected", outcome: { outcome: "rejected", by: "developer", note: "Not yet; too few envelopes.", decidedAt: now } } },
    });
    expect(packageFiles(s.packageDirectory)).toEqual(before);
    expect(acceptProposal(s.h.root, "P-1", { note: "Accept after all." }, s.deps())).toMatchObject({ ok: false });
    expect(rejectProposal(s.h.root, "P-1", { note: "again" }, { now })).toMatchObject({ ok: false });
    expect(rejectProposal(s.h.root, "P-1", { note: "" }, { now })).toMatchObject({ ok: false });
  });

  it("refuses a proposal replayed against a decision that has changed since", async () => {
    const s = setup();
    await recorded(s);
    await draftProposal(s.h.root, thresholdDraft(s, { kind: "threshold", threshold: lower }), s.deps());
    await draftProposal(s.h.root, thresholdDraft(s, { kind: "threshold", threshold: lower, for: "fix-failed" }), s.deps());
    expect(acceptProposal(s.h.root, "P-1", { note: "Accept." }, s.deps())).toMatchObject({ ok: true });

    expect(acceptProposal(s.h.root, "P-2", { note: "Accept." }, s.deps())).toMatchObject({ ok: false, reason: expect.stringContaining("version") });
  });

  it("refuses a proposal once the threshold it was replayed against was changed by hand", async () => {
    const s = setup();
    await recorded(s);
    await draftProposal(s.h.root, thresholdDraft(s, { kind: "threshold", threshold: lower }), s.deps());
    const path = join(s.packageDirectory, "jflow.workflow.json");
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.replace(`"confidence": ${threshold}`, `"confidence": ${above}`));

    expect(acceptProposal(s.h.root, "P-1", { note: "Accept." }, s.deps())).toMatchObject({ ok: false, reason: expect.stringContaining("threshold") });
  });

  it("changes a decision's authority only on acceptance, with its basis naming the proposal", async () => {
    const s = setup();
    await recorded(s);
    await draftProposal(s.h.root, thresholdDraft(s, { kind: "authority", authority: "advisory" }), s.deps());
    expect(loadWorkflowPackage(s.packageDirectory).decisions["escalate"]!.authority).toBe("binding");

    expect(acceptProposal(s.h.root, "P-1", { note: "Make it advisory." }, s.deps())).toMatchObject({ ok: true });

    const escalate = loadWorkflowPackage(s.packageDirectory).decisions["escalate"]!;
    expect(escalate.authority).toBe("advisory");
    expect(escalate.basis).toContain("P-1");
  });
});
