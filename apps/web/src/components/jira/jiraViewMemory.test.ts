import { describe, expect, it } from "vite-plus/test";

import { readJiraView, rememberJiraView } from "./jiraViewMemory";

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

describe("remembered Jira view", () => {
  it("starts from the default view", () => {
    expect(readJiraView(memoryStorage())).toEqual({});
  });

  it("returns the filters, order and environment last used, without the open issue", () => {
    const storage = memoryStorage();
    rememberJiraView(
      {
        preset: "custom",
        jql: "project = OPS",
        projects: ["OPS"],
        status: ["todo"],
        q: "login",
        order: "priority",
        issue: "OPS-7",
        environmentId: "env-1" as never,
      },
      storage,
    );
    expect(readJiraView(storage)).toEqual({
      preset: "custom",
      jql: "project = OPS",
      projects: ["OPS"],
      status: ["todo"],
      q: "login",
      order: "priority",
      environmentId: "env-1",
    });
  });

  it("forgets a filter that was cleared", () => {
    const storage = memoryStorage();
    rememberJiraView({ q: "login", projects: ["OPS"] }, storage);
    rememberJiraView({ projects: ["OPS"] }, storage);
    expect(readJiraView(storage)).toEqual({ projects: ["OPS"] });
  });

  it("reads nothing from storage that is unreadable or holds something else", () => {
    const storage = memoryStorage();
    storage.setItem("t3code:jira:view:v1", "{not json");
    expect(readJiraView(storage)).toEqual({});
    storage.setItem("t3code:jira:view:v1", JSON.stringify({ preset: "nonsense", order: "bogus" }));
    expect(readJiraView(storage)).toEqual({});
    const denied = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readJiraView(denied)).toEqual({});
    expect(() => rememberJiraView({ q: "x" }, denied)).not.toThrow();
  });
});
