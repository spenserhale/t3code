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
import { withSecretProviderVaults } from "@t3tools/secret-provider-core/server/driver";
import {
  browserLoginProviderIds,
  DEFAULT_BROWSER_SECRET_ESCALATION,
  resolveSecretProviderVaults,
  type BrowserNewLoginSettings,
  type BrowserSecretEscalation,
  type SecretProviderId,
  type SecretProviderVault,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "../secrets/secretProviderDefinitions.ts";
import * as Settings from "../serverSettings.ts";

const LIST_CACHE_MS = 5 * 60_000;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8 = new TextEncoder();

export class BrowserLoginError extends Schema.TaggedError<BrowserLoginError>()(
  "BrowserLoginError",
  {
    /**
     * `not_configured` and `unreadable` are a source that is missing or cannot answer now, which
     * passes a request on to the next. `refused` ends it, as do settings that `changed` meanwhile.
     */
    reason: Schema.Literals(["not_configured", "unreadable", "refused", "changed"]),
    message: Schema.String,
    /** A page check's own error, rethrown as it was. */
    cause: Schema.optional(Schema.Defect()),
  },
) {}

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

/**
 * What a prompt allows: filling a login, filling an identity, showing one to the agent, saving a
 * new login, or handing a secret to the agent's command.
 */
export type BrowserApprovalKind =
  | "login"
  | "identity"
  | "identityRead"
  | "newLogin"
  | "secretReference";

/**
 * Which chosen providers a step uses. Unattended ones, such as a service account, are used without
 * asking; attended ones need a person to approve, on this machine or on the user's device. A
 * provider id uses that one alone, for an item an earlier step offered from it.
 */
export type BrowserLoginReach = "unattended" | "attended" | "all" | { readonly provider: string };

/** A chosen provider, as settings describe it; nothing about it is read to know this. */
export interface BrowserLoginProvider {
  readonly id: string;
  /** Its name in Settings > Secrets. */
  readonly account: string;
  readonly unattended: boolean;
  /** The names of the vaults it may open for these steps, when a vault limit applies. */
  readonly vaults?: ReadonlyArray<string>;
}

/**
 * Names the vaults each limited provider may open, for a refusal a vault limit may explain: a
 * provider kept from an item passes the request on as one without it, so only the end can say.
 */
export const vaultLimitNote = (
  providers: ReadonlyArray<Pick<BrowserLoginProvider, "account" | "vaults">>,
) => {
  const limited = providers.flatMap(({ account, vaults }) =>
    vaults === undefined
      ? []
      : [
          vaults.length === 0
            ? `${account} may open no vault`
            : `${account} may open only ${vaults.map((name) => `"${name}"`).join(", ")}`,
        ],
  );
  return limited.length === 0
    ? undefined
    : `A vault limit applies here: ${limited.join("; ")}. The user can change it in Settings > Secrets.`;
};

/** Who "Allow for this thread" was given to. */
export interface BrowserApprovalScope {
  readonly threadId: string;
  /** The environment a relayed request came from; absent for this server's own threads. */
  readonly requester?: string | undefined;
}

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

/** A secret read for an agent's command, and the chosen provider that had it. */
export interface BrowserSecret {
  readonly value: Redacted.Redacted<string>;
  /** The provider's name in Settings > Secrets, such as "Work 1Password". */
  readonly account: string;
}

/** The steps of a secret request, under one vault choice: the environment's or a thread's. */
export interface BrowserLoginSteps {
  /**
   * Where requests no unattended provider answers go, the providers chosen, and the revision
   * that names the settings now. Later steps given the revision fail once the settings change.
   */
  readonly escalation: Effect.Effect<
    {
      readonly revision: string;
      readonly escalation: BrowserSecretEscalation;
      readonly providers: ReadonlyArray<BrowserLoginProvider>;
    },
    BrowserLoginError
  >;
  /**
   * Saved logins whose websites cover `pageUrl`, from the chosen providers of that reach that
   * could list. With nothing chosen, unattended reach finds none and the others fail.
   */
  readonly candidates: (
    pageUrl: string,
    reach: BrowserLoginReach,
  ) => Effect.Effect<
    { readonly revision: string; readonly logins: ReadonlyArray<BrowserLoginCandidate> },
    BrowserLoginError
  >;
  /** The login a reference such as `op://Vault/Item` names, from the first provider that has it. */
  readonly lookupLogin: (
    reference: string,
    reach: BrowserLoginReach,
  ) => Effect.Effect<
    { readonly revision: string; readonly login: BrowserLoginCandidate | undefined },
    BrowserLoginError
  >;
  readonly read: (
    revision: string,
    login: BrowserLoginCandidate,
    fields: ReadonlyArray<SecretProviderLoginField>,
  ) => Effect.Effect<SecretProviderLoginValues, BrowserLoginError>;
  /** Saved identities from the chosen providers of that reach that could list. */
  readonly identityCandidates: (reach: BrowserLoginReach) => Effect.Effect<
    {
      readonly revision: string;
      readonly identities: ReadonlyArray<BrowserIdentityCandidate>;
    },
    BrowserLoginError
  >;
  readonly lookupIdentity: (
    reference: string,
    reach: BrowserLoginReach,
  ) => Effect.Effect<
    { readonly revision: string; readonly identity: BrowserIdentityCandidate | undefined },
    BrowserLoginError
  >;
  readonly readIdentity: (
    revision: string,
    identity: BrowserIdentityCandidate,
  ) => Effect.Effect<SecretProviderIdentityValues, BrowserLoginError>;
  /**
   * The chosen providers of that reach that take a secret reference such as
   * `op://Vault/Item/field`, by their names in Settings > Secrets, found without reading it.
   */
  readonly secretSources: (
    reference: string,
    reach: BrowserLoginReach,
  ) => Effect.Effect<
    { readonly revision: string; readonly accounts: ReadonlyArray<string> },
    BrowserLoginError
  >;
  /** What the reference names, from the first of those providers that returns it. */
  readonly readSecret: (
    revision: string,
    reference: string,
    reach: BrowserLoginReach,
  ) => Effect.Effect<BrowserSecret, BrowserLoginError>;
  /**
   * Whether a person must approve this kind of step, from an attended provider, for this
   * thread: false once they chose "Allow for this thread" under the current settings.
   */
  readonly needsApproval: (
    revision: string,
    scope: BrowserApprovalScope,
    kind: BrowserApprovalKind,
  ) => Effect.Effect<boolean, BrowserLoginError>;
  /** Remembers "Allow for this thread" given under `revision`, never under a newer setting. */
  readonly recordApproval: (
    revision: string,
    scope: BrowserApprovalScope,
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
      /** Saving there needs no one to approve it. */
      readonly unattended: boolean;
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

export class BrowserLogins extends Context.Service<
  BrowserLogins,
  BrowserLoginSteps & {
    /**
     * The same steps for one thread: each provider opens only the vaults the thread's project
     * chose, else the environment's. Settings, approvals and the generation are shared. A thread
     * whose project cannot be read fails each step that reads, never widening to the environment.
     */
    readonly forThread: (threadId: ThreadId) => BrowserLoginSteps;
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
  /**
   * A digest of the provider, its config and its vault limit: a changed config, token included,
   * or another limit lists again.
   */
  readonly key: string;
  /** The saved config with the vault limit of these steps, never stored. */
  readonly config: unknown;
  /** The vaults it may open, as settings name them; absent opens every vault. */
  readonly vaults: ReadonlyArray<SecretProviderVault> | undefined;
  /** Reads without anyone present, such as with a service account token. */
  readonly unattended: boolean;
  readonly logins: SecretProviderLogins;
  readonly identities?: SecretProviderIdentities;
  readonly isReference: (reference: string) => boolean;
  readonly read: SecretProviderDriver["read"];
}

interface Resolved {
  readonly escalation: BrowserSecretEscalation;
  readonly newLogins: BrowserNewLoginSettings | undefined;
  readonly revision: string;
  readonly sources: ReadonlyArray<Source>;
  /** Why no provider at all can be used, for steps that need one. */
  readonly unconfigured: string | undefined;
  /** Every source key settings name, a project's own vault choice's too: their listings stay. */
  readonly keys: ReadonlySet<string>;
}

/** A vault as the user knows it: the name it had when chosen, else its id. */
const vaultName = (vault: SecretProviderVault) => vault.name.trim() || vault.id;

const inReach = (source: Source, reach: BrowserLoginReach) =>
  typeof reach === "object"
    ? source.id === reach.provider
    : reach === "all" || source.unattended === (reach === "unattended");

// Configs hold service account tokens, so the keys kept for the server's life are digests.
const resolve = Effect.fn("BrowserLogins.resolve")(function* (
  drivers: ReadonlyArray<SecretProviderDriver>,
  digest: Digest.Digest["Service"],
  settings: ServerSettings,
  /** Whose vault choice applies: a thread's project, else the environment's (null). */
  projectId: string | null,
): Effect.fn.Return<Resolved> {
  const ids = [...new Set(browserLoginProviderIds(settings.browserLogins))];
  const choices = settings.secretProviderVaults;
  const choiceOf = (id: SecretProviderId) => (Object.hasOwn(choices, id) ? choices[id] : undefined);
  const sources: Array<Source> = [];
  const keys = new Set<string>();
  const environmentKeys = new Map<string, string>();
  for (const id of ids) {
    const configured = settings.secretProviders[id];
    const driver = drivers.find((candidate) => candidate.kind === configured?.kind);
    if (configured === undefined || driver?.logins === undefined) continue;
    const limited = (project: string | null) => {
      const vaults = resolveSecretProviderVaults(choices, id, project);
      const vaultIds = vaults?.map((vault) => vault.id);
      return { vaults, config: withSecretProviderVaults(configured.config, vaultIds) };
    };
    const keyOf = (config: unknown) =>
      digest.digestHex(
        Digest.sha256,
        utf8.encode(encodeJson([id, configured.kind, config ?? null])),
      );
    for (const project of Object.keys(choiceOf(id)?.projects ?? {})) {
      keys.add(yield* keyOf(limited(project).config));
    }
    const environmentKey = yield* keyOf(limited(null).config);
    keys.add(environmentKey);
    environmentKeys.set(id, environmentKey);
    const { vaults, config } = limited(projectId);
    sources.push({
      id,
      account: configured.label,
      label: driver.definition.label,
      key: yield* keyOf(config),
      config,
      vaults,
      unattended: driver.unattended?.(config) ?? false,
      logins: driver.logins,
      ...(driver.identities === undefined ? {} : { identities: driver.identities }),
      isReference: driver.definition.isReference,
      read: driver.read,
    });
  }
  const named = ids.join(", ");
  const unconfigured =
    sources.length > 0
      ? undefined
      : ids.length === 0
        ? "Browser logins are off. The user can turn them on in Settings > Browser by choosing a password manager."
        : ids.length === 1
          ? `The password manager chosen for browser logins (${named}) is missing or cannot fill logins. The user can fix it in Settings > Browser.`
          : `None of the password managers chosen for browser logins (${named}) can fill logins. The user can fix it in Settings > Browser.`;
  const escalation = settings.browserLogins.escalation ?? DEFAULT_BROWSER_SECRET_ESCALATION;
  const newLogins = settings.browserLogins.newLogins;
  return {
    escalation,
    newLogins,
    sources,
    unconfigured,
    keys,
    // Unusable ids count too, so one becoming usable starts a new generation, as does any vault
    // choice, the environment's or a project's.
    revision: encodeJson([
      escalation,
      newLogins ?? null,
      ...ids.map((id) => environmentKeys.get(id) ?? id),
      ids.map((id) => choiceOf(id) ?? null),
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

export const make = Effect.fn("BrowserLogins.make")(function* (
  drivers: ReadonlyArray<SecretProviderDriver>,
) {
  const settingsService = yield* Settings.ServerSettingsService;
  const digest = yield* Digest.Digest;
  const driverServices = yield* Effect.context<SecretProviderDriverServices>();
  const scope = yield* Effect.scope;
  // Optional, so a server without threads, as in tests, reads under the environment's vaults.
  const threads = yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService);
  const loginLists = itemLists<SecretProviderLogin>("logins");
  const identityLists = itemLists<SecretProviderIdentity>("identities");
  // "Allow for this thread" lasts for the server's life. Any change to the providers, their
  // config, or these settings starts a new generation and forgets it; a step begun in an older
  // generation fails, even if the settings have since changed back.
  const approvals = new Set<string>();
  let generation = 0;
  let seenRevision: string | undefined;
  const see = (resolved: Resolved) => {
    if (seenRevision !== undefined && seenRevision !== resolved.revision) {
      generation++;
      approvals.clear();
    }
    seenRevision = resolved.revision;
    for (const { cache } of [loginLists, identityLists]) {
      for (const key of cache.keys()) {
        if (!resolved.keys.has(key)) cache.delete(key);
      }
    }
  };
  const observe = (settings: ServerSettings, projectId: string | null) =>
    resolve(drivers, digest, settings, projectId).pipe(
      Effect.tap((resolved) => Effect.sync(() => see(resolved))),
    );
  // Subscribed before the first read, so no change between the two is missed.
  const changes = yield* settingsService.subscribeChanges;
  yield* settingsService.getSettings.pipe(
    Effect.flatMap((settings) => observe(settings, null)),
    Effect.ignore,
  );
  yield* changes.pipe(
    Stream.runForEach((settings) => Effect.ignore(observe(settings, null))),
    Effect.forkScoped,
  );

  /** The settings now, with each provider limited to the vaults of the project `projectOf` names. */
  const currentIn = (projectOf: Effect.Effect<string | null, BrowserLoginError>) =>
    Effect.flatMap(projectOf, (projectId) =>
      settingsService.getSettings.pipe(
        Effect.mapError(
          () =>
            new BrowserLoginError({ reason: "unreadable", message: "Settings could not be read." }),
        ),
        Effect.flatMap((settings) => observe(settings, projectId)),
      ),
    );
  const environment = currentIn(Effect.succeed(null));

  /** Fails if the settings changed since `revision`, whichever vault choice the step reads under. */
  const atRevision = (current: Effect.Effect<Resolved, BrowserLoginError>, revision: string) =>
    current.pipe(
      Effect.filterOrFail(
        () => String(generation) === revision,
        () =>
          new BrowserLoginError({
            reason: "changed",
            message: "The browser login settings changed. Try again.",
          }),
      ),
    );

  /** A thread's project, whose vault choice its steps read under; none for a thread not found. */
  const projectOfThread = (threadId: ThreadId): Effect.Effect<string | null, BrowserLoginError> =>
    Option.match(threads, {
      onNone: () => Effect.succeed(null),
      onSome: (service) =>
        service.getThreadShell(threadId).pipe(
          Effect.map((shell) => shell?.projectId ?? null),
          // The environment's vaults may be wider than the project's, so nothing is read instead.
          Effect.mapError(
            () =>
              new BrowserLoginError({
                reason: "refused",
                message:
                  "This thread's project could not be read, so the vaults it may use are unknown. Try again.",
              }),
          ),
        ),
    });

  const approvalKey = (kind: BrowserApprovalKind, scope: BrowserApprovalScope) =>
    encodeJson([kind, scope.requester ?? null, scope.threadId]);

  /** For a refusal a source's vault limit may explain. */
  const limitOf = ({ account, vaults }: Source) => {
    const note =
      vaults === undefined
        ? undefined
        : vaultLimitNote([{ account, vaults: vaults.map(vaultName) }]);
    return note === undefined ? "" : ` ${note}`;
  };

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
    const listed = yield* Effect.forEach(
      sources,
      ({ source, list }) => listOne(lists, source, list, now),
      { concurrency: "unbounded" },
    );
    if (listed.length > 0 && listed.every((items) => items === undefined)) {
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

  const candidate = <A extends { readonly id: string }>(source: Source, item: A) => ({
    ...item,
    id: `${source.id}/${item.id}`,
    account: source.account,
  });

  const invalidate = Effect.sync(() => {
    loginLists.version++;
    loginLists.cache.clear();
    loginLists.running.clear();
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

  const newLoginFilled: BrowserLogins["Service"]["newLoginFilled"] = Effect.fn(
    "BrowserLogins.newLoginFilled",
  )((threadId, loginId) =>
    Effect.sync(() => {
      const created = createdLogins.get(createdKey(threadId, loginId));
      if (created !== undefined) created.filled = true;
    }),
  );

  const check: BrowserLogins["Service"]["check"] = Effect.fn("BrowserLogins.check")(
    function* (revision) {
      yield* atRevision(environment, revision);
    },
  );

  const needsApproval: BrowserLogins["Service"]["needsApproval"] = Effect.fn(
    "BrowserLogins.needsApproval",
  )(function* (revision, scope, kind) {
    yield* atRevision(environment, revision);
    return !approvals.has(approvalKey(kind, scope));
  });

  const recordApproval: BrowserLogins["Service"]["recordApproval"] = Effect.fn(
    "BrowserLogins.recordApproval",
  )(function* (revision, scope, kind) {
    yield* atRevision(environment, revision);
    approvals.add(approvalKey(kind, scope));
  });

  /** The steps under the vault choice of the project `projectOf` names, else the environment's. */
  const stepsIn = (
    projectOf: Effect.Effect<string | null, BrowserLoginError>,
  ): BrowserLoginSteps => {
    const current = currentIn(projectOf);
    const currentAt = (revision: string) => atRevision(current, revision);

    /**
     * The chosen sources of a reach. Only unattended reach may come up empty when nothing usable is
     * chosen: it is tried first everywhere, and finding nothing there moves on to the user.
     */
    const reachable = Effect.fn("BrowserLogins.reachable")(function* (reach: BrowserLoginReach) {
      const resolved = yield* current;
      if (resolved.unconfigured !== undefined && reach !== "unattended") {
        return yield* new BrowserLoginError({
          reason: "not_configured",
          message: resolved.unconfigured,
        });
      }
      return {
        revision: String(generation),
        sources: resolved.sources.filter((source) => inReach(source, reach)),
      };
    });

    const candidates: BrowserLogins["Service"]["candidates"] = Effect.fn(
      "BrowserLogins.candidates",
    )(function* (pageUrl, reach) {
      const { revision, sources } = yield* reachable(reach);
      const listed = yield* listAll(
        loginLists,
        sources.map((source) => ({ source, list: source.logins.list(source.config) })),
      );
      return {
        revision,
        logins: sources.flatMap((source, index) =>
          (listed[index] ?? [])
            .filter((login) => loginCoversPage(login.urls, pageUrl))
            .map((login) => candidate(source, login)),
        ),
      };
    });

    /** The first source of a reach whose driver finds what the reference names. */
    const lookup = Effect.fn("BrowserLogins.lookup")(function* <A extends { readonly id: string }>(
      reach: BrowserLoginReach,
      find: (
        source: Source,
      ) => Effect.Effect<A | undefined, never, SecretProviderDriverServices> | undefined,
    ) {
      const { revision, sources } = yield* reachable(reach);
      for (const source of sources) {
        const finding = find(source);
        if (finding === undefined) continue;
        const found = yield* finding.pipe(Effect.provideContext(driverServices));
        if (found !== undefined) return { revision, found: candidate(source, found) };
      }
      return { revision, found: undefined };
    });

    const lookupLogin: BrowserLogins["Service"]["lookupLogin"] = Effect.fn(
      "BrowserLogins.lookupLogin",
    )(function* (reference, reach) {
      const { revision, found } = yield* lookup(reach, (source) =>
        source.logins.lookup?.(source.config, reference),
      );
      return { revision, login: found };
    });

    const lookupIdentity: BrowserLogins["Service"]["lookupIdentity"] = Effect.fn(
      "BrowserLogins.lookupIdentity",
    )(function* (reference, reach) {
      const { revision, found } = yield* lookup(reach, (source) =>
        source.identities?.lookup?.(source.config, reference),
      );
      return { revision, identity: found };
    });

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
    )(function* (reach) {
      const { revision, sources: reached } = yield* reachable(reach);
      const sources = reached.flatMap((source) =>
        source.identities === undefined
          ? []
          : [{ source, list: source.identities.list(source.config) }],
      );
      if (sources.length === 0 && reached.length > 0 && reach !== "unattended") {
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
          (listed[index] ?? []).map((identity) => candidate(source, identity)),
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

    const secretSources: BrowserLogins["Service"]["secretSources"] = Effect.fn(
      "BrowserLogins.secretSources",
    )(function* (reference, reach) {
      const { revision, sources } = yield* reachable(reach);
      return {
        revision,
        accounts: sources
          .filter((source) => source.isReference(reference))
          .map((source) => source.account),
      };
    });

    const readSecret: BrowserLogins["Service"]["readSecret"] = Effect.fn(
      "BrowserLogins.readSecret",
    )(function* (revision, reference, reach) {
      const sources = (yield* currentAt(revision)).sources.filter(
        (source) => inReach(source, reach) && source.isReference(reference),
      );
      for (const source of sources) {
        const [value] = yield* source
          .read(source.config, [reference])
          .pipe(Effect.provideContext(driverServices));
        if (value === undefined) continue;
        // The read can wait on the password manager's own prompt; settings may change meanwhile.
        yield* currentAt(revision);
        return { value: Redacted.make(value), account: source.account };
      }
      return yield* new BrowserLoginError({
        reason: "unreadable",
        message:
          sources.length === 0
            ? `No password manager chosen for browser logins reads ${reference}.`
            : `${sources.map((source) => source.account).join(", ")} did not return ${reference}. It may be locked, the reference may be wrong, or the request was denied there.`,
      });
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
      if (id === undefined) {
        return { revision, account: source.account, vault, unattended: source.unattended };
      }
      const { created, source: saved } = yield* createdLogin(resolved, threadId, id);
      const { login } = created;
      return {
        revision,
        account: login.account,
        ...(login.vault ? { vault: login.vault } : {}),
        login,
        filled: created.filled,
        unattended: saved.unattended,
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
          message: `${source.label} did not save the new login. It may be locked, the vault "${vault}" may not exist, or the account may not be allowed to write to it.${limitOf(source)}`,
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
      yield* invalidate;
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
          message: `${source.label} did not give the login a new password. It may be locked, or the account may not be allowed to change it.${limitOf(source)}`,
        });
      }
      // No page has the new password yet, so a retry reads it rather than replacing it again.
      created.filled = false;
      yield* invalidate;
      return yield* passwordOf(source, login, itemId, changed.password);
    });

    return {
      escalation: Effect.gen(function* () {
        const resolved = yield* current;
        return {
          revision: String(generation),
          escalation: resolved.escalation,
          providers: resolved.sources.map(({ id, account, unattended, vaults }) => ({
            id,
            account,
            unattended,
            ...(vaults === undefined ? {} : { vaults: vaults.map(vaultName) }),
          })),
        };
      }).pipe(Effect.withSpan("BrowserLogins.escalation")),
      candidates,
      lookupLogin,
      read,
      identityCandidates,
      lookupIdentity,
      readIdentity,
      secretSources,
      readSecret,
      newLoginDestination,
      createLogin,
      readNewLogin,
      newLoginFilled,
      regeneratePassword,
      check,
      invalidate,
      needsApproval,
      recordApproval,
    };
  };

  return BrowserLogins.of({
    ...stepsIn(Effect.succeed(null)),
    forThread: (threadId) => stepsIn(projectOfThread(threadId)),
  });
});

export const layer = Layer.effect(BrowserLogins, make(BUILT_IN_SECRET_PROVIDER_DRIVER_LIST));
