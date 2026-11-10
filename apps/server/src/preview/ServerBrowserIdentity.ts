// @effect-diagnostics globalDate:off - Playwright steps run outside the Effect runtime, on the page's wall clock.
import type {
  PreviewAutomationFillIdentityRequest,
  PreviewAutomationFillIdentityResult,
  PreviewAutomationReadIdentityRequest,
  PreviewAutomationReadIdentityResult,
  PreviewIdentityValue,
  PreviewIdentityValues,
  PreviewLoginRequester,
} from "@t3tools/contracts";
import type { SecretProviderIdentityValues } from "@t3tools/secret-provider-core/server/driver";
import * as Effect from "effect/Effect";
import type { CDPSession, ElementHandle, Locator, Page } from "playwright-core";

import * as BrowserLogins from "./BrowserLogins.ts";
import type * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import { before, callOnElement, documentId, LATE, loginError } from "./ServerBrowserLogin.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

/** The provider's values plus `fullName`, which is first plus last name. */
const identityValues = (values: SecretProviderIdentityValues): PreviewIdentityValues => {
  const fullName = [values.firstName, values.lastName].filter(Boolean).join(" ");
  return { ...values, ...(fullName ? { fullName } : {}) };
};

// A Map, so a token such as "constructor" cannot reach Object.prototype.
const AUTOCOMPLETE_VALUES = new Map<string, PreviewIdentityValue>([
  ["given-name", "firstName"],
  ["additional-name", "middleInitial"],
  ["family-name", "lastName"],
  ["name", "fullName"],
  ["email", "email"],
  ["tel", "phone"],
  ["tel-national", "phone"],
  ["organization", "company"],
  ["organization-title", "jobTitle"],
  ["street-address", "street"],
  ["address-line1", "street"],
  ["address-level2", "city"],
  ["address-level1", "state"],
  ["postal-code", "postalCode"],
  ["country", "country"],
  ["country-name", "country"],
  ["bday", "birthDate"],
  ["username", "username"],
]);

/** The value an `autocomplete` attribute asks for. Section, shipping and billing tokens map to none. */
const autocompleteValue = (attribute: string | null): PreviewIdentityValue | undefined =>
  (attribute ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((token) => AUTOCOMPLETE_VALUES.get(token))
    .find((value) => value !== undefined);

// US states, DC and Puerto Rico, then Canadian provinces and territories.
const REGIONS: ReadonlyArray<readonly [code: string, name: string]> = [
  ["AL", "Alabama"],
  ["AK", "Alaska"],
  ["AZ", "Arizona"],
  ["AR", "Arkansas"],
  ["CA", "California"],
  ["CO", "Colorado"],
  ["CT", "Connecticut"],
  ["DE", "Delaware"],
  ["DC", "District of Columbia"],
  ["FL", "Florida"],
  ["GA", "Georgia"],
  ["HI", "Hawaii"],
  ["ID", "Idaho"],
  ["IL", "Illinois"],
  ["IN", "Indiana"],
  ["IA", "Iowa"],
  ["KS", "Kansas"],
  ["KY", "Kentucky"],
  ["LA", "Louisiana"],
  ["ME", "Maine"],
  ["MD", "Maryland"],
  ["MA", "Massachusetts"],
  ["MI", "Michigan"],
  ["MN", "Minnesota"],
  ["MS", "Mississippi"],
  ["MO", "Missouri"],
  ["MT", "Montana"],
  ["NE", "Nebraska"],
  ["NV", "Nevada"],
  ["NH", "New Hampshire"],
  ["NJ", "New Jersey"],
  ["NM", "New Mexico"],
  ["NY", "New York"],
  ["NC", "North Carolina"],
  ["ND", "North Dakota"],
  ["OH", "Ohio"],
  ["OK", "Oklahoma"],
  ["OR", "Oregon"],
  ["PA", "Pennsylvania"],
  ["PR", "Puerto Rico"],
  ["RI", "Rhode Island"],
  ["SC", "South Carolina"],
  ["SD", "South Dakota"],
  ["TN", "Tennessee"],
  ["TX", "Texas"],
  ["UT", "Utah"],
  ["VT", "Vermont"],
  ["VA", "Virginia"],
  ["WA", "Washington"],
  ["WV", "West Virginia"],
  ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
  ["AB", "Alberta"],
  ["BC", "British Columbia"],
  ["MB", "Manitoba"],
  ["NB", "New Brunswick"],
  ["NL", "Newfoundland and Labrador"],
  ["NS", "Nova Scotia"],
  ["NT", "Northwest Territories"],
  ["NU", "Nunavut"],
  ["ON", "Ontario"],
  ["PE", "Prince Edward Island"],
  ["QC", "Quebec"],
  ["SK", "Saskatchewan"],
  ["YT", "Yukon"],
];

/** For matching option text: no case, accents or surrounding space. */
const comparable = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();

const regionNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

/** The English name of an ISO country code; providers often store it lowercase, as in `us`. */
const countryName = (stored: string) =>
  /^[a-z]{2}$/i.test(stored) ? regionNames.of(stored.toUpperCase()) : undefined;

/** What a dropdown option may say for a value, best first. Matching ignores case. */
const optionTexts = (value: PreviewIdentityValue, stored: string): ReadonlyArray<string> => {
  if (value === "country") return [stored, countryName(stored) ?? ""];
  if (value === "state") {
    const region = REGIONS.find((names) =>
      names.some((name) => comparable(name) === comparable(stored)),
    );
    return [stored, ...(region ?? [])];
  }
  return [stored];
};

interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
}

