// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.
import type {
  PreviewAutomationEvaluateInput,
  PreviewLoginField,
  PreviewNewPasswordField,
} from "@t3tools/contracts";
import { loadedFresh } from "@t3tools/shared/browserLoginExposure";
import * as NodeCrypto from "node:crypto";
import type { CDPSession, ElementHandle, Frame, Locator, Page } from "playwright-core";

import { evaluate, ServerBrowserOperationError } from "./ServerBrowserPage.ts";

const LOGIN_ERROR = "PreviewAutomationExecutionError";

export const loginError = (message: string) =>
  new ServerBrowserOperationError({ tag: LOGIN_ERROR, message });

const FIELD_SELECTORS: Record<PreviewLoginField, ReadonlyArray<string>> = {
  username: [
    'input[autocomplete~="username" i]:visible',
    'input[type="email"]:visible',
    'input[name*="user" i]:visible, input[id*="user" i]:visible',
    'input[name*="email" i]:visible, input[id*="email" i]:visible',
    'input[name*="login" i]:visible, input[id*="login" i]:visible',
    'input[type="text"]:visible, input:not([type]):visible',
  ],
  password: ['input[type="password"]:visible'],
  totp: [
    'input[autocomplete="one-time-code" i]:visible',
    'input[name*="otp" i]:visible, input[id*="otp" i]:visible',
    'input[name*="code" i]:visible, input[id*="code" i]:visible',
    'input[inputmode="numeric"]:visible',
  ],
};

const firstPresent = async (frame: Frame, selectors: ReadonlyArray<string>) => {
  for (const selector of selectors) {
    const locator = frame.locator(selector).first();
    if ((await locator.count()) > 0) return locator;
  }
  return undefined;
};

export interface LoginTargets {
  readonly targets: ReadonlyMap<PreviewLoginField, Locator>;
  readonly missing: ReadonlyArray<PreviewLoginField>;
}

/**
 * Finds each field in a frame the login covers: the agent's locator when given, else the first
 * likely input. A field in a frame of another site is never used, so a framed page cannot ask
 * for the parent site's password.
 */
export const findLoginTargets = async (input: {
  readonly page: Page;
  readonly fields: ReadonlyArray<PreviewLoginField>;
  readonly locators: Partial<Record<PreviewLoginField, Locator>>;
  readonly frameCovered: (frameUrl: string) => boolean;
  /** In `Date.now()` time. */
  readonly deadline: number;
}): Promise<LoginTargets> => {
  const targets = new Map<PreviewLoginField, Locator>();
  const missing: PreviewLoginField[] = [];
  const frames = [input.page.mainFrame(), ...input.page.frames()].filter(
    (frame, index, all) => all.indexOf(frame) === index && input.frameCovered(frame.url()),
  );
  for (const field of input.fields) {
    const given = input.locators[field];
    if (given !== undefined) {
      const handle = await given.elementHandle({
        timeout: Math.max(1, Math.min(5_000, input.deadline - Date.now())),
      });
      const frame = await handle?.ownerFrame();
      await handle?.dispose();
      if (frame === null || frame === undefined || !input.frameCovered(frame.url())) {
        throw loginError(
          `The ${field} locator points outside the site this login is saved for. Take a fresh snapshot.`,
        );
      }
      targets.set(field, given);
      continue;
    }
    let found: Locator | undefined;
    for (const frame of frames) {
      found = await firstPresent(frame, FIELD_SELECTORS[field]);
      if (found !== undefined) break;
    }
    if (found === undefined) missing.push(field);
    else targets.set(field, found);
  }
  return { targets, missing };
};

/**
 * Where a sign-up's new password goes, only in frames on the page's own site: the agent's
 * locators, or else the visible password fields, one for the password and a second for its
 * confirmation. Any other number needs the agent's locators.
 */
export const findNewPasswordTargets = async (input: {
  readonly page: Page;
  readonly locators:
    | { readonly password: Locator; readonly confirm?: Locator | undefined }
    | undefined;
  readonly frameCovered: (frameUrl: string) => boolean;
  /** In `Date.now()` time. */
  readonly deadline: number;
}): Promise<
  ReadonlyArray<{ readonly field: PreviewNewPasswordField; readonly target: Locator }>
