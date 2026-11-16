/**
 * The desktop app's side of the secret relay. Another environment that cannot answer a secret
 * request itself relays it to the user's device; this client has its primary environment, the
 * server beside it, ask the user and read the item, and passes the answer back.
 */
import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type BrowserLoginSettings,
  browserLoginProviderIds,
  type EnvironmentId,
  type SecretRelayAnswer,
  type SecretRelayAnswerInput,
  type SecretRelayKind,
  type SecretRelayRequest,
  type SecretRelayStreamItem,
  sessionGrantsScope,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { PreparedConnection } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { request, subscribe } from "../rpc/client.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

const LEGACY_SECRET_RELAY_KINDS = [
  "login",
  "identity",
  "secretReference",
] as const satisfies ReadonlyArray<SecretRelayKind>;
const LOGIN_CHOICE_KINDS = ["loginChoice"] as const satisfies ReadonlyArray<SecretRelayKind>;
const NO_SECRET_RELAY_KINDS: ReadonlyArray<SecretRelayKind> = [];

/** A server sends only the kinds a client names. */
export const SECRET_RELAY_KINDS = [...LEGACY_SECRET_RELAY_KINDS, ...LOGIN_CHOICE_KINDS] as const;

/** Nobody between can read what crosses: TLS, an SSH tunnel, or a socket on this machine. */
export function isEncryptedConnection(
  connection: Pick<PreparedConnection, "target" | "socketUrl">,
): boolean {
  if (connection.target._tag === "SshConnectionTarget") return true;
  let url: URL;
  try {
    url = new URL(connection.socketUrl);
  } catch {
    return false;
  }
  if (url.protocol === "wss:") return true;
  return url.protocol === "ws:" && LOOPBACK_HOSTNAMES.has(url.hostname.replace(/^\[(.*)\]$/, "$1"));
}

export interface SecretRelayCandidate {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly config: {
    readonly secretRelay?: boolean;
    readonly secretRelayLoginChoice?: boolean;
    readonly settings: { readonly browserLogins: BrowserLoginSettings };
  } | null;
  /** Read only for an environment that otherwise qualifies. */
  readonly connection: () => Pick<PreparedConnection, "target" | "socketUrl"> | null;
  readonly session: () => AuthSessionState | null;
}

/** The primary resolves requests, so only its capabilities determine the subscribed kinds. */
export function secretRelayKinds(
  primaryConfig: SecretRelayCandidate["config"],
): ReadonlyArray<SecretRelayKind> {
  if (primaryConfig?.secretRelay !== true) return NO_SECRET_RELAY_KINDS;
  const canRead = browserLoginProviderIds(primaryConfig.settings.browserLogins).length > 0;
  if (canRead) {
    return primaryConfig.secretRelayLoginChoice === true
      ? SECRET_RELAY_KINDS
      : LEGACY_SECRET_RELAY_KINDS;
  }
  return primaryConfig.secretRelayLoginChoice === true ? LOGIN_CHOICE_KINDS : NO_SECRET_RELAY_KINDS;
}

/**
 * The environments whose relayed requests this device answers. None unless the primary can read
 * logins or show a chooser: connected over an encrypted connection, offering those kinds, with a
 * session that may manage access there. Then every other environment that offers the relay over
 * an encrypted connection and lets this session operate.
 */
export function secretRelayEnvironmentIds(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environments: ReadonlyArray<SecretRelayCandidate>;
}): ReadonlyArray<EnvironmentId> {
  const offersRelay = (candidate: SecretRelayCandidate, scope: AuthEnvironmentScope) => {
    if (!candidate.connected || candidate.config?.secretRelay !== true) return false;
    const connection = candidate.connection();
    if (connection === null || !isEncryptedConnection(connection)) return false;
    const session = candidate.session();
    return session !== null && sessionGrantsScope(session, scope);
  };
  const primary = input.environments.find(
    (candidate) => candidate.environmentId === input.primaryEnvironmentId,
  );
  if (
    primary?.config == null ||
    secretRelayKinds(primary.config).length === 0 ||
    !offersRelay(primary, AuthAccessWriteScope)
  ) {
    return [];
  }
  return input.environments
    .filter(
      (candidate) => candidate !== primary && offersRelay(candidate, AuthOrchestrationOperateScope),
    )
    .map((candidate) => candidate.environmentId);
}

export interface SecretRelayChannel<E, ResolveError, AnswerError> {
  /** The requesting environment's requests, and their ends. */
  readonly requests: Stream.Stream<SecretRelayStreamItem, E>;
  /** Asks this device's user and reads the item. */
  readonly resolve: (request: SecretRelayRequest) => Effect.Effect<SecretRelayAnswer, ResolveError>;
  readonly answer: (input: SecretRelayAnswerInput) => Effect.Effect<void, AnswerError>;
}