/**
 * The first enabled option whose value or label says the stored value, or else another way of
 * writing it: a country's English name, a state's or province's code or name.
 */
export const matchOption = (
  options: ReadonlyArray<SelectOption>,
  value: PreviewIdentityValue,
  stored: string,
): number | undefined => {
  for (const text of optionTexts(value, stored)) {
    const wanted = comparable(text);
    if (wanted === "") continue;
    const index = options.findIndex(
      (option) =>
        !option.disabled &&
        (comparable(option.value) === wanted || comparable(option.label) === wanted),
    );
    if (index >= 0) return index;
  }
  return undefined;
};

const TEXT_INPUT_TYPES = new Set(["text", "email", "tel", "search", "url", "number"]);
const ELEMENT_TIMEOUT_MS = 5_000;
const NO_ANSWER = "The field did not answer in time. Use preview_act.";
const REFUSED = "The field changed or refused the value. Use preview_act.";
const MOVED =
  "The page loaded another document before the field was filled. Take a fresh snapshot.";
const LEFT_SITE = "The page left its site before the identity was filled.";

// Run by `callOnElement`, so a value goes into this element alone however the page moves focus.
// Identity values are not secret, so unlike a login the field is not drawn as dots.
const WRITE_TEXT = `function (value, deadline, origin) {
  if (location.origin !== origin) return "left";
  const types = ["text", "email", "tel", "search", "url", "number", "date"];
  const proto =
    this instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : this instanceof HTMLInputElement && types.includes(this.type)
        ? HTMLInputElement.prototype
        : undefined;
  if (proto === undefined) return "not_field";
  if (this.disabled || this.readOnly) return "not_editable";
  const native = Object.getOwnPropertyDescriptor(proto, "value");
  if (Date.now() >= deadline) return "expired";
  this.focus();
  // The page's focus handlers have run, and may have taken the time, the field or the page.
  if (Date.now() >= deadline) return "expired";
  if (location.origin !== origin) return "left";
  if (!this.isConnected || this.ownerDocument !== document) return "gone";
  native.set.call(this, value);
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return native.get.call(this) === value ? "filled" : "changed";
}`;

// Chooses the option probed earlier, only while it still holds the same value.
const WRITE_OPTION = `function (index, value, deadline, origin) {
  if (location.origin !== origin) return "left";
  if (!(this instanceof HTMLSelectElement)) return "not_field";
  if (this.disabled) return "not_editable";
  if (!this.isConnected || this.ownerDocument !== document) return "gone";
  const option = this.options[index];
  if (option === undefined || option.disabled || option.value !== value) return "changed";
  if (Date.now() >= deadline) return "expired";
  const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");
  native.set.call(this, index);
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return native.get.call(this) === index ? "filled" : "changed";
}`;

interface FieldInfo {
  readonly tag: string;
  readonly type: string;
  /** No value yet; a dropdown still showing the page's own default counts. */
  readonly empty: boolean;
}

