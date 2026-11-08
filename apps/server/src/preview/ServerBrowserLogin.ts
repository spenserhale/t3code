import type { PreviewLoginField } from "@t3tools/contracts";
import type { Frame, Locator, Page } from "playwright-core";

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
 * Writes one value into the element a locator points at, if its document is still on the site
 * the login covers. The origin is checked in the same page task as the write, and a handle from a
 * document that has since navigated cannot be evaluated, so a redirect cannot catch the value.
 * The field is drawn as dots (even if the page later reveals it) so images and recordings stay clean.
 */
export const fillCovered = async (input: {
  readonly target: Locator;
  readonly value: string;
  readonly frameCovered: (frameUrl: string) => boolean;
}) => {
  const handle = await input.target.elementHandle({ timeout: 10_000 });
  if (handle === null) throw loginError("A login field disappeared before it was filled.");
  try {
    const frame = await handle.ownerFrame();
    const frameUrl = frame?.url() ?? "";
    if (frame === null || !input.frameCovered(frameUrl)) {
      throw loginError("The page left the login's site before it was filled.");
    }
    const written = await handle.evaluate(
      (element, { value, origin }) => {
        // Runs in the page; the server's types have no DOM.
        const page = globalThis as unknown as {
          readonly location: { readonly origin: string };
          readonly Event: new (type: string, init: { readonly bubbles: boolean }) => unknown;
        };
        if (page.location.origin !== origin) return false;
        const field = element as unknown as {
          readonly style: { setProperty: (name: string, value: string) => void };
          focus: () => void;
          dispatchEvent: (event: unknown) => boolean;
        };
        const setter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(element),
          "value",
        )?.set;
        if (setter === undefined) return false;
        field.style.setProperty("-webkit-text-security", "disc");
        field.focus();
        // The prototype's setter, so frameworks that track the value (React) see the change.
        setter.call(element, value);
        field.dispatchEvent(new page.Event("input", { bubbles: true }));
        field.dispatchEvent(new page.Event("change", { bubbles: true }));
        return true;
      },
      { value: input.value, origin: new URL(frameUrl).origin },
    );
    if (!written) throw loginError("The page left the login's site before it was filled.");
  } finally {
    await handle.dispose().catch(() => undefined);
  }
};

const filled = new WeakMap<Page, Set<string>>();

/** Secrets filled into a page, kept only to scrub them from what the agent reads back. */
export const filledSecrets = (page: Page): ReadonlySet<string> => filled.get(page) ?? new Set();

export const rememberFilled = (page: Page, values: ReadonlyArray<string>) => {
  const secrets = filled.get(page) ?? new Set<string>();
  for (const value of values) if (value.length > 0) secrets.add(value);
  filled.set(page, secrets);
};

const REDACTED = "[filled by password manager]";

/**
 * Replaces every filled secret in a value bound for the agent, in keys as well as values. Only
 * image or video bytes (`data` beside a `mimeType`) are left alone: a short secret could match
 * inside them by chance, and the filled fields are drawn as dots.
 */
export const scrubSecrets = <A>(value: A, secrets: ReadonlySet<string>): A => {
  if (secrets.size === 0) return value;
  const scrubText = (text: string) => {
    let next = text;
    for (const secret of secrets) next = next.split(secret).join(REDACTED);
    return next;
  };
  const scrub = (current: unknown): unknown => {
    if (typeof current === "string") return scrubText(current);
    if (Array.isArray(current)) return current.map(scrub);
    if (current !== null && typeof current === "object") {
      const media = typeof (current as { readonly mimeType?: unknown }).mimeType === "string";
      return Object.fromEntries(
        Object.entries(current).map(([key, entry]) => [
          scrubText(key),
          media && key === "data" ? entry : scrub(entry),
        ]),
      );
    }
    return current;
  };
  return scrub(value) as A;
};

/**
 * Whether a filled secret still sits in any field of the page, where script could read or
 * transform it. A frame that cannot be checked counts as holding one.
 */
export const pageHoldsSecret = async (page: Page, secrets: ReadonlySet<string>) => {
  if (secrets.size === 0) return false;
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    const values = await frame
      .locator("input, textarea")
      .evaluateAll((fields) =>
        fields.map((field) => (field as unknown as { readonly value: string }).value),
      )
      .catch(() => undefined);
    if (values === undefined) return !frame.isDetached();
    if (values.some((value) => [...secrets].some((secret) => value.includes(secret)))) return true;
  }
  return false;
};
