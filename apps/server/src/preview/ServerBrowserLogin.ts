import type { PreviewLoginField } from "@t3tools/contracts";
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
}): Promise<LoginTargets> => {
  const targets = new Map<PreviewLoginField, Locator>();
  const missing: PreviewLoginField[] = [];
  const frames = [input.page.mainFrame(), ...input.page.frames()].filter(
    (frame, index, all) => all.indexOf(frame) === index && input.frameCovered(frame.url()),
  );
  for (const field of input.fields) {
    const given = input.locators[field];
    if (given !== undefined) {
      const handle = await given.elementHandle({ timeout: 5_000 });
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
 * Writes through a handle bound to the element, so a frame that navigates after the site check
 * cannot receive the value. Playwright types natively, bypassing page wrappers of the value
 * setter. The field is drawn as dots first, so images stay clean if the page reveals it.
 */
export const fillCovered = async (input: {
  readonly target: Locator;
  readonly value: string;
  readonly frameCovered: (frameUrl: string) => boolean;
  readonly timeoutMs: number;
}) => {
  const timeout = Math.max(1, input.timeoutMs);
  const handle = await input.target.elementHandle({ timeout });
  if (handle === null) throw loginError("A login field disappeared before it was filled.");
  try {
    const frame = await handle.ownerFrame();
    if (frame === null || !input.frameCovered(frame.url())) {
      throw loginError("The page left the login's site before it was filled.");
    }
    await handle.evaluate((element) =>
      (
        element as unknown as {
          readonly style: { setProperty: (name: string, value: string) => void };
        }
      ).style.setProperty("-webkit-text-security", "disc"),
    );
    await handle.fill(input.value, { timeout });
  } finally {
    await handle.dispose().catch(() => undefined);
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
/** Shorter values would redact ordinary words and numbers from every result. */
const MIN_SECRET_LENGTH = 4;

/** Replaces every filled secret, longest first, in the keys and values of something page-derived. */
export const scrubSecrets = <A>(value: A, secrets: Iterable<string>): A => {
  const ordered = [...new Set(secrets)]
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
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
