import { describe, expect, it } from "vitest";

import { loadShippedWorkflowPackage } from "../workflow/package.js";
import { jevKeyFilePath, resolveConfiguration, resolveJevApiKey } from "./configuration.js";

const workflowPackage = loadShippedWorkflowPackage();

function resolve(document: unknown) {
  return resolveConfiguration(document, workflowPackage);
}

describe("resolveConfiguration defaults", () => {
  it("applies the specified defaults when no configuration is supplied", () => {
    const result = resolve({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configuration.settings["commitOnSuccess"]).toBe(true);
    expect(result.configuration.settings["jev.retryCount"]).toBe(2);
    expect(result.configuration.settings["review.fixRetryLimit"]).toBe(2);
    expect(result.configuration.settings["traces.retention"]).toBe("manual-cleanup");
    expect(result.configuration.settings["evidenceSharing.excludeCredentials"]).toBe(true);
    expect(result.configuration.settings["evidenceSharing.excludeFullConversation"]).toBe(
      true,
    );
    expect(result.configuration.settings["evidenceSharing.excludeFullRepository"]).toBe(
      true,
    );
    expect(result.configuration.settings["evidenceSharing.maxPacketChars"]).toBe(20000);
  });

  it("keeps the Jev retry count and the review fix-retry limit independent", () => {
    const result = resolve({
      settings: { "jev.retryCount": 4, "review.fixRetryLimit": 1 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configuration.settings["jev.retryCount"]).toBe(4);
    expect(result.configuration.settings["review.fixRetryLimit"]).toBe(1);
  });

  it("allows commit-on-success to be turned off", () => {
    const result = resolve({ settings: { commitOnSuccess: false } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configuration.settings["commitOnSuccess"]).toBe(false);
  });
});

describe("resolveConfiguration validation", () => {
  it("rejects an unknown top-level key", () => {
    const result = resolve({ stageModls: {} });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "stageModls",
      message:
        "unknown configuration key; supported keys are primaryModel, stageModels, settings",
    });
  });

  it("rejects an unknown setting key", () => {
    const result = resolve({ settings: { "jev.retries": 2 } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("settings.jev.retries");
    expect(result.issues[0]?.message).toContain("unknown setting");
  });

  it("rejects a setting value outside its declared range", () => {
    const result = resolve({ settings: { "jev.retryCount": 99 } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "settings.jev.retryCount",
      message: "must be an integer between 0 and 5",
    });
  });

  it("rejects a setting value of the wrong type", () => {
    const result = resolve({ settings: { commitOnSuccess: "yes" } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "settings.commitOnSuccess",
      message: "must be a boolean",
    });
  });

  it("rejects disabling the independent review gate", () => {
    const result = resolve({ settings: { "review.requireIndependentReviewer": false } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "settings.review.requireIndependentReviewer",
      message:
        "cannot be changed from its default (true); this gate is not configurable",
    });
  });

  it("rejects disabling credential exclusion from Jev evidence", () => {
    const result = resolve({ settings: { "evidenceSharing.excludeCredentials": false } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("not configurable");
  });

  it("rejects automatic trace deletion", () => {
    const result = resolve({ settings: { "traces.retention": "auto-delete" } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("settings.traces.retention");
  });
});

describe("resolveConfiguration stage models", () => {
  it("accepts a per-stage worker model with an explicit fallback", () => {
    const result = resolve({
      primaryModel: "primary-model",
      stageModels: {
        implement: { model: "worker-a", fallbackModel: "worker-b" },
        review: { model: "worker-c" },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configuration.primaryModel).toBe("primary-model");
    expect(result.configuration.stageModels["implement"]).toEqual({
      model: "worker-a",
      fallbackModel: "worker-b",
    });
    expect(result.configuration.stageModels["review"]).toEqual({ model: "worker-c" });
  });

  it("allows the reviewer model to equal the implementer model", () => {
    const result = resolve({
      stageModels: { implement: { model: "same" }, review: { model: "same" } },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects an unknown stage name", () => {
    const result = resolve({ stageModels: { deploy: { model: "worker" } } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("stageModels.deploy");
    expect(result.issues[0]?.message).toContain("unknown stage");
  });

  it("rejects an always-available action as a configurable stage model", () => {
    const result = resolve({ stageModels: { status: { model: "worker" } } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("stageModels.status");
  });

  it("rejects an implicit fallback placeholder instead of an explicit model", () => {
    const result = resolve({
      stageModels: { implement: { model: "worker-a", fallbackModel: "auto" } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "stageModels.implement.fallbackModel",
      message:
        "must name an explicit model; jflow never substitutes a model automatically and asks the human instead",
    });
  });

  it("takes a stage's efforts as a list of distinct names model-selection chooses among (issue #28)", () => {
    const ok = resolve({ stageModels: { implement: { model: "worker-a", efforts: ["low", "high"] } } });
    expect(ok.ok && ok.configuration.stageModels["implement"]).toEqual({ model: "worker-a", efforts: ["low", "high"] });

    for (const efforts of [[], ["low", "low"], ["low", " "], "high"]) {
      const result = resolve({ stageModels: { implement: { model: "worker-a", efforts } } });
      expect(result.ok, JSON.stringify(efforts)).toBe(false);
      if (result.ok) continue;
      expect(result.issues[0]?.path).toBe("stageModels.implement.efforts");
    }
  });

  it("rejects a per-stage primary conversational model override", () => {
    const result = resolve({
      stageModels: { implement: { model: "worker-a", primaryModel: "other" } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("stageModels.implement.primaryModel");
    expect(result.issues[0]?.message).toContain("fixed across stages");
  });
});

describe("resolveConfiguration secret handling", () => {
  it("rejects a Jev API key stored in configuration", () => {
    const result = resolve({ settings: {}, jevApiKey: "sk-live-123" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "jevApiKey",
      message:
        "secrets must never be stored in jflow configuration or version control; provide the Jev API key via ~/.config/jflow/jev-key or the JFLOW_JEV_API_KEY environment variable",
    });
  });

  it("rejects a declared setting name used as a top-level key", () => {
    const result = resolve({ "evidenceSharing.excludeCredentials": "leak" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("evidenceSharing.excludeCredentials");
  });

  it("rejects a nested secret-looking key", () => {
    const result = resolve({
      stageModels: { implement: { model: "worker-a", apiToken: "abc" } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("secrets must never be stored");
  });
});

describe("resolveJevApiKey", () => {
  it("reports the environment variable as the key source", () => {
    const result = resolveJevApiKey({ env: { JFLOW_JEV_API_KEY: "sk-test" } });

    expect(result).toEqual({
      status: "configured",
      source: "environment",
      key: "sk-test",
    });
  });

  it("reads the user's key file when the environment variable is absent", () => {
    const result = resolveJevApiKey({ env: {}, readKeyFile: () => "sk-file\n" });

    expect(result).toEqual({ status: "configured", source: "key-file", key: "sk-file" });
  });

  it("prefers the environment variable over the key file", () => {
    const result = resolveJevApiKey({
      env: { JFLOW_JEV_API_KEY: "sk-env" },
      readKeyFile: () => "sk-file",
    });

    expect(result).toMatchObject({ source: "environment", key: "sk-env" });
  });

  it("falls back to host secret storage when the environment variable is absent", () => {
    const result = resolveJevApiKey({
      env: {},
      readHostSecret: () => "sk-host",
    });

    expect(result).toEqual({
      status: "configured",
      source: "host-secret-storage",
      key: "sk-host",
    });
  });

  it("asks the human rather than continuing without Jev when no key is configured", () => {
    const result = resolveJevApiKey({ env: {} });

    expect(result.status).toBe("missing");
    if (result.status !== "missing") return;
    expect(result.askHuman).toContain("JFLOW_JEV_API_KEY");
    expect(result.askHuman).toContain("jflow/jev-key");
    expect(result.mayProceedWithoutJev).toBe(false);
  });

  it("treats a blank environment value as missing", () => {
    const result = resolveJevApiKey({ env: { JFLOW_JEV_API_KEY: "   " } });

    expect(result.status).toBe("missing");
  });
});

describe("jevKeyFilePath", () => {
  it("lives in the user's config directory, outside any project", () => {
    expect(jevKeyFilePath({}, "/home/dev")).toBe("/home/dev/.config/jflow/jev-key");
  });

  it("follows XDG_CONFIG_HOME when it is set", () => {
    expect(jevKeyFilePath({ XDG_CONFIG_HOME: "/cfg" }, "/home/dev")).toBe("/cfg/jflow/jev-key");
  });
});