> => {
  if (input.locators !== undefined) {
    const { password, confirm } = input.locators;
    const named = [
      { field: "password" as const, target: password },
      ...(confirm === undefined ? [] : [{ field: "confirm" as const, target: confirm }]),
    ];
    for (const { field, target } of named) {
      const handle = await target.elementHandle({
        timeout: Math.max(1, Math.min(5_000, input.deadline - Date.now())),
      });
      const frame = await handle?.ownerFrame();
      await handle?.dispose();
      if (frame === null || frame === undefined || !input.frameCovered(frame.url())) {
        throw loginError(
          `The ${field} locator points outside this page's site. Take a fresh snapshot.`,
        );
      }
    }
    return named;
  }
  const frames = [input.page.mainFrame(), ...input.page.frames()].filter(
    (frame, index, all) => all.indexOf(frame) === index && input.frameCovered(frame.url()),
  );
  const found: Locator[] = [];
  for (const frame of frames) {
    const fields = frame.locator('input[type="password"]:visible');
    const count = await fields.count().catch(() => 0);
    for (let index = 0; index < count; index++) found.push(fields.nth(index));
  }
  if (found.length === 0 || found.length > 2) {
    throw loginError(
      found.length === 0
        ? "No password field was found on this page's site. Pass `locators` with aria-refs from preview_snapshot."
        : `This page has ${found.length} password fields. Pass \`locators\` for the new password and its confirmation, with aria-refs from preview_snapshot.`,
    );
  }
  return found.map((target, index) => ({ field: index === 0 ? "password" : "confirm", target }));
};

const FILL_WORLD = "t3-preview-login-fill";

/**
 * Finds and untags the element a fill tagged, in this document and its open shadow roots. A
 * document that is not on the field's origin is not searched.
 */
const findTagged = (tag: string, origin: string) => `(() => {
  if (location.origin !== ${JSON.stringify(origin)}) return 0;
  const found = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.hasAttribute(${JSON.stringify(tag)})) found.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  for (const element of found) element.removeAttribute(${JSON.stringify(tag)});
  return found.length === 1 ? found[0] : found.length;
})()`;

// Runs in an isolated world, whose prototypes, clock and view of the document's origin page script
// cannot replace, and returns no value. Frameworks such as React notice a native value write
// followed by an input event.
const WRITE_FIELD = `function (value, deadline, origin) {
  if (location.origin !== origin) return "left";
  const types = ["text", "password", "email", "tel", "number", "search", "url"];
  const proto =
    this instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : this instanceof HTMLInputElement && types.includes(this.type)
        ? HTMLInputElement.prototype
        : undefined;
  if (proto === undefined) return "not_field";
  if (this.disabled || this.readOnly) return "not_editable";
  const native = Object.getOwnPropertyDescriptor(proto, "value");
  if (Date.now() >= deadline) return "expired";
  // Left out of the form state Back or Forward would refill into a later document.
  this.setAttribute("autocomplete", "off");
  this.style.setProperty("-webkit-text-security", "disc", "important");
  this.focus();
  // The page's focus handlers have run, and may have taken the time, the field or the page.
  if (Date.now() >= deadline) return "expired";
  if (location.origin !== origin) return "left";
  if (!this.isConnected || this.ownerDocument !== document) return "gone";
  native.set.call(this, value);
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return native.get.call(this) === value ? "filled" : "changed";
}`;

interface FrameNode {
  readonly frame: { readonly id: string; readonly loaderId: string; readonly url: string };
  readonly childFrames?: ReadonlyArray<FrameNode>;
}
const flattenFrames = (tree: FrameNode): ReadonlyArray<FrameNode["frame"]> => [
  tree.frame,
  ...(tree.childFrames ?? []).flatMap(flattenFrames),
];

/** An out-of-process frame has its own session; any other frame is in its nearest such parent's. */
const sessionFor = async (page: Page, frame: Frame, cdp: CDPSession) => {
  for (
    let current: Frame | null = frame;
    current !== null && current !== page.mainFrame();
    current = current.parentFrame()
  ) {
    const own = await page
      .context()
      .newCDPSession(current)
      .catch(() => undefined);
    if (own !== undefined) return { session: own, owned: true };
  }
  return { session: cdp, owned: false };
};

