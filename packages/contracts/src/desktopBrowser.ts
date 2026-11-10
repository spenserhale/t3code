import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

/** Reading an identity for the agent involves no tab. */
const ApprovalKey = {
  threadId: TrimmedNonEmptyString,
  tabId: Schema.optional(TrimmedNonEmptyString),
};

export const DesktopBrowserEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("attached"), ...TabKey }),
  /** Its `<webview>` went away: closed, crashed, swapped, or devtools took the debugger. */
  Schema.Struct({ type: Schema.Literal("detached"), ...TabKey }),
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  /**
   * The tab's page failed to load. The desktop starts a tab's first load before
   * the server connects, so the server cannot always observe the failure itself.
   */
  Schema.Struct({
    type: Schema.Literal("loadFailed"),
    ...TabKey,
    url: Schema.String,
    code: Schema.Int,
    description: Schema.String,
  }),
  /** Its `<webview>` started or stopped being on screen in a desktop window. */
  Schema.Struct({ type: Schema.Literal("shown"), ...TabKey, shown: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("loginApproval"),
    ...ApprovalKey,
    requestId: TrimmedNonEmptyString,
    approved: Schema.Boolean,
  }),
]);
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

export const DesktopBrowserCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("release"), ...TabKey }),
  Schema.Struct({
    type: Schema.Literal("pointer"),
    ...TabKey,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
  }),
  /** Whether an agent turn runs on the thread, so the tabs it uses stay focused between steps. */
  Schema.Struct({
    type: Schema.Literal("turn"),
    threadId: TrimmedNonEmptyString,
    active: Schema.Boolean,
  }),
  /**
   * Ask the user, in a native dialog, before a password manager login or identity is filled into
   * the tab, or before an identity is shown to the agent (no tab, no origin).
   */
  Schema.Struct({
    type: Schema.Literal("loginApproval"),
    ...ApprovalKey,
    requestId: TrimmedNonEmptyString,
    kind: Schema.optional(Schema.Literals(["login", "identity", "identityRead"])),
    providerLabel: Schema.String,
    /** The saved item's title, a login's or an identity's. */
    loginTitle: Schema.String,
    vault: Schema.optional(Schema.String),
    origin: Schema.optional(Schema.String),
    threadTitle: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    scope: Schema.Literals(["request", "thread", "application"]),
    /** The server stops waiting after this long; a prompt not yet shown by then is never shown. */
    timeoutMs: Schema.Finite,
  }),
  /**
   * A login is being filled into the tab's main document. Sent before the fill writes, so
   * captures of the tab can be refused from then on.
   */
  Schema.Struct({
    type: Schema.Literal("loginFilled"),
    ...TabKey,
    document: TrimmedNonEmptyString,
  }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;
