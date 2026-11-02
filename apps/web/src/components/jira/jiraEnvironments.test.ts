import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { jiraEnvironmentForThread, threadUsesJiraSite } from "./jiraEnvironments";

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

describe("threadUsesJiraSite", () => {
  it("accepts a thread whose key is read on the site's own environment", () => {
    expect(threadUsesJiraSite(a, [a, b], a)).toBe(true);
  });

  it("refuses a thread on another environment that has its own Jira, whose key would be read there", () => {
    expect(threadUsesJiraSite(b, [a, b], a)).toBe(false);
    expect(threadUsesJiraSite(a, [a, b], b)).toBe(false);
  });

  it("accepts a thread on an environment without Jira when the site is the only one", () => {
    expect(threadUsesJiraSite(c, [a], a)).toBe(true);
    expect(threadUsesJiraSite(b, [a], a)).toBe(true);
  });

  it("refuses a thread no site can claim when several have Jira", () => {
    expect(threadUsesJiraSite(c, [a, b], a)).toBe(false);
  });

  it("refuses everything once the site's Jira is gone", () => {
    expect(threadUsesJiraSite(a, [], a)).toBe(false);
    expect(threadUsesJiraSite(a, [b], a)).toBe(false);
  });
});
