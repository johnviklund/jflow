import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createProjectHarness, type ProjectHarness } from "../testing/harness.js";
import { confidenceThreshold } from "../workflow/policy.js";
import { loadShippedWorkflowPackage } from "../workflow/package.js";
import type { DecisionQuestion, JevTransport, TransportRequest } from "./client.js";
import { listEnvelopes, readEnvelope, type DecisionDependencies } from "./decisions.js";
import { askEscalation } from "./escalation.js";
import { replayDecision } from "./replay.js";
import { listTraces } from "./traces.js";

const harnesses: ProjectHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const pkg = loadShippedWorkflowPackage();
const now = "2026-09-25T20:00:00.000Z";
const threshold = confidenceThreshold(pkg, "escalate");
const above = threshold + (1 - threshold) / 2;
const below = threshold / 2;

type Answer = readonly [choice: string, reason: string, confidence: number];

/** A Jev that answers by what the request body contains; the first matching rule wins. */
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

function dependencies(h: ProjectHarness, transport: JevTransport, key = true): DecisionDependencies {
  return {
    context: h.context,
    apiKey: key
      ? { status: "configured", source: "environment", key: "jev-test-key-0123456789" }
      : { status: "missing", askHuman: "Set JFLOW_JEV_API_KEY", mayProceedWithoutJev: false },
    transport,
    now: () => now,
    sleep: async () => undefined,
  };
}

const QUESTION = JSON.parse(readFileSync(fileURLToPath(new URL("../../workflow/questions/escalate.json", import.meta.url)), "utf8")) as Record<
  string,
  unknown
>;
/** A proposed wording that leans towards proceeding on a routine fix failure. */
const PROPOSED = {
  ...QUESTION,
  version: 3,
  status: "proposed",
  prompt: `${String(QUESTION["prompt"])} A first failed fix attempt with a clear next step is routine.`,
  acceptance: undefined,
};

/** Three escalate envelopes: two at fix-failed (one escalated, one proceeded) and one at next-ticket. */
async function recorded(): Promise<ProjectHarness> {
  const h = createProjectHarness();
  harnesses.push(h);
  const answering = jev([
    ["parser", ["escalate", "uncertain", above]],
    ["lexer", ["proceed", "routine", above]],
    ["next-ticket", ["escalate", "consequential", above]],
  ]);
  const deps = dependencies(h, answering);
  await askEscalation(h.root, { kind: "fix-failed", summary: "T1 parser fix failed once", excerpts: [] }, deps);
  await askEscalation(h.root, { kind: "fix-failed", summary: "T2 lexer fix failed once", excerpts: [] }, deps);
  await askEscalation(h.root, { kind: "next-ticket", summary: "T3 is next", excerpts: [] }, deps);
  return h;
}

/** Every file under the shipped workflow package, by path. */
function workflowFiles(): Record<string, string> {
  const root = fileURLToPath(new URL("../../workflow/", import.meta.url));
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[`${entry.parentPath}/${entry.name}`] = readFileSync(`${entry.parentPath}/${entry.name}`, "utf8");
  }
  return files;
}

describe("replaying a proposed question against the stored envelopes", () => {
  it("re-asks Jev over each stored packet and reports the changes by direction, boundary kind and reason code", async () => {
    const h = await recorded();
    // Envelopes asked in the same instant sort by their random suffix, so find the parser one by content.
    const parser = listEnvelopes(h.root).find((id) => {
      const read = readEnvelope(h.root, id);
      return read.ok && read.envelope.request.packet.taskSummary.includes("parser");
    });
    const replaying = jev([
      ["parser", ["proceed", "routine", above]],
      ["lexer", ["proceed", "routine", above]],
      ["next-ticket", ["escalate", "consequential", above]],
    ]);

    const result = await replayDecision(h.root, "escalate", { question: PROPOSED }, dependencies(h, replaying));

    expect(replaying.sent).toHaveLength(3);
    expect(replaying.sent[0]!.body).toContain("A first failed fix attempt with a clear next step is routine.");
    expect(result).toMatchObject({
      ok: true,
      report: {
        decision: "escalate",
        envelopes: 3,
        replayed: 3,
        changed: 1,
        unchanged: 2,
        directions: [{ from: "escalate", to: "proceed", count: 1 }],
        byKind: {
          "fix-failed": { replayed: 2, changed: 1, directions: [{ from: "escalate", to: "proceed", count: 1 }] },
          "next-ticket": { replayed: 1, changed: 0, directions: [] },
        },
        byReasonCode: {
          uncertain: { replayed: 1, changed: 1 },
          routine: { replayed: 1, changed: 0 },
          consequential: { replayed: 1, changed: 0 },
        },
        changes: [
          {
            envelope: parser,
            kind: "fix-failed",
            reasonCode: "uncertain",
            from: { answer: "escalate", route: "act" },
            to: { answer: "proceed", reasonCode: "routine", route: "act" },
          },
        ],
      },
    });
  });

  it("tallies reason codes that change even where the answer stays", async () => {
    const h = await recorded();

    const result = await replayDecision(
      h.root,
      "escalate",
      { question: PROPOSED },
      dependencies(h, jev([["next-ticket", ["escalate", "uncertain", above]], ["parser", ["escalate", "uncertain", above]], ["", ["proceed", "routine", above]]])),
    );

    expect(result).toMatchObject({ ok: true, report: { changed: 0, reasonChanges: [{ from: "consequential", to: "uncertain", count: 1 }] } });
  });

  it("routes a proposed wording's answers as if it were accepted, and reports route changes too", async () => {
    const h = await recorded();

    const result = await replayDecision(
      h.root,
      "escalate",
      { question: PROPOSED },
      dependencies(h, jev([["parser", ["escalate", "uncertain", below]], ["", ["proceed", "routine", above]]])),
    );

    expect(result).toMatchObject({
      ok: true,
      report: {
        changed: 2,
        routeChanges: [{ from: "act", to: "ask-human", count: 1 }],
      },
    });
  });

  it("refuses a proposed question for another decision or with no answers, and asks nothing", async () => {
    const h = await recorded();
    const transport = jev([]);

    const other = await replayDecision(h.root, "escalate", { question: { ...PROPOSED, decision: "validate" } }, dependencies(h, transport));
    const empty = await replayDecision(h.root, "escalate", { question: { ...PROPOSED, answers: [] } }, dependencies(h, transport));

    expect(other).toMatchObject({ ok: false, reason: expect.stringContaining("validate") });
    expect(empty).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: expect.stringContaining("answers") })] });
    expect(transport.sent).toHaveLength(0);
  });
});

