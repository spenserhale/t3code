import type {
  SecretProviderDriver,
  SecretProviderDriverServices,
  SecretProviderIdentities,
  SecretProviderIdentity,
  SecretProviderIdentityValues,
  SecretProviderLogin,
  SecretProviderLoginField,
  SecretProviderLoginValues,
  SecretProviderLogins,
  SecretProviderPasswordRecipe,
} from "@t3tools/secret-provider-core/server/driver";
import {
  browserLoginProviderIds,
  DEFAULT_BROWSER_IDENTITY_READ_APPROVAL,
  type BrowserIdentityReadApproval,
  type BrowserLoginApproval,
  type BrowserNewLoginSettings,
  type SecretProviderId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "../secrets/secretProviderDefinitions.ts";
import * as Settings from "../serverSettings.ts";

const LIST_CACHE_MS = 5 * 60_000;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8 = new TextEncoder();

export class BrowserLoginError extends Data.TaggedError("BrowserLoginError")<{
  readonly reason: "not_configured" | "unreadable";
  readonly message: string;
}> {}

/** A saved login offered for a page, without its secrets. */
export interface BrowserLoginCandidate extends SecretProviderLogin {
  /** `<providerId>/<itemId>`, so a read goes back to the provider the login came from. */
  readonly id: string;
  /** The provider's name in Settings > Secrets, such as "Work 1Password". */
  readonly account: string;
}

/** A saved identity, without its values. */
export interface BrowserIdentityCandidate extends SecretProviderIdentity {
  /** `<providerId>/<itemId>`, so a read goes back to the provider the identity came from. */
  readonly id: string;
  /** The provider's name in Settings > Secrets, such as "Work 1Password". */
  readonly account: string;
}

/** What a prompt allows: filling a login, filling an identity, or showing one to the agent. */
export type BrowserApprovalKind = "login" | "identity" | "identityRead" | "newLogin";

/** A login to save for a sign-up, in the vault the user chose for new logins. */
export interface BrowserNewLogin {
  readonly threadId: string;
  /** Named in the saved item's notes. */
  readonly threadTitle?: string | undefined;
  readonly title: string;
  readonly url: string;
  readonly username: string;
  readonly recipe: SecretProviderPasswordRecipe;
}

/** A login saved for a sign-up, with the password its password manager generated. */
export interface BrowserNewPassword {
  readonly login: BrowserLoginCandidate;
  readonly password: string;
}

export class BrowserLogins extends Context.Service<
  BrowserLogins,
  {
    /** Saved logins whose websites cover `pageUrl`, from every chosen provider that could list. */
    readonly candidates: (pageUrl: string) => Effect.Effect<
      {
        /** Names the settings these logins came from; later steps fail once they change at all. */
        readonly revision: string;
        readonly logins: ReadonlyArray<BrowserLoginCandidate>;
      },
      BrowserLoginError
    >;
    readonly read: (
      revision: string,
      login: BrowserLoginCandidate,
      fields: ReadonlyArray<SecretProviderLoginField>,
    ) => Effect.Effect<SecretProviderLoginValues, BrowserLoginError>;
    /**
     * Saved identities from every chosen provider that could list, for filling one or for
     * showing one to the agent. Showing fails here when the user turned it off.
     */
    readonly identityCandidates: (kind: Exclude<BrowserApprovalKind, "login">) => Effect.Effect<
      {
        readonly revision: string;
        readonly identities: ReadonlyArray<BrowserIdentityCandidate>;
      },
      BrowserLoginError
    >;
    readonly readIdentity: (
      revision: string,
      identity: BrowserIdentityCandidate,
    ) => Effect.Effect<SecretProviderIdentityValues, BrowserLoginError>;
    /**
     * The prompt the user must answer before this kind of step on this thread, or false when
     * none is due. Each kind is approved on its own.
     */
    readonly needsApproval: (
      revision: string,
      threadId: string,
      kind: BrowserApprovalKind,
    ) => Effect.Effect<Exclude<BrowserLoginApproval, "never"> | false, BrowserLoginError>;
    /** Records the answer to a prompt shown under `revision`, never under a newer setting. */
    readonly recordApproval: (
      revision: string,
      threadId: string,
      kind: BrowserApprovalKind,
    ) => Effect.Effect<void, BrowserLoginError>;
    /** Fails if the settings changed since `revision`, for a last check before filling. */
    readonly check: (revision: string) => Effect.Effect<void, BrowserLoginError>;
    /** Forgets listed logins, for after one is saved; a listing begun earlier cannot refill them. */
    readonly invalidate: Effect.Effect<void>;
    /**
     * Where a new login would be saved, for the approval prompt, and the earlier login a call
     * continues: the one `loginId` names, or else one `createLogin` saved for this thread, site
     * and username whose password never reached a page. Fails until the user chooses where new
     * logins go.
     */
    readonly newLoginDestination: (request: {
      readonly threadId: string;
      readonly loginId: string | undefined;
      readonly url: string;
      readonly username: string;
    }) => Effect.Effect<
      {
        readonly revision: string;
        /** The provider's name in Settings > Secrets. */
        readonly account: string;
        readonly vault?: string;
        readonly login?: BrowserLoginCandidate;
        /** Whether that login's password has reached a page, which may then hold it. */
        readonly filled?: boolean;
      },
      BrowserLoginError
    >;
    /**
     * Saves a new login whose password the password manager generates. The login belongs to the
     * thread once saved, however the call ends; an error after that names it.
     */
    readonly createLogin: (
      revision: string,
      input: BrowserNewLogin,
    ) => Effect.Effect<BrowserNewPassword, BrowserLoginError>;
    /** Reads the password of a login `createLogin` made for this thread, for a retry. */
    readonly readNewLogin: (
      revision: string,
      threadId: string,
      loginId: string,
    ) => Effect.Effect<BrowserNewPassword, BrowserLoginError>;
    /** Notes that a new login's password went into a page, so only naming it renews it. */
    readonly newLoginFilled: (threadId: string, loginId: string) => Effect.Effect<void>;
    /**
     * Gives a login `createLogin` made for this thread a newly generated password. Any other login
     * is refused: its site may still expect the password it has.
     */
    readonly regeneratePassword: (
      revision: string,
      threadId: string,
      loginId: string,
      recipe: SecretProviderPasswordRecipe,
    ) => Effect.Effect<BrowserNewPassword, BrowserLoginError>;
  }
>()("t3/preview/BrowserLogins") {}

const hostCovers = (loginHost: string, pageHost: string) =>
  pageHost === loginHost || pageHost.endsWith(`.${loginHost}`);

const parseLoginUrl = (url: string) => {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return undefined;
  }
};

