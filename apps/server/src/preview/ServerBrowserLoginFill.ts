// @effect-diagnostics globalDate:off - Playwright steps run outside the Effect runtime, on the page's wall clock.
import {
  type PreviewAutomationFillLoginRequest,
  type PreviewAutomationFillLoginResult,
  type PreviewLoginField,
  SECRET_RELAY_DEVICE_PREFIX,
} from "@t3tools/contracts";
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

interface FillableLogin {
  readonly id: string;
  readonly title: string;
  readonly vault?: string | undefined;
  readonly account?: string | undefined;
  readonly urls: ReadonlyArray<string>;
}

const summary = (login: Omit<FillableLogin, "urls">) => ({
  id: login.id,
  title: login.title,
  ...(login.vault ? { vault: login.vault } : {}),
  ...(login.account ? { account: login.account } : {}),
});

const notForThisSite = (title: string) =>
  loginError(`The login "${title}" is saved for another site, so it is not filled here.`);

/**
 * Fills a saved login: from this machine's unattended providers without asking, else from its
 * attended ones once the desktop app asks, else from the user's device through the relay. Every
 * value goes through the same page guards, wherever it came from.
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
  const noLogin = { status: "no_login", tabId: tab.tabId, origin } as const;
  // A caller that gave up must not leave an approval or a fill behind.
  const expired = () => performance.now() >= deadlineMs;
  // The page sees wall-clock time, so the steps that reach into it share this deadline.
  const deadline = Date.now() + (deadlineMs - performance.now());

  /** The fields, in frames on the login's site only, found before anyone is asked. */
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
    const absent = fields.filter((field) => values[field] === undefined);
    if (absent.length > 0) {
      throw loginError(`The login "${login.title}" has no ${absent.join(" or ")}.`);
    }
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
    return { status: "filled", tabId: tab.tabId, login: summary(login), filled: fields };
  };

  /** A login of this machine's providers; an attended one is asked about first. */
  const fillHere = async (
    login: BrowserLogins.BrowserLoginCandidate,
    revision: string,
    attended: boolean,
  ) => {
    if (!BrowserLogins.loginCoversPage(login.urls, pageUrl)) throw notForThisSite(login.title);
    const found = await findTargets(login.urls);
    const document = await fillableDocument();
    if (attended) {
      await BrowserSecretAccess.approveHere(context, {
        revision,
        kind: "login",
        key: { threadId: tab.threadId, tabId: tab.tabId },
        prompt: {
          providerLabel: login.account,
          loginTitle: login.title,
          ...(login.vault ? { vault: login.vault } : {}),
          origin,
          ...requester,
        },
        deadlineMs,
        denied: "The user did not approve this login.",
      });
    }
    const values = await step(logins.read(revision, login, fields));
    return fill(login, found, document, values, revision);
  };

  const chooseOrFill = (
    candidates: ReadonlyArray<BrowserLogins.BrowserLoginCandidate>,
    revision: string,
    attended: boolean,
  ) => {
    const login =
      input.login === undefined
        ? candidates.length === 1
          ? candidates[0]
          : undefined
        : candidates.find((candidate) => candidate.id === input.login);
    if (login !== undefined) return fillHere(login, revision, attended);
    return candidates.length === 0
      ? noLogin
      : ({
          status: "choose",
          tabId: tab.tabId,
          origin,
          candidates: candidates.map(summary),
        } as const);
  };

  /** The user's device chooses, asks the user and reads; the page is checked before and after. */
  const fillRelayed = async (ask: { readonly item?: string; readonly reference?: string }) => {
    const { revision, escalation } = await step(logins.escalation);
    // The login's websites are known only from the answer; fields the agent named are checked
    // against them then, so a form in a frame of a sibling subdomain can still be filled.
    if (Object.keys(locators).length === 0) await findTargets([pageUrl]);
    const document = await fillableDocument();
    const answer = await BrowserSecretAccess.relay(context, {
      escalation,
      ask: { kind: "login", threadId: tab.threadId, ...requester, origin, fields, ...ask },
      deadlineMs,
      what: ask.reference ?? (ask.item === undefined ? `a login for ${origin}` : "that login"),
      denied: "The user did not approve this login on their device.",
    });
    if (answer.type === "none") return noLogin;
    if (answer.type === "choose") {
      return { status: "choose", tabId: tab.tabId, origin, candidates: answer.candidates } as const;
    }
    const { item } = answer;
    if (!BrowserLogins.loginCoversPage(item.urls, tab.page.url())) throw notForThisSite(item.title);
    const found = await findTargets(item.urls);
    return fill(item, found, document, BrowserSecretAccess.relayedValues(answer.values), revision);
  };

  if (input.login?.startsWith(SECRET_RELAY_DEVICE_PREFIX)) {
    return fillRelayed({ item: input.login });
  }
  if (input.login === undefined && input.reference !== undefined) {
    const { reference } = input;
    const unattended = await BrowserSecretAccess.tryUnattended(
      context,
      logins.lookupLogin(reference, "unattended"),
    );
    if (unattended?.login !== undefined) {
      return fillHere(unattended.login, unattended.revision, false);
    }
    if (!context.desktopChannel.available) return fillRelayed({ reference });
    const attended = await step(logins.lookupLogin(reference, "attended"));
    return attended.login === undefined
      ? noLogin
      : fillHere(attended.login, attended.revision, true);
  }
  // Unattended providers are tried first; when they have logins for the page, nobody is asked.
  const unattended = await BrowserSecretAccess.tryUnattended(
    context,
    logins.candidates(pageUrl, "unattended"),
  );
  if (unattended !== undefined && unattended.logins.length > 0) {
    return chooseOrFill(unattended.logins, unattended.revision, false);
  }
  if (!context.desktopChannel.available) return fillRelayed({});
  const attended = await step(logins.candidates(pageUrl, "attended"));
  return chooseOrFill(attended.logins, attended.revision, true);
};
