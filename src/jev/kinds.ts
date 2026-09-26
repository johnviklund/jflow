/**
 * Where a decision was asked, read back from its packet (D44, D50): the
 * boundary kind leads an `escalate` packet's task summary and the content
 * kind leads a `classify` one, so an envelope alone says which kind of place
 * it came from. Every other decision is asked in one kind of place, `all`.
 *
 * Kinds are what a question-file proposal splits a decision by (issue #30):
 * replay breaks its report down by them and a per-kind threshold routes by
 * them.
 */

const KIND_PREFIXES: Readonly<Record<string, RegExp>> = {
  escalate: /^Boundary: ([a-z-]+)\./,
  classify: /^Content: ([a-z-]+)\./,
};

/** The kind a packet was asked in: `unknown` when a split decision's packet does not name one. */
export function kindOfPacket(decision: string, taskSummary: string): string {
  const prefix = KIND_PREFIXES[decision];
  if (prefix === undefined) return "all";
  return prefix.exec(taskSummary)?.[1] ?? "unknown";
}
