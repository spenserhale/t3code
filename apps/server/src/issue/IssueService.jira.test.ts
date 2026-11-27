import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  IssueTrackerKind,
  SourceControlProviderKind,
  type IssueTrackerProjectBinding,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as JiraDriver from "@t3tools/issue-tracker-jira/server/driver";
import type { IssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const JIRA = IssueTrackerKind.make("jira");
const WEB = "web" as ProjectId;
const SITE = "https://acme.atlassian.net";

const web: OrchestrationProjectShell = {
  id: WEB,
  title: "web",
  workspaceRoot: "/w/web",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/web",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/web.git",
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: "acme/web",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

const jiraIssue = {
  key: "PROJ-7",
  fields: {
    summary: "Fix the login redirect",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    project: { key: "PROJ" },
    created: "2026-10-20T08:00:00.000+0000",
    updated: "2026-11-01T09:30:00.000+0000",
  },
};

/** A Jira site that knows one issue, and records what was written to it. */
function jiraTracker() {
  const writes: string[] = [];
  const answer = (method: string, path: string, body: unknown): unknown => {
    switch (`${method} ${path}`) {
      case "POST /rest/api/3/search/jql":
        return { issues: [jiraIssue], isLast: true };
      case "GET /rest/api/3/field":
        return [];
      case "GET /rest/api/3/myself":
        return { accountId: "acc-sam", displayName: "Sam Rivera" };
      case "GET /rest/api/3/issue/PROJ-7":
        return jiraIssue;
      case "GET /rest/api/3/issue/PROJ-7/comment":
        return { comments: [], total: 0 };
      case "GET /rest/api/3/issue/PROJ-7/transitions":
        return {
          transitions: [{ id: "31", to: { name: "Done", statusCategory: { key: "done" } } }],
        };
      case "POST /rest/api/3/issue/PROJ-7/transitions":
      case "POST /rest/api/3/issue/PROJ-7/comment":
        writes.push(`${path.split("/").at(-1)} ${JSON.stringify(body)}`);
        return {};
      default:
        return new Response("{}", { status: 404 });
    }
  };
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
          : undefined;
      const answered = answer(request.method, url.pathname, body);
      return HttpClientResponse.fromWeb(
        request,
        answered instanceof Response ? answered : Response.json(answered),
      );
    }),
  );
  const stored = JSON.stringify({ site: SITE, email: "sam@example.com", token: "tok-123" });
  const tracker = JiraDriver.make.pipe(
    Effect.provide(
      Layer.merge(
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.succeed(
          IssueTrackerHost.IssueTrackerHost,
          IssueTrackerHost.IssueTrackerHost.of({
            credentials: { get: () => Effect.succeedSome(stored) },
          }),
        ),
      ),
    ),
  );
  return { tracker, writes };
}

function makeService(
  trackers: ReadonlyArray<IssueTrackerApi>,
  bindings: Record<string, IssueTrackerProjectBinding>,
) {
  return IssueService.IssueService.pipe(
    Effect.provide(
      IssueService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
              list: () =>
                Effect.succeed(
                  new Map(
                    Object.entries(bindings).map(([id, binding]) => [id as ProjectId, binding]),
                  ),
                ),
            }),
            Layer.succeed(
              IssueTrackerRegistry.IssueTrackerRegistry,
              IssueTrackerRegistry.fromTrackers(trackers),
            ),
            Layer.mock(ProjectService.ProjectService)({
              listShells: () => Effect.succeed([web]),
              getShell: (projectId) =>
                Effect.succeed(projectId === WEB ? Option.some(web) : Option.none()),
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () => Effect.succeed(null),
            }),
          ),
        ),
      ),
    ),
  );
}

describe("IssueService with the Jira tracker", () => {
  it.effect(
    "lists, reads, moves and comments on a bound Jira project, and resolves its links",
    () =>
      Effect.gen(function* () {
        const jira = jiraTracker();
        const service = yield* makeService([yield* jira.tracker], {
          web: { tracker: JIRA, scope: "PROJ" },
        });
        const listed = yield* service.list({ state: "open" });
        expect(
          listed.entries.map((entry) => [entry.tracker, entry.host, entry.scope, entry.key]),
        ).toEqual([["jira", "atlassian.net", "PROJ", "PROJ-7"]]);
        expect(listed.trackers).toContainEqual(
          expect.objectContaining({ tracker: "jira", host: "atlassian.net", configured: true }),
        );

        const ref = { projectId: WEB, tracker: JIRA, scope: "PROJ", key: "PROJ-7" };
        const detail = yield* service.detail(ref);
        expect(detail).toMatchObject({
          writable: true,
          url: `${SITE}/browse/PROJ-7`,
          states: [
            { category: "open", name: "In Progress" },
            { category: "closed", name: "Done" },
          ],
        });
        yield* service.setState({ ...ref, state: "Done" });
        yield* service.comment({ ...ref, body: "Shipped." });
        expect(jira.writes).toEqual([
          'transitions {"transition":{"id":"31"}}',
          'comment {"body":{"version":1,"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Shipped."}]}]}}',
        ]);
        // Declared off, so refused before it reaches Jira.
        const create = yield* Effect.flip(
          service.create({ ...ref, title: "New", body: "", labels: [], assignees: [] }),
        );
        expect(create.message).toContain("does not support filing issues");

        for (const url of [
          `${SITE}/browse/PROJ-7`,
          `${SITE}/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-7`,
        ]) {
          expect(yield* service.resolveUrl(url), url).toMatchObject({
            projectId: WEB,
            tracker: JIRA,
            host: "atlassian.net",
            scope: "PROJ",
            key: "PROJ-7",
            writable: true,
            issue: { title: "Fix the login redirect" },
          });
        }
        // The same key on another site is not the connected site's issue.
        const elsewhere = yield* Effect.flip(
          service.resolveUrl("https://other.atlassian.net/browse/PROJ-7"),
        );
        expect(elsewhere).toMatchObject({
          _tag: "IssueOperationError",
          detail: "This issue URL does not belong to the connected workspace.",
        });
      }),
  );

  it.effect("leaves a Jira binding and Jira references alone on a server without the tracker", () =>
    Effect.gen(function* () {
      // An official build reads the same database, Jira binding included, with no Jira tracker.
      const official = yield* makeService([], { web: { tracker: JIRA, scope: "PROJ" } });
      const listed = yield* official.list({ state: "open" });
      expect([listed.entries, listed.errors, listed.scopes]).toEqual([[], [], []]);
      const detail = yield* Effect.flip(
        official.detail({ projectId: WEB, tracker: JIRA, scope: "PROJ", key: "PROJ-7" }),
      );
      expect(detail).toMatchObject({
        _tag: "IssueUnavailableError",
        reason: "tracker-unsupported",
      });
      const link = yield* Effect.flip(official.resolveUrl(`${SITE}/browse/PROJ-7`));
      expect(link).toMatchObject({ _tag: "IssueOperationError", reason: "not-found" });
    }),
  );
});
