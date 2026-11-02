import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShells } from "~/state/entities";
import { vcsEnvironment } from "~/state/vcs";
import { takenBranchNames } from "./jiraIssueKeys";
import { planJiraFanout } from "./jiraThreadStarts";

interface BranchProject {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

/**
 * The branch names a new worktree could collide with: the repository's own, read now and not from
 * a cache, and every thread's. Unsent starts are not here; they are claims, which callers weigh.
 * When the repository cannot be read, the threads' branches are what there is.
 */
export async function readExistingBranchNames(
  project: BranchProject,
  wanted: string,
): Promise<ReadonlySet<string>> {
  const names = new Set(
    readThreadShells().flatMap((shell) => (shell.branch === null ? [] : [shell.branch])),
  );
  const refs = await runAtomCommand(
    appAtomRegistry,
    vcsEnvironment.readRefs,
    {
      environmentId: project.environmentId,
      input: {
        cwd: project.workspaceRoot,
        query: wanted,
        refKind: "all",
        includeMatchingRemoteRefs: true,
        refresh: true,
        limit: 200,
      },
    },
    { reportFailure: false, reportDefect: false },
  );
  if (refs._tag === "Success")
    for (const name of takenBranchNames(refs.value.refs)) names.add(name);
  return names;
}

/** `planJiraFanout` for a send into this project, with branches checked against its repository. */
export const planJiraFanoutFor = (
  threadId: ThreadId,
  project: BranchProject,
): ReturnType<typeof planJiraFanout> =>
  planJiraFanout(threadId, (wanted) => readExistingBranchNames(project, wanted));
