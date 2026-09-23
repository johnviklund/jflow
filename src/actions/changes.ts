import {
  EMPTY_PROGRESS,
  readRecord,
  validateRecord,
  writeRecord,
  type ChangeOwner,
  type ChangeOwnership,
  type ProgressRecord,
} from "../project/records.js";
import { readProjectState } from "../project/state.js";
import { refuse, unreadable, unreadableState, type Refusal } from "./refusal.js";

/**
 * Records who owns uncommitted changes that were already in the working
 * tree (issue #7, SPEC.md confirmed default 1). jflow asks and the developer
 * answers; this writes the answer, in their words, and nothing else. It never
 * stages, commits, stashes or discards a change: a change the developer
 * wants out of the way is theirs to commit or set aside.
 */

export interface ChangeClaim {
  readonly owner: ChangeOwner;
  /** The changes the answer covers; omitted means every unclaimed change. */
  readonly paths?: readonly string[];
  /** What the developer said, recorded as said. */
  readonly note: string;
}

export interface ClaimOutcome {
  readonly claimed: readonly ChangeOwnership[];
  readonly progress: ProgressRecord;
  /** Changes still without an owner after this claim. */
  readonly unclaimedChanges: readonly string[];
}

export type ClaimResult = { readonly ok: true; readonly outcome: ClaimOutcome } | Refusal;

export function claimChanges(root: string, claim: ChangeClaim): ClaimResult {
  if (claim.note.trim() === "") {
    return refuse("an owner is recorded in the developer's words; pass what they said");
  }

  const read = readProjectState(root);
  if (read.kind === "malformed") return unreadableState(read);
  const { state } = read;
  if (!state.gitRepositoryPresent) {
    return refuse(
      state.gitRepositoryUnreadable === undefined
        ? "there is no Git repository here, so there are no uncommitted changes to claim"
        : `the Git repository here cannot be read (${state.gitRepositoryUnreadable})`,
    );
  }
  if (state.unclaimedChanges.length === 0) {
    return refuse("there are no uncommitted changes without an owner");
  }

  const paths = [...new Set(claim.paths ?? state.unclaimedChanges)];
  const unknown = paths.filter((path) => !state.unclaimedChanges.includes(path));
  if (unknown.length > 0) {
    return refuse(
      `not an uncommitted change without an owner: ${unknown.join(", ")}; unclaimed changes are ${state.unclaimedChanges.join(", ")}`,
    );
  }

  const existing = readRecord(root, "progress");
  if (existing.kind === "malformed") return unreadable("progress", existing);
  const current = existing.kind === "present" ? existing.record : EMPTY_PROGRESS;

  let claimed: ChangeOwnership[];
  if (claim.owner === "ticket") {
    const ticketId = current.assignedTicketId;
    if (ticketId === undefined) {
      return refuse("no ticket is assigned to adopt these changes; assign one or record them as the developer's");
    }
    claimed = paths.map((path) => ({ path, owner: "ticket", ticketId, note: claim.note }));
  } else {
    claimed = paths.map((path) => ({ path, owner: "developer", note: claim.note }));
  }

  const progress = validateRecord("progress", {
    ...current,
    // A path can hold a stale claim from a ticket no longer assigned; the new answer replaces it.
    changeOwnership: [
      ...(current.changeOwnership ?? []).filter((entry) => !paths.includes(entry.path)),
      ...claimed,
    ],
  });
  if (!progress.ok) return refuse("the progress record cannot be updated", progress.issues);

  writeRecord(root, "progress", progress.record);
  return {
    ok: true,
    outcome: {
      claimed,
      progress: progress.record,
      unclaimedChanges: state.unclaimedChanges.filter((path) => !paths.includes(path)),
    },
  };
}
