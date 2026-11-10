import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { loginCoversPage } from "./BrowserLogins.ts";
import { documentId, fillCovered } from "./ServerBrowserLogin.ts";

const frameCovered = (url: string) => loginCoversPage(["https://good.test"], url);
const NO_DEADLINE = Number.MAX_SAFE_INTEGER;

const PAGES: Partial<Record<string, string>> = {
  "/": `<input id="otp" type="text"><iframe src="https://good.test/frame"></iframe>`,
  // Focusing the field hands focus to another site's frame, which focuses its own field.
  "/focus": `<input id="password" type="password"><iframe src="https://evil.test/catch"></iframe>
    <script>
      document.getElementById("password").addEventListener("focus", () =>
        document.querySelector("iframe").contentWindow.focus());
    </script>`,
  "/catch": `<input id="password" type="password">
    <script>addEventListener("focus", () => document.getElementById("password").focus());</script>`,
  // The field appears after most of the call's time is gone, and focusing it stalls the page.
  "/late": `<script>
      setTimeout(() => {
        const field = document.createElement("input");
        field.id = "password";
        field.type = "password";
        field.addEventListener("focus", () => {
          const end = Date.now() + 700;
          while (Date.now() < end);
        });
        document.body.append(field);
      }, 600);
    </script>`,
  "/switch": `<input id="otp" type="text" oninput="console.log('written')">`,
};

