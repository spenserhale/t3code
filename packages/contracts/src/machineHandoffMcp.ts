import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestratorMcpClientRequestId,
  OrchestratorMcpEnvironmentTarget,
} from "./orchestratorMcp.ts";

/**
 * `environmentId` is the machine to move to, so it is required and not the optional "act there"
 * target (`OrchestratorMcpEnvironmentTarget`) that makes a tool run in a linked environment.
 */
export const ThreadContinueOnMachineInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: Schema.optional(ThreadId),
  message: Schema.optional(
    Schema.String.check(Schema.isMaxLength(100_000)).annotate({
      description: "Instructions for the agent there. Default: continue where this left off.",
    }),
  ),
  modelSelection: Schema.optional(ModelSelection),
  projectId: Schema.optional(ProjectId),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type ThreadContinueOnMachineInput = typeof ThreadContinueOnMachineInput.Type;

export const ThreadContinueOnMachineResult = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  link: Schema.String,
  projectId: ProjectId,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  pushedCommit: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  /** `failed`: the hand-off is done but this thread stays active, to be settled by hand. */
  sourceSettles: Schema.Literals(["now", "at_turn_end", "failed"]),
});
export type ThreadContinueOnMachineResult = typeof ThreadContinueOnMachineResult.Type;

export const WorktreeOpenBranchInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  projectId: ProjectId,
  /** The branch's name on the remote. */
  branch: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  remote: Schema.optional(TrimmedNonEmptyString),
  /** A project's `repositoryIdentity.canonicalKey`: the repository the branch is on. */
  repositoryKey: Schema.optional(TrimmedNonEmptyString),
  /** What a new branch is compared with in pull requests: a branch name, with no remote in it. */
  baseBranch: Schema.optional(TrimmedNonEmptyString),
  /** The repository `baseBranch` is on, as for `repositoryKey`. Default: the branch's own. */
  baseRepositoryKey: Schema.optional(TrimmedNonEmptyString),
  expectCommit: Schema.optional(TrimmedNonEmptyString),
});
export type WorktreeOpenBranchInput = typeof WorktreeOpenBranchInput.Type;

export const WorktreeOpenBranchResult = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  remote: TrimmedNonEmptyString,
  head: TrimmedNonEmptyString,
  /** False: a worktree that was there already is reused. */
  created: Schema.Boolean,
});
export type WorktreeOpenBranchResult = typeof WorktreeOpenBranchResult.Type;
