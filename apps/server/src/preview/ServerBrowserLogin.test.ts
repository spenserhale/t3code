import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { loginCoversPage } from "./BrowserLogins.ts";
import { fillCovered, pageHoldsSecret } from "./ServerBrowserLogin.ts";

const frameCovered = (url: string) => loginCoversPage(["https://good.test"], url);

describe("filling a saved login", () => {
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
    // Two fake sites, so origins are real without a network.
    await context.route(/^https:\/\/(good|evil)\.test\//, (route) => {
      const url = new URL(route.request().url());
      const body =
        url.pathname === "/"
          ? `<input id="otp" type="text"><iframe src="https://good.test/frame"></iframe>`
          : `<input id="password" type="password">`;
      return route.fulfill({ contentType: "text/html", body });
    });
    page = await context.newPage();
    await page.goto("https://good.test/");
  });
  afterEach(async () => {
    await context.close();
  });

  const frameInput = () => page.frameLocator("iframe").locator("#password");

  it("fills a field on the login's site, as input the page sees, drawn as dots", async () => {
    await page.locator("#otp").evaluate((element) => {
      const otp = element as unknown as {
        value: string;
        dataset: { seen?: string };
        addEventListener: (type: string, listener: () => void) => void;
      };
      otp.addEventListener("input", () => (otp.dataset.seen = otp.value));
    });
    await fillCovered({ target: page.locator("#otp"), value: "123456", frameCovered });
    const state = await page.locator("#otp").evaluate((otp) => {
      const field = otp as unknown as {
        value: string;
        dataset: { seen?: string };
        style: { getPropertyValue: (name: string) => string };
      };
      return {
        value: field.value,
        seen: field.dataset.seen,
        security: field.style.getPropertyValue("-webkit-text-security"),
      };
    });
    expect(state).toEqual({ value: "123456", seen: "123456", security: "disc" });
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
    await expect(fillCovered({ target, value: "hunter2", frameCovered })).rejects.toThrow(
      "left the login's site",
    );
    expect(await target.inputValue()).toBe("");
  });

  it("sees a filled value in any field, whatever its type", async () => {
    const secrets = new Set(["hunter2", "123456"]);
    expect(await pageHoldsSecret(page, secrets)).toBe(false);
    await fillCovered({ target: page.locator("#otp"), value: "123456", frameCovered });
    expect(await pageHoldsSecret(page, secrets)).toBe(true);
    await page.locator("#otp").fill("");
    await fillCovered({ target: frameInput(), value: "hunter2", frameCovered });
    // Revealing the password turns it into a text field; it still counts.
    await frameInput().evaluate((input) => ((input as unknown as { type: string }).type = "text"));
    expect(await pageHoldsSecret(page, secrets)).toBe(true);
    await page.frameLocator("iframe").locator("input").fill("");
    expect(await pageHoldsSecret(page, secrets)).toBe(false);
  });
});
