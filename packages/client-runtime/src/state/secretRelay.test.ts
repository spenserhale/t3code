import { assert, describe, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  EnvironmentId,
  type SecretRelayAnswer,
  type SecretRelayAnswerInput,
  SecretRelayKind,
  type SecretRelayRequest,
  type SecretRelayStreamItem,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import {
  BearerConnectionTarget,
  type ConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import {
  isEncryptedConnection,
  SECRET_RELAY_KINDS,
  type SecretRelayCandidate,
  secretRelayEnvironmentIds,
  serveSecretRelay,
} from "./secretRelay.ts";

// A kind the desktop does not subscribe for is never sent to it, so it would never be answered.
it("subscribes for every kind a relayed request can be", () => {
  assert.deepStrictEqual([...SECRET_RELAY_KINDS].sort(), [...SecretRelayKind.literals].sort());
});

const bearer = (id: string) =>
  new BearerConnectionTarget({
    environmentId: EnvironmentId.make(id),
    label: id,
    connectionId: `connection-${id}`,
  });
const ssh = new SshConnectionTarget({
  environmentId: EnvironmentId.make("ssh"),
  label: "Mini",
  connectionId: "connection-ssh",
});

describe("isEncryptedConnection", () => {
  it("allows TLS, SSH tunnels and this machine, never plain ws to another host", () => {
    const encrypted = (socketUrl: string, target: ConnectionTarget = bearer("box")) =>
      isEncryptedConnection({ target, socketUrl });
    assert.isTrue(encrypted("wss://box.example.test/ws"));
    assert.isTrue(
      encrypted(
        "wss://relay.example.test/ws",
        new RelayConnectionTarget({ environmentId: EnvironmentId.make("relay"), label: "Relay" }),
      ),
    );
    assert.isTrue(encrypted("ws://127.0.0.1:3773/ws"));
    assert.isTrue(encrypted("ws://LOCALHOST:3773/ws"));
    assert.isTrue(encrypted("ws://[::1]:3773/ws"));
    assert.isTrue(encrypted("ws://203.0.113.9:41000/ws", ssh));
    assert.isFalse(encrypted("ws://192.168.1.20:3773/ws"));
    assert.isFalse(encrypted("ws://100.101.102.103:3773/ws"));
    assert.isFalse(encrypted("ws://localhost.example.test:3773/ws"));
    assert.isFalse(encrypted("not a url"));
  });
});

const grant = (...scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [...scopes],
  permissions: [...scopes],
});

const primaryId = EnvironmentId.make("primary");
const primaryTarget = new PrimaryConnectionTarget({
  environmentId: primaryId,
  label: "This Mac",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});

const candidate = (
  environmentId: EnvironmentId,
  overrides: Partial<{
    readonly connected: boolean;
    readonly secretRelay: boolean;
    readonly providers: ReadonlyArray<string>;
    readonly socketUrl: string;
    readonly session: AuthSessionState | null;
  }> = {},
): SecretRelayCandidate => ({
  environmentId,
  connected: overrides.connected ?? true,
  config: {
    ...(overrides.secretRelay === false ? {} : { secretRelay: true }),
    settings: {
      browserLogins: {
        approval: "thread",
        secretProviderIds: (overrides.providers ?? []) as never,
      },
    },
  },
  connection: () => ({
    target: environmentId === primaryId ? primaryTarget : bearer(environmentId),
    socketUrl: overrides.socketUrl ?? "wss://box.example.test/ws",
  }),
  session: () =>
    overrides.session === undefined
      ? grant(AuthAccessWriteScope, AuthOrchestrationOperateScope)
      : overrides.session,
});

describe("secretRelayEnvironmentIds", () => {
  const primary = (overrides: Parameters<typeof candidate>[1] = {}) =>
    candidate(primaryId, {
      providers: ["work"],
      socketUrl: "ws://127.0.0.1:3773/ws",
      ...overrides,
    });
  const remote = (id: string, overrides: Parameters<typeof candidate>[1] = {}) =>
    candidate(EnvironmentId.make(id), overrides);
  const others = [
    remote("tls"),
    remote("lan", { socketUrl: "ws://192.168.1.20:3773/ws" }),
    remote("offline", { connected: false }),
    remote("older", { secretRelay: false }),
    remote("read-only", { session: grant(AuthAccessWriteScope) }),
    {
      ...remote("tunnel", { socketUrl: "ws://127.0.0.1:41000/ws" }),
      connection: () => ({ target: ssh, socketUrl: "ws://127.0.0.1:41000/ws" }),
    },
    {
      ...remote("unread", { connected: false }),
      session: () => {
        throw new Error("An environment that cannot qualify is never asked for its session.");
      },
    },
  ];

  it("answers encrypted environments that offer the relay while the primary can read logins", () => {
    assert.deepStrictEqual(
      secretRelayEnvironmentIds({
        primaryEnvironmentId: primaryId,
        environments: [primary(), ...others],
      }),
      [EnvironmentId.make("tls"), EnvironmentId.make("tunnel")],
    );
    for (const unable of [
      primary({ providers: [] }),
      primary({ secretRelay: false }),
      primary({ connected: false }),
      primary({ socketUrl: "ws://192.168.1.5:3773/ws" }),
      primary({ session: grant(AuthOrchestrationOperateScope) }),
    ]) {
      assert.deepStrictEqual(
        secretRelayEnvironmentIds({
          primaryEnvironmentId: primaryId,
          environments: [unable, ...others],
        }),
        [],
      );
    }
    assert.deepStrictEqual(
      secretRelayEnvironmentIds({ primaryEnvironmentId: null, environments: others }),
      [],
    );
  });
});

const relayed = (requestId: string): SecretRelayStreamItem => ({
  type: "request",
  request: {
    requestId,
    kind: "login",
    threadId: "thread-a",
    origin: "https://grafana.example.com",
    expiresAt: 120_000,
  },
});

describe("serveSecretRelay", () => {
  it.effect(
    "answers each request as it resolves, stops one that ended, and hides why one failed",
    () =>
      Effect.gen(function* () {
        const items = yield* Queue.unbounded<SecretRelayStreamItem>();
        const answers = yield* Queue.unbounded<SecretRelayAnswerInput>();
        const interrupted = yield* Queue.unbounded<string>();
        const asked: Array<string> = [];
        const pending = new Map(
          ["a", "b", "c", "d"].map((id) => [id, Deferred.makeUnsafe<SecretRelayAnswer, Error>()]),
        );
        const settle = (id: string) => pending.get(id)!;
        const resolve = (request: SecretRelayRequest) =>
          Effect.sync(() => asked.push(request.requestId)).pipe(
            Effect.andThen(Deferred.await(settle(request.requestId))),
            Effect.onInterrupt(() => Queue.offer(interrupted, request.requestId)),
          );
        yield* serveSecretRelay({
          requests: Stream.fromQueue(items),
          resolve,
          answer: (input) => Queue.offer(answers, input),
        }).pipe(Effect.forkScoped);

        // A request sent again on resubscribing is not asked twice.
        yield* Queue.offerAll(items, [relayed("a"), relayed("b"), relayed("a"), relayed("c")]);
        const values = {
          type: "values",
          item: { id: "device:work/g1", title: "Grafana", urls: ["https://grafana.example.com"] },
          values: { password: Redacted.make("hunter2") },
        } as const;
        yield* Deferred.succeed(settle("b"), values);
        assert.deepStrictEqual(yield* Queue.take(answers), { requestId: "b", answer: values });
        yield* Deferred.succeed(settle("a"), { type: "none" });
        assert.deepStrictEqual(yield* Queue.take(answers), {
          requestId: "a",
          answer: { type: "none" },
        });

        yield* Queue.offer(items, { type: "ended", requestId: "c" });
        assert.strictEqual(yield* Queue.take(interrupted), "c");

        yield* Queue.offer(items, relayed("d"));
        yield* Deferred.fail(settle("d"), new Error('Expected a string, got "hunter2"'));
        assert.deepStrictEqual(yield* Queue.take(answers), {
          requestId: "d",
          answer: {
            type: "unavailable",
            message: "The desktop app could not reach the server on that device.",
          },
        });
        assert.deepStrictEqual(asked, ["a", "b", "c", "d"]);
      }).pipe(Effect.scoped),
  );
});