describe("replaying a proposed threshold", () => {
  it("re-routes the stored answers without asking Jev, so only the threshold's effect is reported", async () => {
    const h = await recorded();
    const replaying = jev([["", ["proceed", "routine", above]]]);

    const result = await replayDecision(h.root, "escalate", { threshold: 1 }, dependencies(h, replaying, false));

    expect(replaying.sent).toHaveLength(0);
    expect(result).toMatchObject({
      ok: true,
      report: {
        threshold: 1,
        replayed: 3,
        changed: 3,
        directions: [],
        reasonChanges: [],
        routeChanges: [{ from: "act", to: "ask-human", count: 3 }],
      },
    });
  });

  it("keeps a stored answer to wording that was not accepted with the developer, whatever the threshold", async () => {
    const h = createProjectHarness();
    harnesses.push(h);
    const deps = {
      ...dependencies(h, jev([["", ["escalate", "uncertain", above]]])),
      readQuestion: () => ({ ...(PROPOSED as never as DecisionQuestion), decision: "escalate" }),
    };
    await askEscalation(h.root, { kind: "other", summary: "asked under a proposed wording", excerpts: [] }, deps);

    const result = await replayDecision(h.root, "escalate", { threshold: 0 }, dependencies(h, jev([])));

    expect(result).toMatchObject({ ok: true, report: { replayed: 1, changed: 0, routeChanges: [] } });
  });

  it("refuses a threshold outside 0 to 1, and a replay with nothing proposed", async () => {
    const h = await recorded();

    expect(await replayDecision(h.root, "escalate", { threshold: 1.5 }, dependencies(h, jev([])))).toMatchObject({ ok: false });
    expect(await replayDecision(h.root, "escalate", {}, dependencies(h, jev([])))).toMatchObject({ ok: false });
  });
});

describe("replaying a threshold for one kind (issue #30)", () => {
  it("re-routes only the envelopes asked at that kind, and says which kind it replayed", async () => {
    const h = await recorded();

    const result = await replayDecision(h.root, "escalate", { threshold: 1, kind: "fix-failed" }, dependencies(h, jev([]), false));

    expect(result).toMatchObject({
      ok: true,
      report: {
        kind: "fix-failed",
        envelopes: 2,
        replayed: 2,
        changed: 2,
        routeChanges: [{ from: "act", to: "ask-human", count: 2 }],
        byKind: { "fix-failed": { replayed: 2, changed: 2 } },
      },
    });
    expect(result.ok && Object.keys(result.report.byKind)).toEqual(["fix-failed"]);
  });

  it("refuses a kind the decision is not split by, and a kind without a threshold", async () => {
    const h = await recorded();

    expect(await replayDecision(h.root, "escalate", { threshold: 0.5, kind: "testability" }, dependencies(h, jev([])))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("testability"),
    });
    expect(await replayDecision(h.root, "validate", { threshold: 0.5, kind: "all" }, dependencies(h, jev([])))).toMatchObject({ ok: false });
    expect(await replayDecision(h.root, "escalate", { kind: "fix-failed", authority: "advisory" }, dependencies(h, jev([])))).toMatchObject({
      ok: false,
    });
  });
});

