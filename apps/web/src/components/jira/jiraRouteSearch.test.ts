import { describe, expect, it } from "vite-plus/test";

import { applyJiraSearchPatch, jiraSearchInput, parseJiraSearch } from "./jiraRouteSearch";

describe("parseJiraSearch", () => {
  it("reads an empty address as the default view", () => {
    expect(parseJiraSearch({})).toEqual({});
    expect(parseJiraSearch({ preset: "assigned" })).toEqual({});
  });

  it("keeps what is valid and drops what is not", () => {
    expect(
      parseJiraSearch({
        preset: "custom",
        jql: "  project = PROJ  ",
        projects: ["proj", "OPS", "proj", "bad key", 7, "x".repeat(40)],
        status: ["done", "bogus", "todo"],
        q: " login ",
        issue: "proj-12",
        environmentId: "env-1",
      }),
    ).toEqual({
      preset: "custom",
      jql: "project = PROJ",
      projects: ["PROJ", "OPS"],
      status: ["todo", "done"],
      q: "login",
      issue: "PROJ-12",
      environmentId: "env-1",
    });
  });

  it("ignores a JQL query unless the view uses one, and an unknown view or issue", () => {
    expect(parseJiraSearch({ preset: "sprint", jql: "a = b" })).toEqual({ preset: "sprint" });
    expect(parseJiraSearch({ preset: "nonsense", issue: "not-a-key-1" })).toEqual({});
    expect(parseJiraSearch({ projects: "ops", status: "done" })).toEqual({
      projects: ["OPS"],
      status: ["done"],
    });
  });
});

describe("jiraSearchInput", () => {
  it("builds the same request for the same view, in the same key order", () => {
    const a = jiraSearchInput({ q: "x", projects: ["OPS"] });
    const b = jiraSearchInput({ projects: ["OPS"], q: "x" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toEqual({ preset: "assigned", projectKeys: ["OPS"], text: "x", pageSize: 50 });
  });
});

describe("applyJiraSearchPatch", () => {
  it("changes some of a view and takes the rest out of the address when patched to undefined", () => {
    expect(
      applyJiraSearchPatch({ q: "login", issue: "PROJ-1" }, { issue: undefined, preset: "recent" }),
    ).toEqual({ q: "login", preset: "recent" });
  });
});