// Longer timers overflow to an immediate one.
const MAX_TIMER_MS = 2_147_483_647;

/** What `before` gives once its deadline passes. */
export const LATE = Symbol("late");

/** The promise's outcome, or `LATE` once `deadline` (in `Date.now()` time) passes first. */
export const before = <A>(promise: Promise<A>, deadline: number): Promise<A | typeof LATE> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(
      () => resolve(LATE),
      Math.min(MAX_TIMER_MS, Math.max(0, deadline - Date.now())),
    );
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

export type ElementCall =
  | { readonly status: "returned"; readonly value: unknown }
  /** `expired` once the deadline passed or the caller gave up. */
  | { readonly status: "expired" | "threw" }
  /** The element is not in exactly one frame the caller allows, or could not be tagged there. */
  | { readonly status: "left" }
  /** The element's frame or the main page loaded another document since the call began. */
  | { readonly status: "moved" };

/**
 * Calls a function on the element `handle` points at and nowhere else, from an isolated world page
 * script cannot reach. A nonce tag, which the page can copy, only leads to the browser's identity
 * for the node, in the document the call is for; the call resolves that node afresh. The function
 * gets `args`, then the deadline and the element's origin, to check in the page itself.
 */
export const callOnElement = async (input: {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly handle: ElementHandle;
  readonly frameAllowed: (frameUrl: string) => boolean;
  /** The main document the call is for, as `documentId` named it. */
  readonly document: string;
  /** In `Date.now()` time. */
  readonly deadline: number;
  /** Aborted once nobody waits for the call; the function is not sent to the page after that. */
  readonly signal?: AbortSignal | undefined;
  readonly functionDeclaration: string;
  readonly args: ReadonlyArray<string | number>;
}): Promise<ElementCall> => {
  const late = () => Date.now() >= input.deadline || input.signal?.aborted === true;
  const frame = await input.handle.ownerFrame();
  if (frame === null || !input.frameAllowed(frame.url())) return { status: "left" };
  const origin = new URL(frame.url()).origin;
  const owner = await sessionFor(input.page, frame, input.cdp);
  const { session } = owner;
  const release = (objectId: string) =>
    void session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  const frames = async () => flattenFrames((await session.send("Page.getFrameTree")).frameTree);
  try {
    if (late()) return { status: "expired" };
    const untagged = await frames();
    const tag = `data-t3-fill-${NodeCrypto.randomUUID()}`;
    const marked = await input.handle
      .evaluate(
        (element, name) =>
          (
            element as unknown as { setAttribute: (name: string, value: string) => void }
          ).setAttribute(name, ""),
        tag,
      )
      .then(
        () => true,
        () => false,
      );
    if (!marked) return { status: "left" };
    const found: Array<{ readonly frameId: string; readonly objectId: string }> = [];
    let node: { readonly frameId: string; readonly backendNodeId: number };
    try {
      for (const allowed of untagged.filter((each) => input.frameAllowed(each.url))) {
        if (late()) return { status: "expired" };
        const tagged = await session
          .send("Page.createIsolatedWorld", { frameId: allowed.id, worldName: FILL_WORLD })
          .then(({ executionContextId }) =>
            session.send("Runtime.evaluate", {
              contextId: executionContextId,
              expression: findTagged(tag, origin),
            }),
          )
          .catch(() => undefined);
        const objectId = tagged?.result.objectId;
        if (objectId === undefined) continue;
        if (tagged?.exceptionDetails === undefined && tagged?.result.subtype === "node") {
          found.push({ frameId: allowed.id, objectId });
        } else {
          release(objectId);
        }
      }
      // Missing from every allowed frame, or copied onto another element.
      const [only] = found;
      if (only === undefined || found.length > 1) return { status: "left" };
      if (late()) return { status: "expired" };
      const described = await session
        .send("DOM.describeNode", { objectId: only.objectId })
        .catch(() => undefined);
      // The object went with its document.
      if (described === undefined) return { status: "moved" };
      node = { frameId: only.frameId, backendNodeId: described.node.backendNodeId };
    } finally {
      for (const { objectId } of found) release(objectId);
    }
    // Found in the document its frame held before the tag went on, and the call's page still shows.
    const loaderOf = (list: ReadonlyArray<FrameNode["frame"]>) =>
      list.find((each) => each.id === node.frameId)?.loaderId;
    if (
      loaderOf(await frames()) !== loaderOf(untagged) ||
      (await documentId(input.cdp)) !== input.document
    ) {
      return { status: "moved" };
    }
    if (late()) return { status: "expired" };
    // A document loaded from here on detaches the node's own, so the node no longer resolves.
    const objectId = await session
      .send("Page.createIsolatedWorld", { frameId: node.frameId, worldName: FILL_WORLD })
      .then(({ executionContextId }) =>
        session.send("DOM.resolveNode", {
          backendNodeId: node.backendNodeId,
          executionContextId,
        }),
      )
      .then(
        ({ object }) => object.objectId,
        () => undefined,
      );
    if (objectId === undefined) return { status: "moved" };
    try {
      if (late()) return { status: "expired" };
      const called = await before(
        session
          .send("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: input.functionDeclaration,
            arguments: [...input.args, input.deadline, origin].map((value) => ({ value })),
            returnByValue: true,
          })
          .catch(() => undefined),
        input.deadline,
      );
      if (called === LATE) return { status: "expired" };
      // The node's world went with its document.
      if (called === undefined) return { status: "moved" };
      return called.exceptionDetails === undefined
        ? { status: "returned", value: called.result.value }
        : { status: "threw" };
    } finally {
      release(objectId);
    }
  } finally {
    if (owner.owned) void owner.session.detach().catch(() => undefined);
  }
};