/**
 * Like a password manager's default autofill: the page's host is the login's host or one of its
 * subdomains, on the same port, and never over plain http unless the login itself is http.
 */
export const loginCoversPage = (urls: ReadonlyArray<string>, pageUrl: string): boolean => {
  const page = parseLoginUrl(pageUrl);
  if (page === undefined || (page.protocol !== "https:" && page.protocol !== "http:")) {
    return false;
  }
  return urls.some((url) => {
    const login = parseLoginUrl(url);
    if (login === undefined || login.hostname === "") return false;
    if (page.protocol === "http:" && login.protocol !== "http:") return false;
    if (login.port !== page.port) return false;
    return hostCovers(login.hostname.toLowerCase(), page.hostname.toLowerCase());
  });
};

interface Source {
  readonly id: SecretProviderId;
  readonly account: string;
  /** The driver's name, such as "1Password". */
  readonly label: string;
  /** A digest of the provider and its config: a changed config, token included, lists again. */
  readonly key: string;
  readonly config: unknown;
  readonly logins: SecretProviderLogins;
  readonly identities?: SecretProviderIdentities;
}

interface Resolved {
  readonly approval: BrowserLoginApproval;
  readonly identityReadApproval: BrowserIdentityReadApproval;
  readonly newLogins: BrowserNewLoginSettings | undefined;
  readonly revision: string;
  readonly sources: ReadonlyArray<Source>;
}

