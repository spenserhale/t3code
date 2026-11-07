import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import {
  defineSecretProviderDriver,
  type SecretProviderLogin,
  type SecretProviderLoginField,
  type SecretProviderLoginValues,
} from "@t3tools/secret-provider-core/server/driver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";

import { definition, type OnePasswordAccount } from "../shared/definition.ts";

const ONE_PASSWORD_BINARY = "op";
// Bounds a read long enough to reach for a fingerprint reader, short enough not to wedge a rebuild.
const READ_TIMEOUT = Duration.seconds(45);

// `--cache=false` skips the `op daemon`, which hangs on prompts a background server cannot show.
const runOnePassword = Effect.fn("OnePasswordDriver.runOnePassword")(function* (
  args: ReadonlyArray<string>,
) {
  const spawnCommand = yield* resolveSpawnCommand(ONE_PASSWORD_BINARY, ["--cache=false", ...args]);
  return yield* spawnAndCollect(
    ONE_PASSWORD_BINARY,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, { shell: spawnCommand.shell }),
  );
});

// A secret is passed on verbatim; surrounding whitespace can be part of it.
const nonEmpty = (value: string) => (value.trim().length > 0 ? value : undefined);

const readOne = Effect.fn("OnePasswordDriver.readOne")(function* (
  account: OnePasswordAccount,
  reference: string,
) {
  const result = yield* runOnePassword(["read", `--account=${account}`, "--no-newline", reference]);
  if (result.code !== 0) {
    yield* Effect.logWarning("Could not read secret from 1Password", {
      stage: "read",
      exitCode: result.code,
    });
    return undefined;
  }
  return nonEmpty(result.stdout);
});

// One `op inject` costs one unlock for every reference in the template. `op` ignores piped stdin
// from Node, so the template goes through a temp file. A random separator after every reference
// keeps one secret from shifting the others, and leaves any trailing newline outside the values.
const readTogether = Effect.fn("OnePasswordDriver.readTogether")(function* (
  account: OnePasswordAccount,
  references: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const separator = `__t3-secret-${yield* (yield* Crypto.Crypto).randomUUIDv4()}__`;
  const templatePath = yield* fileSystem.makeTempFileScoped({ prefix: "t3code-op-inject-" });
  yield* fileSystem.writeFileString(
    templatePath,
    references.map((reference) => `{{ ${reference} }}${separator}`).join(""),
  );
  const result = yield* runOnePassword(["inject", `--account=${account}`, "-i", templatePath]);
  const values = result.stdout.split(separator);
  const trailing = values.pop();
  if (
    result.code !== 0 ||
    values.length !== references.length ||
    trailing === undefined ||
    trailing.trim().length > 0
  ) {
    yield* Effect.logWarning("Could not batch-read secrets from 1Password", {
      stage: "inject",
      exitCode: result.code,
      references: references.length,
    });
    return undefined;
  }
  return values.map(nonEmpty);
}, Effect.scoped);

/** `None` when 1Password did not answer in time; a failed run reads as `Some(undefined)`. */
const bounded = <A, E extends { readonly _tag: string }, R>(
  stage: "read" | "inject",
  effect: Effect.Effect<A | undefined, E, R>,
) =>
  effect.pipe(
    Effect.timeoutOption(READ_TIMEOUT),
    Effect.tap((outcome) =>
      Option.isNone(outcome)
        ? Effect.logWarning("1Password did not answer in time", { stage })
        : Effect.void,
    ),
    Effect.catch((error) =>
      Effect.logWarning("Could not run 1Password", { stage, error: error._tag }).pipe(
        Effect.as(Option.some(undefined)),
      ),
    ),
  );

const ListedItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  vault: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
  urls: Schema.optional(Schema.Array(Schema.Struct({ href: Schema.String }))),
});
const decodeListedItems = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ListedItem)),
);

const ItemField = Schema.Struct({
  type: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
  totp: Schema.optional(Schema.String),
});
const decodeItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ fields: Schema.optional(Schema.Array(ItemField)) })),
);

/** Logins with at least one website; the rest could never match a page. */
const parseLoginList = (stdout: string): ReadonlyArray<SecretProviderLogin> | undefined =>
  Option.getOrUndefined(
    Option.map(decodeListedItems(stdout), (items) =>
      items.flatMap((item) => {
        const urls = (item.urls ?? []).map((url) => url.href).filter((href) => href.length > 0);
        if (urls.length === 0) return [];
        const vault = item.vault?.name;
        return [{ id: item.id, title: item.title, ...(vault ? { vault } : {}), urls }];
      }),
    ),
  );

/** Picks the requested values out of `op item get --format json`. */
const parseLoginValues = (
  stdout: string,
  fields: ReadonlyArray<SecretProviderLoginField>,
): SecretProviderLoginValues | undefined => {
  const item = Option.getOrUndefined(decodeItem(stdout));
  if (item === undefined) return undefined;
  const itemFields = item.fields ?? [];
  const values: SecretProviderLoginValues = {};
  for (const field of fields) {
    const value =
      field === "totp"
        ? itemFields.find((candidate) => candidate.type === "OTP")?.totp
        : itemFields.find((candidate) => candidate.purpose === field.toUpperCase())?.value;
    if (value !== undefined && value.length > 0) values[field] = value;
  }
  return values;
};

const listLogins = Effect.fn("OnePasswordDriver.listLogins")(function* (
  account: OnePasswordAccount,
) {
  const result = yield* runOnePassword([
    "item",
    "list",
    `--account=${account}`,
    "--categories=Login",
    "--format=json",
  ]);
  const logins = result.code === 0 ? parseLoginList(result.stdout) : undefined;
  if (logins === undefined) {
    yield* Effect.logWarning("Could not list 1Password logins", { exitCode: result.code });
  }
  return logins;
});

// The item id alone is unique in an account, and keeps vault names out of the arguments.
const readLogin = Effect.fn("OnePasswordDriver.readLogin")(function* (
  account: OnePasswordAccount,
  login: SecretProviderLogin,
  fields: ReadonlyArray<SecretProviderLoginField>,
) {
  if (login.id.startsWith("-")) return undefined;
  const result = yield* runOnePassword([
    "item",
    "get",
    login.id,
    `--account=${account}`,
    "--reveal",
    "--format=json",
  ]);
  const values = result.code === 0 ? parseLoginValues(result.stdout, fields) : undefined;
  if (values === undefined) {
    yield* Effect.logWarning("Could not read 1Password login", { exitCode: result.code });
  }
  return values;
});

const boundedLogin = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A | undefined, E, R>,
) =>
  effect.pipe(
    Effect.timeoutOption(READ_TIMEOUT),
    Effect.map(Option.getOrUndefined),
    Effect.catch((error) =>
      Effect.logWarning("Could not run 1Password", { stage: "login", error: error._tag }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

export const driver = defineSecretProviderDriver({
  kind: definition.kind,
  definition,
  read: Effect.fn("OnePasswordDriver.read")(function* ({ account }, references) {
    if (references.length > 1) {
      const together = yield* bounded("inject", readTogether(account, references));
      // Reading one by one after a timeout would only wait that long again for each reference.
      if (Option.isNone(together)) return references.map(() => undefined);
      if (together.value !== undefined) return together.value;
    }
    return yield* Effect.forEach(references, (reference) =>
      bounded("read", readOne(account, reference)).pipe(Effect.map(Option.getOrUndefined)),
    );
  }),
  logins: {
    list: ({ account }) => boundedLogin(listLogins(account)),
    read: ({ account }, login, fields) => boundedLogin(readLogin(account, login, fields)),
  },
});
