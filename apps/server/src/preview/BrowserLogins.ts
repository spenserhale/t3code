import type {
  SecretProviderDriver,
  SecretProviderDriverServices,
  SecretProviderLogin,
  SecretProviderLoginField,
  SecretProviderLoginValues,
  SecretProviderLogins,
} from "@t3tools/secret-provider-core/server/driver";
import type { BrowserLoginApproval, ServerSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "../secrets/secretProviderDefinitions.ts";
import * as Settings from "../serverSettings.ts";

const LIST_CACHE_MS = 5 * 60_000;
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class BrowserLoginError extends Data.TaggedError("BrowserLoginError")<{
  readonly reason: "not_configured" | "unreadable";
  readonly message: string;
}> {}

export interface BrowserLoginProvider {
  readonly id: string;
  readonly label: string;
  readonly approval: BrowserLoginApproval;
}

export class BrowserLogins extends Context.Service<
  BrowserLogins,
  {
    /** Saved logins whose websites cover `pageUrl`, without their secrets. */
    readonly candidates: (pageUrl: string) => Effect.Effect<
      {
        readonly provider: BrowserLoginProvider;
        /** The settings these logins came from; later steps fail once it changes. */
        readonly revision: string;
        readonly logins: ReadonlyArray<SecretProviderLogin>;
      },
      BrowserLoginError
    >;
    readonly read: (
      revision: string,
      login: SecretProviderLogin,
      fields: ReadonlyArray<SecretProviderLoginField>,
    ) => Effect.Effect<SecretProviderLoginValues, BrowserLoginError>;
    /** Whether the user must approve before a fill on this thread under the current setting. */
    readonly needsApproval: (
      revision: string,
      threadId: string,
    ) => Effect.Effect<boolean, BrowserLoginError>;
    /** Records the answer to a prompt shown under `revision`, never under a newer setting. */
    readonly recordApproval: (
      revision: string,
      threadId: string,
    ) => Effect.Effect<void, BrowserLoginError>;
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

interface Resolved {
  readonly provider: BrowserLoginProvider;
  readonly revision: string;
  readonly config: unknown;
  readonly logins: SecretProviderLogins;
}

const resolve = (
  drivers: ReadonlyArray<SecretProviderDriver>,
  settings: ServerSettings,
): Resolved | BrowserLoginError => {
  const id = settings.browserLogins.secretProviderId;
  if (id === undefined) {
    return new BrowserLoginError({
      reason: "not_configured",
      message:
        "Browser logins are off. The user can turn them on in Settings > Browser by choosing a password manager.",
    });
  }
  const configured = settings.secretProviders[id];
  const driver = drivers.find((candidate) => candidate.kind === configured?.kind);
  if (configured === undefined || driver?.logins === undefined) {
    return new BrowserLoginError({
      reason: "not_configured",
      message: `The password manager chosen for browser logins (${id}) is missing or cannot fill logins. The user can fix it in Settings > Browser.`,
    });
  }
  const approval = settings.browserLogins.approval;
  return {
    provider: { id, label: driver.definition.label, approval },
    revision: [id, configured.kind, encodeConfig(configured.config), approval].join("\u0000"),
    config: configured.config,
    logins: driver.logins,
  };
};

export const make = Effect.fn("BrowserLogins.make")(function* (
  drivers: ReadonlyArray<SecretProviderDriver>,
) {
  const settingsService = yield* Settings.ServerSettingsService;
  const driverServices = yield* Effect.context<SecretProviderDriverServices>();
  let listCache: {
    readonly key: string;
    readonly at: number;
    readonly logins: ReadonlyArray<SecretProviderLogin>;
  } | null = null;
  // Approvals last for the server's life; any change to the provider, its config, or the approval
  // setting forgets them all, so turning logins off and on again asks again. Seen both on each
  // read and on the change stream, which catches an off-and-on between two fills.
  const approvals = new Set<string>();
  let seenRevision: string | undefined;
  const see = (resolved: Resolved | BrowserLoginError) => {
    const revision = resolved instanceof BrowserLoginError ? "" : resolved.revision;
    if (seenRevision !== undefined && seenRevision !== revision) approvals.clear();
    seenRevision = revision;
  };
  yield* settingsService.streamChanges.pipe(
    Stream.runForEach((settings) => Effect.sync(() => see(resolve(drivers, settings)))),
    Effect.forkScoped,
  );

  const current = settingsService.getSettings.pipe(
    Effect.mapError(
      () => new BrowserLoginError({ reason: "unreadable", message: "Settings could not be read." }),
    ),
    Effect.flatMap((settings) => {
      const resolved = resolve(drivers, settings);
      see(resolved);
      return resolved instanceof BrowserLoginError
        ? Effect.fail(resolved)
        : Effect.succeed(resolved);
    }),
  );

  const approvalKey = (resolved: Resolved, threadId: string) =>
    resolved.provider.approval === "application"
      ? `${resolved.revision}\u0000application`
      : `${resolved.revision}\u0000thread\u0000${threadId}`;

  const currentAt = (revision: string) =>
    current.pipe(
      Effect.filterOrFail(
        (resolved) => resolved.revision === revision,
        () =>
          new BrowserLoginError({
            reason: "not_configured",
            message: "The browser login settings changed. Try again.",
          }),
      ),
    );

  const candidates: BrowserLogins["Service"]["candidates"] = Effect.fn("BrowserLogins.candidates")(
    function* (pageUrl) {
      const resolved = yield* current;
      const key = resolved.revision;
      const now = yield* Clock.currentTimeMillis;
      let logins =
        listCache?.key === key && now - listCache.at < LIST_CACHE_MS ? listCache.logins : undefined;
      if (logins === undefined) {
        logins = yield* resolved.logins
          .list(resolved.config)
          .pipe(Effect.provideContext(driverServices));
        if (logins === undefined) {
          listCache = null;
          return yield* new BrowserLoginError({
            reason: "unreadable",
            message: `${resolved.provider.label} did not list its logins. It may be locked, or its CLI integration may be off.`,
          });
        }
        listCache = { key, at: now, logins };
      }
      return {
        provider: resolved.provider,
        revision: resolved.revision,
        logins: logins.filter((login) => loginCoversPage(login.urls, pageUrl)),
      };
    },
  );

  const read: BrowserLogins["Service"]["read"] = Effect.fn("BrowserLogins.read")(
    function* (revision, login, fields) {
      const resolved = yield* currentAt(revision);
      const values = yield* resolved.logins
        .read(resolved.config, login, fields)
        .pipe(Effect.provideContext(driverServices));
      if (values === undefined) {
        return yield* new BrowserLoginError({
          reason: "unreadable",
          message: `${resolved.provider.label} did not return the login. It may be locked, or the request was denied there.`,
        });
      }
      return values;
    },
  );

  return BrowserLogins.of({
    candidates,
    read,
    needsApproval: Effect.fn("BrowserLogins.needsApproval")(function* (revision, threadId) {
      const resolved = yield* currentAt(revision);
      return (
        resolved.provider.approval === "request" || !approvals.has(approvalKey(resolved, threadId))
      );
    }),
    recordApproval: Effect.fn("BrowserLogins.recordApproval")(function* (revision, threadId) {
      const resolved = yield* currentAt(revision);
      if (resolved.provider.approval === "request") return;
      approvals.add(approvalKey(resolved, threadId));
    }),
  });
});

export const layer = Layer.effect(BrowserLogins, make(BUILT_IN_SECRET_PROVIDER_DRIVER_LIST));
