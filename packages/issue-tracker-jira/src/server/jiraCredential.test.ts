import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { decodeJiraCredential } from "./jiraCredential.ts";

const packed = (fields: Record<string, unknown>) => JSON.stringify(fields);
const complete = { site: "https://acme.atlassian.net", email: "sam@example.com", token: "tok-123" };

describe("decodeJiraCredential", () => {
  it.effect("reads the site down to its origin and keeps email and token apart", () =>
    Effect.gen(function* () {
      for (const [site, origin, host] of [
        ["https://acme.atlassian.net", "https://acme.atlassian.net", "acme.atlassian.net"],
        // A pasted board address, a bare host and stray case all name the same site.
        [
          "https://Acme.Atlassian.net/jira/software/projects/PROJ/boards/1",
          "https://acme.atlassian.net",
          "acme.atlassian.net",
        ],
        [" acme.atlassian.net ", "https://acme.atlassian.net", "acme.atlassian.net"],
        // A mock on this machine may speak plain http, and its port tells two mocks apart.
        ["http://127.0.0.1:4010", "http://127.0.0.1:4010", "127.0.0.1:4010"],
        ["http://localhost:4010/", "http://localhost:4010", "localhost:4010"],
      ] as const) {
        const credential = yield* decodeJiraCredential("probe", packed({ ...complete, site }));
        expect([credential.origin, credential.host], site).toEqual([origin, host]);
      }
      const credential = yield* decodeJiraCredential(
        "probe",
        packed({ ...complete, email: " sam@example.com ", token: " tok-123\n", extra: true }),
      );
      expect(credential.email).toBe("sam@example.com");
      expect(Redacted.value(credential.apiToken)).toBe("tok-123");
    }),
  );

  it.effect("refuses what cannot reach a site, saying what is missing", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string]> = [
        // What a client that draws no fields sends: the token alone.
        ["tok-123", "only a token arrived"],
        [JSON.stringify("tok-123"), "only a token arrived"],
        [packed({ ...complete, site: "" }), "Enter the Jira site address"],
        [packed({ ...complete, site: "http://acme.atlassian.net" }), "must start with https://"],
        [packed({ ...complete, site: "ftp://acme.atlassian.net" }), "must start with https://"],
        [
          packed({ ...complete, site: "https://user:pw@acme.atlassian.net" }),
          "must start with https://",
        ],
        [packed({ ...complete, site: "https://" }), "must start with https://"],
        [packed({ site: complete.site, token: complete.token }), "Enter the email"],
        [packed({ site: complete.site, email: complete.email }), "Enter an API token"],
        [packed({ ...complete, email: "sam@exämple.com" }), "printable ASCII"],
        [packed({ ...complete, token: "tok 123" }), "printable ASCII"],
      ];
      for (const [token, detail] of cases) {
        const refused = yield* Effect.flip(decodeJiraCredential("probe", token));
        expect([refused.reason, refused.detail], token).toEqual([
          "unauthenticated",
          expect.stringContaining(detail),
        ]);
      }
    }),
  );
});