const fieldInfo = (handle: ElementHandle): Promise<FieldInfo> =>
  handle.evaluate((element) => {
    const field = element as unknown as {
      readonly tagName: string;
      readonly type?: string;
      readonly value?: string;
      readonly selectedIndex?: number;
      readonly options?: ArrayLike<{ readonly defaultSelected: boolean }>;
    };
    const tag = field.tagName.toLowerCase();
    if (tag !== "select") {
      return { tag, type: String(field.type ?? "").toLowerCase(), empty: !field.value };
    }
    const options = Array.from(field.options ?? []);
    const index = field.selectedIndex ?? -1;
    const pristine = options.some((option) => option.defaultSelected)
      ? options[index]?.defaultSelected === true
      : index <= 0;
    return { tag, type: "", empty: !field.value || pristine };
  });

const selectOptions = (handle: ElementHandle): Promise<ReadonlyArray<SelectOption>> =>
  handle.evaluate((element) =>
    Array.from(
      (
        element as unknown as {
          readonly options: ArrayLike<{ value: string; label: string; disabled: boolean }>;
        }
      ).options,
      ({ value, label, disabled }) => ({ value, label, disabled }),
    ),
  );

interface IdentityTarget {
  readonly value: PreviewIdentityValue;
  /** An agent's locator, resolved again right before writing. */
  readonly locator?: Locator;
  readonly handle?: ElementHandle;
}

const callEnded = () => loginError("The call ended before the identity was filled.");

type FoundField = { readonly value: PreviewIdentityValue; readonly handle: ElementHandle };

const scanAutocompleteFields = async (
  page: Page,
  frameAllowed: (frameUrl: string) => boolean,
): Promise<ReadonlyArray<FoundField>> => {
  const found: Array<FoundField> = [];
  for (const frame of page.frames()) {
    if (!frameAllowed(frame.url())) continue;
    const handles = await frame
      .locator("input, select, textarea")
      .elementHandles()
      .catch(() => []);
    for (const handle of handles) {
      const value = autocompleteValue(await handle.getAttribute("autocomplete").catch(() => null));
      const fillable =
        value !== undefined &&
        (await handle.isVisible().catch(() => false)) &&
        (await handle.isEditable().catch(() => false)) &&
        (await fieldInfo(handle).catch(() => undefined))?.empty === true;
      if (fillable) found.push({ value, handle });
      else await handle.dispose().catch(() => undefined);
    }
  }
  return found;
};

/**
 * Visible, editable, empty fields whose `autocomplete` names an identity value, in frames on the
 * page's own site. Fields in any other frame, such as an ad or a chat widget, are never used.
 */
const findAutocompleteFields = async (
  page: Page,
  frameAllowed: (frameUrl: string) => boolean,
  deadline: number,
) => {
  const scan = scanAutocompleteFields(page, frameAllowed);
  const found = await before(scan, deadline);
  if (found !== LATE) return found;
  void scan
    .then((fields) => Promise.all(fields.map(({ handle }) => handle.dispose())))
    .catch(() => undefined);
  throw callEnded();
};

/**
 * Checks that each of the agent's locators points into a frame on the page's own site, before
 * anyone is asked to approve. A locator into another site's frame refuses the whole fill.
 */
export const checkIdentityLocators = async (
  fields: ReadonlyArray<{ readonly value: PreviewIdentityValue; readonly locator: Locator }>,
  frameAllowed: (frameUrl: string) => boolean,
  /** In `Date.now()` time. */
  deadline: number,
) => {
  for (const { value, locator } of fields) {
    if (Date.now() >= deadline) throw callEnded();
    const handle = await locator.elementHandle({
      timeout: Math.max(1, Math.min(ELEMENT_TIMEOUT_MS, deadline - Date.now())),
    });
    const frame = await handle?.ownerFrame();
    await handle?.dispose();
    if (frame === null || frame === undefined || !frameAllowed(frame.url())) {
      throw loginError(
        `The ${value} locator points outside this page's site. Take a fresh snapshot.`,
      );
    }
  }
};

const ADDRESS_PARTS: ReadonlySet<PreviewIdentityValue> = new Set([
  "street",
  "city",
  "state",
  "postalCode",
  "country",
]);

