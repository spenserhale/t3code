import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  JiraAuthFailedError,
  JiraNotFoundError,
  JiraRateLimitedError,
  JiraRequestError,
  ProviderInstanceId,
  ThreadId,
  type JiraComment,
  type JiraIssueSummary,
  type JiraTransition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as JiraClient from "../../../jira/JiraClient.ts";
import * as JiraCredentials from "../../../jira/JiraCredentials.ts";
import * as JiraService from "../../../jira/JiraService.ts";
import { plainTextToAdf, type AdfDocument } from "../../../jira/jiraAdf.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as JiraHandlers from "./handlers.ts";
import { JiraToolkit } from "./tools.ts";

const saved: JiraClient.JiraCredential = {
  siteUrl: "https://acme.atlassian.net",
  email: "sam@example.com",
  apiToken: Redacted.make("token-123"),
};

const issue = (key: string, status = "To Do"): JiraIssueSummary => ({
  key,
  summary: `Summary of ${key}`,
  url: `https://acme.atlassian.net/browse/${key}`,
  status: { name: status, category: status === "To Do" ? "todo" : "in-progress" },
  issueType: "Task",
  priority: null,
  assignee: null,
  projectKey: key.slice(0, key.lastIndexOf("-")),
  projectName: "Platform",
  updatedAt: "2026-11-01T09:30:00.000+0000",
});

const startProgress: JiraTransition = {
  id: "31",
  name: "Start progress",
  to: { name: "In Progress", category: "in-progress" },
};

const comment: JiraComment = {
  id: "10001",
  author: { accountId: "acct-1", displayName: "Sam" },
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  bodyMarkdown: "Fixed.",
};

const die = (name: string) => () => Effect.die(`${name} was not expected`);

const fakeClient = (partial: Partial<JiraClient.JiraClient["Service"]>) =>
  JiraClient.JiraClient.of({
    myself: die("myself"),
    listProjects: die("listProjects"),
    listAcceptanceCriteriaFields: () => Effect.succeed([]),
    searchIssues: die("searchIssues"),
    getIssue: die("getIssue"),
    getIssueSummary: die("getIssueSummary"),
    listTransitions: die("listTransitions"),
    transition: die("transition"),
    addComment: die("addComment"),
    ...partial,
  });

const layerJira = (
  client: Partial<JiraClient.JiraClient["Service"]>,
  credentials: Option.Option<JiraClient.JiraCredential>,
) =>
  JiraService.layer.pipe(
    Layer.provide(Layer.succeed(JiraClient.JiraClient, fakeClient(client))),
    Layer.provide(
      Layer.succeed(
        JiraCredentials.JiraCredentials,
        JiraCredentials.JiraCredentials.of({
          get: Effect.succeed(credentials),
          set: () => Effect.void,
          clear: Effect.void,
        }),
      ),
    ),
  );

const threadCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:jira"),
  requestNamespace: "provider:jira",
  thread: {
    threadId: ThreadId.make("thread:jira"),
    providerSessionId: "provider:jira",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const clientCaller = (
  access: McpInvocationContext.McpClientCaller["access"],
  linked = false,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:jira"),
  requestNamespace: "client:jira",
  thread: undefined,
  client: { sessionId: "session:jira", label: "Other machine", access, linked },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const makeHarness = Effect.fn("makeJiraToolkitHarness")(function* (
  client: Partial<JiraClient.JiraClient["Service"]> = {},
  credentials: Option.Option<JiraClient.JiraCredential> = Option.some(saved),
) {
  const toolkit = yield* JiraToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(JiraHandlers.layer).pipe(
        Layer.provide(layerJira(client, credentials)),
      ),
    ),
  );
  const call = (
    name: keyof typeof JiraToolkit.tools,
    params: unknown,
    scope: McpInvocationContext.McpInvocationScope = threadCaller,
  ) =>
    toolkit.handle(name, params as never).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => ({ isFailure: chunk.at(-1)!.isFailure, result: chunk.at(-1)!.result })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(McpToolAccessTestkit.liveThreadsLayer),
    );
  return { call };
});

