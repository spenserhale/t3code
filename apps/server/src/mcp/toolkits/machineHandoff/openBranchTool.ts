import {
  OrchestratorMcpFailure,
  WorktreeOpenBranchInput,
  WorktreeOpenBranchResult,
} from "@t3tools/contracts";
import { Tool } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorktreeOpenBranch from "../../WorktreeOpenBranch.ts";

/**
 * Apart from the toolkit because `ThreadMachineHandoff` forwards it to the machine a thread moves
 * to, and the toolkit names that service.
 */
export const WorktreeOpenBranchTool = Tool.make("t3_worktree_open_branch", {
  description:
    "Open a branch from a remote in a worktree of a project, fetching it first. Reuses a worktree or local branch that has it and fast-forwards it; one with changes or commits of its own is left alone. `remote`: default the one that is `repositoryKey`, else origin. `baseBranch`: what a new local branch is compared with, a branch name without its remote, on `baseRepositoryKey` (default: the branch's own). `expectCommit`: fails unless the branch holds it. `created`: whether this call made the worktree. Bind a thread to it with `t3_thread_launch` `workspaceStrategy` `existing_worktree`.",
  parameters: WorktreeOpenBranchInput,
  success: WorktreeOpenBranchResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    WorktreeOpenBranch.WorktreeOpenBranch,
  ],
})
  .annotate(Tool.Title, "Open a branch in a git worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);