describe("replaying a whole-decision threshold once a kind has its own (issue #30)", () => {
  it("leaves the envelopes of that kind on their own threshold, as routing will after acceptance", async () => {
    const h = await recorded();
    const escalate = pkg.policy["escalate"]!;
    const split = {
      ...dependencies(h, jev([]), false),
      context: {
        ...h.context,
        workflowPackage: { ...pkg, policy: { ...pkg.policy, escalate: { ...escalate, thresholds: { ...escalate.thresholds, "confidence:fix-failed": 0 } } } },
      },
    };

    const result = await replayDecision(h.root, "escalate", { threshold: 1 }, split);

    expect(result).toMatchObject({ ok: true, report: { replayed: 3, changed: 1, byKind: { "fix-failed": { changed: 0 }, "next-ticket": { changed: 1 } } } });
  });
});

describe("replaying a proposed authority (issue #30)", () => {
  it("re-routes the stored confident answers under the proposed authority, without asking Jev", async () => {
    const h = await recorded();
    const transport = jev([]);

    const result = await replayDecision(h.root, "escalate", { authority: "advisory" }, dependencies(h, transport, false));

    expect(transport.sent).toHaveLength(0);
    expect(result).toMatchObject({
      ok: true,
      report: { authority: "advisory", replayed: 3, changed: 3, directions: [], routeChanges: [{ from: "act", to: "weigh", count: 3 }] },
    });
  });

  it("refuses an authority that is not binding or advisory", async () => {
    const h = await recorded();

    expect(await replayDecision(h.root, "escalate", { authority: "sovereign" as never }, dependencies(h, jev([])))).toMatchObject({ ok: false });
  });
});

describe("what replay reads and writes", () => {
  it("says so when the decision has no stored envelopes, rather than reporting an empty success", async () => {
    const h = await recorded();
    const transport = jev([]);

    const result = await replayDecision(h.root, "validate", { threshold: 0.5 }, dependencies(h, transport));

    expect(result).toMatchObject({ ok: true, report: { decision: "validate", envelopes: 0, nothingToReplay: expect.stringContaining("no stored") } });
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses an undeclared decision", async () => {
    const h = await recorded();

    expect(await replayDecision(h.root, "disposition", { threshold: 0.5 }, dependencies(h, jev([])))).toMatchObject({ ok: false });
  });

  it("writes only traces: no envelope, record, question or policy file, and makes no workflow decision", async () => {
    const h = await recorded();
    const files = h.snapshot();
    const workflow = workflowFiles();
    const traces = listTraces(h.root).length;

    await replayDecision(h.root, "escalate", { question: PROPOSED, threshold: 0.99 }, dependencies(h, jev([["", ["proceed", "routine", above]]])));

    const after = h.snapshot();
    const paths = new Set([...Object.keys(files), ...Object.keys(after)]);
    const changed = [...paths].filter((path) => after[path] !== files[path]);
    expect(changed.length).toBe(3);
    expect(changed.every((path) => path.startsWith(".jflow/traces/"))).toBe(true);
    expect(listTraces(h.root).length).toBe(traces + 3);
    expect(after[".jflow/.gitignore"]).toBe("*\n");
    expect(workflowFiles()).toEqual(workflow);
  });

  it("reports failed calls per envelope without recording a Jev fallback, and asks for a missing key", async () => {
    const h = await recorded();
    const files = h.snapshot();

    const failing = await replayDecision(h.root, "escalate", { question: PROPOSED }, dependencies(h, jev([["parser", ["proceed", "routine", above]]])));
    const missing = await replayDecision(h.root, "escalate", { question: PROPOSED }, dependencies(h, jev([]), false));

    expect(failing).toMatchObject({ ok: true, report: { replayed: 1, failed: [{ envelope: expect.any(String) }, { envelope: expect.any(String) }] } });
    expect(failing.ok && failing.report.nothingToReplay).toBeUndefined();
    expect(h.snapshot()["jflow/jev.json"]).toBe(files["jflow/jev.json"]);
    expect(missing).toMatchObject({ ok: false, askHuman: expect.stringContaining("JFLOW_JEV_API_KEY") });
  });

  it("does not report a replay in which every call failed as a success", async () => {
    const h = await recorded();

    const result = await replayDecision(h.root, "escalate", { question: PROPOSED }, dependencies(h, jev([])));

    expect(result).toMatchObject({ ok: true, report: { replayed: 0, nothingToReplay: expect.stringContaining("could not be asked") } });
  });

  it("lists stored envelopes it cannot read", async () => {
    const h = await recorded();
    h.writeFile(".jflow/envelopes/ENV-0-escalate-broken.json", "{ not json");

    const result = await replayDecision(h.root, "escalate", { threshold: 0.5 }, dependencies(h, jev([])));

    expect(result).toMatchObject({ ok: true, report: { replayed: 3, unreadable: [{ envelope: "ENV-0-escalate-broken" }] } });
  });
});