// Configs hold service account tokens, so the keys kept for the server's life are digests.
const resolve = Effect.fn("BrowserLogins.resolve")(function* (
  drivers: ReadonlyArray<SecretProviderDriver>,
  digest: Digest.Digest["Service"],
  settings: ServerSettings,
): Effect.fn.Return<Resolved, BrowserLoginError> {
  const ids = [...new Set(browserLoginProviderIds(settings.browserLogins))];
  if (ids.length === 0) {
    return yield* new BrowserLoginError({
      reason: "not_configured",
      message:
        "Browser logins are off. The user can turn them on in Settings > Browser by choosing a password manager.",
    });
  }
  const sources: Array<Source> = [];
  for (const id of ids) {
    const configured = settings.secretProviders[id];
    const driver = drivers.find((candidate) => candidate.kind === configured?.kind);
    if (configured === undefined || driver?.logins === undefined) continue;
    const identity = encodeJson([id, configured.kind, configured.config ?? null]);
    sources.push({
      id,
      account: configured.label,
      label: driver.definition.label,
      key: yield* digest.digestHex(Digest.sha256, utf8.encode(identity)),
      config: configured.config,
      logins: driver.logins,
      ...(driver.identities === undefined ? {} : { identities: driver.identities }),
    });
  }
  if (sources.length === 0) {
    const named = ids.join(", ");
    return yield* new BrowserLoginError({
      reason: "not_configured",
      message:
        ids.length === 1
          ? `The password manager chosen for browser logins (${named}) is missing or cannot fill logins. The user can fix it in Settings > Browser.`
          : `None of the password managers chosen for browser logins (${named}) can fill logins. The user can fix it in Settings > Browser.`,
    });
  }
  const { approval } = settings.browserLogins;
  const identityReadApproval =
    settings.browserLogins.identityReadApproval ?? DEFAULT_BROWSER_IDENTITY_READ_APPROVAL;
  const newLogins = settings.browserLogins.newLogins;
  return {
    approval,
    identityReadApproval,
    newLogins,
    sources,
    // Unusable ids count too, so one becoming usable starts a new generation.
    revision: encodeJson([
      approval,
      identityReadApproval,
      newLogins ?? null,
      ...ids.map((id) => sources.find((source) => source.id === id)?.key ?? id),
    ]),
  };
});

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** What the saved item says about itself, so the user can tell a login left by a sign-up. */
const newLoginNotes = (input: BrowserNewLogin, today: string) =>
  [
    "Created by T3 Code",
    input.threadTitle ? ` for the thread "${oneLine(input.threadTitle)}"` : "",
    ` on ${today} for ${input.url}.`,
    " It can be deleted if the sign-up did not finish.",
  ].join("");

const newLoginsError = (message: string) =>
  new BrowserLoginError({ reason: "not_configured", message });

interface Listed<A> {
  readonly at: number;
  readonly items: ReadonlyArray<A>;
}

/** One kind of item's listings, kept per source. */
interface ItemLists<A> {
  readonly what: "logins" | "identities";
  readonly cache: Map<string, Listed<A>>;
  /** Listing is rate limited (service accounts), so requests that arrive meanwhile share one. */
  readonly running: Map<string, Deferred.Deferred<ReadonlyArray<A> | undefined>>;
  /** Raised by `invalidate`, so a listing begun earlier cannot refill the cache. */
  version: number;
}

const itemLists = <A>(what: ItemLists<A>["what"]): ItemLists<A> => ({
  what,
  cache: new Map(),
  running: new Map(),
  version: 0,
});

const identityReadOff = () =>
  new BrowserLoginError({
    reason: "not_configured",
    message:
      "Showing identity details to the agent is off. Fill the built-in browser with preview_fill_identity instead, or ask the user to allow it under Identity details for other browsers in Settings > Browser > Logins.",
  });