/**
 * Writes into the element the locator resolved to and nowhere else; keystrokes would follow focus
 * into any frame. Only frames on the login's site are written, only in the document the fill is
 * for, and never after the deadline or once `signal` aborts.
 */
export const fillCovered = async (input: {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly field: PreviewLoginField;
  readonly target: Locator;
  readonly value: string;
  readonly frameCovered: (frameUrl: string) => boolean;
  /** The main document the fill is for, as `documentId` named it. */
  readonly document: string;
  /** In `Date.now()` time. */
  readonly deadline: number;
  /** Aborted once nobody waits for the call. */
  readonly signal?: AbortSignal | undefined;
}) => {
  const expired = () => loginError("The call ended before the login was filled.");
  const left = () => loginError("The page left the login's site before it was filled.");
  const remaining = input.deadline - Date.now();
  if (remaining <= 0 || input.signal?.aborted) throw expired();
  const handle = await input.target.elementHandle({ timeout: Math.min(MAX_TIMER_MS, remaining) });
  if (handle === null) throw loginError("A login field disappeared before it was filled.");
  try {
    const call = await callOnElement({
      page: input.page,
      cdp: input.cdp,
      handle,
      frameAllowed: input.frameCovered,
      document: input.document,
      deadline: input.deadline,
      signal: input.signal,
      functionDeclaration: WRITE_FIELD,
      args: [input.value],
    });
    switch (call.status) {
      case "expired":
        throw expired();
      case "left":
        throw left();
      case "moved":
        throw loginError(
          "The page loaded another document before the login was filled. Take a fresh snapshot and try again.",
        );
      case "threw":
        throw loginError(`The ${input.field} field could not be filled.`);
    }
    switch (call.value) {
      case "filled":
        return;
      case "expired":
        throw expired();
      case "left":
        throw left();
      case "gone":
        throw loginError("A login field disappeared before it was filled.");
      case "not_editable":
        throw loginError(`The ${input.field} field is disabled or read-only.`);
      case "changed":
        throw loginError(
          `The page changed the ${input.field} field as it was filled. Check the page before submitting.`,
        );
      default:
        throw loginError(`The ${input.field} locator does not point at a text field.`);
    }
  } finally {
    await handle.dispose().catch(() => undefined);
  }
};

/** The origin of an address, or none when it has none of its own, as a blank page's has. */
const originsOf = (url: string) => {
  const origin = URL.canParse(url) ? new URL(url).origin : "null";
  return origin === "null" ? [] : [origin];
};

