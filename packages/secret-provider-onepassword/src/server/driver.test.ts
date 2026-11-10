// @effect-diagnostics nodeBuiltinImport:off -- the fake `op` reads the template the driver wrote.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";
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
  const options: Array<ChildProcess.CommandOptions> = [];
  const spawned = Deferred.makeUnsafe<void>();
  const layer = Layer.mergeAll(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const { args, options: commandOptions } = command as unknown as {
            readonly args: ReadonlyArray<string>;
            readonly options: ChildProcess.CommandOptions;
          };
          invocations.push(args);
          options.push(commandOptions);
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
  return { layer, invocations, options, spawned };
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
      assert.strictEqual(op.options[0]?.env, undefined);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("signs in with a service account token, in the environment of op alone", () => {
    const op = fakeOp((args) =>
      args.includes("inject")
        ? injectFrom({
            "op://Shared/OpenAI/credential": "sk-a",
            "op://Shared/Anthropic/key": "sk-b",
          })(args)
        : { stdout: "sk-a" },
    );
    const config = { account, serviceAccountToken: "ops_test-token" };
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read(config, ["op://Shared/OpenAI/credential"]), [
        "sk-a",
      ]);
      assert.deepStrictEqual(
        yield* driver.read(config, ["op://Shared/OpenAI/credential", "op://Shared/Anthropic/key"]),
        ["sk-a", "sk-b"],
      );

      assert.deepStrictEqual(op.invocations[0], [
        "--cache=false",
        "read",
        "--no-newline",
        "op://Shared/OpenAI/credential",
      ]);
      assert.deepStrictEqual(op.invocations[1]?.slice(0, 3), ["--cache=false", "inject", "-i"]);
      assert.strictEqual(op.options.length, 2);
      for (const { env, extendEnv } of op.options) {
        const token = env?.OP_SERVICE_ACCOUNT_TOKEN;
        assert.isTrue(Redacted.isRedacted(token) && Redacted.value(token) === "ops_test-token");
        assert.deepStrictEqual(Object.keys(env ?? {}), ["OP_SERVICE_ACCOUNT_TOKEN"]);
        assert.isTrue(extendEnv);
      }
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
      // Fields a login has no use for may hold values other than strings.
      { id: "office", type: "ADDRESS", value: { street: "1 Main St", city: "Springfield" } },
      { id: "otp", type: "OTP", value: "otpauth://totp/x?secret=ABC", totp: "123456" },
    ],
  });
  const grafana = { id: "abc123", title: "Grafana", vault: "Work", urls: ["https://x"] };
  const generated = "Xk3$pQ9!vB2@mN7#tR5&wL8*";
  const recipe = { length: 24, digits: true, symbols: true };
  const newLogin = {
    vault: "Sign-ups",
    title: "-shop.test",
    url: "https://shop.test",
    username: "-ada@example.com",
    recipe,
    notes: "Created for a sign-up.",
  };
  /** What `op item create` or `op item edit` prints, with the password field's value if given. */
  const savedItem = (password?: string) =>
    JSON.stringify({
      id: "new1",
      title: "-shop.test",
      vault: { id: "v7", name: "Sign-ups" },
      urls: [{ primary: true, href: "https://shop.test" }],
      fields: [
        { id: "username", type: "STRING", purpose: "USERNAME", value: "-ada@example.com" },
        {
          id: "password",
          type: "CONCEALED",
          purpose: "PASSWORD",
          ...(password === undefined ? {} : { value: password }),
        },
      ],
    });
  const saved = {
    id: "new1",
    title: "-shop.test",
    vault: "Sign-ups",
    vaultId: "v7",
    urls: ["https://shop.test"],
  };

  it.effect("creates a login whose password 1Password generates, never on the command line", () => {
    const op = fakeOp(() => ({ stdout: savedItem(generated) }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.logins!.create!({ account }, newLogin), {
        login: saved,
        password: generated,
      });
      // Values that look like flags stay inside `--flag=value` and `field=value` arguments.
      assert.deepStrictEqual(op.invocations, [
        [
          "--cache=false",
          "item",
          "--account=my.1password.com",
          "create",
          "--category=login",
          "--vault=Sign-ups",
          "--title=-shop.test",
          "--url=https://shop.test",
          "--generate-password=letters,digits,symbols,24",
          "--tags=T3 Code",
          "--format=json",
          "username=-ada@example.com",
          "notesPlain=Created for a sign-up.",
        ],
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  // Reading the password back can fail once the login is saved, so the caller does it and the
  // saved login is never lost with it.
  it.effect.each([
    ["no value", undefined],
    ["a concealment hint", "[use 'op item get new1 --reveal' to reveal]"],
    ["a value the recipe could not make", "hunter2"],
  ] as const)(
    "returns the saved login without a password when the output shows %s",
    ([, shown]) => {
      const op = fakeOp((args) =>
        args.includes("create") ? { stdout: savedItem(shown) } : { code: 1, stderr: "[ERROR]" },
      );
      return Effect.gen(function* () {
        assert.deepStrictEqual(yield* driver.logins!.create!({ account }, newLogin), {
          login: saved,
          password: undefined,
        });
        assert.strictEqual(op.invocations.length, 1);
      }).pipe(Effect.provide(op.layer));
    },
  );

  it.effect.each([
    ["shows the new password", "abc123DEF456", { password: "abc123DEF456" }],
    ["shows none", undefined, { password: undefined }],
  ] as const)(
    "regenerates the password of a login in its vault; the output %s",
    ([, shown, edited]) => {
      const shorter = { length: 12, digits: true, symbols: false };
      const op = fakeOp((args) =>
        args.includes("edit") ? { stdout: savedItem(shown) } : { code: 1, stderr: "[ERROR]" },
      );
      return Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* driver.logins!.regeneratePassword!({ account }, saved, shorter),
          edited,
        );
        assert.deepStrictEqual(op.invocations, [
          [
            "--cache=false",
            "item",
            "--account=my.1password.com",
            "edit",
            "new1",
            "--vault=v7",
            "--generate-password=letters,digits,12",
            "--format=json",
          ],
        ]);
      }).pipe(Effect.provide(op.layer));
    },
  );

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
          "--account=my.1password.com",
          "list",
          "--categories=Login",
          "--format=json",
        ],
      ]);
      assert.strictEqual(op.options[0]?.env, undefined);
    }).pipe(Effect.provide(op.layer));
  });

  describe("with a service account token", () => {
    const config = { account, serviceAccountToken: "ops_test-token" };
    const vaults = (...ids: ReadonlyArray<string>) =>
      JSON.stringify(ids.map((id) => ({ id, name: `Vault ${id}` })));
    const jira = JSON.stringify([
      {
        id: "jira1",
        title: "Jira",
        vault: { id: "v2", name: "Agents" },
        urls: [{ href: "https://jira.example.com" }],
      },
    ]);
    const vaultOf = (args: ReadonlyArray<string>) =>
      args.find((arg) => arg.startsWith("--vault="))?.slice("--vault=".length);

    it.effect("lists each vault it sees, then reads a login from its vault", () => {
      const op = fakeOp((args) =>
        args[1] === "vault"
          ? { stdout: vaults("v1", "v2") }
          : args[2] === "list"
            ? { stdout: vaultOf(args) === "v1" ? listed : jira }
            : { stdout: item },
      );
      return Effect.gen(function* () {
        const logins = yield* driver.logins!.list(config);
        assert.deepStrictEqual(logins, [
          {
            id: "abc123",
            title: "Grafana",
            vault: "Work",
            vaultId: "v1",
            urls: ["https://grafana.example.com/login"],
          },
          {
            id: "jira1",
            title: "Jira",
            vault: "Agents",
            vaultId: "v2",
            urls: ["https://jira.example.com"],
          },
        ]);
        assert.deepStrictEqual(yield* driver.logins!.read(config, logins![0]!, ["password"]), {
          password: "hunter2",
        });

        const [vaultList, ...rest] = op.invocations;
        assert.deepStrictEqual(vaultList, ["--cache=false", "vault", "list", "--format=json"]);
        assert.sameDeepMembers(
          rest.slice(0, 2).map((args) => [...args]),
          [
            ["--cache=false", "item", "list", "--vault=v1", "--categories=Login", "--format=json"],
            ["--cache=false", "item", "list", "--vault=v2", "--categories=Login", "--format=json"],
          ],
        );
        assert.deepStrictEqual(rest[2], [
          "--cache=false",
          "item",
          "get",
          "abc123",
          "--vault=v1",
          "--reveal",
          "--format=json",
        ]);
        // The token goes only to op's environment: never an argument, never `--account` with it.
        assert.isFalse(op.invocations.flat().some((arg) => arg.includes("ops_test-token")));
        assert.isFalse(op.invocations.flat().some((arg) => arg.startsWith("--account")));
        for (const { env } of op.options) {
          const token = env?.OP_SERVICE_ACCOUNT_TOKEN;
          assert.isTrue(Redacted.isRedacted(token) && Redacted.value(token) === "ops_test-token");
        }
      }).pipe(Effect.provide(op.layer));
    });

    it.effect("a vault that cannot be listed hides only its own logins", () => {
      const op = fakeOp((args) =>
        args[1] === "vault"
          ? { stdout: vaults("v1", "--help", "v2") }
          : vaultOf(args) === "v1"
            ? { code: 1, stderr: "[ERROR] rate limited" }
            : { stdout: jira },
      );
      return Effect.gen(function* () {
        const logins = yield* driver.logins!.list(config);
        assert.deepStrictEqual(
          logins?.map((login) => login.id),
          ["jira1"],
        );
        assert.isFalse(op.invocations.some((args) => vaultOf(args) === "--help"));
      }).pipe(Effect.provide(op.layer));
    });

    it.effect("lists identities vault by vault, then reads one from its vault", () => {
      const op = fakeOp((args) =>
        args[1] === "vault"
          ? { stdout: vaults("v1", "v2") }
          : args[2] === "list"
            ? {
                stdout: JSON.stringify(
                  vaultOf(args) === "v1"
                    ? [{ id: "me1", title: "Me", vault: { id: "v1", name: "Agents" } }]
                    : [],
                ),
              }
            : {
                stdout: JSON.stringify({
                  fields: [{ id: "firstname", type: "STRING", value: "Ada" }],
                }),
              },
      );
      return Effect.gen(function* () {
        const identities = yield* driver.identities!.list(config);
        assert.deepStrictEqual(identities, [
          { id: "me1", title: "Me", vault: "Agents", vaultId: "v1" },
        ]);
        assert.deepStrictEqual(yield* driver.identities!.read(config, identities![0]!), {
          firstName: "Ada",
        });
        assert.sameDeepMembers(
          op.invocations.slice(1, 3).map((args) => [...args]),
          [
            [
              "--cache=false",
              "item",
              "list",
              "--vault=v1",
              "--categories=Identity",
              "--format=json",
            ],
            [
              "--cache=false",
              "item",
              "list",
              "--vault=v2",
              "--categories=Identity",
              "--format=json",
            ],
          ],
        );
        assert.deepStrictEqual(op.invocations[3], [
          "--cache=false",
          "item",
          "get",
          "me1",
          "--vault=v1",
          "--format=json",
        ]);
      }).pipe(Effect.provide(op.layer));
    });

    it.effect("reads as not listing when every vault fails", () => {
      const op = fakeOp((args) =>
        args[1] === "vault" ? { stdout: vaults("v1", "v2") } : { code: 1, stderr: "[ERROR]" },
      );
      return Effect.gen(function* () {
        assert.strictEqual(yield* driver.logins!.list(config), undefined);
        assert.strictEqual(op.invocations.length, 3);
      }).pipe(Effect.provide(op.layer));
    });
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
        "--account=my.1password.com",
        "get",
        "abc123",
        "--reveal",
        "--format=json",
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("looks up the item a reference names, by category, without revealing it", () => {
    const referenced = (category: string) =>
      JSON.stringify({
        id: "abc123",
        title: "Grafana",
        category,
        vault: { id: "v2", name: "Agents Vault" },
        urls: [{ primary: true, href: "https://grafana.example.com/login" }],
        fields: [{ id: "password", type: "CONCEALED", purpose: "PASSWORD" }],
      });
    const op = fakeOp((args) =>
      args.includes("Me") ? { stdout: referenced("IDENTITY") } : { stdout: referenced("LOGIN") },
    );
    const token = { account, serviceAccountToken: "ops_test-token" };
    return Effect.gen(function* () {
      const login = {
        id: "abc123",
        title: "Grafana",
        vault: "Agents Vault",
        vaultId: "v2",
        urls: ["https://grafana.example.com/login"],
      };
      assert.deepStrictEqual(
        yield* driver.logins!.lookup!({ account }, "op://Agents Vault/Grafana"),
        login,
      );
      // A field after the item is ignored; a service account names no account.
      assert.deepStrictEqual(
        yield* driver.logins!.lookup!(token, "op://Agents Vault/Grafana/password"),
        login,
      );
      assert.deepStrictEqual(
        yield* driver.identities!.lookup!({ account }, "op://Agents Vault/Me"),
        {
          id: "abc123",
          title: "Grafana",
          vault: "Agents Vault",
          vaultId: "v2",
        },
      );
      // Another category is not what was asked for.
      assert.strictEqual(
        yield* driver.identities!.lookup!({ account }, "op://Agents Vault/Grafana"),
        undefined,
      );
      assert.strictEqual(
        yield* driver.logins!.lookup!({ account }, "op://Agents Vault/Me"),
        undefined,
      );
      assert.deepStrictEqual(op.invocations.slice(0, 2), [
        [
          "--cache=false",
          "item",
          "--account=my.1password.com",
          "get",
          "Grafana",
          "--vault=Agents Vault",
          "--format=json",
        ],
        ["--cache=false", "item", "get", "Grafana", "--vault=Agents Vault", "--format=json"],
      ]);
      assert.isFalse(op.invocations.some((args) => args.includes("--reveal")));
      // Only a service account is used without asking anyone.
      assert.isFalse(driver.unattended!({ account }));
      assert.isTrue(driver.unattended!(token));
      assert.isFalse(driver.unattended!({ account, serviceAccountToken: "" }));
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads a locked or failed account as undefined", () => {
    const op = fakeOp(() => ({ code: 1, stderr: "[ERROR] account is locked" }));
    return Effect.gen(function* () {
      assert.strictEqual(
        yield* driver.logins!.lookup!({ account }, "op://Work/Grafana"),
        undefined,
      );
      assert.strictEqual(yield* driver.logins!.list({ account }), undefined);
      assert.strictEqual(yield* driver.logins!.read({ account }, grafana, ["password"]), undefined);
      assert.strictEqual(yield* driver.identities!.list({ account }), undefined);
      assert.strictEqual(yield* driver.identities!.read({ account }, grafana), undefined);
      assert.strictEqual(yield* driver.logins!.create!({ account }, newLogin), undefined);
      assert.strictEqual(
        yield* driver.logins!.regeneratePassword!({ account }, saved, recipe),
        undefined,
      );
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("never passes an item or vault id that looks like a flag", () => {
    const op = fakeOp(() => ({ stdout: item }));
    return Effect.gen(function* () {
      for (const flag of [
        { ...grafana, id: "--help" },
        { ...grafana, vaultId: "--help" },
      ]) {
        assert.strictEqual(yield* driver.logins!.read({ account }, flag, ["password"]), undefined);
        assert.strictEqual(yield* driver.identities!.read({ account }, flag), undefined);
        assert.strictEqual(
          yield* driver.logins!.regeneratePassword!({ account }, flag, recipe),
          undefined,
        );
      }
      for (const reference of [
        "op://--help/Grafana",
        "op://Work/--help",
        "op://Work",
        "Work/Grafana",
      ]) {
        assert.strictEqual(yield* driver.logins!.lookup!({ account }, reference), undefined);
      }
      assert.strictEqual(op.invocations.length, 0);
    }).pipe(Effect.provide(op.layer));
  });
});

describe("1Password identities", () => {
  const me = { id: "me1", title: "Me" };
  const readFields = (fields: ReadonlyArray<object>) => {
    const op = fakeOp(() => ({ stdout: JSON.stringify({ id: "me1", fields }) }));
    return driver.identities!.read({ account }, me).pipe(Effect.provide(op.layer));
  };

  it.effect("lists every identity, website or not", () => {
    const op = fakeOp(() => ({
      stdout: JSON.stringify([{ id: "me1", title: "Me", vault: { id: "v1", name: "Private" } }]),
    }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.identities!.list({ account }), [
        { id: "me1", title: "Me", vault: "Private" },
      ]);
      assert.deepStrictEqual(op.invocations, [
        [
          "--cache=false",
          "item",
          "--account=my.1password.com",
          "list",
          "--categories=Identity",
          "--format=json",
        ],
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads values by field id, then by label, with the first phone that is set", () =>
    Effect.gen(function* () {
      const values = yield* readFields([
        { id: "firstname", type: "STRING", label: "first name", value: " Ada " },
        { id: "initial", type: "STRING", label: "initial", value: "M" },
        { id: "lastname", type: "STRING", label: "last name", value: "Lovelace" },
        { id: "sex", type: "MENU", label: "sex", value: "female" },
        { id: "birthdate", type: "DATE", label: "birth date", value: "642902400" },
        { id: "company", type: "STRING", label: "company", value: "" },
        { id: "q7x2", type: "STRING", label: "Company", value: "Analytical Engines" },
        { id: "defphone", type: "PHONE", label: "default phone", value: "" },
        { id: "cellphone", type: "PHONE", label: "cell", value: "+1 555 0100" },
        { id: "homephone", type: "PHONE", label: "home", value: "+1 555 0101" },
        { id: "email", type: "EMAIL", label: "email", value: "ada@example.com" },
        { id: "username", type: "STRING", label: "username", value: "ada" },
        { id: "9kd1", type: "STRING", label: "Job Title", value: "Programmer" },
        {
          id: "address",
          type: "ADDRESS",
          label: "address",
          value: "1 Main St, Springfield, IL, 62701, us",
        },
      ]);
      assert.deepStrictEqual(values, {
        firstName: "Ada",
        middleInitial: "M",
        lastName: "Lovelace",
        email: "ada@example.com",
        phone: "+1 555 0100",
        company: "Analytical Engines",
        jobTitle: "Programmer",
        username: "ada",
        birthDate: "1990-05-17",
        address: "1 Main St, Springfield, IL, 62701, us",
      });
    }),
  );

  it.effect("never reads a credential as a person's details, by id or by label", () =>
    Effect.gen(function* () {
      const names = [
        "firstname",
        "first name",
        "initial",
        "middle initial",
        "lastname",
        "last name",
        "email",
        "defphone",
        "cellphone",
        "phone",
        "company",
        "jobtitle",
        "job title",
        "birthdate",
        "birth date",
        "username",
        "address",
      ];
      const fields = names.flatMap((name, index) => [
        { id: name, type: "CONCEALED", label: name, value: `secret-${index}` },
        { id: `c${index}`, type: "CONCEALED", label: name, value: `secret-${index}` },
        { id: `o${index}`, type: "OTP", label: name, value: "otpauth://x", totp: "123456" },
        { id: `p${index}`, type: "STRING", purpose: "PASSWORD", label: name, value: `pw-${index}` },
        { id: `u${index}`, label: name, value: `untyped-${index}` },
      ]);
      assert.deepStrictEqual(yield* readFields(fields), {});
    }),
  );

  it.effect.each([
    ["epoch seconds", "642902400", "1990-05-17"],
    ["epoch seconds in a JSON number", 642902400, "1990-05-17"],
    ["an ISO date", "1990-05-17", "1990-05-17"],
    ["seconds before 1970", "-86400", "1969-12-31"],
  ] as const)("reads a birth date given as %s", ([, value, birthDate]) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* readFields([{ id: "birthdate", type: "DATE", value }]), {
        birthDate,
      });
    }),
  );

  // The CLI's ADDRESS output is unverified: parts come only from an object, and a string is kept
  // whole, since splitting one assigns the wrong parts.
  it.effect.each([
    [
      "an object",
      { street: "1 Main St", city: "Springfield", state: "IL", zip: "62701", country: "us" },
      { street: "1 Main St", city: "Springfield", state: "IL", postalCode: "62701", country: "us" },
    ],
    [
      "an object with empty parts",
      { street: "10 Downing St", city: "London", state: "", zip: "SW1A 2AA", country: "gb" },
      { street: "10 Downing St", city: "London", postalCode: "SW1A 2AA", country: "gb" },
    ],
    [
      "a string with more parts than expected",
      "1 Main St, Apt 4, Springfield, IL 62701, us",
      { address: "1 Main St, Apt 4, Springfield, IL 62701, us" },
    ],
    [
      "a string ending in a state code",
      "1 Main St, Sacramento, CA",
      { address: "1 Main St, Sacramento, CA" },
    ],
    [
      "lines of text with empty parts",
      "10 Downing St\nLondon, , SW1A 2AA\ngb",
      { address: "10 Downing St, London, SW1A 2AA, gb" },
    ],
    ["only separators", " , \n, ", {}],
    ["something else", 42, {}],
  ] as const)("reads an address given as %s", ([, value, address]) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* readFields([{ id: "address", type: "ADDRESS", label: "address", value }]),
        address,
      );
    }),
  );
});
