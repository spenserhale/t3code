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
  Schema.Struct({
    type: Schema.Literal("loginApproval"),
    ...ApprovalKey,
    requestId: TrimmedNonEmptyString,
    /** Allow once, allow for this thread, or false for Deny. */
    approved: Schema.Union([Schema.Literals(["once", "thread"]), Schema.Literal(false)]),
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
    kind: Schema.optional(Schema.Literals(["login", "identity", "identityRead", "newLogin"])),
    /** The password managers that would be opened. */
    providerLabel: Schema.String,
    /** The item's title, when known before anything is read, such as a new login's. */
    loginTitle: Schema.optional(Schema.String),
    /** The item the agent named, such as `op://Vault/Item`. */
    reference: Schema.optional(Schema.String),
    vault: Schema.optional(Schema.String),
    origin: Schema.optional(Schema.String),
    threadTitle: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    /** The machine a relayed request came from; absent for this server's own threads. */
    machine: Schema.optional(Schema.String),
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
  /** The server stopped waiting: a prompt not yet answered closes as a Deny. */
  Schema.Struct({ type: Schema.Literal("loginApprovalCancel"), requestId: TrimmedNonEmptyString }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;
