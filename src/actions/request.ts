import type { WorkflowPackage } from "../workflow/types.js";

/**
 * Resolves what the developer asked for to exactly one workflow action, or
 * to a question when the request fits more than one (issue #4). Naming an
 * action and describing it conversationally reach the same contract; an
 * ambiguous request is never guessed at.
 */

export type RequestResolution =
  | { readonly kind: "action"; readonly action: string; readonly matchedBy: "name" | "phrase" }
  | {
      readonly kind: "ambiguous";
      readonly candidates: readonly string[];
      /** The clarifying question to put to the developer. */
      readonly question: string;
    }
  | { readonly kind: "unknown"; readonly message: string };

/**
 * Conversational cues per action, for a request that does not start with an
 * action name. Matching any cue scores more than a bare mention of the
 * action's name, because names such as "plan" and "review" are ordinary
 * nouns in a request about something else ("where are we with the plan?").
 * Kept in the helper rather than the package (the package declares what an
 * action is, not how a developer might ask for it) so that "ask, never
 * guess" is a tested rule rather than an instruction.
 */
const CONVERSATIONAL_CUES: Readonly<Record<string, readonly string[]>> = {
  brainstorm: ["what to build", "figure out", "explore", "investigate", "define the spec", "specification"],
  plan: ["into tickets", "break down", "breakdown", "ticket breakdown", "plan the work"],
  implement: ["carry out", "build ticket", "work on ticket", "do ticket", "start ticket", "code it"],
  troubleshoot: ["failing", "why is", "why does", "broken", "diagnose", "not working", "error"],
  review: ["review my changes", "my changes", "look over", "assess", "check the diff"],
  wrap: ["wrap up", "end the session", "finish for today", "for today", "stop here", "leave a note"],
  realign: ["changed my mind", "change the plan", "new direction", "rescope", "re-scope", "change of scope"],
  status: ["where are we", "how far", "current state", "progress", "what's done", "what is done"],
  next: ["what should i do", "what now", "what's next", "what is next", "next step"],
  todo: ["remember for later", "for later", "add a todo", "note for later", "future work"],
  learn: ["lesson", "learned", "learnt", "remember that", "record that"],
};

/** The actions the cue table covers; every one must exist in the package. */
export const CUED_ACTIONS: readonly string[] = Object.keys(CONVERSATIONAL_CUES);

const NAME_SCORE = 1;
const CUE_SCORE = 2;

/** Words that may precede an action name without changing the request. */
const INVOCATION_PREFIXES = ["jflow", "run", "please"];

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(haystack: string, phrase: string): boolean {
  return ` ${haystack} `.includes(` ${phrase} `);
}

function stripInvocationPrefixes(words: readonly string[]): readonly string[] {
  let rest = words;
  while (rest.length > 1 && INVOCATION_PREFIXES.includes(rest[0]!)) rest = rest.slice(1);
  return rest;
}

export function resolveRequest(text: string, workflowPackage: WorkflowPackage): RequestResolution {
  const actionNames = workflowPackage.actions.map((action) => action.name);
  const unknown = (): RequestResolution => ({
    kind: "unknown",
    message: `no jflow action matches the request; the actions are ${actionNames.join(", ")}`,
  });

  const normalised = normalise(text.replace(/^\s*\//, ""));
  if (normalised === "") return unknown();

  // A request that starts with an action name is that action, whatever
  // follows ("implement the progress bar"); naming an action runs it.
  const words = stripInvocationPrefixes(normalised.split(" "));
  const leading = words[0]!;
  if (actionNames.includes(leading)) {
    return { kind: "action", action: leading, matchedBy: "name" };
  }

  const scores = actionNames.map((name) => {
    const cues = CONVERSATIONAL_CUES[name] ?? [];
    const cueMatched = cues.some((cue) => containsPhrase(normalised, normalise(cue)));
    const score =
      (containsPhrase(normalised, name) ? NAME_SCORE : 0) + (cueMatched ? CUE_SCORE : 0);
    return { name, score };
  });

  const best = Math.max(...scores.map((entry) => entry.score));
  if (best === 0) return unknown();

  const candidates = scores.filter((entry) => entry.score === best).map((entry) => entry.name);
  if (candidates.length === 1) {
    return { kind: "action", action: candidates[0]!, matchedBy: "phrase" };
  }
  return {
    kind: "ambiguous",
    candidates,
    question: `Which action did you mean: ${candidates.join(" or ")}?`,
  };
}