describe("filling a saved login", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    // Two fake sites, so origins are real without a network.
    await context.route(/^https:\/\/(good|evil)\.test\//, (route) => {
      const url = new URL(route.request().url());
      // A page that knows the fill's tag and puts it on its own field.
      const copied = url.pathname === "/copy" ? (url.searchParams.get("tag") ?? "") : undefined;
      const body =
        copied === undefined
          ? (PAGES[url.pathname] ?? `<input id="password" type="password">`)
          : `<input id="password" type="password" ${copied}>`;
      return route.fulfill({ contentType: "text/html", body });
    });
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    await page.goto("https://good.test/");
  });
  afterEach(async () => {
    await context.close();
  });

  const frameInput = () => page.frameLocator("iframe").locator("#password");

  it("fills a field on the login's site, as input the page sees, drawn as dots", async () => {
    // Script that wrapped the value setter beforehand must not be handed the value.
    await page.evaluate(() => {
      const scope = globalThis as unknown as {
        HTMLInputElement: { prototype: object };
        hooked?: string;
      };
      const native = Object.getOwnPropertyDescriptor(scope.HTMLInputElement.prototype, "value")!;
      Object.defineProperty(scope.HTMLInputElement.prototype, "value", {
        ...native,
        set(this: unknown, value: string) {
          scope.hooked = value;
          native.set!.call(this, value);
        },
      });
    });
    // React tracks a field's value through a setter on the element itself, and fires onChange
    // when an input event finds the value changed behind it.
    await page.locator("#otp").evaluate((element) => {
      const otp = element as unknown as {
        value: string;
        dataset: { seen?: string; tracked?: string };
        addEventListener: (type: string, listener: () => void) => void;
      };
      const native = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(otp), "value")!;
      let tracked = "";
      Object.defineProperty(otp, "value", {
        configurable: true,
        get(this: unknown) {
          return native.get!.call(this);
        },
        set(this: unknown, value: string) {
          tracked = value;
          native.set!.call(this, value);
        },
      });
      otp.addEventListener("input", () => {
        otp.dataset.seen = otp.value;
        otp.dataset.tracked = tracked;
      });
    });
    await fillCovered({
      page,
      cdp,
      field: "totp",
      target: page.locator("#otp"),
      value: "123456",
      frameCovered,
      document: await documentId(cdp),
      deadline: NO_DEADLINE,
    });
    const state = await page.locator("#otp").evaluate((otp) => {
      const field = otp as unknown as {
        value: string;
        dataset: { seen?: string; tracked?: string };
        style: { getPropertyValue: (name: string) => string };
      };
      return {
        value: field.value,
        seen: field.dataset.seen,
        tracked: field.dataset.tracked,
        security: field.style.getPropertyValue("-webkit-text-security"),
      };
    });
    // The tracker still holds the old value, so React would report the change.
    expect(state).toEqual({ value: "123456", seen: "123456", tracked: "", security: "disc" });
    expect(await page.evaluate(() => (globalThis as { hooked?: string }).hooked)).toBeUndefined();
  });

  it("writes only into the chosen field, wherever the page moves focus", async () => {
    await page.goto("https://good.test/focus");
    const caught = page.frameLocator("iframe").locator("#password");
    await caught.waitFor();
    await fillCovered({
      page,
      cdp,
      field: "password",
      target: page.locator("#password"),
      value: "hunter22",
      frameCovered,
      document: await documentId(cdp),
      deadline: NO_DEADLINE,
    });
    expect(await caught.inputValue()).toBe("");
    expect(await page.locator("#password").inputValue()).toBe("hunter22");
  });

  it("never writes after the call's deadline, even once the write has begun", async () => {
    await page.goto("https://good.test/late");
    await expect(
      fillCovered({
        page,
        cdp,
        field: "password",
        target: page.locator("#password"),
        value: "hunter22",
        frameCovered,
        document: await documentId(cdp),
        // The page's clock, which the write checks.
        deadline: ((await page.evaluate("Date.now()")) as number) + 1_000,
      }),
    ).rejects.toThrow("The call ended before the login was filled.");
    expect(await page.locator("#password").inputValue()).toBe("");
  });

  it("refuses a frame that moved to another site after the field was chosen", async () => {
    const target = frameInput();
    await target.waitFor();
    const moved = page.waitForEvent("framenavigated", (frame) =>
      frame.url().startsWith("https://evil.test/"),
    );
    await page
      .locator("iframe")
      .evaluate((frame) => ((frame as unknown as { src: string }).src = "https://evil.test/frame"));
    await (await moved).waitForLoadState();
    await expect(
      fillCovered({
        page,
        cdp,
        field: "password",
        target,
        value: "hunter2",
        frameCovered,
        document: await documentId(cdp),
        deadline: NO_DEADLINE,
      }),
    ).rejects.toThrow("left the login's site");
    expect(await target.inputValue()).toBe("");
  });

  it.each(["https://evil.test", "https://good.test"])(
    "never writes into a document %s loads in place of the field's",
    async (destination) => {
      // Moves the page on before each call the fill makes in turn, until one finishes unmoved.
      let unmoved = false;
      for (let moveAt = 0; moveAt < 40 && !unmoved; moveAt++) {
        await page.goto("https://good.test/switch");
        const document = await documentId(cdp);
        let written = false;
        const onConsole = (message: { text: () => string }) => {
          if (message.text() === "written") written = true;
        };
        page.on("console", onConsole);
        let calls = 0;
        const moving = {
          send: async (method: string, params?: object) => {
            if (calls++ === moveAt) {
              const tag = await page.evaluate(() => {
                const scope = globalThis as unknown as {
                  document: {
                    querySelector: (
                      selector: string,
                    ) => { attributes: Iterable<{ name: string }> } | null;
                  };
                };
                const field = scope.document.querySelector("#otp");
                return [...(field?.attributes ?? [])]
                  .map((attribute) => attribute.name)
                  .find((name) => name.startsWith("data-t3-fill-"));
              });
              await page.goto(`${destination}/copy?tag=${tag ?? ""}`);
            }
            return cdp.send(method as "Page.getFrameTree", params);
          },
        } as unknown as CDPSession;
        const filled = await fillCovered({
          page,
          cdp: moving,
          field: "totp",
          target: page.locator("#otp"),
          value: "123456",
          frameCovered,
          document,
          deadline: NO_DEADLINE,
        }).then(
          () => true,
          () => false,
        );
        page.off("console", onConsole);
        unmoved = calls <= moveAt;
        // Success means the field the fill was for took the value, and nothing else did.
        expect(filled).toBe(written);
        if (unmoved) expect(written).toBe(true);
        else expect(await page.locator("#password").inputValue()).toBe("");
      }
      expect(unmoved).toBe(true);
    },
  );

  it("names a document until the page loads a new one", async () => {
    const first = await documentId(cdp);
    await page.evaluate(() =>
      (
        globalThis as unknown as { history: { pushState: (...args: unknown[]) => void } }
      ).history.pushState({}, "", "/next"),
    );
    expect(await documentId(cdp)).toBe(first);
    await page.reload();
    expect(await documentId(cdp)).not.toBe(first);
  });
});
