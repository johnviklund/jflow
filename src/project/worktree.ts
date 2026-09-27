import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { PROJECT_RECORD_DIRECTORY, type TreeEntry } from "./records.js";

/**
 * The helper's only access to Git (issues #7, #10, SPEC.md confirmed
 * default 1). Every Git command jflow runs goes through this module.
 * `readOnlyGit` admits read-only subcommands and nothing else. The one
 * write is `commitPaths`, the ticket's local commit (D34): it stages and
 * commits the paths it is given and builds its own arguments, so no code
 * path can initialize a repository, discard a change, absorb work it was
 * not given, or push, publish or merge.
 */

const READ_ONLY_SUBCOMMANDS = ["status", "rev-parse", "log"] as const;

/** The only writes: making a ticket's local commit. Never push, merge or anything that discards. */
const COMMIT_SUBCOMMANDS = ["add", "commit"] as const;

export function readOnlyGit(root: string, args: readonly string[]): string {
  const [subcommand] = args;
  if (subcommand === undefined || !(READ_ONLY_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new Error(
      `jflow runs read-only Git commands only (${READ_ONLY_SUBCOMMANDS.join(", ")}); refused "git ${args.join(" ")}"`,
    );
  }
  return git(root, args);
}

function git(root: string, args: readonly string[]): string {
  const [subcommand] = args;
  if (!([...READ_ONLY_SUBCOMMANDS, ...COMMIT_SUBCOMMANDS] as readonly string[]).includes(subcommand ?? "")) {
    throw new Error(`jflow never runs "git ${args.join(" ")}"`);
  }
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // `git status` otherwise refreshes the index as a side effect.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

export type WorkingTree =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      /**
       * Paths with uncommitted changes (staged, unstaged or untracked),
       * relative to the project root and sorted. jflow's own record directory
       * is left out; changes outside the project directory are not its to own.
       */
      readonly changedPaths: readonly string[];
    }
  | {
      /** There is a `.git` here but Git cannot read it; never treated as clean. */
      readonly kind: "unreadable";
      readonly message: string;
    };

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim();
    return error.message;
  }
  return String(error);
}

/** Paths from `git status --porcelain=v1 -z`, relative to the repository top level. */
function parsePorcelain(output: string): string[] {
  const paths: string[] = [];
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    paths.push(field.slice(3));
    // A rename or copy is followed by its source path in the next field.
    if (status.includes("R") || status.includes("C")) {
      const source = fields[index + 1];
      if (source !== undefined && source !== "") paths.push(source);
      index += 1;
    }
  }
  return paths;
}

function isInside(path: string): boolean {
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

/** Changed paths under the project, relative to it and in portable form. */
function changedPaths(root: string, topLevel: string, output: string): string[] {
  const project = realpathSync(root);
  const changed = new Set<string>();
  for (const path of parsePorcelain(output)) {
    const local = relative(project, join(topLevel, path));
    if (!isInside(local)) continue;
    changed.add(local.split(sep).join("/"));
  }
  return [...changed].sort();
}

const statusOf = (root: string, pathspec: string) =>
  readOnlyGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", pathspec]);

/**
 * The changed project records under `jflow/`, which `readWorkingTree`
 * leaves out; a ticket's commit carries them with its changes (D34).
 */
export function readChangedRecords(root: string): string[] {
  const topLevel = readOnlyGit(root, ["rev-parse", "--show-toplevel"]).trim();
  return changedPaths(root, topLevel, statusOf(root, PROJECT_RECORD_DIRECTORY));
}

/**
 * Commits exactly `paths` (relative to `root`) as one local commit and
 * returns its hash. `--only` takes each path from the working tree and
 * leaves every other path, staged or not, as it was. Never pushes, publishes
 * or merges.
 */
export function commitPaths(root: string, paths: readonly string[], message: string): string {
  if (paths.length === 0) throw new Error("there is nothing to commit");
  try {
    // Intent to add makes new files known to Git without staging their content: a
    // refused commit leaves only empty entries for them. --only commits the working tree.
    git(root, ["add", "--intent-to-add", "--", ...paths]);
    git(root, ["commit", "--quiet", "--only", "--message", message, "--", ...paths]);
  } catch (error) {
    throw new Error(errorText(error));
  }
  return readOnlyGit(root, ["rev-parse", "HEAD"]).trim();
}

/**
 * Reads the working tree at `root` without changing it. A directory Git does
 * not recognize is `absent`; a `.git` Git cannot read is `unreadable`.
 */
export function readWorkingTree(root: string): WorkingTree {
  let topLevel: string;
  try {
    topLevel = readOnlyGit(root, ["rev-parse", "--show-toplevel"]).trim();
  } catch (error) {
    if (existsSync(join(root, ".git"))) return { kind: "unreadable", message: errorText(error) };
    return { kind: "absent" };
  }

  let output: string;
  try {
    output = statusOf(root, ".");
  } catch (error) {
    return { kind: "unreadable", message: errorText(error) };
  }

  const records = `${PROJECT_RECORD_DIRECTORY}/`;
  return {
    kind: "present",
    changedPaths: changedPaths(root, topLevel, output).filter((path) => !path.startsWith(records)),
  };
}

/** The trailer naming the ticket a jflow commit completed (issue #10). */
export const TICKET_TRAILER = "Jflow-Ticket";
/** The trailer on the commit of a plan's records once its integrated review passed (#33). */
export const PLAN_TRAILER = "Jflow-Plan";

/**
 * Whether a commit carries `ticketId` in its ticket trailer, read-only. The
 * tickets record cannot hold the commit's own hash, since the commit
 * includes the records, so this is how a done ticket's commit is found.
 * Ticket ids are unique within a plan; one reused across plans would match
 * the earlier plan's commit.
 */
export function ticketCommitExists(root: string, ticketId: string): boolean {
  try {
    const trailers = readOnlyGit(root, ["log", `--format=%(trailers:key=${TICKET_TRAILER},valueonly)`]);
    return trailers.split("\n").some((line) => line.trim() === ticketId);
  } catch {
    return false;
  }
}

/** Whether the repository has `commit`, read-only (`rev-parse --verify`). */
export function commitExists(root: string, commit: string): boolean {
  try {
    readOnlyGit(root, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export type TreeSnapshot =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly message: string }
  | {
      readonly kind: "present";
      /** The checked-out commit; absent before the first commit. */
      readonly head?: string;
      readonly files: readonly TreeEntry[];
    };

/**
 * The working tree as it stands, precisely enough that any edit shows as a
 * difference (issue #11): the commit checked out and a hash of each changed
 * path's content. An unchanged path matches HEAD, so HEAD covers it. The
 * records under `jflow/` are left out, as they are the helper's to write.
 */
export function snapshotWorkingTree(root: string): TreeSnapshot {
  const tree = readWorkingTree(root);
  if (tree.kind !== "present") return tree;
  let head: string | undefined;
  try {
    head = readOnlyGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).trim();
  } catch {
    head = undefined;
  }
  const files = tree.changedPaths.map((path): TreeEntry => {
    const full = join(root, path);
    if (!existsSync(full)) return { path };
    return { path, sha256: createHash("sha256").update(readFileSync(full)).digest("hex") };
  });
  return head === undefined || head === "" ? { kind: "present", files } : { kind: "present", head, files };
}
