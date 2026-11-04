import { OrchestratorMcpFailure, type JiraError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as JiraService from "../../../jira/JiraService.ts";
import { shapeIssueForAgent } from "../../../jira/jiraAgentIssue.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { JIRA_SEARCH_DEFAULT_PAGE_SIZE, JiraToolkit } from "./tools.ts";

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** The connection is the user's to fix, so those messages say where; the rest say what to change. */
const jiraFailure = (error: JiraError): OrchestratorMcpFailure => {
  switch (error._tag) {
    case "JiraNotConfiguredError":
      return failure(
        "orchestration_error",
        "Jira is not connected on this machine. Connect it in Settings → Jira.",
      );
    case "JiraAuthFailedError":
      return failure(
        "orchestration_error",
        "Jira did not accept the saved email and API token. Reconnect it in Settings → Jira.",
      );
    case "JiraNotFoundError":
      return failure("invalid_request", error.message);
    case "JiraRateLimitedError":
      return failure("orchestration_error", error.message);
    case "JiraRequestError": {
      const { status, detail } = error;
      if (error.operation === "credentials") {
        return failure(
          "orchestration_error",
          "The saved Jira credentials could not be read. Reconnect it in Settings → Jira.",
        );
      }
      if (status === 403) {
        return failure(
          "capability_denied",
          detail === undefined
            ? "Jira says the connected account may not do this."
            : `Jira says the connected account may not do this: ${detail}`,
        );
      }
      // Without a status the request never left: the service refused its input.
      if (status === undefined && detail !== undefined) return failure("invalid_request", detail);
      if (status !== undefined && status >= 400 && status < 500) {
        return failure("invalid_request", error.message);
      }
      return failure("orchestration_error", `${error.message} Try again shortly.`);
    }
  }
};

const make = Effect.gen(function* () {
  const jira = yield* JiraService.JiraService;
  const asFailure = <A>(call: Effect.Effect<A, JiraError>) => Effect.mapError(call, jiraFailure);
  // Reads check the orchestration capability themselves; the write wrappers already do.
  const reading = <A>(call: Effect.Effect<A, JiraError>) =>
    readCaller().pipe(Effect.andThen(asFailure(call)));

  return {
    jira_issue_search: McpToolAccess.reads((input) =>
      reading(
        jira.search({
          preset: input.preset,
          ...(input.jql === undefined ? {} : { jql: input.jql }),
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.projectKeys === undefined ? {} : { projectKeys: input.projectKeys }),
          ...(input.statusCategories === undefined
            ? {}
            : { statusCategories: input.statusCategories }),
          ...(input.sort === undefined ? {} : { sort: input.sort }),
          ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
          pageSize: input.pageSize ?? JIRA_SEARCH_DEFAULT_PAGE_SIZE,
        }),
      ),
    ),
    jira_issue_read: McpToolAccess.reads(({ key, comments, maxChars }) =>
      reading(
        jira
          .getIssue({ key })
          .pipe(Effect.map((issue) => shapeIssueForAgent(issue, { comments, maxChars }))),
      ),
    ),
    jira_issue_transition: McpToolAccess.either(
      ({ transitionId }) => transitionId === undefined,
      McpToolAccess.reads(({ key }) => reading(jira.listTransitions({ key }))),
      McpToolAccess.writes(({ key, transitionId }) =>
        transitionId === undefined
          ? Effect.die("unreachable")
          : asFailure(jira.transition({ key, transitionId })),
      ),
    ),
    jira_issue_comment: McpToolAccess.writes(({ key, body }) =>
      asFailure(jira.addComment({ key, body })),
    ),
  } satisfies McpToolAccess.Handlers<typeof JiraToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(JiraToolkit, make);
