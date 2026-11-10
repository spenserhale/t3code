import { it } from "@effect/vitest";
import type { SecretProviderIdentityValues } from "@t3tools/secret-provider-core/server/driver";
import * as Effect from "effect/Effect";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from "vite-plus/test";

import { loginCoversPage } from "./BrowserLogins.ts";
import {
  checkIdentityLocators,
  fillIdentity,
  fillIdentityField,
  makeIdentityContext,
  matchOption,
  type IdentityContext,
} from "./ServerBrowserIdentity.ts";

describe("matchOption", () => {
  const options = (...pairs: ReadonlyArray<readonly [value: string, label: string]>) =>
    pairs.map(([value, label]) => ({ value, label, disabled: false }));
  const cases = [
    ["a country by its code", options(["", "Choose"], ["US", "United States"]), "country", "us", 1],
    ["a country by its English name", options(["840", "United States"]), "country", "us", 0],
    ["a country saved as a name", options(["us", "United States"]), "country", "United States", 0],
    ["a state code by its name", options(["", "Choose"], ["il", "Illinois"]), "state", "IL", 1],
    ["a province name by its code", options(["ON", "Ont."]), "state", "Ontario", 0],
    ["a name without its accents", options(["qc", "Québec"]), "state", "Quebec", 0],
    ["no match", options(["CA", "Canada"]), "country", "us", undefined],
    ["only an empty option", options(["", ""]), "city", "Springfield", undefined],
  ] as const;
  it.each(cases)("finds %s", (_, given, value, stored, expected) => {
    expect(matchOption(given, value, stored)).toBe(expected);
  });

  it("skips a disabled option", () => {
    expect(
      matchOption([{ value: "US", label: "United States", disabled: true }], "country", "us"),
    ).toBeUndefined();
  });
});

const SIGNUP_PAGE = `
  <input id="first" autocomplete="given-name">
  <input id="last" autocomplete="section-a billing family-name">
  <input id="full" autocomplete="name">
  <input id="email" type="email" autocomplete="email">
  <input id="company" autocomplete="organization" value="Kept">
  <input id="hiddenTel" autocomplete="tel" style="display: none">
  <input id="zip" autocomplete="postal-code" disabled>
  <select id="state" autocomplete="address-level1">
    <option value="">Choose</option><option value="IL">Illinois</option><option>Ontario</option>
  </select>
  <select id="country" autocomplete="country">
    <option value="">Choose</option><option value="CA">Canada</option><option value="US">United States</option>
  </select>
  <input id="countryName" autocomplete="shipping country-name">
  <input id="bday" type="date" autocomplete="bday">
  <input id="job" autocomplete="organization-title">
  <iframe id="ad" src="https://ads.test/frame"></iframe>
  <iframe id="sub" src="https://accounts.shop.test/frame"></iframe>`;

const ADA: SecretProviderIdentityValues = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phone: "+1 555 0100",
  company: "Analytical Engines",
  birthDate: "1990-05-17",
  state: "IL",
  country: "us",
};

/** The calls here end only when they finish; each field still has its own short timeout. */
const NO_DEADLINE = Number.MAX_SAFE_INTEGER;

/** A server with one identity whose fills need no approval. */
const identityServer = Effect.fn("identityServer")(function* (
  values: SecretProviderIdentityValues,
) {
  const reads: Array<string> = [];
  const logins: IdentityContext["logins"] = {
    identityCandidates: () =>
      Effect.succeed({
        revision: "0",
        identities: [{ id: "work/me", title: "Me", account: "Work" }],
      }),
    readIdentity: (_revision, identity) =>
      Effect.sync(() => {
        reads.push(identity.id);
        return values;
      }),
    needsApproval: () => Effect.succeed(false),
    recordApproval: () => Effect.void,
    check: () => Effect.void,
  };
  const context = yield* makeIdentityContext(logins, {
    available: false,
    approveLogin: () => Effect.succeed(false),
  });
  return { context, reads };
});

