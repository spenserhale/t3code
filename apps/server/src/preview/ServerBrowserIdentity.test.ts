import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { it } from "@effect/vitest";
import type { SecretProviderIdentityValues } from "@t3tools/secret-provider-core/server/driver";
import * as OnePassword from "@t3tools/secret-provider-onepassword/server/driver";
import { OnePasswordAccount } from "@t3tools/secret-provider-onepassword/shared/definition";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vite-plus/test";

import { loginCoversPage } from "./BrowserLogins.ts";
import {
  checkIdentityLocators,
  fillIdentity,
  fillIdentityField,
  makeIdentityContext,
  matchOption,
  readIdentity,
  type IdentityContext,
} from "./ServerBrowserIdentity.ts";
import { documentId } from "./ServerBrowserLogin.ts";

describe("matchOption", () => {
  const options = (...pairs: ReadonlyArray<readonly [value: string, label: string]>) =>
    pairs.map(([value, label]) => ({ value, label, disabled: false }));
  const cases = [
    ["a country by its code", options(["", "Choose"], ["US", "United States"]), "country", "us", 1],
    ["a country by its English name", options(["840", "United States"]), "country", "us", 0],
    ["a country saved as a name", options(["us", "United States"]), "country", "United States", 0],
    ["a country name by its code", options(["", "Choose"], ["FR", "Fra."]), "country", "France", 1],
    [
      "a country name by its current code",
      options(["GB", "Great Britain"]),
      "country",
      "united kingdom",
      0,
    ],
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

/** The shop's pages by path; any other path is a frame of the subdomain or the ad network. */
const PAGES: Partial<Record<string, string>> = {
  "/signup": SIGNUP_PAGE,
  "/address": `<input id="street" autocomplete="street-address">
    <input id="city" autocomplete="address-level2"><textarea id="whole"></textarea>`,
  // Focusing the field hands focus to another site's frame, which focuses its own field.
  "/focus": `<input id="email" autocomplete="email"><iframe id="thief" src="https://ads.test/catch"></iframe>
    <script>
      document.getElementById("email").addEventListener("focus", () =>
        document.getElementById("thief").contentWindow.focus());
    </script>`,
  "/catch": `<input id="caught">
    <script>addEventListener("focus", () => document.getElementById("caught").focus());</script>`,
  // Answers the look at #first's value with a promise that never settles; the page stays free.
  "/stall": `<input id="first" autocomplete="given-name"><input id="email" autocomplete="email">
    <script>
      const stalled = new WeakSet();
      let next = false;
      const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      Object.defineProperty(document.getElementById("first"), "value", {
        get() {
          next = true;
          return value.get.call(this);
        },
      });
      Object.defineProperty(Object.prototype, "then", {
        get() {
          if (next) stalled.add(this);
          next = false;
          return stalled.has(this) ? () => console.log("stalled") : undefined;
        },
      });
    </script>`,
  // Focusing the field stalls the page.
  "/late": `<input id="email" autocomplete="email">
    <script>
      document.getElementById("email").addEventListener("focus", () => {
        const end = Date.now() + 700;
        while (Date.now() < end);
      });
    </script>`,
};

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

/** `op` printing one Identity item, so its values go through the real 1Password driver. */
const onePasswordItem = (fields: ReadonlyArray<object>) =>
  Layer.mergeAll(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(JSON.stringify({ fields }))),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      ),
    ),
    NodeFileSystem.layer,
    NodeCrypto.layer,
  );

const fromOnePassword = (fields: ReadonlyArray<object>) =>
  OnePassword.driver
    .identities!.read(
      { account: OnePasswordAccount.make("my.1password.com") },
      { id: "me1", title: "Me" },
    )
    .pipe(
      Effect.map((values) => values ?? {}),
      Effect.provide(onePasswordItem(fields)),
    );

