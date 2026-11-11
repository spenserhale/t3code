import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

export const DesktopBrowserEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("attached"), ...TabKey }),
  /** Its `<webview>` went away: closed, crashed, swapped, or devtools took the debugger. */
  Schema.Struct({ type: Schema.Literal("detached"), ...TabKey }),
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("loginApproval"),
    ...TabKey,
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
  /** Ask the user, in a native dialog, before a password manager login is filled into the tab. */
  Schema.Struct({
    type: Schema.Literal("loginApproval"),
    ...TabKey,
    requestId: TrimmedNonEmptyString,
    providerLabel: Schema.String,
    loginTitle: Schema.String,
    vault: Schema.optional(Schema.String),
    origin: Schema.String,
    threadTitle: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    scope: Schema.Literals(["request", "thread", "application"]),
    /** The server stops waiting after this long; a prompt not yet shown by then is never shown. */
    timeoutMs: Schema.Finite,
  }),
  /**
   * A login was filled into the tab's main document, or a filled document showed another address.
   * Sent before the fill writes, so captures of the tab can be refused from then on.
   */
  Schema.Struct({
    type: Schema.Literal("loginFilled"),
    ...TabKey,
    document: TrimmedNonEmptyString,
    url: Schema.String,
  }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;
