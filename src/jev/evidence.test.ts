import { describe, expect, it } from "vitest";

import { buildEvidencePacket, sharingLimitsFrom, type SharingLimits } from "./evidence.js";

const limits: SharingLimits = {
  excludeFullConversation: true,
  excludeFullRepository: true,
  maxPacketChars: 2000,
};

describe("buildEvidencePacket", () => {
  it("carries only the decision's task summary, candidates and selected excerpts", () => {
    const packet = buildEvidencePacket(
      {
        decision: "next-action",
        taskSummary: "T1 is assigned; tests pass",
        candidates: ["implement", "review"],
        excerpts: [{ source: "npm test", text: "18 passed" }],
      },
      limits,
    );

    expect(packet).toEqual({
      decision: "next-action",
      taskSummary: "T1 is assigned; tests pass",
      candidates: ["implement", "review"],
      excerpts: [{ source: "npm test", text: "18 passed" }],
      omitted: [],
    });
  });

  it("redacts credentials, including the configured key itself, and says where", () => {
    const packet = buildEvidencePacket(
      {
        decision: "validate",
        taskSummary: "deploy uses sk-live-abcdefghijklmnop",
        candidates: [],
        excerpts: [
          { source: ".env", text: "API_KEY=abcdefghijklmnopqrstuv\n" },
          { source: "log", text: "called with jev-key-0123456789" },
        ],
      },
      limits,
      { knownSecrets: ["jev-key-0123456789"] },
    );

    const sent = JSON.stringify(packet.excerpts) + packet.taskSummary;
    expect(sent).not.toContain("sk-live-abcdefghijklmnop");
    expect(sent).not.toContain("abcdefghijklmnopqrstuv");
    expect(sent).not.toContain("jev-key-0123456789");
    expect(packet.omitted).toEqual([
      { source: "taskSummary", reason: "credential redacted" },
      { source: ".env", reason: "credential redacted" },
      { source: "log", reason: "credential redacted" },
    ]);
  });

  it("leaves out full conversation and repository content while the sharing limits exclude them", () => {
    const input = {
      decision: "classify",
      taskSummary: "s",
      candidates: [],
      excerpts: [
        { source: "chat", text: "entire transcript", scope: "full-conversation" as const },
        { source: "repo", text: "every file", scope: "full-repository" as const },
        { source: "src/a.ts:10-12", text: "selected lines" },
      ],
    };

    const excluded = buildEvidencePacket(input, limits);
    const allowed = buildEvidencePacket(input, {
      ...limits,
      excludeFullConversation: false,
      excludeFullRepository: false,
    });

    expect(excluded.excerpts.map((excerpt) => excerpt.source)).toEqual(["src/a.ts:10-12"]);
    expect(excluded.omitted).toEqual([
      { source: "chat", reason: "full conversation excluded by evidenceSharing.excludeFullConversation" },
      { source: "repo", reason: "full repository excluded by evidenceSharing.excludeFullRepository" },
    ]);
    expect(allowed.excerpts).toHaveLength(3);
  });

  it("stays within the packet size limit, truncating and then dropping excerpts in order", () => {
    const packet = buildEvidencePacket(
      {
        decision: "validate",
        taskSummary: "s",
        candidates: [],
        excerpts: [
          { source: "a", text: "x".repeat(900) },
          { source: "b", text: "y".repeat(900) },
          { source: "c", text: "z".repeat(900) },
        ],
      },
      { ...limits, maxPacketChars: 1500 },
    );

    const sizes = packet.excerpts.map((excerpt) => excerpt.text.length);
    expect(sizes.reduce((sum, size) => sum + size, 0) + "s".length).toBe(1500);
    expect(packet.excerpts[0]?.text).toHaveLength(900);
    expect(packet.omitted).toEqual(
      expect.arrayContaining([
        { source: "b", reason: "truncated to the packet size limit" },
        { source: "c", reason: "dropped: packet size limit reached" },
      ]),
    );
  });

  it("cuts an oversized task summary to the limit rather than sending it whole", () => {
    const packet = buildEvidencePacket(
      { decision: "validate", taskSummary: "s".repeat(1200), candidates: ["met", "not-met"], excerpts: [{ source: "a", text: "x" }] },
      { ...limits, maxPacketChars: 1000 },
    );

    expect(packet.taskSummary.length + packet.candidates.join("").length).toBe(1000);
    expect(packet.excerpts).toEqual([]);
    expect(packet.omitted).toEqual([
      { source: "taskSummary", reason: "truncated to the packet size limit" },
      { source: "a", reason: "dropped: packet size limit reached" },
    ]);
  });

  it("redacts sources and names the candidate redacted, keeping the text around a secret", () => {
    const packet = buildEvidencePacket(
      {
        decision: "classify",
        taskSummary: "s",
        candidates: ["todo", "token=abcdefghijklmnopqrstuv"],
        excerpts: [{ source: "password: abcdefghijklmnopqrst", text: "line one password=abcdefghijklmnopqrst\nline two" }],
      },
      limits,
    );

    expect(packet.candidates[1]).toBe("[credential redacted]");
    expect(packet.excerpts[0]?.source).toBe("[credential redacted]");
    expect(packet.excerpts[0]?.text).toBe("line one [credential redacted]\nline two");
    expect(packet.omitted.map((entry) => entry.source)).toEqual(["candidates[1]", "[credential redacted]"]);
  });

  it("reads the limits from the resolved configuration", () => {
    expect(
      sharingLimitsFrom({
        stageModels: {},
        settings: {
          "evidenceSharing.excludeFullConversation": true,
          "evidenceSharing.excludeFullRepository": false,
          "evidenceSharing.maxPacketChars": 8000,
        },
      }),
    ).toEqual({ excludeFullConversation: true, excludeFullRepository: false, maxPacketChars: 8000 });
  });
});
