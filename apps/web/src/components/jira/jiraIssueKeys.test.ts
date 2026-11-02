import { describe, expect, it } from "vite-plus/test";

import {
  extractIssueKeys,
  issueBranchName,
  issueThreadTitle,
  linkedThreadTitle,
  takenBranchNames,
  unlinkedThreadTitle,
  unusedBranchName,
} from "./jiraIssueKeys";

const projects = new Set(["PROJ", "OPS", "T3"]);

describe("extractIssueKeys", () => {
  it("takes the key off the front of a title it was put on, and only then", () => {
    expect(unlinkedThreadTitle("PROJ-1: Fix the login redirect", "PROJ-1")).toBe(
      "Fix the login redirect",
    );
    expect(unlinkedThreadTitle("PROJ-1 - Fix", "PROJ-1")).toBe("Fix");
    expect(unlinkedThreadTitle("Fix PROJ-1", "PROJ-1")).toBeNull();
    expect(unlinkedThreadTitle("PROJ-1:", "PROJ-1")).toBeNull();
    expect(unlinkedThreadTitle("PROJ-12: Fix", "PROJ-1")).toBeNull();
  });

  it.each([
    [{ title: "PROJ-123: Fix login redirect", branch: null }, ["PROJ-123"]],
    [{ title: "Fix login", branch: "PROJ-45-fix-login" }, ["PROJ-45"]],
    [{ title: "Fix login", branch: "feature/proj-45-fix-login" }, ["PROJ-45"]],
    [{ title: "Follow up on OPS-7 and PROJ-8", branch: "ops-7-follow-up" }, ["OPS-7", "PROJ-8"]],
    [{ title: "Port T3-9 to the new API", branch: null }, ["T3-9"]],
  ])("finds the keys in %j", (thread, expected) => {
    expect(extractIssueKeys(thread, projects)).toEqual(expected);
  });

  it("ignores text that only looks like a key, because no project has that name", () => {
    expect(
      extractIssueKeys(
        { title: "Try GPT-4 and UTF-8 handling, RFC-2119", branch: "gpt-4-eval" },
        projects,
      ),
    ).toEqual([]);
  });

  it("does not read a key out of a longer word or number", () => {
    expect(
      extractIssueKeys(
        { title: "XPROJ-1 and PROJ-12345678901 and PROJ-0", branch: "myproj-5" },
        projects,
      ),
    ).toEqual([]);
  });

  it("wants a title's key in capitals, but lets a branch use either case", () => {
    expect(extractIssueKeys({ title: "fix proj-12", branch: null }, projects)).toEqual([]);
    expect(extractIssueKeys({ title: "fix", branch: "fix/proj-12" }, projects)).toEqual([
      "PROJ-12",
    ]);
  });

  it("finds nothing until the site's projects are known", () => {
    expect(extractIssueKeys({ title: "PROJ-1", branch: "PROJ-1" }, new Set())).toEqual([]);
  });
});

describe("thread names", () => {
  it("titles a thread with the key and summary, cut to a readable length", () => {
    expect(issueThreadTitle("PROJ-1", "  Fix   the\nlogin  ")).toBe("PROJ-1: Fix the login");
    expect(issueThreadTitle("PROJ-1", "x".repeat(300))).toHaveLength(120);
  });

  it("puts the key in front of a title once, and keeps a title that already has it", () => {
    expect(linkedThreadTitle("Fix the login redirect", "PROJ-1")).toBe(
      "PROJ-1: Fix the login redirect",
    );
    expect(linkedThreadTitle("Fix PROJ-1 redirect", "PROJ-1")).toBe("Fix PROJ-1 redirect");
    expect(linkedThreadTitle("Fix PROJ-12 redirect", "PROJ-1")).toBe(
      "PROJ-1: Fix PROJ-12 redirect",
    );
  });

  it.each([
    ["PROJ-123", "Fix the login redirect!", "PROJ-123-fix-the-login-redirect"],
    ["PROJ-123", "  Café: résumé/upload — fails  ", "PROJ-123-cafe-resume-upload-fails"],
    ["PROJ-123", "one two three four five six seven eight", "PROJ-123-one-two-three-four-five-six"],
    ["PROJ-123", "日本語", "PROJ-123"],
  ])("names the branch for %s from %j", (key, summary, expected) => {
    expect(issueBranchName(key, summary)).toBe(expected);
  });

  it("numbers a branch name that is taken", () => {
    const taken = new Set(["PROJ-1-a", "PROJ-1-a-2"]);
    expect(unusedBranchName("PROJ-1-b", taken)).toBe("PROJ-1-b");
    expect(unusedBranchName("PROJ-1-a", taken)).toBe("PROJ-1-a-3");
  });
});

describe("takenBranchNames", () => {
  it("lists local branches and the remote ones by their short name", () => {
    expect(
      takenBranchNames([
        { name: "main" },
        { name: "feature/a", isRemote: false },
        { name: "origin/PROJ-1-fix", isRemote: true, remoteName: "origin" },
        { name: "upstream/PROJ-1-fix", isRemote: true, remoteName: "upstream" },
        { name: "odd/name", isRemote: true },
      ]),
    ).toEqual(new Set(["main", "feature/a", "PROJ-1-fix", "odd/name"]));
  });

  it("makes the next free name step over a branch that exists only in the repository", () => {
    const taken = takenBranchNames([
      { name: "PROJ-1-fix" },
      { name: "origin/PROJ-1-fix-2", isRemote: true, remoteName: "origin" },
    ]);
    expect(unusedBranchName("PROJ-1-fix", taken)).toBe("PROJ-1-fix-3");
  });
});