/** Why a value the identity lacks was not filled. */
const missing = (value: PreviewIdentityValue, values: PreviewIdentityValues) =>
  ADDRESS_PARTS.has(value) && values.address !== undefined
    ? `The identity's address is stored as one line, so its ${value} is not filled on its own. Get the address with preview_read_identity, then fill the field with preview_act.`
    : `The identity has no ${value}.`;

/** The write a field needs for a value, or why it gets none. */
const chooseWrite = async (handle: ElementHandle, value: PreviewIdentityValue, stored: string) => {
  const field = await fieldInfo(handle);
  if (field.tag === "select") {
    const options = await selectOptions(handle);
    const index = matchOption(options, value, stored);
    const option = index === undefined ? undefined : options[index];
    if (index === undefined || option === undefined) {
      return `No option matches the identity's ${value}. Use preview_act.`;
    }
    return { functionDeclaration: WRITE_OPTION, args: [index, option.value] };
  }
  if (field.tag === "input" && field.type === "date") {
    const date = /^\d{4}-\d{2}-\d{2}/.exec(stored)?.[0];
    if (date === undefined) return `The ${value} is not a YYYY-MM-DD date. Use preview_act.`;
    return { functionDeclaration: WRITE_TEXT, args: [date] };
  }
  if (field.tag === "textarea" || (field.tag === "input" && TEXT_INPUT_TYPES.has(field.type))) {
    const text = value === "country" ? (countryName(stored) ?? stored) : stored;
    return { functionDeclaration: WRITE_TEXT, args: [text] };
  }
  return "Not a text field or a native dropdown. Use preview_act.";
};

interface FieldWrite {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly handle: ElementHandle;
  readonly value: PreviewIdentityValue;
  readonly values: PreviewIdentityValues;
  readonly frameAllowed: (frameUrl: string) => boolean;
  /** The main document the fill is for, as `documentId` named it. */
  readonly document: string;
  /** In `Date.now()` time. */
  readonly deadline: number;
}

const writeIdentityField = async (input: FieldWrite): Promise<string | undefined> => {
  const { handle, value } = input;
  const frame = await handle.ownerFrame();
  if (frame === null || !input.frameAllowed(frame.url())) throw loginError(LEFT_SITE);
  const stored = input.values[value];
  if (stored === undefined) return missing(value, input.values);
  const write = await chooseWrite(handle, value, stored).catch(() => REFUSED);
  if (typeof write === "string") return write;
  const call = await callOnElement({
    page: input.page,
    cdp: input.cdp,
    handle,
    frameAllowed: input.frameAllowed,
    document: input.document,
    deadline: input.deadline,
    ...write,
  });
  switch (call.status) {
    case "expired":
      return NO_ANSWER;
    case "moved":
      return MOVED;
    case "left":
    case "threw":
      return REFUSED;
  }
  switch (call.value) {
    case "filled":
      return undefined;
    case "expired":
      return NO_ANSWER;
    case "left":
      throw loginError(LEFT_SITE);
    default:
      return REFUSED;
  }
};

/**
 * Puts one value into the handle's element alone, in a frame on the page's site and the document
 * the fill is for, and never after the deadline, which also bounds looking at the field. Returns
 * why it was skipped, or undefined once filled.
 */
export const fillIdentityField = async (input: FieldWrite): Promise<string | undefined> => {
  const written = await before(writeIdentityField(input), input.deadline);
  return written === LATE ? NO_ANSWER : written;
};

export interface IdentityContext {
  readonly logins: Pick<
    BrowserLogins.BrowserLogins["Service"],
    "identityCandidates" | "readIdentity" | "needsApproval" | "recordApproval" | "check"
  >;
  readonly desktopChannel: Pick<
    DesktopBrowserChannel.DesktopBrowserChannel["Service"],
    "available" | "approveLogin"
  >;
  /** Runs a step of the login service; its failure becomes an operation error. */
  readonly step: <A>(effect: Effect.Effect<A, BrowserLogins.BrowserLoginError>) => Promise<A>;
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>;
}

