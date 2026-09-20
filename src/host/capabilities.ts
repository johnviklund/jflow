import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { JEV_API_KEY_ENV_VAR } from "../secrets.js";

/**
 * Host capability checks, verified by execution rather than assumed from
 * documentation (SPEC.md D11, D13; issue #4, #24). Each capability the
 * workflow depends on is probed where the helper can probe it, and labelled
 * `unverified` with the reason where it cannot. Nothing is claimed as
 * supported on the strength of a document.
 */

export const HOST_CAPABILITIES = [
  "project-files",
  "shell",
  "secret-environment",
  "secret-host-storage",
  "distinct-agent-context",
  "pinned-worker-model",
] as const;

export type HostCapability = (typeof HOST_CAPABILITIES)[number];

export interface HostCapabilityResult {
  readonly capability: HostCapability;
  readonly status: "verified" | "unverified";
  /** What was attempted and what happened; never a secret's value. */
  readonly evidence: string;
}

export interface HostCapabilityReport {
  readonly checkedAt: string;
  readonly results: readonly HostCapabilityResult[];
}

export interface HostProbeOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Runs a command and returns its stdout; throws when it cannot run. */
  readonly exec: (command: string, args: readonly string[]) => string;
  /** The host's own secret storage, when an integration provides one (#16). */
  readonly readHostSecret?: () => string | undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function probeProjectFiles(root: string): HostCapabilityResult {
  const probe = join(root, `.jflow-host-check-${process.pid}`);
  const payload = `jflow host check ${Date.now()}\n`;
  try {
    writeFileSync(probe, payload);
    const read = readFileSync(probe, "utf8");
    rmSync(probe);
    if (read !== payload) {
      return {
        capability: "project-files",
        status: "unverified",
        evidence: `wrote ${probe} but read back different content`,
      };
    }
    return {
      capability: "project-files",
      status: "verified",
      evidence: `wrote, read back and removed ${probe}`,
    };
  } catch (error) {
    rmSync(probe, { force: true });
    return {
      capability: "project-files",
      status: "unverified",
      evidence: `could not write and read a probe file under ${root}: ${errorText(error)}`,
    };
  }
}

function probeShell(exec: HostProbeOptions["exec"]): HostCapabilityResult {
  try {
    const output = exec("git", ["--version"]).trim();
    return { capability: "shell", status: "verified", evidence: `ran git --version: ${output}` };
  } catch (error) {
    return {
      capability: "shell",
      status: "unverified",
      evidence: `could not run git --version: ${errorText(error)}`,
    };
  }
}

function probeEnvironmentSecret(env: HostProbeOptions["env"]): HostCapabilityResult {
  const value = env[JEV_API_KEY_ENV_VAR];
  return typeof value === "string" && value.trim() !== ""
    ? {
        capability: "secret-environment",
        status: "verified",
        evidence: `${JEV_API_KEY_ENV_VAR} is set in the environment (value not recorded)`,
      }
    : {
        capability: "secret-environment",
        status: "unverified",
        evidence: `${JEV_API_KEY_ENV_VAR} is not set in this environment`,
      };
}

function probeHostSecret(read: HostProbeOptions["readHostSecret"]): HostCapabilityResult {
  if (!read) {
    return {
      capability: "secret-host-storage",
      status: "unverified",
      evidence:
        "no host secret storage integration is available to the helper; #24 probe (b), #16",
    };
  }
  try {
    const value = read();
    return typeof value === "string" && value.trim() !== ""
      ? {
          capability: "secret-host-storage",
          status: "verified",
          evidence: "host secret storage returned a value (not recorded)",
        }
      : {
          capability: "secret-host-storage",
          status: "unverified",
          evidence: "host secret storage returned nothing",
        };
  } catch (error) {
    return {
      capability: "secret-host-storage",
      status: "unverified",
      evidence: `host secret storage failed: ${errorText(error)}`,
    };
  }
}

/** Affordances only the host can demonstrate; the helper cannot probe them. */
const HOST_ONLY: readonly HostCapabilityResult[] = [
  {
    capability: "distinct-agent-context",
    status: "unverified",
    evidence:
      "cannot be probed from the helper; verified by running a worker on the host and confirming its context is separate (#24 probe a1)",
  },
  {
    capability: "pinned-worker-model",
    status: "unverified",
    evidence:
      "cannot be probed from the helper; verified by pinning a worker's model on the host and confirming which model ran (#24 probe a2)",
  },
];

export function checkHostCapabilities(root: string, options: HostProbeOptions): HostCapabilityReport {
  return {
    checkedAt: new Date().toISOString(),
    results: [
      probeProjectFiles(root),
      probeShell(options.exec),
      probeEnvironmentSecret(options.env),
      probeHostSecret(options.readHostSecret),
      ...HOST_ONLY,
    ],
  };
}

/** The real probe options for the process the helper runs in. */
export function processProbeOptions(): HostProbeOptions {
  return {
    env: process.env,
    exec: (command, args) => execFileSync(command, [...args], { encoding: "utf8" }),
  };
}