it.effect.each([
  { when: "searching", name: "jira_issue_search", params: { preset: "assigned" } },
  { when: "reading", name: "jira_issue_read", params: { key: "PROJ-1" } },
  { when: "listing moves", name: "jira_issue_transition", params: { key: "PROJ-1" } },
  {
    when: "making a move",
    name: "jira_issue_transition",
    params: { key: "PROJ-1", transitionId: "31" },
  },
  { when: "commenting", name: "jira_issue_comment", params: { key: "PROJ-1", body: "Done." } },
] as const)("says Jira is not connected when $when", (row) =>
  Effect.gen(function* () {
    const { call } = yield* makeHarness({}, Option.none());
    expect(yield* call(row.name, row.params)).toMatchObject({
      isFailure: true,
      result: {
        _tag: "OrchestratorMcpFailure",
        code: "orchestration_error",
        message: "Jira is not connected on this machine. Connect it in Settings → Jira.",
      },
    });
  }),
);

it.effect.each([
  {
    when: "Jira rejects the saved token",
    failure: new JiraAuthFailedError({ status: 401 }),
    code: "orchestration_error",
    says: "Reconnect it in Settings → Jira",
  },
  {
    when: "the issue does not exist",
    failure: new JiraNotFoundError({ key: "PROJ-9" }),
    code: "invalid_request",
    says: "Jira has no issue PROJ-9",
  },
  {
    when: "Jira rate limits",
    failure: new JiraRateLimitedError({ retryAfterSeconds: 30 }),
    code: "orchestration_error",
    says: "Try again in 30 seconds",
  },
  {
    when: "the account may not see it",
    failure: new JiraRequestError({
      operation: "getIssue",
      status: 403,
      detail: "You do not have permission to view this issue.",
    }),
    code: "capability_denied",
    says: "may not do this: You do not have permission to view this issue.",
  },
  {
    when: "Jira refuses the request",
    failure: new JiraRequestError({
      operation: "getIssue",
      status: 400,
      detail: "Error in the JQL Query: unknown field.",
    }),
    code: "invalid_request",
    says: "Error in the JQL Query: unknown field.",
  },
  {
    when: "Jira cannot be reached",
    failure: new JiraRequestError({ operation: "getIssue" }),
    code: "orchestration_error",
    says: "Could not reach Jira (getIssue). Try again shortly.",
  },
  {
    when: "Jira has an outage",
    failure: new JiraRequestError({ operation: "getIssue", status: 503 }),
    code: "orchestration_error",
    says: "Try again shortly.",
  },
])("tells the agent what to do when $when", (row) =>
  Effect.gen(function* () {
    const { call } = yield* makeHarness({ getIssue: () => Effect.fail(row.failure) });
    const { isFailure, result } = yield* call("jira_issue_read", { key: "PROJ-1" });
    expect(isFailure).toBe(true);
    expect(result).toMatchObject({ code: row.code });
    expect((result as { message: string }).message).toContain(row.says);
  }),
);

it.effect("searches with a small page and the preset's own query unless told otherwise", () =>
  Effect.gen(function* () {
    const searches: Array<JiraClient.JiraSearchRequest> = [];
    const { call } = yield* makeHarness({
      searchIssues: (_credential, request) =>
        Effect.sync(() => searches.push(request)).pipe(
          Effect.as({ issues: [issue("PROJ-1")], nextPageToken: "next-1" }),
        ),
    });
    expect(yield* call("jira_issue_search", { preset: "assigned" })).toEqual({
      isFailure: false,
      result: {
        issues: [issue("PROJ-1")],
        nextPageToken: "next-1",
        jql: "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
      },
    });
    expect(searches).toEqual([
      {
        jql: "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
        pageSize: 20,
      },
    ]);
  }),
);