/** The services the flows use, with runners for their steps from Playwright code. */
export const makeIdentityContext = Effect.fn("ServerBrowserIdentity.makeContext")(function* (
  logins: IdentityContext["logins"],
  desktopChannel: IdentityContext["desktopChannel"],
) {
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const context: IdentityContext = {
    logins,
    desktopChannel,
    step: (effect) =>
      runPromise(
        effect.pipe(
          Effect.mapError((error) => loginError(error.message)),
          Effect.catchDefect(() => Effect.fail(loginError("The password manager failed."))),
        ),
      ),
    runPromise: (effect) => runPromise(effect),
  };
  return context;
});

interface IdentityTab {
  readonly threadId: string;
  readonly tabId: string;
  readonly page: Page;
  readonly cdp: CDPSession;
}

const summary = (identity: BrowserLogins.BrowserIdentityCandidate) => ({
  id: identity.id,
  title: identity.title,
  ...(identity.vault ? { vault: identity.vault } : {}),
  account: identity.account,
});

const choose = (
  identities: ReadonlyArray<BrowserLogins.BrowserIdentityCandidate>,
  id: string | undefined,
) =>
  id === undefined
    ? identities.length === 1
      ? identities[0]
      : undefined
    : identities.find((identity) => identity.id === id);

const requesterPrompt = (requester: PreviewLoginRequester | undefined) => ({
  ...(requester?.threadTitle ? { threadTitle: requester.threadTitle } : {}),
  ...(requester?.provider ? { agent: requester.provider } : {}),
});

/** Country before the rest, since a page may only list its states once a country is chosen. */
const countryFirst = <A extends { readonly value: PreviewIdentityValue }>(
  targets: ReadonlyArray<A>,
) => [...targets].sort((a, b) => Number(b.value === "country") - Number(a.value === "country"));

/**
 * Fills the user's saved identity into a tab: the fields the agent named, or else every empty
 * field tagged with `autocomplete`, only in frames on the page's own site. Identity values are
 * personal, not secret, so they are neither hidden in the page nor scrubbed from later results.
 */
