// @effect-diagnostics nodeBuiltinImport:off -- the fake `op` reads the template the driver wrote.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";

import { OnePasswordAccount } from "../shared/definition.ts";
import { driver } from "./driver.ts";

const encoder = new TextEncoder();
const account = OnePasswordAccount.make("my.1password.com");

type OpResult = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly hang?: boolean;
};

function fakeOp(answer: (args: ReadonlyArray<string>) => OpResult) {
  const invocations: Array<ReadonlyArray<string>> = [];
  const spawned = Deferred.makeUnsafe<void>();
  const layer = Layer.mergeAll(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
          invocations.push(args);
          Deferred.doneUnsafe(spawned, Effect.void);
          const result = answer(args);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: result.hang
              ? Effect.never
              : Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(encoder.encode(result.stdout ?? "")),
            stderr: Stream.make(encoder.encode(result.stderr ?? "")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
    NodeFileSystem.layer,
    NodeCrypto.layer,
  );
  return { layer, invocations, spawned };
}

// Answers `op inject` by substituting each `{{ reference }}` in the template file it was handed.
const injectFrom =
  (secrets: Readonly<Record<string, string>>) =>
  (args: ReadonlyArray<string>): OpResult => {
    const template = NodeFS.readFileSync(args[args.indexOf("-i") + 1]!, "utf8");
    return { stdout: template.replace(/\{\{ (\S+) \}\}/g, (_, reference) => secrets[reference]!) };
  };

describe("1Password driver", () => {
  it.effect("reads one reference from the account", () => {
    const op = fakeOp(() => ({ stdout: "sk-live" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op://Private/OpenAI/credential"]), [
        "sk-live",
      ]);
      assert.deepStrictEqual(op.invocations, [
        [
          "--cache=false",
          "read",
          "--account=my.1password.com",
          "--no-newline",
          "op://Private/OpenAI/credential",
        ],
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads a failed reference as undefined", () => {
    const op = fakeOp(() => ({ code: 1, stderr: "[ERROR] account is locked" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op://Private/OpenAI/credential"]), [
        undefined,
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads every reference in a single call", () => {
    const op = fakeOp(
      injectFrom({
        "op://Private/OpenAI/credential": "sk-a",
        "op://Private/Anthropic/key": " sk-b\n",
      }),
    );
    return Effect.gen(function* () {
      const values = yield* driver.read({ account }, [
        "op://Private/OpenAI/credential",
        "op://Private/Anthropic/key",
      ]);

      assert.deepStrictEqual(values, ["sk-a", " sk-b\n"]);
      assert.strictEqual(op.invocations.length, 1);
      assert.deepStrictEqual(op.invocations[0]?.slice(0, 3), [
        "--cache=false",
        "inject",
        "--account=my.1password.com",
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("falls back to one read at a time when the batch fails", () => {
    const op = fakeOp((args) =>
      args.includes("inject")
        ? { code: 1, stderr: '[ERROR] could not resolve "op://Private/Gone/key"' }
        : args.at(-1) === "op://Private/Gone/key"
          ? { code: 1, stderr: "[ERROR] item not found" }
          : { stdout: "sk-a" },
    );
    return Effect.gen(function* () {
      const values = yield* driver.read({ account }, [
        "op://Private/OpenAI/credential",
        "op://Private/Gone/key",
      ]);

      assert.deepStrictEqual(values, ["sk-a", undefined]);
      assert.strictEqual(op.invocations.length, 3);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("does not read one at a time after the batch times out", () => {
    const op = fakeOp(() => ({ hang: true }));
    return Effect.gen(function* () {
      const reading = yield* driver
        .read({ account }, ["op://Private/OpenAI/credential", "op://Private/Anthropic/key"])
        .pipe(Effect.forkChild);
      yield* Deferred.await(op.spawned);
      yield* TestClock.adjust("1 minute");

      assert.deepStrictEqual(yield* Fiber.join(reading), [undefined, undefined]);
      assert.strictEqual(op.invocations.length, 1);
    }).pipe(Effect.provide(op.layer));
  });
});

describe("1Password logins", () => {
  const listed = JSON.stringify([
    {
      id: "abc123",
      title: "Grafana",
      vault: { id: "v1", name: "Work" },
      urls: [{ primary: true, href: "https://grafana.example.com/login" }],
    },
    { id: "nourl", title: "Wi-Fi", vault: { id: "v1", name: "Work" } },
  ]);
  const item = JSON.stringify({
    id: "abc123",
    fields: [
      { id: "username", type: "STRING", purpose: "USERNAME", value: "ops@example.com" },
      { id: "password", type: "CONCEALED", purpose: "PASSWORD", value: "hunter2" },
      { id: "notes", type: "STRING", purpose: "NOTES", value: "" },
      { id: "otp", type: "OTP", value: "otpauth://totp/x?secret=ABC", totp: "123456" },
    ],
  });
  const grafana = { id: "abc123", title: "Grafana", vault: "Work", urls: ["https://x"] };

  it.effect("lists logins that have a website, without reading secrets", () => {
    const op = fakeOp(() => ({ stdout: listed }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.logins!.list({ account }), [
        {
          id: "abc123",
          title: "Grafana",
          vault: "Work",
          urls: ["https://grafana.example.com/login"],
        },
      ]);
      assert.deepStrictEqual(op.invocations, [
        [
          "--cache=false",
          "item",
          "list",
          "--account=my.1password.com",
          "--categories=Login",
          "--format=json",
        ],
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads only the requested fields, with the current one-time code", () => {
    const op = fakeOp(() => ({ stdout: item }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.logins!.read({ account }, grafana, ["password"]), {
        password: "hunter2",
      });
      assert.deepStrictEqual(
        yield* driver.logins!.read({ account }, grafana, ["username", "password", "totp"]),
        { username: "ops@example.com", password: "hunter2", totp: "123456" },
      );
      assert.deepStrictEqual(op.invocations[0], [
        "--cache=false",
        "item",
        "get",
        "abc123",
        "--account=my.1password.com",
        "--reveal",
        "--format=json",
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads a locked or failed account as undefined", () => {
    const op = fakeOp(() => ({ code: 1, stderr: "[ERROR] account is locked" }));
    return Effect.gen(function* () {
      assert.strictEqual(yield* driver.logins!.list({ account }), undefined);
      assert.strictEqual(yield* driver.logins!.read({ account }, grafana, ["password"]), undefined);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("never passes an item id that looks like a flag", () => {
    const op = fakeOp(() => ({ stdout: item }));
    return Effect.gen(function* () {
      const flag = { ...grafana, id: "--help" };
      assert.strictEqual(yield* driver.logins!.read({ account }, flag, ["password"]), undefined);
      assert.strictEqual(op.invocations.length, 0);
    }).pipe(Effect.provide(op.layer));
  });
});
