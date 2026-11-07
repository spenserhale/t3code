import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMachineHandoff from "../../../peer/ThreadMachineHandoff.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import * as WorktreeOpenBranch from "../../WorktreeOpenBranch.ts";
import { launchCommandId } from "../project/handlers.ts";
import { MachineHandoffToolkit } from "./tools.ts";

const handlers = {
  t3_thread_continue_on_machine: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* ThreadMachineHandoff.ThreadMachineHandoff;
        return yield* service.continueOnMachine(scope, input);
      }),
  ),
  // A branch on a worktree here belongs to no thread until a launch binds it, so a link may open
  // the one its own thread is about to use.
  t3_worktree_open_branch: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* WorktreeOpenBranch.WorktreeOpenBranch;
        return yield* service.open(scope, input);
      }),
    { linkedCallers: "allowed" },
  ),
  // The id a launch gives its thread, which a retry of that launch finds again.
  t3_thread_launch_lookup: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const commandId = yield* launchCommandId(scope.requestNamespace, input.clientRequestId);
      const shell = yield* threads
        .getThreadShell(ThreadId.make(commandId))
        .pipe(Effect.mapError(unavailable));
      return {
        launched:
          shell === null || shell.deletedAt !== null
            ? null
            : {
                threadId: shell.id,
                link: McpInvocationContext.threadLinkFor(scope, shell.id),
                projectId: shell.projectId,
              },
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof MachineHandoffToolkit.tools>;

export const layer = McpToolAccess.toLayer(MachineHandoffToolkit, handlers);
