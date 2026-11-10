// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.
import type { PreviewLoginField } from "@t3tools/contracts";
import { type FilledDocuments, withoutFragment } from "@t3tools/shared/browserLoginExposure";
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
 * into any frame. A nonce tag, which the page can copy, only leads from Playwright to the
 * browser's own identity for the node, taken in the document the fill is for. The write resolves
 * that node afresh, confirms the document's origin from inside, and checks the deadline there.
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
}) => {
  const expired = () => loginError("The call ended before the login was filled.");
  const left = () => loginError("The page left the login's site before it was filled.");
  const moved = () =>
    loginError(
      "The page loaded another document before the login was filled. Take a fresh snapshot and try again.",
    );
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
    const origin = new URL(frame.url()).origin;
    owner = await sessionFor(input.page, frame, input.cdp);
    const { session } = owner;
    const release = (objectId: string) =>
      void session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    const frames = async () => flattenFrames((await session.send("Page.getFrameTree")).frameTree);
    remaining();
    const untagged = await frames();
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
    const found: Array<{ readonly frameId: string; readonly objectId: string }> = [];
    for (const covered of untagged.filter((each) => input.frameCovered(each.url))) {
      remaining();
      const tagged = await session
        .send("Page.createIsolatedWorld", { frameId: covered.id, worldName: FILL_WORLD })
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
        found.push({ frameId: covered.id, objectId });
      } else {
        release(objectId);
      }
    }
    let node: { readonly frameId: string; readonly backendNodeId: number };
    try {
      // Missing from every frame on the login's site, or copied onto another element.
      const [only] = found;
      if (only === undefined || found.length > 1) throw left();
      remaining();
      const described = await session.send("DOM.describeNode", { objectId: only.objectId });
      node = { frameId: only.frameId, backendNodeId: described.node.backendNodeId };
    } finally {
      for (const { objectId } of found) release(objectId);
    }
    // Found in the document its frame held before the tag went on, and the fill's page still shows.
    const loaderOf = (list: ReadonlyArray<FrameNode["frame"]>) =>
      list.find((each) => each.id === node.frameId)?.loaderId;
    if (
      loaderOf(await frames()) !== loaderOf(untagged) ||
      (await documentId(input.cdp)) !== input.document
    ) {
      throw moved();
    }
    remaining();
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
    if (objectId === undefined) throw moved();
    try {
      remaining();
      const { result, exceptionDetails } = await before(
        session.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: WRITE_FIELD,
          arguments: [{ value: input.value }, { value: input.deadline }, { value: origin }],
          returnByValue: true,
        }),
        input.deadline,
        expired,
      ).catch((cause: unknown) => {
        // The node's world went with its document.
        throw cause instanceof ServerBrowserOperationError ? cause : moved();
      });
      if (exceptionDetails !== undefined) {
        throw loginError(`The ${input.field} field could not be filled.`);
      }
      switch (result.value) {
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
      release(objectId);
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

/**
 * What each tab's documents held, by tab, so a desktop tab that reconnects keeps it. The agent's
 * script and a filled login never share a document: script ran first means reload before filling,
 * and a fill means a new document before script runs again.
 */
export const makeDocumentMarks = () => {
  const tabs = new Map<
    string,
    {
      /** Documents the agent ran script in, where it could have hooked a later fill. */
      readonly scripted: Set<string>;
      /** Documents a login was filled into, and every address they showed. */
      readonly filled: { readonly documents: Set<string>; readonly urls: Set<string> };
    }
  >();
  const marksOf = (tab: string) => {
    const existing = tabs.get(tab);
    if (existing) return existing;
    const created = {
      scripted: new Set<string>(),
      filled: { documents: new Set<string>(), urls: new Set<string>() },
    };
    tabs.set(tab, created);
    return created;
  };
  return {
    markScripted: (tab: string, documentIds: ReadonlyArray<string>) => {
      for (const id of documentIds) marksOf(tab).scripted.add(id);
    },
    wasScripted: (tab: string, id: string) => tabs.get(tab)?.scripted.has(id) === true,
    markFilled: (tab: string, id: string, url: string) => {
      const { filled } = marksOf(tab);
      filled.documents.add(id);
      filled.urls.add(withoutFragment(url));
    },
    /** Keeps a later address of a filled document, such as one `pushState` gave it. */
    noteAddress: (tab: string, id: string, url: string) => {
      const filled = tabs.get(tab)?.filled;
      if (!filled?.documents.has(id)) return false;
      filled.urls.add(withoutFragment(url));
      return true;
    },
    filled: (tab: string): FilledDocuments | undefined => {
      const filled = tabs.get(tab)?.filled;
      return filled !== undefined && filled.documents.size > 0 ? filled : undefined;
    },
    forget: (tab: string) => void tabs.delete(tab),
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
