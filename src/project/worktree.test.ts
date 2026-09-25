import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { commitPaths, readChangedRecords, readOnlyGit, readWorkingTree, snapshotWorkingTree } from "./worktree.js";

const roots: string[] = [];

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "jflow-worktree-"));
  roots.push(root);
  return root;
}

/** The test sets up the repository; jflow itself never initializes one. */
function repository(): string {
  const root = directory();
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  run("init", "--quiet");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  writeFileSync(join(root, "tracked.txt"), "one\n");
  run("add", ".");
  run("commit", "--quiet", "-m", "initial");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readWorkingTree", () => {
  it("reports no repository for a plain directory", () => {
    expect(readWorkingTree(directory())).toEqual({ kind: "absent" });
  });

  it("reports a clean repository with no changed paths", () => {
    expect(readWorkingTree(repository())).toEqual({ kind: "present", changedPaths: [] });
  });

  it("lists modified, staged, untracked and deleted paths relative to the project root", () => {
    const root = repository();
    writeFileSync(join(root, "tracked.txt"), "two\n");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "new file.ts"), "x\n");
    writeFileSync(join(root, "staged.txt"), "s\n");
    execFileSync("git", ["add", "staged.txt"], { cwd: root });

    expect(readWorkingTree(root)).toEqual({
      kind: "present",
      changedPaths: ["src/new file.ts", "staged.txt", "tracked.txt"],
    });

    rmSync(join(root, "tracked.txt"));
    expect(readWorkingTree(root)).toMatchObject({ changedPaths: expect.arrayContaining(["tracked.txt"]) });
  });

  it("reports both sides of a staged rename", () => {
    const root = repository();
    execFileSync("git", ["mv", "tracked.txt", "moved.txt"], { cwd: root });

    expect(readWorkingTree(root)).toEqual({
      kind: "present",
      changedPaths: ["moved.txt", "tracked.txt"],
    });
  });

  it("leaves out jflow's own records, which are jflow's to change", () => {
    const root = repository();
    mkdirSync(join(root, "jflow"));
    writeFileSync(join(root, "jflow", "progress.json"), "{}\n");

    expect(readWorkingTree(root)).toEqual({ kind: "present", changedPaths: [] });
  });

  it("scopes a project inside a larger repository to the project directory", () => {
    const top = repository();
    const root = join(top, "project");
    mkdirSync(root);
    writeFileSync(join(root, "inside.txt"), "i\n");
    writeFileSync(join(top, "outside.txt"), "o\n");

    expect(readWorkingTree(root)).toEqual({ kind: "present", changedPaths: ["inside.txt"] });
  });

  it("reports a .git directory Git cannot read as unreadable, not as clean", () => {
    const root = directory();
    mkdirSync(join(root, ".git"));

    const result = readWorkingTree(root);

    expect(result.kind).toBe("unreadable");
  });
});

describe("readOnlyGit", () => {
  it.each([
    ["init"],
    ["reset", "--hard"],
    ["clean", "-fd"],
    ["checkout", "--", "."],
    ["restore", "."],
    ["stash"],
    ["rm", "tracked.txt"],
    ["commit", "-am", "absorbed"],
    ["add", "."],
    ["push"],
    ["merge", "main"],
    ["-C", "/elsewhere", "status"],
  ])("refuses %s: jflow never initializes, discards or absorbs changes", (...args) => {
    const root = repository();
    writeFileSync(join(root, "tracked.txt"), "developer's work\n");

    expect(() => readOnlyGit(root, args)).toThrow(/read-only/);
    expect(readWorkingTree(root)).toEqual({ kind: "present", changedPaths: ["tracked.txt"] });
  });

  it("runs a read-only command", () => {
    expect(readOnlyGit(repository(), ["rev-parse", "--is-inside-work-tree"]).trim()).toBe("true");
  });
});

describe("readChangedRecords", () => {
  it("lists the changed records under jflow/ that readWorkingTree leaves out", () => {
    const root = repository();
    mkdirSync(join(root, "jflow"));
    writeFileSync(join(root, "jflow", "progress.json"), "{}\n");
    writeFileSync(join(root, "other.txt"), "o\n");

    expect(readChangedRecords(root)).toEqual(["jflow/progress.json"]);
  });
});

describe("commitPaths", () => {
  const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

  it("commits exactly the named paths, leaving every other change, staged or not, where it was", () => {
    const root = repository();
    writeFileSync(join(root, "gone.txt"), "g\n");
    git(root, "add", "gone.txt");
    git(root, "commit", "--quiet", "-m", "add gone");
    writeFileSync(join(root, "tracked.txt"), "ticket\n");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "new.ts"), "n\n");
    rmSync(join(root, "gone.txt"));
    writeFileSync(join(root, "mine.txt"), "developer\n");
    writeFileSync(join(root, "staged.txt"), "developer staged\n");
    git(root, "add", "staged.txt");

    const hash = commitPaths(root, ["gone.txt", "src/new.ts", "tracked.txt"], "T1: Parser");

    expect(hash).toBe(git(root, "rev-parse", "HEAD").trim());
    expect(git(root, "show", "--name-status", "--format=%s", "HEAD").trim().split("\n")).toEqual([
      "T1: Parser",
      "",
      "D\tgone.txt",
      "A\tsrc/new.ts",
      "M\ttracked.txt",
    ]);
    expect(git(root, "status", "--porcelain=v1")).toBe("A  staged.txt\n?? mine.txt\n");
  });

  it("refuses to commit nothing", () => {
    expect(() => commitPaths(repository(), [], "empty")).toThrow(/nothing/);
  });
});

describe("snapshotWorkingTree", () => {
  it("records HEAD and the content of every changed path, so any edit shows as a difference", () => {
    const root = repository();
    writeFileSync(join(root, "tracked.txt"), "developer's edit\n");
    writeFileSync(join(root, "new.txt"), "n\n");

    const before = snapshotWorkingTree(root);
    expect(before).toMatchObject({
      kind: "present",
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
      files: [
        { path: "new.txt", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        { path: "tracked.txt", sha256: expect.any(String) },
      ],
    });
    expect(snapshotWorkingTree(root)).toEqual(before);

    writeFileSync(join(root, "tracked.txt"), "a diagnostic edit\n");
    expect(snapshotWorkingTree(root)).not.toEqual(before);
  });

  it("records a deleted path without a hash, and has no head before the first commit", () => {
    const root = repository();
    rmSync(join(root, "tracked.txt"));
    expect(snapshotWorkingTree(root)).toMatchObject({ files: [{ path: "tracked.txt" }] });
    expect(snapshotWorkingTree(root)).not.toHaveProperty("files.0.sha256");

    const empty = directory();
    execFileSync("git", ["init", "--quiet"], { cwd: empty });
    expect(snapshotWorkingTree(empty)).toEqual({ kind: "present", files: [] });
    expect(snapshotWorkingTree(directory())).toEqual({ kind: "absent" });
  });
});
