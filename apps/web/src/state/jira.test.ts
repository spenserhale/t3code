import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { jiraLookupSignalAtom, jiraRevisionAtom, refreshJira, refreshJiraChips } from "./jira";

const environmentId = EnvironmentId.make("env-jira-refresh");

// A signal nobody reads is rebuilt from nothing on the next read, so these are kept mounted.
const watch = () => {
  onTestFinished(appAtomRegistry.mount(jiraLookupSignalAtom(environmentId)));
  onTestFinished(appAtomRegistry.mount(jiraRevisionAtom(environmentId)));
  return {
    chips: () => appAtomRegistry.get(jiraLookupSignalAtom(environmentId)),
    page: () => appAtomRegistry.get(jiraRevisionAtom(environmentId)),
  };
};

describe("what makes the status chips ask Jira again", () => {
  it("is a refresh of everything shown from the environment, as after a write", () => {
    const { chips } = watch();
    const before = chips();
    refreshJira(environmentId);
    expect(chips()).not.toBe(before);
  });

  it("is also a refresh of the chips alone, which leaves the rest of the page where it is", () => {
    const { chips, page } = watch();
    const chipsBefore = chips();
    const pageBefore = page();
    refreshJiraChips(environmentId);
    expect(chips()).not.toBe(chipsBefore);
    expect(page()).toBe(pageBefore);
  });

  it("changes with every refresh, however many come one after another", () => {
    const { chips } = watch();
    const seen = new Set([chips()]);
    refreshJiraChips(environmentId);
    seen.add(chips());
    refreshJiraChips(environmentId);
    seen.add(chips());
    refreshJira(environmentId);
    seen.add(chips());
    expect(seen.size).toBe(4);
  });
});
