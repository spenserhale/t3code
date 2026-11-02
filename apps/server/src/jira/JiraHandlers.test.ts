import { assert, it } from "@effect/vitest";
import {
  JiraAuthFailedError,
  JiraNotFoundError,
  JiraRateLimitedError,
  JiraRequestError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as JiraClient from "./JiraClient.ts";
import * as JiraCredentials from "./JiraCredentials.ts";
import * as JiraHandlers from "./JiraHandlers.ts";
import * as JiraService from "./JiraService.ts";

it.effect("answers as not set up when the runtime has no Jira service", () =>
  Effect.gen(function* () {
    const handlers = yield* JiraHandlers.make;
    assert.deepStrictEqual(yield* handlers[WS_METHODS.jiraStatus]({}), { configured: false });
    const search = yield* handlers[WS_METHODS.jiraSearch]({ preset: "assigned" }).pipe(Effect.flip);
    assert.strictEqual(search._tag, "JiraNotConfiguredError");
    const comment = yield* handlers[WS_METHODS.jiraAddComment]({
      key: "PROJ-1",
      body: "hello",
    }).pipe(Effect.flip);
    assert.strictEqual(comment._tag, "JiraNotConfiguredError");
  }),
);

const unexpected = () => Effect.die("not expected");

// The service's own typed errors reach the client unchanged; the handler adds none of its own.
it.effect.each([
  new JiraAuthFailedError({ status: 401 }),
  new JiraNotFoundError({ key: "PROJ-1" }),
  new JiraRateLimitedError({ retryAfterSeconds: 7 }),
  new JiraRequestError({ operation: "getIssue", status: 500 }),
])("passes $_tag from the service through untouched", (failure) => {
  const client = JiraClient.JiraClient.of({
    myself: unexpected,
    listProjects: unexpected,
    searchIssues: unexpected,
    getIssue: () => Effect.fail(failure),
    getIssueSummary: unexpected,
    listTransitions: unexpected,
    transition: unexpected,
    addComment: unexpected,
  });
  const credentials = JiraCredentials.JiraCredentials.of({
    get: Effect.succeedSome({
      siteUrl: "https://acme.atlassian.net",
      email: "sam@example.com",
      apiToken: undefined as never,
    }),
    set: () => Effect.void,
    clear: Effect.void,
  });
  const layer = JiraService.layer.pipe(
    Layer.provide(Layer.succeed(JiraClient.JiraClient, client)),
    Layer.provide(Layer.succeed(JiraCredentials.JiraCredentials, credentials)),
  );
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    const handlers = yield* JiraHandlers.make.pipe(
      Effect.provideService(JiraService.JiraService, jira),
    );
    const error = yield* handlers[WS_METHODS.jiraGetIssue]({ key: "PROJ-1" }).pipe(Effect.flip);
    assert.strictEqual(error, failure);
  }).pipe(Effect.provide(layer));
});
