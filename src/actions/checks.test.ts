import { describe, expect, it } from "vitest";

import { processCheckRunner, runTicketChecks, type CheckOptions, type CheckRunner } from "./checks.js";

/** A runner answering from a table of command → [output, exit code]. */
function scripted(table: Record<string, readonly [string, number]>): CheckRunner & { readonly ran: string[] } {
  const ran: string[] = [];
  const runner: CheckRunner = (command) => {
    ran.push(command);
    const [output, exitCode] = table[command] ?? ["command not scripted", 127];
    return { output, exitCode, timedOut: false };
  };
  return Object.assign(runner, { ran });
}

const options = (runner: CheckRunner, extra: Partial<CheckOptions> = {}) => ({
  runner,
  cwd: "/project",
  timeoutMs: 1000,
  maxChars: 10_000,
  knownSecrets: [],
  ...extra,
});

describe("runTicketChecks", () => {
  it("runs every check and records its output and exit code as check evidence, keeping the agent's claim", () => {
    const runner = scripted({ "npm test": ["✔ parses dates\n1 passed", 0], "npm run lint": ["2 problems", 1] });

    const result = runTicketChecks(
      { ticketId: "T1", evidence: [{ kind: "claim", source: "implementer", text: "added the parser" }], checks: ["npm test", "npm run lint"] },
      options(runner),
    );

    expect(result).toEqual({
      ok: true,
      input: {
        ticketId: "T1",
        evidence: [
          { kind: "check", source: "npm test", text: "✔ parses dates\n1 passed", exitCode: 0 },
          { kind: "check", source: "npm run lint", text: "2 problems", exitCode: 1 },
          { kind: "claim", source: "implementer", text: "added the parser" },
        ],
        checks: ["npm test", "npm run lint"],
      },
    });
    expect(runner.ran).toEqual(["npm test", "npm run lint"]);
  });

  it("refuses check output the agent wrote itself, and runs nothing", () => {
    const runner = scripted({});

    const result = runTicketChecks(
      { ticketId: "T1", evidence: [{ kind: "check", source: "npm test", text: "41 tests passed", exitCode: 0 }], checks: ["npm test"] },
      options(runner),
    );

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("jflow runs the checks itself") });
    expect(runner.ran).toEqual([]);
  });

  it("refuses a draft without checks to run", () => {
    const result = runTicketChecks({ ticketId: "T1", evidence: [], checks: [] }, options(scripted({})));

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("checks") });
  });

  it("records a check that runs out of time as failed, saying so", () => {
    const runner: CheckRunner = () => ({ output: "started", exitCode: null, timedOut: true });

    const result = runTicketChecks({ ticketId: "T1", evidence: [], checks: ["npm test"] }, options(runner, { timeoutMs: 5000 }));

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.input.evidence[0]).toMatchObject({ exitCode: 124, text: expect.stringContaining("stopped after 5000 ms") });
  });

  it("redacts credentials and the known key from the output", () => {
    const runner = scripted({ "npm test": ["token = abcdefghijklmnopqrstuv\nkey jev-secret-value-123\nok", 0] });

    const result = runTicketChecks(
      { ticketId: "T1", evidence: [], checks: ["npm test"] },
      options(runner, { knownSecrets: ["jev-secret-value-123"] }),
    );

    expect(result).toMatchObject({ ok: true });
    const text = result.ok ? result.input.evidence[0]?.text : "";
    expect(text).not.toContain("abcdefghijklmnopqrstuv");
    expect(text).not.toContain("jev-secret-value-123");
    expect(text).toContain("ok");
  });

  it("cuts long output in the middle, keeping its start and end", () => {
    const long = `FIRST LINE\n${"x".repeat(5000)}\nLAST LINE`;
    const runner = scripted({ "npm test": [long, 0] });

    const result = runTicketChecks({ ticketId: "T1", evidence: [], checks: ["npm test"] }, options(runner, { maxChars: 1000 }));

    const text = result.ok ? (result.input.evidence[0]?.text ?? "") : "";
    expect(text.startsWith("FIRST LINE")).toBe(true);
    expect(text.endsWith("LAST LINE")).toBe(true);
    expect(text).toContain("cut from the middle by jflow");
    expect(text.length).toBeLessThanOrEqual(1000);
  });
});

describe("processCheckRunner", () => {
  it("runs the command in a shell, merging stderr into the output, and reports its exit code", () => {
    const run = processCheckRunner({ PATH: process.env["PATH"] });

    const result = run("echo out; echo err >&2; exit 3", { cwd: process.cwd(), timeoutMs: 10_000 });

    expect(result).toEqual({ output: "out\nerr\n", exitCode: 3, timedOut: false });
  });

  it("never passes the Jev key to the check", () => {
    const run = processCheckRunner({ PATH: process.env["PATH"], JFLOW_JEV_API_KEY: "jev-secret" });

    const result = run('echo "key=${JFLOW_JEV_API_KEY:-unset}"', { cwd: process.cwd(), timeoutMs: 10_000 });

    expect(result.output).toBe("key=unset\n");
  });

  it("stops a check at its time limit", () => {
    const run = processCheckRunner({ PATH: process.env["PATH"] });

    const result = run("sleep 5", { cwd: process.cwd(), timeoutMs: 200 });

    expect(result).toMatchObject({ exitCode: null, timedOut: true });
  });
});