/**
 * Names the page a fill is checked against: its main document, then the origins its frames are
 * on. A new main document changes the name, and so does a frame that comes onto another origin.
 * So a write that finds the name unchanged lands on an origin the fill has checked and marked.
 */
export const documentId = async (cdp: CDPSession): Promise<string> => {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const origins = new Set(flattenFrames(frameTree).flatMap((frame) => originsOf(frame.url)));
  return [frameTree.frame.loaderId, ...[...origins].toSorted()].join(" ");
};

/** The main document in a name `documentId` gave, as the browser itself names it. */
const mainDocument = (document: string) => document.split(" ", 1)[0] ?? document;

/** `tab` names the tab the login was filled in, as the agent would. */
export const scriptOff = (origin: string, tab: string) =>
  loginError(
    `The password manager filled a login on this site (${origin}) in ${tab}, and a window a page opened joins the tabs here, so script could reach that login. preview_evaluate stays off on this site in these tabs. Open the site in a new tab with preview_open: it stays signed in, and script runs there.`,
  );
const fillOff = (origin: string) =>
  loginError(
    `preview_evaluate has run on this site (${origin}) in this tab or one joined to it by a window a page opened, where script left running could read a login. So the password manager fills none into a page that is on this site or frames it. Open the page in a new tab with preview_open and fill it there, before any preview_evaluate.`,
  );
const SCRIPTED_PAGE =
  "preview_evaluate ran in this page, so no login is filled into it. Load the page again with preview_navigate, then fill it.";
const TAB_CLOSED = "The tab closed.";

/**
 * The origins of the frames now in a page, by their addresses. A frame without one of its own,
 * such as a blank one, is on the origin of the frame that made it.
 */
export const frameOrigins = (page: Page): ReadonlyArray<string> => [
  ...new Set(page.frames().flatMap((frame) => originsOf(frame.url()))),
];

// Each is called on a page's own global object. A blank page's address has no origin;
// `origin` is the one it inherited from its opener, unless the page made that name its own.
const SCRIPT_ORIGINS = `function () {
  const own = this.origin;
  return [location.origin, typeof own === "string" ? own : null];
}`;
// Runs the source as a script of the page, with its last value, as `Runtime.evaluate` does.
const RUN_SCRIPT = "function (source) { return (0, eval)(source); }";
const PAGE_MOVED =
  "The page loaded another document before the script ran, so it did not run. Call preview_evaluate again.";

const UNKNOWN_SITE =
  "This page does not say which site it is on, so preview_evaluate did not run. Load the page again with preview_navigate.";

/** The origins a page's script runs on, from the page's answer to `SCRIPT_ORIGINS`. */
const scriptOrigins = (answer: unknown): ReadonlyArray<string> => {
  const [address, own] = Array.isArray(answer) ? (answer as ReadonlyArray<unknown>) : [];
  // Only a page with an address of its own can do without the origin it would have inherited.
  if (typeof address !== "string" || (typeof own !== "string" && address === "null")) {
    throw loginError(UNKNOWN_SITE);
  }
  return [...new Set([address, own ?? address])].filter(
    (origin): origin is string => typeof origin === "string" && origin !== "null",
  );
};

/** The origin a page's main frame shows by its address, if that has one. */
export const pageOrigins = async (cdp: CDPSession): Promise<ReadonlyArray<string>> =>
  originsOf((await cdp.send("Page.getFrameTree")).frameTree.frame.url);

export const FILL_CAME =
  "A login was filled in this tab as the script was about to run, so it did not run. Call preview_evaluate again.";
const HISTORY_KEPT =
  "This tab's history could not be cleared, so the script did not run: after a login is filled in a tab, script runs there only once Back can bring no filled value up. Call preview_evaluate again.";

/** The page agent script is about to run in. */
export interface ScriptPage {
  /** Its main document, as the browser names it. */
  readonly document: string;
  readonly origins: ReadonlyArray<string>;
  /** Whether it was loaded fresh. Not read for a tab no login had been filled in. */
  readonly fresh: boolean | undefined;
  /** Whether the tab's history was cleared for this script. */
  readonly cleared: boolean;
}

/**
 * Why agent script may not run in a page: it may show a filled value, a login was filled in its
 * tab while it was looked at, or a tab its windows reach holds a login on its site.
 */
