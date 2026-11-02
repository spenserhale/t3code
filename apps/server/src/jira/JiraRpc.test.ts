import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  JiraAuthFailedError,
  JiraNotConfiguredError,
  JiraNotFoundError,
  JiraRateLimitedError,
  JiraRequestError,
  WS_METHODS,
  WsRpcGroup,
  type AuthEnvironmentScope,
  type JiraIssueSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as JiraClient from "./JiraClient.ts";
import * as JiraCredentials from "./JiraCredentials.ts";
import * as JiraHandlers from "./JiraHandlers.ts";
import * as JiraService from "./JiraService.ts";

const issue: JiraIssueSummary = {
  key: "PROJ-12",
  summary: "Fix the login redirect",
  url: "https://acme.atlassian.net/browse/PROJ-12",
  status: { name: "In Progress", category: "in-progress" },
  issueType: "Bug",
  priority: null,
  assignee: { accountId: "acc-1", displayName: "Sam Rivera" },
  projectKey: "PROJ",
  projectName: "Platform",
  updatedAt: "2026-11-01T09:30:00.000+0000",
};

const detail = {
  ...issue,
  reporter: null,
  createdAt: "2026-10-20T08:00:00.000+0000",
  labels: ["auth"],
  descriptionMarkdown: "Users bounce back to login.",
  comments: [
    {
      id: "9001",
      author: { accountId: "acc-2", displayName: "Alex Kim" },
      createdAt: "2026-10-21T10:00:00.000+0000",
      updatedAt: "2026-10-21T10:05:00.000+0000",
      bodyMarkdown: "Reproduced.",
    },
  ],
  commentCount: 1,
};

const die = () => Effect.die("not expected");

// Everything a client sends or receives goes through the schemas, so this is the
// check that what the service returns is something the wire can carry.
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, `jira.${string}`> =>
      !tag.startsWith("jira."),
  ),
);

const serve = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  overrides: Partial<JiraClient.JiraClient["Service"]> = {},
) =>
  Effect.gen(function* () {
    let configured: JiraClient.JiraCredential | undefined;
    const client = JiraClient.JiraClient.of({
      myself: (credential) => {
        configured = credential;
        return Effect.succeed({ accountId: "acc-1", displayName: "Sam Rivera" });
      },
      listProjects: () => Effect.succeed([{ key: "PROJ", name: "Platform" }]),
      searchIssues: () => Effect.succeed({ issues: [issue], nextPageToken: "next" }),
      getIssue: () => Effect.succeed(detail),
      getIssueSummary: die,
      listTransitions: () =>
        Effect.succeed([
          { id: "31", name: "Start review", to: { name: "In Review", category: "in-progress" } },
        ]),
      transition: () => Effect.void,
      addComment: () => Effect.succeed(detail.comments[0]!),
      ...overrides,
    });
    const credentials = Layer.effect(
      JiraCredentials.JiraCredentials,
      Effect.sync(() => {
        let saved: Option.Option<JiraClient.JiraCredential> = Option.none();
        return JiraCredentials.JiraCredentials.of({
          get: Effect.sync(() => saved),
          set: (credential) => Effect.sync(() => void (saved = Option.some(credential))),
          clear: Effect.sync(() => void (saved = Option.none())),
        });
      }),
    );
    const service = yield* JiraService.JiraService.pipe(
      Effect.provide(
        JiraService.layer.pipe(
          Layer.provide(Layer.succeed(JiraClient.JiraClient, client)),
          Layer.provide(credentials),
        ),
      ),
    );
    const handlers = yield* JiraHandlers.make.pipe(
      Effect.provideService(JiraService.JiraService, service),
    );
    const rpc = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.mergeAll(group.toLayer(handlers), RpcAuthorization.layer(scopes))),
    );
    return { rpc, configured: () => configured };
  });

// RpcTest passes values without serializing them, so the wire form is checked here.
type WireSchema = Schema.Codec<unknown, unknown, never, never>;
const wireRoundTrip = (schema: WireSchema, value: unknown) =>
  Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.map((wire) => JSON.parse(JSON.stringify(wire)) as unknown),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
  );
const schemasOf = (tag: string) => {
  const rpc = WsRpcGroup.requests.get(tag)!;
  return {
    payload: rpc.payloadSchema as unknown as WireSchema,
    success: rpc.successSchema as unknown as WireSchema,
    error: rpc.errorSchema as unknown as WireSchema,
  };
};

