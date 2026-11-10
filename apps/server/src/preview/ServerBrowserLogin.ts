// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.
import type { PreviewLoginField } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import type { CDPSession, Frame, Locator, Page } from "playwright-core";

import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";

const LOGIN_ERROR = "PreviewAutomationExecutionError";

export const loginError = (message: string) =>
  new ServerBrowserOperationError(LOGIN_ERROR, message);

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

const FILL_WORLD = "t3-preview-login-fill";

/** Finds and untags the element a fill tagged, in this document and its open shadow roots. */
const findTagged = (tag: string) => `(() => {
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

// Runs in an isolated world, whose prototypes and clock page script cannot replace, and returns
// no value. Frameworks such as React notice a native value write followed by an input event.
const WRITE_FIELD = `function (value, deadline) {
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
  this.style.setProperty("-webkit-text-security", "disc", "important");
  this.focus();
  // The page's focus handlers have run, and may have taken the time or the field.
  if (Date.now() >= deadline) return "expired";
  if (!this.isConnected || this.ownerDocument !== document) return "gone";
  native.set.call(this, value);
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return native.get.call(this) === value ? "filled" : "changed";
}`;

interface FrameNode {
  readonly frame: { readonly id: string; readonly url: string };
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

const before = <A>(promise: Promise<A>, deadline: number, expired: () => Error) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(expired()),
      Math.min(MAX_TIMER_MS, Math.max(0, deadline - Date.now())),
    );
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

/**
 * Writes into the element the locator resolved to and nowhere else; keystrokes would follow focus
 * into any frame. A nonce tag finds it again from an isolated world, only in frames on the login's
 * site. Objects die with their document, and the write checks the deadline in the page itself.
 */
export const fillCovered = async (input: {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly field: PreviewLoginField;
  readonly target: Locator;
  readonly value: string;
  readonly frameCovered: (frameUrl: string) => boolean;
  /** In `Date.now()` time. */
  readonly deadline: number;
}) => {
  const expired = () => loginError("The call ended before the login was filled.");
  const left = () => loginError("The page left the login's site before it was filled.");
  const remaining = () => {
    const ms = input.deadline - Date.now();
    if (ms <= 0) throw expired();
    return Math.min(MAX_TIMER_MS, ms);
  };
  const handle = await input.target.elementHandle({ timeout: remaining() });
  if (handle === null) throw loginError("A login field disappeared before it was filled.");
  const tag = `data-t3-fill-${NodeCrypto.randomUUID()}`;
  let owner: { readonly session: CDPSession; readonly owned: boolean } | undefined;
  try {
    const frame = await handle.ownerFrame();
    if (frame === null || !input.frameCovered(frame.url())) throw left();
    owner = await sessionFor(input.page, frame, input.cdp);
    const { session } = owner;
    remaining();
    await handle
      .evaluate(
        (element, name) =>
          (
            element as unknown as { setAttribute: (name: string, value: string) => void }
          ).setAttribute(name, ""),
        tag,
      )
      .catch(() => {
        throw left();
      });
    const { frameTree } = await session.send("Page.getFrameTree");
    const found: Array<string> = [];
    for (const covered of flattenFrames(frameTree).filter((each) => input.frameCovered(each.url))) {
      remaining();
      const tagged = await session
        .send("Page.createIsolatedWorld", { frameId: covered.id, worldName: FILL_WORLD })
        .then(({ executionContextId }) =>
          session.send("Runtime.evaluate", {
            contextId: executionContextId,
            expression: findTagged(tag),
          }),
        )
        .catch(() => undefined);
      const objectId = tagged?.result.objectId;
      if (objectId === undefined) continue;
      if (tagged?.exceptionDetails === undefined && tagged?.result.subtype === "node") {
        found.push(objectId);
      } else {
        void session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
    try {
      // Missing from every frame on the login's site, or copied onto another element.
      const [objectId] = found;
      if (objectId === undefined || found.length > 1) throw left();
      remaining();
      const { result, exceptionDetails } = await before(
        session.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: WRITE_FIELD,
          arguments: [{ value: input.value }, { value: input.deadline }],
          returnByValue: true,
        }),
        input.deadline,
        expired,
      );
      if (exceptionDetails !== undefined) {
        throw loginError(`The ${input.field} field could not be filled.`);
      }
      switch (result.value) {
        case "filled":
          return;
        case "expired":
          throw expired();
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
      for (const objectId of found) {
        void session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
  } finally {
    await handle.dispose().catch(() => undefined);
    if (owner?.owned) void owner.session.detach().catch(() => undefined);
  }
};

/** The page's current main document; a navigation to a new document changes it. */
export const documentId = async (cdp: CDPSession): Promise<string> => {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  return frameTree.frame.loaderId;
};

interface DocumentMarks {
  /** Documents the agent ran script in, where it could have hooked a later fill. */
  readonly scripted: Set<string>;
  /** Documents a login was filled into, where script could read it back. */
  readonly filled: Set<string>;
}

const marks = new WeakMap<Page, DocumentMarks>();
const marksOf = (page: Page) => {
  const existing = marks.get(page);
  if (existing) return existing;
  const created: DocumentMarks = { scripted: new Set(), filled: new Set() };
  marks.set(page, created);
  return created;
};

/**
 * The agent's script and a filled login never share a document: script ran first means reload
 * before filling, and a fill means a new document before script runs again.
 */
export const markScripted = (page: Page, documentIds: ReadonlyArray<string>) => {
  for (const id of documentIds) marksOf(page).scripted.add(id);
};
export const wasScripted = (page: Page, id: string) => marksOf(page).scripted.has(id);
export const markFilled = (page: Page, id: string) => marksOf(page).filled.add(id);
export const holdsFill = (page: Page, id: string) => marksOf(page).filled.has(id);

const REDACTED = "[filled by password manager]";

/**
 * A shorter secret would match ordinary words and numbers, and a line break would not survive a
 * single-line field, so the page would hold a value scrubbing cannot find. Neither is filled.
 */
export const scrubbable = (secret: string) => secret.length >= 4 && !/[\r\n]/.test(secret);

/** Replaces every given secret, longest first, in the keys and values of something page-derived. */
export const scrubSecrets = <A>(value: A, secrets: Iterable<string>): A => {
  const ordered = [...new Set(secrets)]
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return value;
  const scrubText = (text: string) => {
    let next = text;
    for (const secret of ordered) next = next.split(secret).join(REDACTED);
    return next;
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

/** Every password and code filled while the server runs: any page may show one again later. */
export const makeFilledSecrets = () => {
  const secrets = new Set<string>();
  return {
    remember: (values: Iterable<string>) => {
      for (const value of values) if (value.length > 0) secrets.add(value);
    },
    scrub: <A>(value: A): A => (secrets.size === 0 ? value : scrubSecrets(value, secrets)),
  };
};
