/**
 * The `jira.*` handlers, spread into the handlers `ws.ts` serves. The service
 * is optional, so a runtime without it answers as Jira not being set up.
 */
import {
  JiraNotConfiguredError,
  WS_METHODS,
  type JiraAddCommentInput,
  type JiraConfigureInput,
  type JiraIssueInput,
  type JiraLookupInput,
  type JiraSearchInput,
  type JiraStatus,
  type JiraStatusInput,
  type JiraTransitionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { JiraService } from "./JiraService.ts";

export const make = Effect.gen(function* () {
  const jira = yield* Effect.serviceOption(JiraService);
  const use = <A, E>(call: (service: JiraService["Service"]) => Effect.Effect<A, E>) =>
    Option.match(jira, {
      onNone: () => Effect.fail(new JiraNotConfiguredError()),
      onSome: call,
    });
  return {
    [WS_METHODS.jiraStatus]: (input: JiraStatusInput) =>
      Option.match(jira, {
        onNone: () => Effect.succeed<JiraStatus>({ configured: false }),
        onSome: (service) => service.status(input),
      }),
    [WS_METHODS.jiraConfigure]: (input: JiraConfigureInput) =>
      use((service) => service.configure(input)),
    [WS_METHODS.jiraDisconnect]: (_input: Record<string, never>) =>
      use((service) => service.disconnect),
    [WS_METHODS.jiraListProjects]: (_input: Record<string, never>) =>
      use((service) => service.listProjects),
    [WS_METHODS.jiraSearch]: (input: JiraSearchInput) => use((service) => service.search(input)),
    [WS_METHODS.jiraGetIssue]: (input: JiraIssueInput) => use((service) => service.getIssue(input)),
    [WS_METHODS.jiraListTransitions]: (input: JiraIssueInput) =>
      use((service) => service.listTransitions(input)),
    [WS_METHODS.jiraTransition]: (input: JiraTransitionInput) =>
      use((service) => service.transition(input)),
    [WS_METHODS.jiraAddComment]: (input: JiraAddCommentInput) =>
      use((service) => service.addComment(input)),
    [WS_METHODS.jiraLookupIssues]: (input: JiraLookupInput) =>
      use((service) => service.lookupIssues(input)),
    [WS_METHODS.jiraRefresh]: (_input: Record<string, never>) =>
      Option.match(jira, {
        onNone: () => Effect.void,
        onSome: (service) => service.refresh,
      }),
  };
});
