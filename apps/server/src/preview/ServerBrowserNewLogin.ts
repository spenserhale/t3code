// @effect-diagnostics globalDate:off - Playwright steps run outside the Effect runtime, on the page's wall clock.
import type {
  PreviewAutomationFillNewLoginRequest,
  PreviewAutomationFillNewLoginResult,
  PreviewNewPasswordField,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type { CDPSession, Page } from "playwright-core";

import * as BrowserLogins from "./BrowserLogins.ts";
import type * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import {
  documentId,
  fillCovered,
  findNewPasswordTargets,
  loginError,
  scrubbable,
} from "./ServerBrowserLogin.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

export interface NewLoginContext {
  readonly logins: Pick<
    BrowserLogins.BrowserLogins["Service"],
    | "newLoginDestination"
    | "createLogin"
    | "regeneratePassword"
    | "needsApproval"
    | "recordApproval"
    | "check"
  >;
  readonly desktopChannel: Pick<
    DesktopBrowserChannel.DesktopBrowserChannel["Service"],
    "available" | "approveLogin"
  >;
  /** Runs a step of the login service; its failure becomes an operation error. */
  readonly step: <A>(effect: Effect.Effect<A, BrowserLogins.BrowserLoginError>) => Promise<A>;
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>;
  /** Whether the agent ran script in this document of the tab, where it could hook a fill. */
  readonly wasScripted: (document: string) => boolean;
  /**
   * Marks this document of the tab as holding a filled password, as a login fill does: script,
   * images and recording stay off there, and a desktop drawing the tab is told before any write.
   */
  readonly markFilled: (document: string) => Promise<void>;
  /** Adds filled values to what later results are scrubbed of. */
  readonly rememberSecrets: (values: ReadonlyArray<string>) => void;
}

interface NewLoginTab {
  readonly threadId: string;
  readonly tabId: string;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly recording: object | null;
  readonly recordingStart: object | null;
}

const summary = (login: BrowserLogins.BrowserLoginCandidate) => ({
  id: login.id,
  title: login.title,
  ...(login.vault ? { vault: login.vault } : {}),
  account: login.account,
});

/**
 * Saves a new login for the sign-up form in a tab, with a password the password manager
 * generates, then fills it into the password fields as dots. With `login`, a login made here
 * earlier gets a new password instead. The agent never sees the password, so every guard of a
 * login fill applies.
 */
export const fillNewLogin = async (
  context: NewLoginContext,
  tab: NewLoginTab,
  input: PreviewAutomationFillNewLoginRequest,
  deadlineMs: number,
): Promise<PreviewAutomationFillNewLoginResult> => {
  const { logins, step } = context;
  // The page sees wall-clock time, so the steps that reach into it share this deadline.
  const deadline = Date.now() + (deadlineMs - performance.now());
  const remaining = () => deadline - Date.now();
  const pageUrl = tab.page.url();
  const frameCovered = (frameUrl: string) => BrowserLogins.loginCoversPage([pageUrl], frameUrl);
  if (!frameCovered(pageUrl)) {
    throw loginError(
      "Open the sign-up page first: logins are saved only for http and https pages.",
    );
  }
  const page = new URL(pageUrl);
  const destination = await step(logins.newLoginDestination(tab.threadId, input.login));
  const earlier = destination.login;
  if (earlier !== undefined && !BrowserLogins.loginCoversPage(earlier.urls, pageUrl)) {
    throw loginError(
      `The login "${earlier.title}" is for another site. Omit \`login\` to create one for this site.`,
    );
  }
  const locate = (locator: string | undefined) =>
    ServerBrowserPage.targetLocator(tab.page, { locator }) ?? undefined;
  const named = locate(input.locators?.password);
  const targets = await findNewPasswordTargets({
    page: tab.page,
    locators: named && { password: named, confirm: locate(input.locators?.confirm) },
    frameCovered,
    deadline,
  });
  if (tab.recording || tab.recordingStart) {
    throw loginError(
      "Stop the recording before filling a new password, then start it again after signing up.",
    );
  }
  const document = await documentId(tab.cdp);
  if (context.wasScripted(document)) {
    throw loginError(
      "preview_evaluate ran in this page, so a password cannot be filled here. Reload the page with preview_navigate, fill in the form again, then call preview_fill_new_login.",
    );
  }
  // Saved for the site, not one host, so the login also fills on its sign-in page.
  const site = page.hostname.replace(/^www\./i, "");
  const url = `${page.protocol}//${page.host.replace(/^www\./i, "")}`;
  const title = earlier?.title ?? input.title ?? site;
  const ask = await step(logins.needsApproval(destination.revision, tab.threadId, "newLogin"));
  if (ask !== false) {
    // Only a desktop app attached to this server can ask, also for tabs it does not draw.
    if (!context.desktopChannel.available) {
      throw loginError(
        "Nobody can approve a new login on this machine. Ask the user to sign up in the tab, or to choose Don't ask in Settings > Browser > Logins for this environment.",
      );
    }
    const approved = await context.runPromise(
      context.desktopChannel.approveLogin(
        { threadId: tab.threadId, tabId: tab.tabId },
        Math.max(0, remaining()),
        {
          kind: "newLogin",
          providerLabel: destination.account,
          loginTitle: title,
          ...(destination.vault ? { vault: destination.vault } : {}),
          origin: page.origin,
          ...(input.requester?.threadTitle ? { threadTitle: input.requester.threadTitle } : {}),
          ...(input.requester?.provider ? { agent: input.requester.provider } : {}),
          scope: ask,
        },
      ),
    );
    if (!approved) throw loginError("The user did not approve this new login.");
    if (remaining() <= 0) throw loginError("The approval came after the call ended.");
    await step(logins.recordApproval(destination.revision, tab.threadId, "newLogin"));
  }
  // A caller that gave up must not leave a login behind.
  if (remaining() <= 0) throw loginError("The call ended before the login was saved.");
  const recipe = {
    length: input.recipe?.length ?? 24,
    digits: input.recipe?.digits ?? true,
    symbols: input.recipe?.symbols ?? true,
  };
  const { login, password } = await step(
    earlier === undefined
      ? logins.createLogin(destination.revision, {
          threadId: tab.threadId,
          threadTitle: input.requester?.threadTitle,
          title,
          url,
          username: input.username,
          recipe,
        })
      : logins.regeneratePassword(destination.revision, tab.threadId, earlier.id, recipe),
  );
  try {
    if (!scrubbable(password)) {
      throw loginError(
        "The password manager gave a password shorter than 4 characters or holding a line break, which could not be kept out of what you read, so it was not filled.",
      );
    }
    // The page may have moved on, or the settings changed, while the password was made.
    if (!frameCovered(tab.page.url()) || (await documentId(tab.cdp)) !== document) {
      throw loginError("The page changed before the password was filled.");
    }
    await step(logins.check(destination.revision));
    // Marked before the first write, so even a fill that fails partway blocks script here.
    await context.markFilled(document);
    context.rememberSecrets([password]);
    const filled: Array<PreviewNewPasswordField> = [];
    for (const { field, target } of targets) {
      if (remaining() <= 0) throw loginError("The call ended before the password was filled.");
      await fillCovered({
        page: tab.page,
        cdp: tab.cdp,
        field: "password",
        target,
        value: password,
        frameCovered,
        document,
        deadline,
      });
      filled.push(field);
    }
    return {
      status: "filled",
      tabId: tab.tabId,
      login: summary(login),
      filled,
      created: earlier === undefined,
    };
  } catch (cause) {
    // The login is saved by now; naming it lets a retry reuse it instead of saving another.
    const error = ServerBrowserPage.toOperationError(cause);
    throw new ServerBrowserPage.ServerBrowserOperationError(
      error.tag,
      `${error.message} The login "${login.title}" was saved; call again with login "${login.id}" to fill it with a new password.`,
      error.detail,
    );
  }
};
