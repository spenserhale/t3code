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

/**
 * How often the user is asked before a login is filled, after 1Password's own approval setting.
 * `never` asks nobody, for machines no one can answer on.
 */
export const BrowserLoginApproval = Schema.Literals(["request", "thread", "application", "never"]);
export type BrowserLoginApproval = typeof BrowserLoginApproval.Type;
export const DEFAULT_BROWSER_LOGIN_APPROVAL: BrowserLoginApproval = "thread";

/**
 * How often the user is asked before an identity's values are shown to the agent, for browsers
 * the server does not control. `off` never shows them.
 */
export const BrowserIdentityReadApproval = Schema.Literals([
  "off",
  "request",
  "thread",
  "application",
  "never",
]);
export type BrowserIdentityReadApproval = typeof BrowserIdentityReadApproval.Type;
export const DEFAULT_BROWSER_IDENTITY_READ_APPROVAL: BrowserIdentityReadApproval = "request";

export const BROWSER_LOGIN_PROVIDERS_MAX = 8;

export const BrowserLoginSettings = Schema.Struct({
  /** Saved before `secretProviderIds` existed; read only when that is absent. */
  secretProviderId: Schema.optional(SecretProviderId),
  /** The configured secret providers logins come from. None turns the feature off. */
  secretProviderIds: Schema.optional(Schema.Array(SecretProviderId)),
  /** Also covers filling an identity into the built-in browser. */
  approval: BrowserLoginApproval.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_LOGIN_APPROVAL)),
  ),
  /** Absent means `DEFAULT_BROWSER_IDENTITY_READ_APPROVAL`. */
  identityReadApproval: Schema.optional(BrowserIdentityReadApproval),
});
export type BrowserLoginSettings = typeof BrowserLoginSettings.Type;

// Like the other settings' limits, the cap applies to writes only, so it can change later.
export const BrowserLoginSettingsWrite = Schema.Struct({
  ...BrowserLoginSettings.fields,
  secretProviderIds: Schema.optional(
    Schema.Array(SecretProviderId).check(Schema.isMaxLength(BROWSER_LOGIN_PROVIDERS_MAX)),
  ),
});

export const browserLoginProviderIds = (
  settings: BrowserLoginSettings,
): ReadonlyArray<SecretProviderId> =>
  settings.secretProviderIds ??
  (settings.secretProviderId === undefined ? [] : [settings.secretProviderId]);

const LoginLocator = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
const ApprovalTimeoutMs = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(180_000)),
).annotate({ description: "Default 120000, which includes waiting for the user to approve." });

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
  timeoutMs: ApprovalTimeoutMs,
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
  /** The password manager it came from, as the user named it in Settings > Secrets. */
  account: Schema.optional(Schema.String),
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

/**
 * Filling a sign-up form with an identity from the user's password manager: name, contact
 * details and address. These values are personal, not secret: the agent can read them back from
 * the page, and `preview_read_identity` hands them over directly once the user allows it.
 */
export const PreviewIdentityValue = Schema.Literals([
  "firstName",
  "middleInitial",
  "lastName",
  "fullName",
  "email",
  "phone",
  "company",
  "jobTitle",
  "birthDate",
  "street",
  "city",
  "state",
  "postalCode",
  "country",
  "username",
]);
export type PreviewIdentityValue = typeof PreviewIdentityValue.Type;

const IdentityChoice = Schema.optional(
  TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
).annotate({
  description: "Identity id from an earlier `choose` result. Omit to use the only one saved.",
});

const PREVIEW_IDENTITY_FIELDS_MAX = 40;

export const PreviewAutomationFillIdentityInput = Schema.Struct({
  tabId: Schema.optional(PreviewTabId),
  identity: IdentityChoice,
  // The tool's description explains `fields`, so it carries no description of its own.
  fields: Schema.optional(
    Schema.Array(Schema.Struct({ locator: LoginLocator, value: PreviewIdentityValue })).check(
      Schema.isMaxLength(PREVIEW_IDENTITY_FIELDS_MAX),
    ),
  ),
  timeoutMs: ApprovalTimeoutMs,
});
export type PreviewAutomationFillIdentityInput = typeof PreviewAutomationFillIdentityInput.Type;

export const PreviewAutomationFillIdentityRequest = Schema.Struct({
  ...PreviewAutomationFillIdentityInput.fields,
  requester: Schema.optional(PreviewLoginRequester),
});
export type PreviewAutomationFillIdentityRequest = typeof PreviewAutomationFillIdentityRequest.Type;

export const PreviewAutomationFillIdentityResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("filled"),
    tabId: PreviewTabId,
    identity: PreviewLoginCandidate,
    /** One entry per field filled, so a value can appear twice. */
    filled: Schema.Array(PreviewIdentityValue),
    /** Fields left for the agent to finish, such as a custom dropdown, with why. */
    skipped: Schema.Array(Schema.Struct({ value: PreviewIdentityValue, reason: Schema.String })),
  }),
  Schema.Struct({
    status: Schema.Literal("choose"),
    tabId: PreviewTabId,
    candidates: Schema.Array(PreviewLoginCandidate),
  }),
  Schema.Struct({ status: Schema.Literal("no_identity"), tabId: PreviewTabId }),
]);
export type PreviewAutomationFillIdentityResult = typeof PreviewAutomationFillIdentityResult.Type;

export const PreviewAutomationReadIdentityInput = Schema.Struct({
  identity: IdentityChoice,
  timeoutMs: ApprovalTimeoutMs,
});
export type PreviewAutomationReadIdentityInput = typeof PreviewAutomationReadIdentityInput.Type;

export const PreviewAutomationReadIdentityRequest = Schema.Struct({
  ...PreviewAutomationReadIdentityInput.fields,
  requester: Schema.optional(PreviewLoginRequester),
});
export type PreviewAutomationReadIdentityRequest = typeof PreviewAutomationReadIdentityRequest.Type;

export const PreviewIdentityValues = Schema.Record(
  PreviewIdentityValue,
  Schema.optionalKey(Schema.String),
);
export type PreviewIdentityValues = typeof PreviewIdentityValues.Type;

export const PreviewAutomationReadIdentityResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("read"),
    identity: PreviewLoginCandidate,
    values: PreviewIdentityValues,
  }),
  Schema.Struct({
    status: Schema.Literal("choose"),
    candidates: Schema.Array(PreviewLoginCandidate),
  }),
  Schema.Struct({ status: Schema.Literal("no_identity") }),
]);
export type PreviewAutomationReadIdentityResult = typeof PreviewAutomationReadIdentityResult.Type;
