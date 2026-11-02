import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { jiraEnvironmentForThread } from "./jiraEnvironments";

const a = EnvironmentId.make("env-a");
const b = EnvironmentId.make("env-b");
const c = EnvironmentId.make("env-c");

describe("jiraEnvironmentForThread", () => {
  it("prefers the thread's own environment when Jira is set up there", () => {
    expect(jiraEnvironmentForThread(b, [a, b])).toBe(b);
    expect(jiraEnvironmentForThread(a, [a])).toBe(a);
  });

  it("falls back to the only environment that has Jira", () => {
    expect(jiraEnvironmentForThread(c, [a])).toBe(a);
  });

  it("belongs to no site when several have Jira and none is the thread's own", () => {
    expect(jiraEnvironmentForThread(c, [a, b])).toBeNull();
  });

  it("belongs to no site when no environment has Jira", () => {
    expect(jiraEnvironmentForThread(a, [])).toBeNull();
  });
});
