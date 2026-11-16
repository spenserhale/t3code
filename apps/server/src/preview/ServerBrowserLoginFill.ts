// @effect-diagnostics globalDate:off - Playwright steps run outside the Effect runtime, on the page's wall clock.
import type {
  PreviewAutomationFillLoginRequest,
  PreviewAutomationFillLoginResult,
  PreviewLoginField,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { CDPSession, Page } from "playwright-core";

import * as BrowserLogins from "./BrowserLogins.ts";
import * as BrowserLoginChoice from "./BrowserLoginChoice.ts";
import * as BrowserSecretAccess from "./BrowserSecretAccess.ts";
import {
  documentId,
  fillCovered,
  findLoginTargets,
  loginError,
  scrubbable,
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
  /**
   * Whether the agent ran script in this page, where it could hook a fill. Throws where script ran
   * on a site of the page in tabs a window joins. `document` is the page as `documentId` named it.
   */
  readonly wasScripted: (document: string) => boolean;
  /**
   * Refuses the same again and in that step marks the page as holding a filled login: script,
   * images and recording stay off the page, and script off its sites in tabs a window joins. A
   * desktop drawing the tab is told before any write.
   */
  readonly markFilled: (document: string) => Promise<void>;
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
  readonly loginSourceUrl?: string | undefined;
  loginSelection?: LoginSelection | undefined;
}

export interface LoginSelection {
  readonly id: string;
  readonly origin: string;
  readonly revision: string;
  /** Actual writing sites authorized by the successful fill. */
  readonly urls: ReadonlyArray<string>;
  readonly fillOrigin?: string | undefined;
}

interface FillableLogin extends BrowserSecretAccess.SecretItem {
  readonly urls: ReadonlyArray<string>;
  readonly fillOrigin?: string | undefined;
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

  /** The fields sought, in frames on the given site only. */
  const findTargets = async (urls: ReadonlyArray<string>, sought = fields, fillOrigin?: string) => {
    const frameCovered = (frameUrl: string) =>
      fillOrigin === undefined
        ? BrowserLogins.loginCoversPage(urls, frameUrl)
        : URL.canParse(frameUrl) && new URL(frameUrl).origin === fillOrigin;
    const { targets, missing } = await findLoginTargets({
      page: tab.page,
      fields: sought,
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

  /** A locator given for a field must lead to one element, whatever site the login is for. */
  const checkLocators = async () => {
    for (const field of fields) {
      const matches = await locators[field]?.count();
      if (matches === undefined || matches === 1) continue;
      throw loginError(
        `The ${field} locator matches ${matches === 0 ? "nothing on this page" : `${matches} elements`}. Take a fresh snapshot and pass the field's aria-ref from preview_snapshot.`,
      );
    }
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

  /** The page a fill may go into, as named for it: no recording, and no agent script in it. */
  const fillableDocument = async () => {
    if (tab.recording || tab.recordingStart) {
      throw loginError(
        "Stop the recording before filling a login, then start it again after signing in.",
      );
    }
    const document = await documentId(tab.cdp);
    if (context.wasScripted(document)) {
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
    await context.markFilled(document);
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
        document,
        deadline,
        signal: context.signal,
      });
    }
    tab.loginSelection = {
      id: login.id,
      origin,
      revision,
      urls: login.fillOrigin === origin ? [origin] : login.urls,
      ...(login.fillOrigin === undefined ? {} : { fillOrigin: login.fillOrigin }),
    };
    return {
      status: "filled",
      tabId: tab.tabId,
      login: BrowserSecretAccess.summary(login),
      filled: fields,
    };
  };

  let document: string | undefined;
  const checkPage = BrowserSecretAccess.pageStep(async () => {
    if (expired()) throw loginError("The call ended before the login was filled.");
    if (
      !URL.canParse(tab.page.url()) ||
      new URL(tab.page.url()).origin !== origin ||
      (document !== undefined && (await documentId(tab.cdp)) !== document)
    ) {
      throw loginError("The page changed before the login was filled. Try again.");
    }
  });
  const ready = BrowserSecretAccess.pageStep(async () => {
    if (document !== undefined) {
      await step(checkPage);
      return;
    }
    await checkLocators();
    await findTargets(
      [pageUrl],
      fields.filter((field) => locators[field] === undefined),
    );
    document = await fillableDocument();
  });
  const currentRevision = (await step(logins.escalation)).revision;
  const remembered =
    input.reference === undefined &&
    tab.loginSelection?.origin === origin &&
    tab.loginSelection.revision === currentRevision &&
    BrowserLogins.loginCoversPage(tab.loginSelection.urls, pageUrl)
      ? tab.loginSelection
      : undefined;
  const changeAccount =
    remembered !== undefined && input.login !== undefined && input.login !== remembered.id;
  const previous = changeAccount || fields.includes("username") ? undefined : remembered;
  const access = await step(
    BrowserSecretAccess.resolve<
      BrowserLoginChoice.SelectedLogin,
      Readonly<Partial<Record<PreviewLoginField, string>>>
    >(
      context,
      {
        kind: "login",
        threadId: tab.threadId,
        ...requester,
        tabId: tab.tabId,
        origin,
        item: previous?.id,
        reference: input.reference,
        deadline,
        // Before anyone is asked or anything read; the login's own sites are checked once known.
        ready,
      },
      {
        what: `a login for ${origin}`,
        find: Effect.fn("ServerBrowserLoginFill.find")(function* (
          reach: BrowserLogins.BrowserLoginReach,
        ) {
          const found =
            input.reference === undefined
              ? yield* logins.candidates(pageUrl, reach, tab.loginSourceUrl)
              : yield* logins.lookupLogin(input.reference, reach).pipe(
                  Effect.map(({ revision, login }) => ({
                    revision,
                    logins: login === undefined ? [] : [login],
                  })),
                );
          const reused =
            previous?.revision === found.revision
              ? found.logins.find((candidate) => candidate.id === previous.id)
              : undefined;
          if (
            reused !== undefined &&
            (BrowserLogins.loginCoversPage(reused.urls, origin) || previous?.fillOrigin === origin)
          ) {
            return [
              {
                ...reused,
                userChosen: true,
                ...(previous?.fillOrigin === undefined ? {} : { fillOrigin: previous.fillOrigin }),
              },
            ];
          }
          const login = yield* BrowserLoginChoice.select(context, {
            revision: found.revision,
            candidates: found.logins,
            threadId: tab.threadId,
            tabId: tab.tabId,
            ...requester,
            origin,
            deadline,
            ready,
            checkPage,
            forceChoice: changeAccount,
          });
          return login === undefined ? [] : [login];
        }),
        read: Effect.fn("ServerBrowserLoginFill.read")(function* (
          revision: string,
          login: BrowserLoginChoice.SelectedLogin,
        ) {
          yield* checkPage;
          const values = yield* logins.read(revision, login, fields).pipe(
            Effect.mapError((error) =>
              login.userChosen &&
              (error.reason === "unreadable" || error.reason === "not_configured")
                ? new BrowserLogins.BrowserLoginError({
                    reason: "refused",
                    message: `The selected login "${login.title}" could not be read. Unlock its password manager or choose another login, then try again.`,
                  })
                : error,
            ),
          );
          const missing = login.userChosen ? lacks(login, values) : undefined;
          if (missing !== undefined)
            return yield* new BrowserLogins.BrowserLoginError({
              reason: "refused",
              message: `${missing} Choose another login or ask the user to sign in.`,
            });
          return values;
        }),
        unusable: (login) =>
          login.fillOrigin === origin || BrowserLogins.loginCoversPage(login.urls, pageUrl)
            ? undefined
            : notForThisSite(login.title),
        lacks,
        relay: {
          ask: {
            kind: "login",
            threadId: tab.threadId,
            ...requester,
            origin,
            fields,
            ...(tab.loginSourceUrl === undefined ? {} : { siteUrl: tab.loginSourceUrl }),
          },
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
    throw loginError(
      "Choosing this login needs an updated T3 Code desktop app on the user's device. Update it, then try again.",
    );
  }
  const { item } = access;
  await step(checkPage);
  if (item.fillOrigin !== undefined && item.fillOrigin !== origin) {
    throw loginError("The login choice was authorized for another origin. Try again.");
  }
  if (item.fillOrigin !== origin && !BrowserLogins.loginCoversPage(item.urls, tab.page.url())) {
    throw loginError(notForThisSite(item.title));
  }
  const found = await findTargets(
    item.fillOrigin === origin ? [origin] : item.urls,
    fields,
    item.fillOrigin,
  );
  return fill(item, found, document ?? (await fillableDocument()), access.values, access.revision);
};