export const fillIdentity = async (
  context: IdentityContext,
  tab: IdentityTab,
  input: PreviewAutomationFillIdentityRequest,
  deadlineMs: number,
): Promise<PreviewAutomationFillIdentityResult> => {
  const { logins, step } = context;
  const { revision, identities } = await step(logins.identityCandidates("identity"));
  const identity = choose(identities, input.identity);
  if (identity === undefined) {
    return identities.length === 0
      ? { status: "no_identity", tabId: tab.tabId }
      : { status: "choose", tabId: tab.tabId, candidates: identities.map(summary) };
  }
  const pageUrl = tab.page.url();
  const frameAllowed = (frameUrl: string) => BrowserLogins.loginCoversPage([pageUrl], frameUrl);
  if (!frameAllowed(pageUrl)) {
    throw loginError("Open the sign-up page first: identities fill only http and https pages.");
  }
  // The page sees wall-clock time, so every step that reaches into it shares this deadline.
  const deadline = Date.now() + (deadlineMs - performance.now());
  const remaining = () => deadline - Date.now();
  const named = (input.fields ?? []).flatMap(({ locator, value }) => {
    const target = ServerBrowserPage.targetLocator(tab.page, { locator });
    return target === null ? [] : [{ value, locator: target }];
  });
  if (named.length > 0) {
    await checkIdentityLocators(named, frameAllowed, deadline);
  } else {
    const found = await findAutocompleteFields(tab.page, frameAllowed, deadline);
    await Promise.all(found.map(({ handle }) => handle.dispose().catch(() => undefined)));
    if (found.length === 0) {
      throw loginError(
        "No empty fields tagged with autocomplete were found. Pass `fields` with aria-ref locators from preview_snapshot.",
      );
    }
  }
  const document = await documentId(tab.cdp);
  const ask = await step(logins.needsApproval(revision, tab.threadId, "identity"));
  if (ask !== false) {
    // Only a desktop app attached to this server can ask, also for tabs it does not draw.
    if (!context.desktopChannel.available) {
      throw loginError(
        "Nobody can approve filling an identity on this machine. Ask the user to fill the form in the tab, or to choose Don't ask in Settings > Browser > Logins for this environment.",
      );
    }
    const approved = await context.runPromise(
      context.desktopChannel.approveLogin(
        { threadId: tab.threadId, tabId: tab.tabId },
        Math.max(0, remaining()),
        {
          kind: "identity",
          providerLabel: identity.account,
          loginTitle: identity.title,
          ...(identity.vault ? { vault: identity.vault } : {}),
          origin: new URL(pageUrl).origin,
          ...requesterPrompt(input.requester),
          scope: ask,
        },
      ),
    );
    if (!approved) throw loginError("The user did not approve filling this identity.");
    if (remaining() <= 0) throw loginError("The approval came after the call ended.");
    await step(logins.recordApproval(revision, tab.threadId, "identity"));
  }
  const values = identityValues(await step(logins.readIdentity(revision, identity)));
  // The page may have moved on, or the settings changed, while the user was deciding.
  if ((await documentId(tab.cdp)) !== document) {
    throw loginError(
      "The page changed before the identity was filled. Take a fresh snapshot and try again.",
    );
  }
  await step(logins.check(revision));
  const targets = countryFirst<IdentityTarget>(
    named.length > 0 ? named : await findAutocompleteFields(tab.page, frameAllowed, deadline),
  );
  const filled: Array<PreviewIdentityValue> = [];
  const skipped: Array<{ readonly value: PreviewIdentityValue; readonly reason: string }> = [];
  try {
    for (const target of targets) {
      if (remaining() <= 0) throw callEnded();
      // One field that never answers must not use up the whole call.
      const fieldDeadline = Math.min(deadline, Date.now() + ELEMENT_TIMEOUT_MS);
      const handle =
        target.handle ??
        (await target.locator
          ?.elementHandle({ timeout: Math.max(1, fieldDeadline - Date.now()) })
          .catch(() => null));
      if (handle === undefined || handle === null) {
        skipped.push({ value: target.value, reason: "The field is gone. Take a fresh snapshot." });
        continue;
      }
      try {
        const reason = await fillIdentityField({
          page: tab.page,
          cdp: tab.cdp,
          handle,
          value: target.value,
          values,
          frameAllowed,
          document,
          deadline: fieldDeadline,
        });
        if (reason === undefined) filled.push(target.value);
        else skipped.push({ value: target.value, reason });
      } finally {
        if (target.handle === undefined) await handle.dispose().catch(() => undefined);
      }
    }
  } finally {
    await Promise.all(targets.map((target) => target.handle?.dispose().catch(() => undefined)));
  }
  return { status: "filled", tabId: tab.tabId, identity: summary(identity), filled, skipped };
};

/**
 * Hands one identity's values to the agent, for a browser this server does not control. The user
 * approves under its own setting; the values go to the agent and its model provider as they are.
 */
export const readIdentity = async (
  context: IdentityContext,
  threadId: string,
  input: PreviewAutomationReadIdentityRequest,
  deadlineMs: number,
): Promise<PreviewAutomationReadIdentityResult> => {
  const { logins, step } = context;
  const remaining = () => deadlineMs - performance.now();
  const { revision, identities } = await step(logins.identityCandidates("identityRead"));
  const identity = choose(identities, input.identity);
  if (identity === undefined) {
    return identities.length === 0
      ? { status: "no_identity" }
      : { status: "choose", candidates: identities.map(summary) };
  }
  const ask = await step(logins.needsApproval(revision, threadId, "identityRead"));
  if (ask !== false) {
    if (!context.desktopChannel.available) {
      throw loginError(
        "Nobody can approve showing an identity on this machine. Fill the built-in browser with preview_fill_identity instead, or ask the user to choose Don't ask under Identity details for other browsers in Settings > Browser > Logins.",
      );
    }
    const approved = await context.runPromise(
      context.desktopChannel.approveLogin({ threadId }, Math.max(0, remaining()), {
        kind: "identityRead",
        providerLabel: identity.account,
        loginTitle: identity.title,
        ...(identity.vault ? { vault: identity.vault } : {}),
        ...requesterPrompt(input.requester),
        scope: ask,
      }),
    );
    if (!approved) throw loginError("The user did not approve showing this identity.");
    if (remaining() <= 0) throw loginError("The approval came after the call ended.");
    await step(logins.recordApproval(revision, threadId, "identityRead"));
  }
  const values = identityValues(await step(logins.readIdentity(revision, identity)));
  return { status: "read", identity: summary(identity), values };
};
