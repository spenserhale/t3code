import { Effect, Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewTabId } from "./preview.ts";
import { SecretProviderId } from "./secretReference.ts";

/**
 * Signing an agent's browser tab in with a login from the user's password manager. The agent
 * names the fields; the server reads the values from a secret provider and fills them itself, so
 * no username, password, or one-time code ever reaches the agent.
 */

export const PreviewLoginField = Schema.Literals(["username", "password", "totp"]);
export type PreviewLoginField = typeof PreviewLoginField.Type;

/** How often the user is asked before a login is filled, after 1Password's own approval setting. */
export const BrowserLoginApproval = Schema.Literals(["request", "thread", "application"]);
export type BrowserLoginApproval = typeof BrowserLoginApproval.Type;
export const DEFAULT_BROWSER_LOGIN_APPROVAL: BrowserLoginApproval = "thread";

export const BrowserLoginSettings = Schema.Struct({
  /** The configured secret provider logins come from. Unset turns the feature off. */
  secretProviderId: Schema.optional(SecretProviderId),
  approval: BrowserLoginApproval.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_LOGIN_APPROVAL)),
  ),
});
export type BrowserLoginSettings = typeof BrowserLoginSettings.Type;

const LoginLocator = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));

export const PreviewAutomationFillLoginInput = Schema.Struct({
  tabId: Schema.optional(PreviewTabId),
  login: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))).annotate({
    description:
      "Login id from an earlier `choose` result. Omit to use the only login saved for this site.",
  }),
  fields: Schema.optional(Schema.Array(PreviewLoginField).check(Schema.isMaxLength(3))).annotate({
    description:
      "Default username and password. On a sign-in split over pages, fill what this page shows. `totp` fills a one-time code.",
  }),
  locators: Schema.optional(
    Schema.Struct({
      username: Schema.optional(LoginLocator),
      password: Schema.optional(LoginLocator),
      totp: Schema.optional(LoginLocator),
    }),
  ).annotate({
    description:
      "`aria-ref=<ref>` per field from `preview_snapshot`, when the fields are not found on their own.",
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(180_000)),
  ).annotate({ description: "Default 120000, which includes waiting for the user to approve." }),
});
export type PreviewAutomationFillLoginInput = typeof PreviewAutomationFillLoginInput.Type;

/** Who asks, shown in the approval prompt. Set by the server from the caller, never by the agent. */
export const PreviewLoginRequester = Schema.Struct({
  threadTitle: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  provider: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
});
export type PreviewLoginRequester = typeof PreviewLoginRequester.Type;

/** What the broker carries to the browser host. */
export const PreviewAutomationFillLoginRequest = Schema.Struct({
  ...PreviewAutomationFillLoginInput.fields,
  requester: Schema.optional(PreviewLoginRequester),
});
export type PreviewAutomationFillLoginRequest = typeof PreviewAutomationFillLoginRequest.Type;

export const PreviewLoginCandidate = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  vault: Schema.optional(Schema.String),
});
export type PreviewLoginCandidate = typeof PreviewLoginCandidate.Type;

export const PreviewAutomationFillLoginResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("filled"),
    tabId: PreviewTabId,
    login: PreviewLoginCandidate,
    filled: Schema.Array(PreviewLoginField),
  }),
  Schema.Struct({
    status: Schema.Literal("choose"),
    tabId: PreviewTabId,
    origin: Schema.String,
    candidates: Schema.Array(PreviewLoginCandidate),
  }),
  Schema.Struct({
    status: Schema.Literal("no_login"),
    tabId: PreviewTabId,
    origin: Schema.String,
  }),
]);
export type PreviewAutomationFillLoginResult = typeof PreviewAutomationFillLoginResult.Type;
