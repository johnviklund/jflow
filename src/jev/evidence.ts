import type { ResolvedConfiguration } from "../config/configuration.js";
import { SECRET_VALUE_PATTERN } from "../secrets.js";

/**
 * The bounded, decision-specific evidence packet sent to Jev (issue #16,
 * D22). Only what one decision needs goes out: a task summary, the
 * candidates, and selected excerpts. Credentials are always redacted; full
 * conversation or repository content is left out while the project's
 * sharing limits exclude it (the default); and the task summary,
 * candidates and excerpt text together never exceed the configured size.
 * Everything withheld is listed in `omitted`, so the trace shows what Jev
 * did not see.
 */

/** How much of the source an excerpt carries; only `excerpt` is always shareable. */
export type ExcerptScope = "excerpt" | "full-conversation" | "full-repository";

export interface EvidenceExcerpt {
  /** Where the text came from: a file and line range, a command, a record. */
  readonly source: string;
  readonly text: string;
  /** Defaults to `excerpt`. */
  readonly scope?: ExcerptScope;
}

export interface EvidenceInput {
  readonly decision: string;
  readonly taskSummary: string;
  readonly candidates: readonly string[];
  readonly excerpts: readonly EvidenceExcerpt[];
}

export interface Omission {
  readonly source: string;
  readonly reason: string;
}

export interface EvidencePacket {
  readonly decision: string;
  readonly taskSummary: string;
  readonly candidates: readonly string[];
  readonly excerpts: readonly { readonly source: string; readonly text: string }[];
  readonly omitted: readonly Omission[];
}

export interface SharingLimits {
  readonly excludeFullConversation: boolean;
  readonly excludeFullRepository: boolean;
  /** Upper bound on the summary, candidates and excerpt text together. */
  readonly maxPacketChars: number;
}

/** The limits as the project configured them; credential exclusion is locked on and not a limit. */
export function sharingLimitsFrom(configuration: ResolvedConfiguration): SharingLimits {
  const { settings } = configuration;
  const maxPacketChars = settings["evidenceSharing.maxPacketChars"];
  if (typeof maxPacketChars !== "number") {
    throw new Error("evidenceSharing.maxPacketChars is missing from the resolved configuration");
  }
  return {
    excludeFullConversation: settings["evidenceSharing.excludeFullConversation"] !== false,
    excludeFullRepository: settings["evidenceSharing.excludeFullRepository"] !== false,
    maxPacketChars,
  };
}

const REDACTED = "[credential redacted]";
const SECRET_VALUES = new RegExp(SECRET_VALUE_PATTERN.source, "gi");

/** Replaces credentials, keeping any whitespace the pattern consumed after one. */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let result = text.replace(SECRET_VALUES, (match) => REDACTED + (/\s$/.exec(match)?.[0] ?? ""));
  for (const secret of knownSecrets) {
    if (secret !== "") result = result.split(secret).join(REDACTED);
  }
  return result;
}

type ExclusionLimit = "excludeFullConversation" | "excludeFullRepository";

const EXCLUSIONS: Readonly<Record<Exclude<ExcerptScope, "excerpt">, readonly [ExclusionLimit, string]>> = {
  "full-conversation": [
    "excludeFullConversation",
    "full conversation excluded by evidenceSharing.excludeFullConversation",
  ],
  "full-repository": [
    "excludeFullRepository",
    "full repository excluded by evidenceSharing.excludeFullRepository",
  ],
};

/** The first `length` UTF-16 units, backing off rather than splitting a surrogate pair. */
function cut(text: string, length: number): string {
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

export function buildEvidencePacket(
  input: EvidenceInput,
  limits: SharingLimits,
  options: { readonly knownSecrets?: readonly string[] } = {},
): EvidencePacket {
  const secrets = options.knownSecrets ?? [];
  const omitted: Omission[] = [];
  const clean = (source: string, text: string): string => {
    const redacted = redact(text, secrets);
    if (redacted !== text) omitted.push({ source, reason: "credential redacted" });
    return redacted;
  };

  const candidates = input.candidates.map((candidate, index) => clean(`candidates[${index}]`, candidate));
  // Candidates go whole, since they are the answers to choose from; the
  // summary is cut to what is left, then excerpts share the rest.
  let budget = limits.maxPacketChars - candidates.join("").length;
  let taskSummary = clean("taskSummary", input.taskSummary);
  if (taskSummary.length > budget) {
    taskSummary = cut(taskSummary, Math.max(0, budget));
    omitted.push({ source: "taskSummary", reason: "truncated to the packet size limit" });
  }
  budget -= taskSummary.length;

  const excerpts: { source: string; text: string }[] = [];
  for (const excerpt of input.excerpts) {
    const source = redact(excerpt.source, secrets);
    const scope = excerpt.scope ?? "excerpt";
    if (scope !== "excerpt") {
      const [limit, reason] = EXCLUSIONS[scope];
      if (limits[limit]) {
        omitted.push({ source, reason });
        continue;
      }
    }
    const text = clean(source, excerpt.text);
    if (budget <= 0) {
      omitted.push({ source, reason: "dropped: packet size limit reached" });
      continue;
    }
    if (text.length > budget) {
      excerpts.push({ source, text: cut(text, budget) });
      omitted.push({ source, reason: "truncated to the packet size limit" });
      budget = 0;
      continue;
    }
    excerpts.push({ source, text });
    budget -= text.length;
  }

  return { decision: input.decision, taskSummary, candidates, excerpts, omitted };
}
