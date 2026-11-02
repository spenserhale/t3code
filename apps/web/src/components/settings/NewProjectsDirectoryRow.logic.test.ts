import { describe, expect, it } from "vite-plus/test";

import { newProjectsDirectoryProblem } from "./NewProjectsDirectoryRow.logic";

describe("newProjectsDirectoryProblem", () => {
  it("accepts empty, home-relative and absolute folders on either platform", () => {
    for (const value of [
      "",
      "  ",
      "~",
      "~/code",
      "~\\code",
      "/work/projects",
      "D:\\projects",
      "d:/projects",
      "\\\\server\\share",
    ]) {
      expect(newProjectsDirectoryProblem(value), value).toBeNull();
    }
  });

  it("refuses a folder that is relative to nothing", () => {
    for (const value of [
      "projects",
      "./projects",
      "../projects",
      "~other/projects",
      "C:projects",
      "C:",
    ]) {
      expect(newProjectsDirectoryProblem(value), value).toContain("absolute");
    }
  });
});