export type ScriptRefusal =
  | { readonly _tag: "shows" }
  | { readonly _tag: "changed" }
  | { readonly _tag: "reached"; readonly origin: string; readonly tab: string };

/** Decides on agent script for one tab. `check` and `admit` throw to refuse the page. */
export interface ScriptGate {
  /** Whether a login was filled in the tab, and whether its history may still hold one. */
  readonly fills: () => "none" | "cleared" | "kept";
  readonly check: (page: ScriptPage) => void;
  /** Checks again, and in the same step marks the page as one script ran in. */
  readonly admit: (page: ScriptPage) => void;
}

/**
 * Runs agent script in a page the gate admits, and nowhere else: the script is bound to the
 * page's global object, whose id dies with its document, so a page loaded in between fails the
 * call. Every question is asked between two readings of the tab's main document. Documents only
 * follow one another, so two equal readings mean each answer was about that document.
 */
export const evaluateAdmitted = (
  cdp: CDPSession,
  input: PreviewAutomationEvaluateInput,
  timeoutMs: number,
  gate: ScriptGate,
) =>
  evaluate(cdp, input, timeoutMs, async ({ expression, ...options }) => {
    const mainFrame = async () => (await cdp.send("Page.getFrameTree")).frameTree.frame;
    const { id: frameId, loaderId: document } = await mainFrame();
    const { result: page } = await cdp.send("Runtime.evaluate", { expression: "this" });
    const objectId = page.objectId;
    if (objectId === undefined) throw loginError(UNKNOWN_SITE);
    const onPage = (functionDeclaration: string, rest: object) =>
      cdp
        .send("Runtime.callFunctionOn", { objectId, functionDeclaration, ...rest })
        .catch((cause: unknown) => {
          throw String(cause).includes("Cannot find context") ? loginError(PAGE_MOVED) : cause;
        });
    try {
      const { result, exceptionDetails } = await onPage(SCRIPT_ORIGINS, { returnByValue: true });
      const origins = scriptOrigins(exceptionDetails === undefined ? result.value : undefined);
      const fills = gate.fills();
      const fresh =
        fills === "none"
          ? undefined
          : await loadedFresh(
              (method, params) => cdp.send(method as "Page.createIsolatedWorld", params as never),
              frameId,
            );
      gate.check({ document, origins, fresh, cleared: false });
      // Script can open a window that outlives its page and reads the tab's later ones. History
      // is where a filled value outlives a page, so none is left for Back to bring up.
      const cleared = fills === "kept";
      if (cleared) {
        await cdp.send("Page.resetNavigationHistory").catch(() => {
          throw loginError(HISTORY_KEPT);
        });
      }
      if ((await mainFrame()).loaderId !== document) throw loginError(PAGE_MOVED);
      gate.admit({ document, origins, fresh, cleared });
      return await onPage(RUN_SCRIPT, { arguments: [{ value: expression }], ...options });
    } finally {
      void cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  });

/** Tabs whose pages can hold each other's windows, because a page of one opened another. */
interface Family {
  /** Whether a page of a tab here ever opened a window. Alone, a tab's script dies with its page. */
  joined: boolean;
  /** Origins agent script has run on in these tabs. */
  readonly scripted: Set<string>;
}

/**
 * Keeps agent script and filled logins apart. A tab's script dies with its page, so there the
 * two are kept apart page by page: no script where a filled value may show, no fill where script
 * ran. Once a page opens a window, script can live on in it and read the tab's later pages, so
 * tabs a window joins are kept apart site by site.
 */
export const makeDocumentMarks = () => {
  /** Windows a page opened, which are no tab yet. */
  const windows = new Map<unknown, Family>();
  const tabs = new Map<
    string,
    {
      readonly family: Family;
      readonly origins: () => ReadonlyArray<string>;
      /** Main documents agent script ran in. */
      readonly scripts: Set<string>;
      /** Main documents a login was filled into. */
      readonly documents: Set<string>;
      /** Origins that had a frame in the tab's page when a login was filled into it. */
      readonly filled: Set<string>;
      /** Whether a login was filled since the tab's history was last cleared. */
      kept: boolean;
    }
  >();
  /** Throws where agent script has run on one of the origins, in tabs a window joins. */
  const refuseScripted = (family: Family, origins: ReadonlyArray<string>) => {
    if (!family.joined) return;
    const origin = origins.find((each) => family.scripted.has(each));
    if (origin !== undefined) throw fillOff(origin);
  };
  const known = (tab: string) => {
    const marks = tabs.get(tab);
    if (marks === undefined) throw loginError(TAB_CLOSED);
    return marks;
  };
  const scriptRefusal = (tab: string, page: ScriptPage): ScriptRefusal | undefined => {
    const marks = known(tab);
    if (marks.documents.size > 0) {
      if (page.fresh === undefined) return { _tag: "changed" };
      if (marks.documents.has(page.document) || !page.fresh) return { _tag: "shows" };
    }
    if (!marks.family.joined) return undefined;
    for (const [other, each] of tabs) {
      const origin = page.origins.find((found) => each.filled.has(found));
      if (each.family === marks.family && origin !== undefined) {
        return { _tag: "reached", origin, tab: other };
      }
    }
    return undefined;
  };
  return {
    /** A page of the tab opened a window, or is about to. */
    windowOpened: (tab: string) => {
      const marks = tabs.get(tab);
      if (marks !== undefined) marks.family.joined = true;
    },
    /** A window a tab's page opened can hold that page's script before it is a tab itself. */
    hold: (opener: string, window: unknown) => {
      const family = tabs.get(opener)?.family;
      if (family === undefined) return;
      family.joined = true;
      windows.set(window, family);
    },
    release: (window: unknown) => {
      windows.delete(window);
    },
    /**
     * A tab's page is known. `origins` names the origins of the frames now in it, and `window`
     * is the page itself where another tab's page opened it.
     */
    open: (tab: string, origins: () => ReadonlyArray<string>, window?: unknown) => {
      // A desktop tab whose connection came back keeps what its page held.
      const held = tabs.get(tab);
      const family = held?.family ??
        windows.get(window) ?? { joined: false, scripted: new Set<string>() };
      // While the connection was away, script left in the page could open a window unseen.
      if (held !== undefined && held.scripts.size > 0) family.joined = true;
      tabs.set(tab, {
        family,
        origins,
        scripts: held?.scripts ?? new Set(),
        documents: held?.documents ?? new Set(),
        filled: held?.filled ?? new Set(),
        kept: held?.kept ?? false,
      });
    },
    /** The tab's page is gone, and with it its history, where a filled value outlives a page. */
    close: (tab: string) => {
      tabs.delete(tab);
    },
    /** Whether a login was filled in the tab, and whether its history may still hold one. */
    fills: (tab: string) => {
      const marks = tabs.get(tab);
      if (marks === undefined || marks.documents.size === 0) return "none" as const;
      return marks.kept ? ("kept" as const) : ("cleared" as const);
    },
    scriptRefusal,
    /**
     * Marks the page agent script is about to run in, in the same step as finding nothing
     * against it. Otherwise marks nothing and says why.
     */
    admitScript: (tab: string, page: ScriptPage): ScriptRefusal | undefined => {
      const refusal = scriptRefusal(tab, page);
      if (refusal !== undefined) return refusal;
      const marks = known(tab);
      // A login filled since the history was looked at.
      if (marks.kept && !page.cleared) return { _tag: "changed" };
      marks.kept = false;
      marks.scripts.add(page.document);
      for (const origin of page.origins) marks.family.scripted.add(origin);
      return undefined;
    },
    /** Script that has run may have taken its page to these origins. */
    noteScript: (tab: string, origins: ReadonlyArray<string>) => {
      const scripted = tabs.get(tab)?.family.scripted;
      for (const origin of origins) scripted?.add(origin);
    },
    /**
     * Whether agent script ran in the page, as `documentId` named it. Throws where script has run
     * on the origin of a frame in the page, then or now, in tabs a window joins.
     */
    wasScripted: (tab: string, document: string): boolean => {
      const { family, origins, scripts } = known(tab);
      if (scripts.has(mainDocument(document))) return true;
      refuseScripted(family, [...document.split(" ").slice(1), ...origins()]);
      return false;
    },
    /** Checks the same again, and in the same step marks the page and its origins filled. */
    markFilled: (tab: string, document: string) => {
      const marks = known(tab);
      if (marks.scripts.has(mainDocument(document))) throw loginError(SCRIPTED_PAGE);
      const origins = [...document.split(" ").slice(1), ...marks.origins()];
      refuseScripted(marks.family, origins);
      for (const origin of origins) marks.filled.add(origin);
      marks.documents.add(mainDocument(document));
      marks.kept = true;
    },
    /** The documents a login was filled into, for a tab that has had one. */
    filled: (tab: string): ReadonlySet<string> | undefined => {
      const documents = tabs.get(tab)?.documents;
      return documents !== undefined && documents.size > 0 ? documents : undefined;
    },
  };
};

const REDACTED = "[filled by password manager]";

// As Playwright collapses accessible names and snapshot text.
const collapsed = (text: string) =>
  text
    .replace(/[\u200b\u00ad]/g, "")
    .trim()
    .replace(/\s+/g, " ");

/**
 * A shorter secret would match ordinary words and numbers, and a line break would not survive a
 * single-line field, so the page would hold a value scrubbing cannot find. Neither is filled.
 */
export const scrubbable = (secret: string) =>
  secret.length >= 4 && collapsed(secret).length >= 4 && !/[\r\n]/.test(secret);

/**
 * The ways text can hold a secret: as is or with whitespace collapsed, each JSON-escaped (logs,
 * snapshot names), with Playwright's `\xNN` escapes (snapshot text), URL-encoded (a form sent in
 * the address), and with `'` doubled inside a single-quoted snapshot key.
 */
const secretForms = (secret: string) =>
  [secret, collapsed(secret)].flatMap((base) => {
    const quoted = base.replace(/[\\"\p{Cc}]/gu, (char) =>
      '\\"\b\f\n\r\t'.includes(char)
        ? JSON.stringify(char).slice(1, -1)
        : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
    const encoded = [
      new URLSearchParams([["", base]]).toString().slice(1),
      encodeURIComponent(base.toWellFormed()),
    ];
    return [base, JSON.stringify(base).slice(1, -1), quoted, ...encoded].flatMap((form) => [
      form,
      form.replaceAll("'", "''"),
    ]);
  });

const scrubForms = <A>(value: A, forms: ReadonlyArray<string>): A => {
  const scrubText = (text: string) => {
    const spans: Array<readonly [number, number]> = [];
    for (const form of forms) {
      for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
        spans.push([at, at + form.length]);
      }
    }
    if (spans.length === 0) return text;
    spans.sort((a, b) => a[0] - b[0]);
    let next = "";
    let kept = 0;
    let [start, end] = spans[0]!;
    for (const [from, to] of spans) {
      if (from > end) {
        next += text.slice(kept, start) + REDACTED;
        kept = end;
        start = from;
      }
      end = Math.max(end, to);
    }
    return next + text.slice(kept, start) + REDACTED + text.slice(end);
  };
  const scrub = (current: unknown): unknown => {
    if (typeof current === "string") return scrubText(current);
    if (Array.isArray(current)) return current.map(scrub);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current).map(([key, entry]) => [scrubText(key), scrub(entry)]),
      );
    }
    return current;
  };
  return scrub(value) as A;
};

const formsOf = (secrets: Iterable<string>) =>
  new Set([...secrets].flatMap(secretForms).filter((form) => form.length > 0));

/**
 * Replaces every occurrence of every given secret, in any of its forms, in the keys and values
 * of something page-derived. Overlapping or touching occurrences become one marker.
 */
export const scrubSecrets = <A>(value: A, secrets: Iterable<string>): A => {
  const forms = formsOf(secrets);
  return forms.size === 0 ? value : scrubForms(value, [...forms]);
};

/** Every password and code filled while the server runs: any page may show one again later. */
export const makeFilledSecrets = () => {
  let forms: ReadonlyArray<string> = [];
  return {
    remember: (values: Iterable<string>) => {
      forms = [...new Set([...forms, ...formsOf(values)])];
    },
    scrub: <A>(value: A): A => (forms.length === 0 ? value : scrubForms(value, forms)),
  };
};