export const make = Effect.fn("BrowserLogins.make")(function* (
  drivers: ReadonlyArray<SecretProviderDriver>,
) {
  const settingsService = yield* Settings.ServerSettingsService;
  const digest = yield* Digest.Digest;
  const driverServices = yield* Effect.context<SecretProviderDriverServices>();
  const scope = yield* Effect.scope;
  const loginLists = itemLists<SecretProviderLogin>("logins");
  const identityLists = itemLists<SecretProviderIdentity>("identities");
  // Approvals last for the server's life. Any change to the providers, their config, or the
  // approval settings starts a new generation and forgets them all; a step begun in an older
  // generation fails, even if the settings have since changed back.
  const approvals = new Set<string>();
  let generation = 0;
  let seenRevision: string | undefined;
  const see = (revision: string) => {
    if (seenRevision !== undefined && seenRevision !== revision) {
      generation++;
      approvals.clear();
    }
    seenRevision = revision;
  };
  // Settings that turn logins off count as one revision too.
  const observe = (settings: ServerSettings) =>
    resolve(drivers, digest, settings).pipe(
      Effect.tap((resolved) => Effect.sync(() => see(resolved.revision))),
      Effect.tapError(() => Effect.sync(() => see(""))),
    );
  // Subscribed before the first read, so no change between the two is missed.
  const changes = yield* settingsService.subscribeChanges;
  yield* settingsService.getSettings.pipe(Effect.flatMap(observe), Effect.ignore);
  yield* changes.pipe(
    Stream.runForEach((settings) => Effect.ignore(observe(settings))),
    Effect.forkScoped,
  );

  const current = settingsService.getSettings.pipe(
    Effect.mapError(
      () => new BrowserLoginError({ reason: "unreadable", message: "Settings could not be read." }),
    ),
    Effect.flatMap(observe),
  );

  const approvalKey = (
    kind: BrowserApprovalKind,
    approval: BrowserLoginApproval,
    threadId: string,
  ) =>
    approval === "application"
      ? `${kind}\u0000application`
      : `${kind}\u0000thread\u0000${threadId}`;

  const approvalMode = (
    resolved: Resolved,
    kind: BrowserApprovalKind,
  ): Effect.Effect<BrowserLoginApproval, BrowserLoginError> =>
    kind !== "identityRead"
      ? Effect.succeed(resolved.approval)
      : resolved.identityReadApproval === "off"
        ? Effect.fail(identityReadOff())
        : Effect.succeed(resolved.identityReadApproval);

  const currentAt = (revision: string) =>
    current.pipe(
      Effect.filterOrFail(
        () => String(generation) === revision,
        () =>
          new BrowserLoginError({
            reason: "not_configured",
            message: "The browser login settings changed. Try again.",
          }),
      ),
    );

  const listOne = Effect.fn("BrowserLogins.listOne")(function* <A>(
    lists: ItemLists<A>,
    source: Source,
    list: Effect.Effect<ReadonlyArray<A> | undefined, never, SecretProviderDriverServices>,
    now: number,
  ): Effect.fn.Return<ReadonlyArray<A> | undefined> {
    const cached = lists.cache.get(source.key);
    if (cached !== undefined && now - cached.at < LIST_CACHE_MS) return cached.items;
    const running = lists.running.get(source.key);
    if (running !== undefined) return yield* Deferred.await(running);
    const done = yield* Deferred.make<ReadonlyArray<A> | undefined>();
    lists.running.set(source.key, done);
    const version = lists.version;
    // Forked, so a caller that gives up does not end the listing the others wait on.
    yield* list.pipe(
      Effect.provideContext(driverServices),
      Effect.tap((items) => {
        if (version !== lists.version) return Effect.void;
        if (items !== undefined) {
          lists.cache.set(source.key, { at: now, items });
          return Effect.void;
        }
        lists.cache.delete(source.key);
        return Effect.logWarning(`A password manager did not list its ${lists.what}`, {
          secretProviderId: source.id,
        });
      }),
      Effect.onExit((exit) =>
        Effect.suspend(() => {
          if (lists.running.get(source.key) === done) lists.running.delete(source.key);
          return Deferred.done(done, exit);
        }),
      ),
      Effect.forkIn(scope),
    );
    return yield* Deferred.await(done);
  });

  /**
   * Lists each source once per config, keeping a list five minutes. A locked or rate-limited
   * provider hides only its own items; all of them failing is an error.
   */
  const listAll = Effect.fn("BrowserLogins.listAll")(function* <A>(
    lists: ItemLists<A>,
    sources: ReadonlyArray<{
      readonly source: Source;
      readonly list: Effect.Effect<
        ReadonlyArray<A> | undefined,
        never,
        SecretProviderDriverServices
      >;
    }>,
  ): Effect.fn.Return<ReadonlyArray<ReadonlyArray<A>>, BrowserLoginError> {
    const now = yield* Clock.currentTimeMillis;
    for (const key of lists.cache.keys()) {
      if (!sources.some(({ source }) => source.key === key)) lists.cache.delete(key);
    }
    const listed = yield* Effect.forEach(
      sources,
      ({ source, list }) => listOne(lists, source, list, now),
      { concurrency: "unbounded" },
    );
    if (listed.every((items) => items === undefined)) {
      const [only, ...others] = sources;
      return yield* new BrowserLoginError({
        reason: "unreadable",
        message:
          only !== undefined && others.length === 0
            ? `${only.source.label} did not list its ${lists.what}. It may be locked, or its CLI integration may be off.`
            : `None of the password managers chosen for browser logins listed their ${lists.what}. They may be locked, or their CLI integration may be off.`,
      });
    }
    return listed.map((items) => items ?? []);
  });

  /** The chosen provider an item id names, and the provider's own id for it. */
  const sourceOf = (resolved: Resolved, id: string) => {
    const slash = id.indexOf("/");
    const source =
      slash < 0
        ? undefined
        : resolved.sources.find((candidate) => candidate.id === id.slice(0, slash));
    return source === undefined ? undefined : { source, itemId: id.slice(slash + 1) };
  };

  const candidates: BrowserLogins["Service"]["candidates"] = Effect.fn("BrowserLogins.candidates")(
    function* (pageUrl) {
      const resolved = yield* current;
      const revision = String(generation);
      const listed = yield* listAll(
        loginLists,
        resolved.sources.map((source) => ({ source, list: source.logins.list(source.config) })),
      );
      return {
        revision,
        logins: resolved.sources.flatMap((source, index) =>
          (listed[index] ?? [])
            .filter((login) => loginCoversPage(login.urls, pageUrl))
            .map((login) => ({
              ...login,
              id: `${source.id}/${login.id}`,
              account: source.account,
            })),
        ),
      };
    },
  );

  const read: BrowserLogins["Service"]["read"] = Effect.fn("BrowserLogins.read")(
    function* (revision, login, fields) {
      const found = sourceOf(yield* currentAt(revision), login.id);
      if (found === undefined) {
        return yield* new BrowserLoginError({
          reason: "not_configured",
          message: "That login is not from a password manager chosen for browser logins.",
        });
      }
      const { source, itemId } = found;
      const values = yield* source.logins
        .read(source.config, { ...login, id: itemId }, fields)
        .pipe(Effect.provideContext(driverServices));
      if (values === undefined) {
        return yield* new BrowserLoginError({
          reason: "unreadable",
          message: `${source.label} did not return the login. It may be locked, or the request was denied there.`,
        });
      }
      // The read can wait on the password manager's own prompt; settings may change meanwhile.
      yield* currentAt(revision);
      return values;
    },
  );

  const identityCandidates: BrowserLogins["Service"]["identityCandidates"] = Effect.fn(
    "BrowserLogins.identityCandidates",
  )(function* (kind) {
    const resolved = yield* current;
    yield* approvalMode(resolved, kind);
    const revision = String(generation);
    const sources = resolved.sources.flatMap((source) =>
      source.identities === undefined
        ? []
        : [{ source, list: source.identities.list(source.config) }],
    );
    if (sources.length === 0) {
      return yield* new BrowserLoginError({
        reason: "not_configured",
        message:
          "None of the password managers chosen for browser logins can fill identities. The user can choose one in Settings > Browser.",
      });
    }
    const listed = yield* listAll(identityLists, sources);
    return {
      revision,
      identities: sources.flatMap(({ source }, index) =>
        (listed[index] ?? []).map((identity) => ({
          ...identity,
          id: `${source.id}/${identity.id}`,
          account: source.account,
        })),
      ),
    };
  });

  const readIdentity: BrowserLogins["Service"]["readIdentity"] = Effect.fn(
    "BrowserLogins.readIdentity",
  )(function* (revision, identity) {
    const found = sourceOf(yield* currentAt(revision), identity.id);
    const identities = found?.source.identities;
    if (found === undefined || identities === undefined) {
      return yield* new BrowserLoginError({
        reason: "not_configured",
        message: "That identity is not from a password manager chosen for browser logins.",
      });
    }
    const values = yield* identities
      .read(found.source.config, { ...identity, id: found.itemId })
      .pipe(Effect.provideContext(driverServices));
    if (values === undefined) {
      return yield* new BrowserLoginError({
        reason: "unreadable",
        message: `${found.source.label} did not return the identity. It may be locked, or the request was denied there.`,
      });
    }
    yield* currentAt(revision);
    return values;
  });

  // Logins created here, by thread and id, for the server's life: only these get a new password.
  const createdLogins = new Map<
    string,
    {
      readonly threadId: string;
      readonly login: BrowserLoginCandidate;
      readonly url: string;
      readonly username: string;
      filled: boolean;
    }
  >();
  const createdKey = (threadId: string, loginId: string) => `${threadId}\u0000${loginId}`;

  const newLoginSource = Effect.fn("BrowserLogins.newLoginSource")(function* (resolved: Resolved) {
    const chosen = resolved.newLogins;
    if (chosen === undefined) {
      return yield* newLoginsError(
        "New logins are off. The user can choose where new logins are saved in Settings > Browser > Logins.",
      );
    }
    const source = resolved.sources.find((candidate) => candidate.id === chosen.secretProviderId);
    if (source === undefined) {
      return yield* newLoginsError(
        `The password manager chosen for new logins (${chosen.secretProviderId}) is not one chosen for browser logins. The user can fix it in Settings > Browser > Logins.`,
      );
    }
    const create = source.logins.create;
    if (create === undefined) {
      return yield* newLoginsError(
        `${source.label} cannot create logins. The user can choose another password manager for new logins in Settings > Browser > Logins.`,
      );
    }
    return { source, vault: chosen.vault, create };
  });

  const createdLogin = Effect.fn("BrowserLogins.createdLogin")(function* (
    resolved: Resolved,
    threadId: string,
    loginId: string,
  ) {
    const created = createdLogins.get(createdKey(threadId, loginId));
    if (created === undefined) {
      return yield* newLoginsError(
        "Only a login preview_fill_new_login created in this thread since the server started can get a new password, so a password a site already uses is never replaced. Omit `login` to create a new one.",
      );
    }
    const found = sourceOf(resolved, created.login.id);
    if (found === undefined) {
      return yield* newLoginsError(
        "The password manager that saved this login cannot give it a new password now. Omit `login` to create a new one.",
      );
    }
    return { created, source: found.source, itemId: found.itemId };
  });

  /** A saved login's password: the one its save showed, or else read back. */
  const passwordOf = Effect.fn("BrowserLogins.passwordOf")(function* (
    source: Source,
    login: BrowserLoginCandidate,
    itemId: string,
    shown: string | undefined,
  ) {
    if (shown !== undefined && shown.length > 0) return { login, password: shown };
    const values = yield* source.logins
      .read(source.config, { ...login, id: itemId }, ["password"])
      .pipe(Effect.provideContext(driverServices));
    const password = values?.password;
    if (password === undefined || password.length === 0) {
      return yield* new BrowserLoginError({
        reason: "unreadable",
        message: `The login "${login.title}" is saved, but ${source.label} did not return its password. It may be locked. Call again with login "${login.id}" to fill it.`,
      });
    }
    return { login, password };
  });

  const newLoginDestination: BrowserLogins["Service"]["newLoginDestination"] = Effect.fn(
    "BrowserLogins.newLoginDestination",
  )(function* ({ threadId, loginId, url, username }) {
    const resolved = yield* current;
    const revision = String(generation);
    const { source, vault } = yield* newLoginSource(resolved);
    // A retry after a save whose password never reached a page continues that login.
    const id =
      loginId ??
      [...createdLogins.values()].find(
        (created) =>
          created.threadId === threadId &&
          !created.filled &&
          created.url === url &&
          created.username === username,
      )?.login.id;
    if (id === undefined) return { revision, account: source.account, vault };
    const { created } = yield* createdLogin(resolved, threadId, id);
    const { login } = created;
    return {
      revision,
      account: login.account,
      ...(login.vault ? { vault: login.vault } : {}),
      login,
      filled: created.filled,
    };
  });

  const createLogin: BrowserLogins["Service"]["createLogin"] = Effect.fn(
    "BrowserLogins.createLogin",
  )(function* (revision, input) {
    const { source, vault, create } = yield* newLoginSource(yield* currentAt(revision));
    const today = DateTime.formatIsoDateUtc(yield* DateTime.now);
    const created = yield* create(source.config, {
      vault,
      title: input.title,
      url: input.url,
      username: input.username,
      recipe: input.recipe,
      notes: newLoginNotes(input, today),
    }).pipe(Effect.provideContext(driverServices));
    if (created === undefined) {
      return yield* new BrowserLoginError({
        reason: "unreadable",
        message: `${source.label} did not save the new login. It may be locked, the vault "${vault}" may not exist, or the account may not be allowed to write to it.`,
      });
    }
    const login: BrowserLoginCandidate = {
      ...created.login,
      id: `${source.id}/${created.login.id}`,
      account: source.account,
    };
    // Kept for the thread before its password is read, so a retry finds it however this ends.
    createdLogins.set(createdKey(input.threadId, login.id), {
      threadId: input.threadId,
      login,
      url: input.url,
      username: input.username,
      filled: false,
    });
    // Listed again on the next lookup, so preview_fill_login finds it at once.
    loginLists.cache.delete(source.key);
    return yield* passwordOf(source, login, created.login.id, created.password);
  });

  const readNewLogin: BrowserLogins["Service"]["readNewLogin"] = Effect.fn(
    "BrowserLogins.readNewLogin",
  )(function* (revision, threadId, loginId) {
    const resolved = yield* currentAt(revision);
    yield* newLoginSource(resolved);
    const { created, source, itemId } = yield* createdLogin(resolved, threadId, loginId);
    return yield* passwordOf(source, created.login, itemId, undefined);
  });

  const regeneratePassword: BrowserLogins["Service"]["regeneratePassword"] = Effect.fn(
    "BrowserLogins.regeneratePassword",
  )(function* (revision, threadId, loginId, recipe) {
    const resolved = yield* currentAt(revision);
    yield* newLoginSource(resolved);
    const { created, source, itemId } = yield* createdLogin(resolved, threadId, loginId);
    const regenerate = source.logins.regeneratePassword;
    if (regenerate === undefined) {
      return yield* newLoginsError(
        "The password manager that saved this login cannot give it a new password now. Omit `login` to create a new one.",
      );
    }
    const { login } = created;
    const changed = yield* regenerate(source.config, { ...login, id: itemId }, recipe).pipe(
      Effect.provideContext(driverServices),
    );
    if (changed === undefined) {
      return yield* new BrowserLoginError({
        reason: "unreadable",
        message: `${source.label} did not give the login a new password. It may be locked, or the account may not be allowed to change it.`,
      });
    }
    // No page has the new password yet, so a retry reads it rather than replacing it again.
    created.filled = false;
    return yield* passwordOf(source, login, itemId, changed.password);
  });

  return BrowserLogins.of({
    candidates,
    read,
    identityCandidates,
    readIdentity,
    newLoginDestination,
    createLogin,
    readNewLogin,
    newLoginFilled: Effect.fn("BrowserLogins.newLoginFilled")((threadId, loginId) =>
      Effect.sync(() => {
        const created = createdLogins.get(createdKey(threadId, loginId));
        if (created !== undefined) created.filled = true;
      }),
    ),
    regeneratePassword,
    check: Effect.fn("BrowserLogins.check")(function* (revision) {
      yield* currentAt(revision);
    }),
    invalidate: Effect.sync(() => {
      loginLists.version++;
      loginLists.cache.clear();
      loginLists.running.clear();
    }),
    needsApproval: Effect.fn("BrowserLogins.needsApproval")(function* (revision, threadId, kind) {
      const approval = yield* approvalMode(yield* currentAt(revision), kind);
      if (approval === "never") return false;
      return approval === "request" || !approvals.has(approvalKey(kind, approval, threadId))
        ? approval
        : false;
    }),
    recordApproval: Effect.fn("BrowserLogins.recordApproval")(function* (revision, threadId, kind) {
      const approval = yield* approvalMode(yield* currentAt(revision), kind);
      if (approval === "request" || approval === "never") return;
      approvals.add(approvalKey(kind, approval, threadId));
    }),
  });
});

export const layer = Layer.effect(BrowserLogins, make(BUILT_IN_SECRET_PROVIDER_DRIVER_LIST));