describe("filling a saved identity", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    // The shop, one of its subdomains and an ad network, so origins are real without a network.
    await context.route(/^https:\/\/(shop|accounts\.shop|ads)\.test\//, (route) => {
      const url = new URL(route.request().url());
      const body =
        url.pathname === "/signup"
          ? SIGNUP_PAGE
          : url.hostname === "ads.test"
            ? `<input id="adEmail" autocomplete="email">`
            : `<input id="subTel" type="tel" autocomplete="tel">`;
      return route.fulfill({ contentType: "text/html", body });
    });
    page = await context.newPage();
    await page.goto("https://shop.test/signup");
    await page.frameLocator("#sub").locator("#subTel").waitFor();
    await page.frameLocator("#ad").locator("#adEmail").waitFor();
  });
  afterEach(async () => {
    await context.close();
  });

  const tab = async () => ({
    threadId: "thread-1",
    tabId: "tab-1",
    page,
    cdp: await context.newCDPSession(page),
  });
  const frameAllowed = (url: string) => loginCoversPage(["https://shop.test/signup"], url);
  const valueOf = (selector: string, frame?: string) =>
    (frame === undefined
      ? page.locator(selector)
      : page.frameLocator(frame).locator(selector)
    ).inputValue();

  it.live("fills the empty autocomplete fields on the page's own site, country first", () =>
    Effect.gen(function* () {
      const { context: identity } = yield* identityServer(ADA);
      const result = yield* Effect.promise(async () =>
        fillIdentity(identity, await tab(), {}, NO_DEADLINE),
      );

      expect(result).toEqual({
        status: "filled",
        tabId: "tab-1",
        identity: { id: "work/me", title: "Me", account: "Work" },
        filled: [
          "country",
          "country",
          "firstName",
          "lastName",
          "fullName",
          "email",
          "state",
          "birthDate",
          "phone",
        ],
        skipped: [{ value: "jobTitle", reason: "The identity has no jobTitle." }],
      });
      const values = Object.fromEntries(
        yield* Effect.promise(() =>
          Promise.all(
            [
              "#first",
              "#last",
              "#full",
              "#email",
              "#company",
              "#hiddenTel",
              "#zip",
              "#state",
              "#country",
              "#countryName",
              "#bday",
              "#job",
            ].map(async (selector) => [selector, await valueOf(selector)] as const),
          ),
        ),
      );
      expect(values).toEqual({
        "#first": "Ada",
        "#last": "Lovelace",
        "#full": "Ada Lovelace",
        "#email": "ada@example.com",
        // Filled already, hidden, or disabled: left alone.
        "#company": "Kept",
        "#hiddenTel": "",
        "#zip": "",
        "#state": "IL",
        "#country": "US",
        "#countryName": "United States",
        "#bday": "1990-05-17",
        "#job": "",
      });
      // A subdomain of the page's site is filled; another site's frame never is.
      expect(yield* Effect.promise(() => valueOf("#subTel", "#sub"))).toBe("+1 555 0100");
      expect(yield* Effect.promise(() => valueOf("#adEmail", "#ad"))).toBe("");
    }),
  );

  it.live("refuses a locator into another site's frame before reading the identity", () =>
    Effect.gen(function* () {
      const { context: identity, reads } = yield* identityServer(ADA);
      yield* Effect.promise(async () => {
        await expect(
          checkIdentityLocators(
            [{ value: "email", locator: page.frameLocator("#ad").locator("#adEmail") }],
            frameAllowed,
            5_000,
          ),
        ).rejects.toThrow("The email locator points outside this page's site.");
        // Through the whole fill, a selector into that frame is refused the same way.
        await expect(
          fillIdentity(
            identity,
            await tab(),
            {
              fields: [
                { locator: "#ad >> internal:control=enter-frame >> #adEmail", value: "email" },
              ],
            },
            NO_DEADLINE,
          ),
        ).rejects.toThrow("points outside this page's site");
        expect(await valueOf("#adEmail", "#ad")).toBe("");
      });
      expect(reads).toEqual([]);
    }),
  );

  it("refuses a frame that moved to another site after it was checked", async () => {
    const target = page.frameLocator("#sub").locator("#subTel");
    await checkIdentityLocators([{ value: "phone", locator: target }], frameAllowed, 5_000);
    const moved = page.waitForEvent("framenavigated", (frame) =>
      frame.url().startsWith("https://ads.test/"),
    );
    await page
      .locator("#sub")
      .evaluate((frame) => ((frame as unknown as { src: string }).src = "https://ads.test/frame"));
    await (await moved).waitForLoadState();
    const handle = await page.frameLocator("#sub").locator("input").elementHandle();
    await expect(
      fillIdentityField({
        handle: handle!,
        value: "email",
        stored: "ada@example.com",
        frameAllowed,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("left its site");
    expect(await handle!.inputValue()).toBe("");
  });
});
