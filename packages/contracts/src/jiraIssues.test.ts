import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  JIRA_COMMENT_MAX_LENGTH,
  JiraAddCommentInput,
  JiraConfigureInput,
  JiraIssueKey,
} from "./jiraIssues.ts";

const isIssueKey = Schema.is(JiraIssueKey);
const decodeConfigure = Schema.decodeUnknownEffect(JiraConfigureInput);
const encodeConfigure = Schema.encodeEffect(JiraConfigureInput);
const decodeComment = Schema.decodeUnknownEffect(JiraAddCommentInput);

it.effect.each([
  { key: "PROJ-123", valid: true },
  { key: "T3-9", valid: true },
  { key: "AB_C2-1000000", valid: true },
  { key: "A-1", valid: false },
  { key: "proj-1", valid: false },
  { key: "PROJ-0", valid: false },
  { key: "PROJ-01", valid: false },
  { key: "PROJ-1x", valid: false },
  { key: "PROJ-1 ", valid: false },
])("reads $key as an issue key: $valid", ({ key, valid }) =>
  Effect.sync(() => assert.strictEqual(isIssueKey(key), valid)),
);

it.effect("keeps the API token out of anything that prints the decoded input", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeConfigure({
      siteUrl: " https://acme.atlassian.net ",
      email: "sam@example.com",
      apiToken: " secret-token ",
    });
    assert.strictEqual(decoded.siteUrl, "https://acme.atlassian.net");
    assert.strictEqual(Redacted.value(decoded.apiToken), "secret-token");
    assert.notInclude(JSON.stringify(decoded), "secret-token");
    assert.notInclude(String(decoded.apiToken), "secret-token");
    const encoded = yield* encodeConfigure(decoded);
    assert.strictEqual(encoded.apiToken, "secret-token");
  }),
);

it.effect("refuses an empty or oversized comment", () =>
  Effect.gen(function* () {
    const decode = decodeComment;
    assert.strictEqual(
      (yield* Effect.flip(decode({ key: "PROJ-1", body: "  " })))._tag,
      "SchemaError",
    );
    assert.strictEqual(
      (yield* Effect.flip(decode({ key: "PROJ-1", body: "x".repeat(JIRA_COMMENT_MAX_LENGTH + 1) })))
        ._tag,
      "SchemaError",
    );
    assert.strictEqual((yield* decode({ key: "PROJ-1", body: " ok " })).body, "ok");
  }),
);
