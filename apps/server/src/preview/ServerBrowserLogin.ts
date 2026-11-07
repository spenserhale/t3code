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

const filled = new WeakMap<Page, Set<string>>();

/** Secrets filled into a page, kept only to scrub them from what the agent reads back. */
export const filledSecrets = (page: Page): ReadonlySet<string> => filled.get(page) ?? new Set();

export const rememberFilled = (page: Page, values: ReadonlyArray<string>) => {
  const secrets = filled.get(page) ?? new Set<string>();
  for (const value of values) if (value.length > 0) secrets.add(value);
  filled.set(page, secrets);
};

const REDACTED = "[filled by password manager]";

/** Replaces every filled secret in a value bound for the agent. */
export const scrubSecrets = <A>(value: A, secrets: ReadonlySet<string>): A => {
  if (secrets.size === 0) return value;
  const scrub = (current: unknown): unknown => {
    if (typeof current === "string") {
      let next = current;
      for (const secret of secrets) next = next.split(secret).join(REDACTED);
      return next;
    }
    if (Array.isArray(current)) return current.map(scrub);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        // Image bytes are left alone; a short secret could match inside them by chance.
        Object.entries(current).map(([key, entry]) => [
          key,
          key === "screenshot" ? entry : scrub(entry),
        ]),
      );
    }
    return current;
  };
  return scrub(value) as A;
};

/** Whether a filled password still sits in an input of the page, where script could read it. */
export const pageHoldsSecret = async (page: Page, secrets: ReadonlySet<string>) => {
  if (secrets.size === 0) return false;
  for (const frame of page.frames()) {
    const values = await frame
      .locator('input[type="password"]')
      .evaluateAll((inputs) =>
        inputs.map((input) => (input as unknown as { readonly value: string }).value),
      )
      .catch(() => [] as string[]);
    if (values.some((value) => secrets.has(value))) return true;
  }
  return false;
};