it.effect("sends every Jira answer and error over the wire and reads it back unchanged", () =>
  Effect.gen(function* () {
    const answers: ReadonlyArray<readonly [string, unknown]> = [
      [
        WS_METHODS.jiraStatus,
        {
          configured: true,
          siteUrl: "https://acme.atlassian.net",
          email: "sam@example.com",
          account: { accountId: "acc-1", displayName: "Sam Rivera" },
        },
      ],
      [WS_METHODS.jiraStatus, { configured: false }],
      [WS_METHODS.jiraListProjects, { projects: [{ key: "PROJ", name: "Platform" }] }],
      [
        WS_METHODS.jiraSearch,
        { issues: [issue], nextPageToken: null, jql: "project = PROJ ORDER BY updated DESC" },
      ],
      [WS_METHODS.jiraGetIssue, detail],
      [
        WS_METHODS.jiraListTransitions,
        {
          transitions: [
            { id: "31", name: "Start review", to: { name: "In Review", category: "in-progress" } },
          ],
        },
      ],
      [WS_METHODS.jiraTransition, issue],
      [WS_METHODS.jiraAddComment, detail.comments[0]],
      [WS_METHODS.jiraLookupIssues, { issues: [issue] }],
    ];
    for (const [tag, value] of answers) {
      assert.deepStrictEqual(yield* wireRoundTrip(schemasOf(tag).success, value), value, tag);
    }
    for (const failure of [
      new JiraNotConfiguredError(),
      new JiraAuthFailedError({ status: 401 }),
      new JiraNotFoundError({ key: "PROJ-1" }),
      new JiraRateLimitedError({ retryAfterSeconds: 7 }),
      new JiraRequestError({ operation: "search", status: 400, detail: "Bad JQL" }),
    ]) {
      const read = yield* wireRoundTrip(schemasOf(WS_METHODS.jiraSearch).error, failure);
      assert.deepStrictEqual(read, failure);
    }
    const input = yield* wireRoundTrip(schemasOf(WS_METHODS.jiraConfigure).payload, {
      siteUrl: "acme.atlassian.net",
      email: "sam@example.com",
      apiToken: Redacted.make("token-123"),
    });
    assert.strictEqual(
      Redacted.value((input as { apiToken: Redacted.Redacted<string> }).apiToken),
      "token-123",
    );
  }),
);

it.effect("carries a connection and every kind of answer across the wire", () =>
  Effect.gen(function* () {
    const { rpc, configured } = yield* serve([
      AuthOrchestrationReadScope,
      AuthSettingsWriteScope,
      AuthSourceControlWriteScope,
    ]);
    assert.deepStrictEqual(yield* rpc[WS_METHODS.jiraStatus]({}), { configured: false });

    const connected = yield* rpc[WS_METHODS.jiraConfigure]({
      siteUrl: "acme.atlassian.net",
      email: "sam@example.com",
      apiToken: Redacted.make("token-123"),
    });
    assert.deepStrictEqual(connected, {
      configured: true,
      siteUrl: "https://acme.atlassian.net",
      email: "sam@example.com",
      account: { accountId: "acc-1", displayName: "Sam Rivera" },
    });
    assert.strictEqual(Redacted.value(configured()!.apiToken), "token-123");

    assert.deepStrictEqual(yield* rpc[WS_METHODS.jiraListProjects]({}), {
      projects: [{ key: "PROJ", name: "Platform" }],
    });
    const found = yield* rpc[WS_METHODS.jiraSearch]({ preset: "assigned", text: "login" });
    assert.deepStrictEqual(found.issues, [issue]);
    assert.strictEqual(found.nextPageToken, "next");
    assert.deepStrictEqual(yield* rpc[WS_METHODS.jiraGetIssue]({ key: "PROJ-12" }), detail);
    assert.strictEqual(
      (yield* rpc[WS_METHODS.jiraListTransitions]({ key: "PROJ-12" })).transitions[0]?.to.name,
      "In Review",
    );
    assert.deepStrictEqual(
      (yield* rpc[WS_METHODS.jiraLookupIssues]({ keys: ["PROJ-12"] })).issues,
      [issue],
    );
    yield* rpc[WS_METHODS.jiraAddComment]({ key: "PROJ-12", body: "Linked" });
    yield* rpc[WS_METHODS.jiraDisconnect]({});
    assert.deepStrictEqual(yield* rpc[WS_METHODS.jiraStatus]({}), { configured: false });
  }).pipe(Effect.scoped),
);

it.effect("hands the client a service failure as the typed error, not a defect", () =>
  Effect.gen(function* () {
    const { rpc } = yield* serve([AuthOrchestrationReadScope, AuthSettingsWriteScope], {
      searchIssues: () => Effect.fail(new JiraRateLimitedError({ retryAfterSeconds: 7 })),
    });
    const notSetUp = yield* rpc[WS_METHODS.jiraSearch]({ preset: "assigned" }).pipe(Effect.flip);
    assert.strictEqual(notSetUp._tag, "JiraNotConfiguredError");
    assert.strictEqual(notSetUp.message, "Jira is not set up on this environment.");

    yield* rpc[WS_METHODS.jiraConfigure]({
      siteUrl: "https://acme.atlassian.net",
      email: "sam@example.com",
      apiToken: Redacted.make("token-123"),
    });
    const limited = yield* rpc[WS_METHODS.jiraSearch]({ preset: "assigned" }).pipe(Effect.flip);
    assert.strictEqual(limited._tag, "JiraRateLimitedError");
    if (limited._tag === "JiraRateLimitedError") assert.strictEqual(limited.retryAfterSeconds, 7);
  }).pipe(Effect.scoped),
);