it.effect("runs custom JQL under the filters, order and page the agent asked for", () =>
  Effect.gen(function* () {
    const searches: Array<JiraClient.JiraSearchRequest> = [];
    const { call } = yield* makeHarness({
      searchIssues: (_credential, request) =>
        Effect.sync(() => searches.push(request)).pipe(
          Effect.as({ issues: [], nextPageToken: null }),
        ),
    });
    yield* call("jira_issue_search", {
      preset: "custom",
      jql: "project = PLAT ORDER BY created DESC",
      text: "login",
      projectKeys: ["plat"],
      statusCategories: ["todo"],
      sort: "key",
      pageToken: "page-2",
      pageSize: 5,
    });
    expect(searches).toEqual([
      {
        jql: '(project = PLAT) AND project in ("PLAT") AND statusCategory in ("To Do") AND text ~ "login" ORDER BY key ASC',
        pageSize: 5,
        pageToken: "page-2",
      },
    ]);
  }),
);

it.effect("lists the moves Jira offers without an id, and makes one only with an id", () =>
  Effect.gen(function* () {
    const moves: Array<{ key: string; transitionId: string }> = [];
    const { call } = yield* makeHarness({
      listTransitions: () => Effect.succeed([startProgress]),
      transition: (_credential, key, transitionId) =>
        Effect.sync(() => void moves.push({ key, transitionId })),
      getIssueSummary: () => Effect.succeed(issue("PROJ-1", "In Progress")),
    });
    expect(yield* call("jira_issue_transition", { key: "PROJ-1" })).toEqual({
      isFailure: false,
      result: { transitions: [startProgress] },
    });
    expect(moves).toEqual([]);
    expect(
      yield* call("jira_issue_transition", { key: "PROJ-1", transitionId: "31" }),
    ).toMatchObject({
      isFailure: false,
      result: { key: "PROJ-1", status: { name: "In Progress", category: "in-progress" } },
    });
    expect(moves).toEqual([{ key: "PROJ-1", transitionId: "31" }]);
  }),
);

it.effect("adds the agent's text to the issue as a comment", () =>
  Effect.gen(function* () {
    const added: Array<{ key: string; body: AdfDocument }> = [];
    const { call } = yield* makeHarness({
      addComment: (_credential, key, body) =>
        Effect.sync(() => void added.push({ key, body })).pipe(Effect.as(comment)),
    });
    const body = "Fixed in the login flow.\n\nSee https://example.com/pull/1";
    expect(yield* call("jira_issue_comment", { key: "PROJ-1", body })).toEqual({
      isFailure: false,
      result: comment,
    });
    expect(added).toEqual([{ key: "PROJ-1", body: plainTextToAdf(body) }]);
  }),
);

// A read-only client, or work a link below full access started, may look but not change.
it.effect.each([
  { who: "a read-only client", scope: clientCaller("read-only") },
  { who: "a linked environment below full access", scope: clientCaller("approval-required", true) },
])("lets $who read Jira but not move or comment", ({ scope }) =>
  Effect.gen(function* () {
    const touched: Array<string> = [];
    const { call } = yield* makeHarness({
      listTransitions: () => Effect.succeed([startProgress]),
      transition: () => Effect.sync(() => void touched.push("transition")),
      addComment: () => Effect.sync(() => touched.push("comment")).pipe(Effect.as(comment)),
    });
    expect(yield* call("jira_issue_transition", { key: "PROJ-1" }, scope)).toMatchObject({
      isFailure: false,
    });
    for (const [name, params] of [
      ["jira_issue_transition", { key: "PROJ-1", transitionId: "31" }],
      ["jira_issue_comment", { key: "PROJ-1", body: "Done." }],
    ] as const) {
      expect(yield* call(name, params, scope)).toMatchObject({
        isFailure: true,
        result: { code: "capability_denied" },
      });
    }
    expect(touched).toEqual([]);
  }),
);

it.effect("advertises reads as read-only and surfaces a failure as the tool's error", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(
      Object.fromEntries(
        server.tools.map(({ tool }) => [tool.name, tool.annotations?.readOnlyHint]),
      ),
    ).toEqual({
      jira_issue_search: true,
      jira_issue_read: true,
      jira_issue_transition: false,
      jira_issue_comment: false,
    });
    const result = yield* server
      .callTool({ name: "jira_issue_read", arguments: { key: "PROJ-1" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, threadCaller),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Jira is not connected on this machine");
  }).pipe(
    Effect.provide(
      McpHttpServer.layerJiraToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(layerJira({}, Option.none())),
      ),
    ),
  ),
);