/** A server whose service account holds one identity, so its fills need no approval. */
const identityServer = Effect.fn("identityServer")(function* (
  values: SecretProviderIdentityValues | Effect.Effect<SecretProviderIdentityValues>,
) {
  const reads: Array<string> = [];
  const logins: IdentityContext["logins"] = {
    escalation: Effect.succeed({ revision: "0", escalation: "refuse" }),
    identityCandidates: (reach) =>
      Effect.succeed({
        revision: "0",
        identities: reach === "unattended" ? [{ id: "work/me", title: "Me", account: "Work" }] : [],
      }),
    lookupIdentity: () => Effect.succeed({ revision: "0", identity: undefined }),
    readIdentity: (_revision, identity) =>
      Effect.suspend(() => {
        reads.push(identity.id);
        return Effect.isEffect(values) ? values : Effect.succeed(values);
      }),
    needsApproval: () => Effect.succeed(false),
    recordApproval: () => Effect.void,
    check: () => Effect.void,
  };
  const context = yield* makeIdentityContext(
    logins,
    { available: false, approveLogin: () => Effect.succeed(false) },
    undefined,
  );
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
        PAGES[url.pathname] ??
        (url.hostname === "ads.test"
          ? `<input id="adEmail" autocomplete="email">`
          : `<input id="subTel" type="tel" autocomplete="tel">`);
      return route.fulfill({ contentType: "text/html", body });
    });
    page = await context.newPage();
    await page.goto("https://shop.test/signup");
    await page.frameLocator("#sub").locator("#subTel").waitFor();
    await page.frameLocator("#ad").locator("#adEmail").waitFor();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await context.close();
  });

  const tab = async () => ({
    threadId: "thread-1",
    tabId: "tab-1",
    page,
    cdp: await context.newCDPSession(page),
  });
  /** The tab and the document it shows now, as the write of one field takes them. */
  const fieldTab = async () => {
    const opened = await tab();
    return { ...opened, document: await documentId(opened.cdp) };
  };
  const frameAllowed = (url: string) => loginCoversPage(["https://shop.test/signup"], url);
  /** The page's clock, which a write checks its deadline against. */
  const pageClock = async () => (await page.evaluate("Date.now()")) as number;
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

  it.live("never reads or fills a credential stored in the identity", () =>
    Effect.gen(function* () {
      const { context: identity } = yield* identityServer(
        fromOnePassword([
          { id: "firstname", type: "STRING", label: "first name", value: "Ada" },
          { id: "k2x9", type: "CONCEALED", label: "email", value: "hunter2-secret" },
          { id: "lastname", type: "CONCEALED", label: "last name", value: "hunter3-secret" },
        ]),
      );
      const read = yield* Effect.promise(() => readIdentity(identity, "thread-1", {}, NO_DEADLINE));
      expect(read).toEqual({
        status: "read",
        identity: { id: "work/me", title: "Me", account: "Work" },
        values: { firstName: "Ada", fullName: "Ada" },
      });
      const filled = yield* Effect.promise(async () =>
        fillIdentity(identity, await tab(), {}, NO_DEADLINE),
      );
      expect(filled).toMatchObject({ status: "filled" });
      const state = yield* Effect.promise(async () => ({
        first: await valueOf("#first"),
        last: await valueOf("#last"),
        email: await valueOf("#email"),
        frames: await Promise.all(page.frames().map((frame) => frame.content())),
      }));
      expect(state).toMatchObject({ first: "Ada", last: "", email: "" });
      expect(JSON.stringify(state)).not.toMatch(/hunter\d-secret/);
    }),
  );

  it.live("leaves the parts of an address kept on one line to the agent", () =>
    Effect.gen(function* () {
      const address = "1 Main St, Apt 4, Springfield, IL 62701, us";
      const { context: identity } = yield* identityServer({ firstName: "Ada", address });
      yield* Effect.promise(() => page.goto("https://shop.test/address"));
      const parts = yield* Effect.promise(async () =>
        fillIdentity(identity, await tab(), {}, NO_DEADLINE),
      );
      const oneLine = (value: string) =>
        `The identity's address is stored as one line, so its ${value} is not filled on its own. Get the address with preview_read_identity, then fill the field with preview_act.`;
      expect(parts).toMatchObject({
        filled: [],
        skipped: [
          { value: "street", reason: oneLine("street") },
          { value: "city", reason: oneLine("city") },
        ],
      });
      // Named, the whole address goes into one field.
      const whole = yield* Effect.promise(async () =>
        fillIdentity(
          identity,
          await tab(),
          { fields: [{ locator: "#whole", value: "address" }] },
          NO_DEADLINE,
        ),
      );
      expect(whole).toMatchObject({ filled: ["address"], skipped: [] });
      const values = yield* Effect.promise(async () =>
        Promise.all(["#street", "#city", "#whole"].map((selector) => valueOf(selector))),
      );
      expect(values).toEqual(["", "", address]);
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
            NO_DEADLINE,
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

  it("writes only into the chosen field, wherever the page moves focus", async () => {
    await page.goto("https://shop.test/focus");
    const caught = page.frameLocator("#thief").locator("#caught");
    await caught.waitFor();
    const handle = await page.locator("#email").elementHandle();
    const reason = await fillIdentityField({
      ...(await fieldTab()),
      handle: handle!,
      value: "email",
      values: { email: "ada@example.com" },
      frameAllowed,
      deadline: NO_DEADLINE,
    });
    expect(reason).toBeUndefined();
    expect(await caught.inputValue()).toBe("");
    expect(await page.locator("#email").inputValue()).toBe("ada@example.com");
  });

  it("never writes after the deadline, even once the write has begun", async () => {
    await page.goto("https://shop.test/late");
    const handle = await page.locator("#email").elementHandle();
    const reason = await fillIdentityField({
      ...(await fieldTab()),
      handle: handle!,
      value: "email",
      values: { email: "ada@example.com" },
      frameAllowed,
      deadline: (await pageClock()) + 300,
    });
    expect(reason).toBe("The field did not answer in time. Use preview_act.");
    expect(await page.locator("#email").inputValue()).toBe("");
  });

  it("gives up on a field once the page stops answering, and never fills it later", async () => {
    const handle = await page.locator("#first").elementHandle();
    const fields = await fieldTab();
    const deadline = (await pageClock()) + 300;
    // Busy for longer than the field may take, so even looking at the field waits behind it.
    const free = page.evaluate("const end = Date.now() + 1500; while (Date.now() < end); 'free'");
    const reason = fillIdentityField({
      ...fields,
      handle: handle!,
      value: "firstName",
      values: { firstName: "Ada" },
      frameAllowed,
      deadline,
    });
    expect(await Promise.race([reason, free])).toBe(
      "The field did not answer in time. Use preview_act.",
    );
    expect(await page.locator("#first").inputValue()).toBe("");
  });

  it.live("gives a field that never answers 5 seconds, then looks at the rest", () =>
    Effect.gen(function* () {
      const { context: identity } = yield* identityServer(ADA);
      const result = yield* Effect.promise(async () => {
        await page.goto("https://shop.test/stall");
        let stalls = 0;
        let onStall = () => {};
        page.on("console", (message) => {
          if (message.text() !== "stalled") return;
          stalls += 1;
          onStall();
        });
        const stalled = (count: number) =>
          new Promise<void>((resolve) => {
            onStall = () => {
              if (stalls >= count) resolve();
            };
            onStall();
          });
        const opened = await tab();
        // Only the fields' time is on this clock: Playwright itself runs on immediates.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        try {
          const filling = fillIdentity(identity, opened, {}, NO_DEADLINE);
          // The fields are looked at before anyone is asked, and again for the fill itself.
          await Promise.race([stalled(1), filling]);
          await vi.advanceTimersByTimeAsync(5_000);
          await Promise.race([stalled(2), filling]);
          await vi.advanceTimersByTimeAsync(5_000);
          return await filling;
        } finally {
          vi.useRealTimers();
        }
      });
      expect(result).toEqual({
        status: "filled",
        tabId: "tab-1",
        identity: { id: "work/me", title: "Me", account: "Work" },
        filled: ["email"],
        skipped: [
          { value: "firstName", reason: "The field did not answer in time. Use preview_act." },
        ],
      });
      expect(yield* Effect.promise(() => valueOf("#email"))).toBe("ada@example.com");
    }),
  );

  it("leaves a field alone once the page has loaded another document", async () => {
    const opened = await fieldTab();
    await page.reload();
    const handle = await page.locator("#first").elementHandle();
    const reason = await fillIdentityField({
      ...opened,
      handle: handle!,
      value: "firstName",
      values: { firstName: "Ada" },
      frameAllowed,
      deadline: NO_DEADLINE,
    });
    expect(reason).toBe(
      "The page loaded another document before the field was filled. Take a fresh snapshot.",
    );
    expect(await page.locator("#first").inputValue()).toBe("");
  });

  it("refuses a frame that moved to another site after it was checked", async () => {
    const target = page.frameLocator("#sub").locator("#subTel");
    await checkIdentityLocators([{ value: "phone", locator: target }], frameAllowed, NO_DEADLINE);
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
        ...(await fieldTab()),
        handle: handle!,
        value: "email",
        values: { email: "ada@example.com" },
        frameAllowed,
        deadline: NO_DEADLINE,
      }),
    ).rejects.toThrow("left its site");
    expect(await handle!.inputValue()).toBe("");
  });
});
