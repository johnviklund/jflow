import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { PROJECT_RECORD_DIRECTORY } from "./records.js";

/**
 * The helper's only access to Git (issue #7, SPEC.md confirmed default 1).
 * Every Git command jflow runs goes through `readOnlyGit`, which admits read-only
 * subcommands and nothing else, so no code path can initialize a
 * repository, discard a change, or stage or commit pre-existing work. The
 * local commit (D34) widens this list deliberately, in the issue that owns it.
 */

const READ_ONLY_SUBCOMMANDS = ["status", "rev-parse"] as const;

export function readOnlyGit(root: string, args: readonly string[]): string {
  const [subcommand] = args;
  if (subcommand === undefined || !(READ_ONLY_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new Error(
      `jflow runs read-only Git commands only (${READ_ONLY_SUBCOMMANDS.join(", ")}); refused "git ${args.join(" ")}"`,
    );
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
    output = readOnlyGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  } catch (error) {
    return { kind: "unreadable", message: errorText(error) };
  }

  const project = realpathSync(root);
  const records = `${PROJECT_RECORD_DIRECTORY}/`;
  const changedPaths = new Set<string>();
  for (const path of parsePorcelain(output)) {
    const local = relative(project, join(topLevel, path));
    if (!isInside(local)) continue;
    const portable = local.split(sep).join("/");
    if (portable.startsWith(records)) continue;
    changedPaths.add(portable);
  }
  return { kind: "present", changedPaths: [...changedPaths].sort() };
}
