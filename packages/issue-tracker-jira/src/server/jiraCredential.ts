/**
 * What a Jira Cloud site signs requests with: its address, the account's email and an API token.
 * The connect flow carries one string, so a client that draws the descriptor's fields sends the
 * three as a JSON object; a client that does not sends the token alone, which is refused here.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";

import { JIRA_KIND, isLoopbackHostname } from "../shared/issueUrl.ts";

export interface JiraCredential {
  /** `https://acme.atlassian.net`: where requests go and what issue links start with. */
  readonly origin: string;
  /** The origin's host, which is how issue links name the site. */
  readonly host: string;
  readonly email: string;
  readonly apiToken: Redacted.Redacted<string>;
}

const PackedCredential = Schema.Struct({
  site: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
});
const decodePacked = Schema.decodeUnknownOption(Schema.fromJsonString(PackedCredential));

// Basic auth puts email and token in a header: printable ASCII only, so no newline reaches it.
const HEADER_SAFE = /^[!-~]+$/u;

const SITE_EXAMPLE = "https://your-site.atlassian.net";

function siteOf(value: string): { readonly origin: string; readonly host: string } | null {
  const trimmed = value.trim();
  const url = URL.parse(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  if (url === null || url.hostname === "" || url.username !== "" || url.password !== "") {
    return null;
  }
  const secure = url.protocol === "https:";
  if (!secure && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) return null;
  return { origin: url.origin, host: url.host.toLowerCase() };
}

/** The credential in `token`, or why Jira cannot be reached with it. */
export const decodeJiraCredential = Effect.fn("decodeJiraCredential")(function* (
  operation: string,
  token: string,
) {
  const refuse = (detail: string) =>
    new IssueTrackerError({ tracker: JIRA_KIND, operation, reason: "unauthenticated", detail });
  const packed = decodePacked(token);
  if (packed._tag === "None") {
    return yield* refuse(
      "Jira needs the site address and the account's email as well as the API token, and only " +
        "a token arrived. Connect Jira from a client that asks for all three.",
    );
  }
  const { site = "", email = "", token: apiToken = "" } = packed.value;
  if (site.trim() === "") {
    return yield* refuse(`Enter the Jira site address, such as ${SITE_EXAMPLE}.`);
  }
  const parsed = siteOf(site);
  if (parsed === null) {
    return yield* refuse(
      `The Jira site address must start with https://, such as ${SITE_EXAMPLE}.`,
    );
  }
  if (email.trim() === "") {
    return yield* refuse("Enter the email of the Atlassian account the API token belongs to.");
  }
  if (apiToken.trim() === "") return yield* refuse("Enter an API token.");
  if (!HEADER_SAFE.test(email.trim()) || !HEADER_SAFE.test(apiToken.trim())) {
    return yield* refuse("The email and API token can only hold printable ASCII characters.");
  }
  const credential: JiraCredential = {
    ...parsed,
    email: email.trim(),
    apiToken: Redacted.make(apiToken.trim()),
  };
  return credential;
});
