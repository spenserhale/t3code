// @effect-diagnostics globalDate:off - Playwright steps run outside the Effect runtime, on the page's wall clock.
import type {
  PreviewAutomationFillLoginRequest,
  PreviewAutomationFillLoginResult,
  PreviewLoginField,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { CDPSession, Page } from "playwright-core";

import * as BrowserLogins from "./BrowserLogins.ts";
import * as BrowserSecretAccess from "./BrowserSecretAccess.ts";
import {
  documentId,
  fillCovered,
  findLoginTargets,
  loginError,
  markFilled,
  scrubbable,
  wasScripted,
} from "./ServerBrowserLogin.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

export interface LoginFillContext extends BrowserSecretAccess.SecretAccessContext {
  readonly logins: Pick<
    BrowserLogins.BrowserLogins["Service"],
    | "escalation"
    | "candidates"
    | "lookupLogin"
    | "read"
    | "needsApproval"
    | "recordApproval"
    | "check"
  >;
  /** Adds filled values to what later results are scrubbed of. */
  readonly rememberSecrets: (values: ReadonlyArray<string>) => void;
}

interface LoginTab {
  readonly threadId: string;
  readonly tabId: string;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly recording: object | null;
  readonly recordingStart: object | null;
}

interface FillableLogin extends BrowserSecretAccess.SecretItem {
  readonly urls: ReadonlyArray<string>;
}

const notForThisSite = (title: string) =>
  `The login "${title}" is saved for another site, so it is not filled here.`;

/**
 * Fills a saved login in the order every secret request follows (see `BrowserSecretAccess`).
 * Every value goes through the same page guards, wherever it came from.
 */
export const fillLogin = async (
  context: LoginFillContext,
  tab: LoginTab,
  input: PreviewAutomationFillLoginRequest,
  deadlineMs: number,
): Promise<PreviewAutomationFillLoginResult> => {
  const { logins, step } = context;
  const pageUrl = tab.page.url();
  const origin = URL.canParse(pageUrl) ? new URL(pageUrl).origin : pageUrl;
  const fields = [...new Set<PreviewLoginField>(input.fields ?? ["username", "password"])];
  const locators = Object.fromEntries(
    Object.entries(input.locators ?? {}).flatMap(([field, locator]) => {
      const target = ServerBrowserPage.targetLocator(tab.page, { locator });
      return target === null ? [] : [[field, target]];
    }),
  );
  const requester = {
    ...(input.requester?.threadTitle ? { threadTitle: input.requester.threadTitle } : {}),
    ...(input.requester?.provider ? { agent: input.requester.provider } : {}),
  };
  // A caller that gave up must not leave an approval or a fill behind.
  const expired = () => performance.now() >= deadlineMs || context.signal?.aborted === true;
  // The page sees wall-clock time, so the steps that reach into it share this deadline.
  const deadline = Date.now() + (deadlineMs - performance.now());

  /** The fields, in frames on the login's site only. */
  const findTargets = async (urls: ReadonlyArray<string>) => {
    const frameCovered = (frameUrl: string) => BrowserLogins.loginCoversPage(urls, frameUrl);
    const { targets, missing } = await findLoginTargets({
      page: tab.page,
      fields,
      locators,
      frameCovered,
      deadline,
    });
    if (missing.length > 0) {
      throw loginError(
        `No ${missing.join(" or ")} field was found. Pass its aria-ref from preview_snapshot in \`locators\`, or leave it out of \`fields\`.`,
      );
    }
    return { frameCovered, targets };
  };

  const lacks = (
    login: BrowserSecretAccess.SecretItem,
    values: Readonly<Partial<Record<PreviewLoginField, string>>>,
  ) => {
    const absent = fields.filter((field) => values[field] === undefined);
    return absent.length === 0
      ? undefined
      : `The login "${login.title}" has no ${absent.join(" or ")}.`;
  };

  /** The document a fill may go into: no recording, and no agent script in it. */
  const fillableDocument = async () => {
    if (tab.recording || tab.recordingStart) {
      throw loginError(
        "Stop the recording before filling a login, then start it again after signing in.",
      );
    }
    const document = await documentId(tab.cdp);
    if (wasScripted(tab.page, document)) {
      throw loginError(
        "preview_evaluate ran in this page, so a login cannot be filled here. Reload the page with preview_navigate, then call preview_fill_login again.",
      );
    }
    return document;
  };

  const fill = async (
    login: FillableLogin,
    found: Awaited<ReturnType<typeof findTargets>>,
    document: string,
    values: Readonly<Partial<Record<PreviewLoginField, string>>>,
    revision: string,
  ): Promise<PreviewAutomationFillLoginResult> => {
    const lacking = lacks(login, values);
    if (lacking !== undefined) throw loginError(lacking);
    const unsafe = fields.filter(
      (field) => field !== "username" && !scrubbable(values[field] ?? ""),
    );
    if (unsafe.length > 0) {
      throw loginError(
        `The login "${login.title}" cannot be filled: its ${unsafe.join(" and ")} could not be kept out of what you read, being shorter than 4 characters or holding a line break. Ask the user to sign in in the tab.`,
      );
    }
    // The page may have moved on, or the settings changed, while the user was deciding.
    if (!found.frameCovered(tab.page.url()) || (await documentId(tab.cdp)) !== document) {
      throw loginError("The page left the login's site before it was filled.");
    }
    if (tab.recording || tab.recordingStart) {
      throw loginError("A recording started before the login was filled.");
    }
    await step(logins.check(revision));
    // Marked before the first write, so even a fill that fails partway blocks script here.
    markFilled(tab.page, document);
    context.rememberSecrets(
      fields.flatMap((field) => (field === "username" ? [] : [values[field] ?? ""])),
    );
    for (const field of fields) {
      const target = found.targets.get(field);
      if (target === undefined) continue;
      if (expired()) throw loginError("The call ended before the login was filled.");
      await fillCovered({
        page: tab.page,
        cdp: tab.cdp,
        field,
        target,
        value: values[field] ?? "",
        frameCovered: found.frameCovered,
        deadline,
      });
    }
    return {
      status: "filled",
      tabId: tab.tabId,
      login: BrowserSecretAccess.summary(login),
      filled: fields,
    };
  };

  let document: string | undefined;
  const access = await step(
    BrowserSecretAccess.resolve(
      context,
      {
        kind: "login",
        threadId: tab.threadId,
        ...requester,
        tabId: tab.tabId,
        origin,
        item: input.login,
        reference: input.reference,
        deadline,
        // Before anyone is asked or anything read; the login's own sites are checked once known.
        ready: BrowserSecretAccess.pageStep(async () => {
          if (Object.keys(locators).length === 0) await findTargets([pageUrl]);
          document = await fillableDocument();
        }),
      },
      {
        what: `a login for ${origin}`,
        find: (reach) =>
          input.reference === undefined
            ? logins.candidates(pageUrl, reach).pipe(Effect.map((found) => found.logins))
            : logins
                .lookupLogin(input.reference, reach)
                .pipe(Effect.map(({ login }) => (login === undefined ? [] : [login]))),
        read: (revision, login) => logins.read(revision, login, fields),
        unusable: (login) =>
          BrowserLogins.loginCoversPage(login.urls, pageUrl)
            ? undefined
            : notForThisSite(login.title),
        lacks,
        relay: {
          ask: { kind: "login", threadId: tab.threadId, ...requester, origin, fields },
          values: (values) =>
            Object.fromEntries(
              fields.flatMap((field) =>
                values[field] === undefined ? [] : [[field, values[field]]],
              ),
            ),
        },
      },
    ),
  );
  if (access.status === "none") return { status: "no_login", tabId: tab.tabId, origin };
  if (access.status === "choose") {
    return { status: "choose", tabId: tab.tabId, origin, candidates: [...access.candidates] };
  }
  const { item } = access;
  if (!BrowserLogins.loginCoversPage(item.urls, tab.page.url())) {
    throw loginError(notForThisSite(item.title));
  }
  const found = await findTargets(item.urls);
  return fill(item, found, document ?? (await fillableDocument()), access.values, access.revision);
};