class SecretRelayResolveError extends Schema.TaggedError<SecretRelayResolveError>()(
  "SecretRelayResolveError",
  {},
) {}

// Fixed, because a failure can quote what it was decoding, and that may be a value.
const UNREACHABLE: SecretRelayAnswer = {
  type: "unavailable",
  // oxlint-disable-next-line t3code/no-untranslated-copy -- sent to the requesting server for its agent
  message: "The desktop app could not reach the server on that device.",
};

const answerRequest = <E, ResolveError, AnswerError>(
  channel: SecretRelayChannel<E, ResolveError, AnswerError>,
  relayed: SecretRelayRequest,
) =>
  channel.resolve(relayed).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      () => Effect.succeed(UNREACHABLE),
    ),
    Effect.flatMap((answer) => channel.answer({ requestId: relayed.requestId, answer })),
    // An answer that cannot be delivered times out on the requesting server.
    Effect.ignoreCause,
  );

/**
 * Answers each request in its own fiber, so one waiting on the user holds up no other. `ended`
 * interrupts a request still being resolved, which closes the device's dialog.
 */
export const serveSecretRelay = Effect.fn("SecretRelay.serve")(function* <
  E,
  ResolveError,
  AnswerError,
>(channel: SecretRelayChannel<E, ResolveError, AnswerError>) {
  const resolving = yield* FiberMap.make<string>();
  yield* channel.requests.pipe(
    Stream.runForEach((item) =>
      item.type === "ended"
        ? FiberMap.remove(resolving, item.requestId)
        : FiberMap.run(resolving, item.request.requestId, answerRequest(channel, item.request), {
            onlyIfMissing: true,
          }),
    ),
  );
}, Effect.scoped);

/** Answers `environmentId`'s relayed requests with `resolve` until interrupted. */
const relayEnvironment = Effect.fn("SecretRelay.relayEnvironment")(function* <ResolveError>(
  environmentId: EnvironmentId,
  kinds: ReadonlyArray<SecretRelayKind>,
  resolve: (request: SecretRelayRequest) => Effect.Effect<SecretRelayAnswer, ResolveError>,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* serveSecretRelay({
    requests: registry.followStream(
      environmentId,
      subscribe(WS_METHODS.subscribeSecretRelay, { kinds: [...kinds] }),
    ),
    resolve,
    // A route can change under a live subscription, so each answer checks the one it takes.
    answer: (input) =>
      registry.run(
        environmentId,
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (!Option.exists(prepared, isEncryptedConnection)) return;
          yield* request(WS_METHODS.secretRelayAnswer, input);
        }),
      ),
  });
});

export function createSecretRelayAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const resolve = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:secret-relay:resolve",
    tag: WS_METHODS.secretRelayResolve,
  });
  /** While mounted, answers `environmentId`'s relayed requests through the primary. */
  const relayForKinds = Atom.family((kinds: ReadonlyArray<SecretRelayKind>) =>
    Atom.family((primaryEnvironmentId: EnvironmentId) =>
      Atom.family((environmentId: EnvironmentId) =>
        runtime
          .atom(
            Effect.gen(function* () {
              const atoms = yield* AtomRegistry.AtomRegistry;
              const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
              const requester = Effect.map(SubscriptionRef.get(registry.entries), (entries) => ({
                environmentId,
                label: (entries.get(environmentId)?.target.label ?? environmentId).slice(0, 200),
              }));
              yield* relayEnvironment(environmentId, kinds, (relayed) =>
                requester.pipe(
                  Effect.flatMap((from) =>
                    resolve.run(atoms, {
                      environmentId: primaryEnvironmentId,
                      input: { request: relayed, requester: from },
                    }),
                  ),
                  Effect.catchCauseIf(
                    (cause) => !Cause.hasInterruptsOnly(cause),
                    (cause) =>
                      Effect.logWarning(
                        "This device's server did not answer a relayed request.",
                      ).pipe(
                        Effect.annotateLogs({
                          environmentId,
                          ...safeErrorLogAttributes(Cause.squash(cause)),
                        }),
                        Effect.andThen(Effect.fail(new SecretRelayResolveError())),
                      ),
                  ),
                ),
              );
            }).pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning("Stopped answering relayed secret requests.").pipe(
                    Effect.annotateLogs({
                      environmentId,
                      ...safeErrorLogAttributes(Cause.squash(cause)),
                    }),
                  ),
              ),
            ),
          )
          .pipe(Atom.withLabel(`secret-relay:${primaryEnvironmentId}:${environmentId}`)),
      ),
    ),
  );
  return {
    resolve,
    relay: (primaryEnvironmentId: EnvironmentId, kinds: ReadonlyArray<SecretRelayKind>) =>
      relayForKinds(kinds)(primaryEnvironmentId),
  };
}
