import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { JEV_API_KEY_ENV_VAR } from "../secrets.js";
import { HOST_CAPABILITIES, checkHostCapabilities } from "./capabilities.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jflow-host-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const shellWorks = () => "git version 2.0.0";
const shellFails = () => {
  throw new Error("spawn git ENOENT");
};

describe("checkHostCapabilities", () => {
  it("reports every capability with a verified or unverified label and evidence", () => {
    const report = checkHostCapabilities(makeRoot(), { env: {}, exec: shellWorks });

    expect(report.results.map((r) => r.capability).sort()).toEqual([...HOST_CAPABILITIES].sort());
    for (const result of report.results) {
      expect(["verified", "unverified"]).toContain(result.status);
      expect(result.evidence.length).toBeGreaterThan(0);
    }
  });

  it("verifies project file access by writing, reading back and removing a probe file", () => {
    const root = makeRoot();

    const report = checkHostCapabilities(root, { env: {}, exec: shellWorks });

    expect(report.results.find((r) => r.capability === "project-files")?.status).toBe("verified");
    expect(readdirSync(root)).toEqual([]);
  });

  it("leaves project file access unverified when the directory cannot be written", () => {
    const report = checkHostCapabilities("/nonexistent/jflow-root", { env: {}, exec: shellWorks });

    const result = report.results.find((r) => r.capability === "project-files");
    expect(result?.status).toBe("unverified");
    expect(result?.evidence).toContain("ENOENT");
  });

  it("verifies shell execution only when a command actually ran", () => {
    const root = makeRoot();

    const ok = checkHostCapabilities(root, { env: {}, exec: shellWorks });
    const failed = checkHostCapabilities(root, { env: {}, exec: shellFails });

    expect(ok.results.find((r) => r.capability === "shell")?.status).toBe("verified");
    expect(failed.results.find((r) => r.capability === "shell")?.status).toBe("unverified");
    expect(failed.results.find((r) => r.capability === "shell")?.evidence).toContain("ENOENT");
  });

  it("verifies the environment secret only when it is set, and never records its value", () => {
    const root = makeRoot();

    const unset = checkHostCapabilities(root, { env: {}, exec: shellWorks });
    const set = checkHostCapabilities(root, {
      env: { [JEV_API_KEY_ENV_VAR]: "sk-test-1234567890abcdef" },
      exec: shellWorks,
    });

    expect(unset.results.find((r) => r.capability === "secret-environment")?.status).toBe(
      "unverified",
    );
    const verified = set.results.find((r) => r.capability === "secret-environment");
    expect(verified?.status).toBe("verified");
    expect(JSON.stringify(set)).not.toContain("1234567890abcdef");
  });

  it("verifies host secret storage only through an injected reader that returns a value", () => {
    const root = makeRoot();

    const none = checkHostCapabilities(root, { env: {}, exec: shellWorks });
    const some = checkHostCapabilities(root, {
      env: {},
      exec: shellWorks,
      readHostSecret: () => "from-keychain-abcdef",
    });

    expect(none.results.find((r) => r.capability === "secret-host-storage")?.status).toBe(
      "unverified",
    );
    expect(some.results.find((r) => r.capability === "secret-host-storage")?.status).toBe(
      "verified",
    );
    expect(JSON.stringify(some)).not.toContain("from-keychain");
  });

  it("never claims agent isolation or model pinning from the helper", () => {
    const report = checkHostCapabilities(makeRoot(), { env: {}, exec: shellWorks });

    for (const capability of ["distinct-agent-context", "pinned-worker-model"]) {
      const result = report.results.find((r) => r.capability === capability);
      expect(result?.status).toBe("unverified");
      expect(result?.evidence).toContain("#24");
    }
  });
});
