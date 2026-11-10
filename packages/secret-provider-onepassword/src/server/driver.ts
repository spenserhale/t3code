import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import {
  defineSecretProviderDriver,
  type SecretProviderIdentity,
  type SecretProviderIdentityField,
  type SecretProviderIdentityValues,
  type SecretProviderLogin,
  type SecretProviderLoginField,
  type SecretProviderLoginValues,
  type SecretProviderNewLogin,
  type SecretProviderPasswordRecipe,
} from "@t3tools/secret-provider-core/server/driver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";
import * as Redacted from "effect/Redacted";

import { definition, type OnePasswordSecretProviderConfig } from "../shared/definition.ts";

const ONE_PASSWORD_BINARY = "op";
// Bounds a read long enough to reach for a fingerprint reader, short enough not to wedge a rebuild.
const READ_TIMEOUT = Duration.seconds(45);

// `--cache=false` skips the `op daemon`, which hangs on prompts a background server cannot show.
// A service account token reaches only this child's environment. `--account` is left out with it:
// how `op` combines the two is undocumented.
const runOnePassword = Effect.fn("OnePasswordDriver.runOnePassword")(function* (
  { account, serviceAccountToken }: OnePasswordSecretProviderConfig,
  command: "read" | "inject" | "item" | "vault",
  args: ReadonlyArray<string>,
) {
  const spawnCommand = yield* resolveSpawnCommand(ONE_PASSWORD_BINARY, [
    "--cache=false",
    command,
    ...(serviceAccountToken ? [] : [`--account=${account}`]),
    ...args,
  ]);
  return yield* spawnAndCollect(
    ONE_PASSWORD_BINARY,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      shell: spawnCommand.shell,
      ...(serviceAccountToken
        ? {
            env: { OP_SERVICE_ACCOUNT_TOKEN: Redacted.make(serviceAccountToken) },
            extendEnv: true,
          }
        : {}),
    }),
  );
});

// A secret is passed on verbatim; surrounding whitespace can be part of it.
const nonEmpty = (value: string) => (value.trim().length > 0 ? value : undefined);

const readOne = Effect.fn("OnePasswordDriver.readOne")(function* (
  config: OnePasswordSecretProviderConfig,
  reference: string,
) {
  const result = yield* runOnePassword(config, "read", ["--no-newline", reference]);
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
  config: OnePasswordSecretProviderConfig,
  references: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const separator = `__t3-secret-${yield* (yield* SecureRandom.SecureRandom).uuidV4()}__`;
  const templatePath = yield* fileSystem.makeTempFileScoped({ prefix: "t3code-op-inject-" });
  yield* fileSystem.writeFileString(
    templatePath,
    references.map((reference) => `{{ ${reference} }}${separator}`).join(""),
  );
  const result = yield* runOnePassword(config, "inject", ["-i", templatePath]);
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

const boundedItem = <A, E extends { readonly _tag: string }, R>(
  stage: "login" | "identity",
  effect: Effect.Effect<A | undefined, E, R>,
) =>
  effect.pipe(
    Effect.timeoutOption(READ_TIMEOUT),
    Effect.map(Option.getOrUndefined),
    Effect.catch((error) =>
      Effect.logWarning("Could not run 1Password", { stage, error: error._tag }).pipe(
        Effect.as(undefined),
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
const decodeVaults = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String }))),
);

// Fields are read one property at a time: an item can hold fields a login never uses, such as an
// address whose value is an object, and those must not make the whole item unreadable.
const decodeItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ fields: Schema.optional(Schema.Array(Schema.Unknown)) })),
);
const textOf = (field: unknown, key: "type" | "purpose" | "value" | "totp") => {
  const value =
    typeof field === "object" && field !== null
      ? (field as Readonly<Record<string, unknown>>)[key]
      : undefined;
  return typeof value === "string" ? value : undefined;
};

// An Identity's ADDRESS field may not hold a string, so identity values decode as unknown.
const IdentityField = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
});
type IdentityField = typeof IdentityField.Type;
const decodeIdentityItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ fields: Schema.optional(Schema.Array(IdentityField)) })),
);
const decodeAddressObject = Schema.decodeUnknownOption(
  Schema.Struct({
    street: Schema.optional(Schema.String),
    city: Schema.optional(Schema.String),
    state: Schema.optional(Schema.String),
    zip: Schema.optional(Schema.String),
    country: Schema.optional(Schema.String),
  }),
);

type ListedVaultItem = {
  readonly item: typeof ListedItem.Type;
  readonly vaultId: string | undefined;
};

/** Logins with at least one website; the rest could never match a page. */
const toLogins = (listed: ReadonlyArray<ListedVaultItem>): ReadonlyArray<SecretProviderLogin> =>
  listed.flatMap(({ item, vaultId }) => {
    const urls = (item.urls ?? []).map((url) => url.href).filter((href) => href.length > 0);
    if (urls.length === 0) return [];
    const vault = item.vault?.name;
    return [
      {
        id: item.id,
        title: item.title,
        ...(vault ? { vault } : {}),
        ...(vaultId === undefined ? {} : { vaultId }),
        urls,
      },
    ];
  });

const toIdentities = (
  listed: ReadonlyArray<ListedVaultItem>,
): ReadonlyArray<SecretProviderIdentity> =>
  listed.map(({ item, vaultId }) => {
    const vault = item.vault?.name;
    return {
      id: item.id,
      title: item.title,
      ...(vault ? { vault } : {}),
      ...(vaultId === undefined ? {} : { vaultId }),
    };
  });

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
    const [kind, key, wanted] =
      field === "totp"
        ? (["type", "totp", "OTP"] as const)
        : (["purpose", "value", field.toUpperCase()] as const);
    const value = itemFields
      .filter((candidate) => textOf(candidate, kind) === wanted)
      .map((candidate) => textOf(candidate, key))
      .find((text) => text !== undefined);
    if (value !== undefined && value.length > 0) values[field] = value;
  }
  return values;
};

type AddressField = "street" | "city" | "state" | "postalCode" | "country";
type IdentityTextField = Exclude<SecretProviderIdentityField, AddressField>;

/**
 * Each value's field ids, then its labels, in the order they are tried, and the field types it
 * may have. No secret type is listed, so a password, one-time code or concealed field is never
 * read as a person's details, whatever its id or label says.
 */
const IDENTITY_FIELDS: Record<
  IdentityTextField | "address",
  {
    readonly ids: ReadonlyArray<string>;
    readonly labels: ReadonlyArray<string>;
    readonly types: ReadonlyArray<string>;
  }
> = {
  firstName: { ids: ["firstname"], labels: ["first name"], types: ["STRING"] },
  middleInitial: { ids: ["initial"], labels: ["initial", "middle initial"], types: ["STRING"] },
  lastName: { ids: ["lastname"], labels: ["last name"], types: ["STRING"] },
  email: { ids: ["email"], labels: ["email"], types: ["EMAIL", "STRING"] },
  phone: {
    ids: ["defphone", "cellphone", "homephone", "busphone"],
    labels: ["default phone", "phone", "mobile", "cell", "home", "business"],
    types: ["PHONE", "STRING"],
  },
  company: { ids: ["company"], labels: ["company"], types: ["STRING"] },
  jobTitle: { ids: ["jobtitle"], labels: ["job title"], types: ["STRING"] },
  birthDate: { ids: ["birthdate"], labels: ["birth date"], types: ["DATE", "STRING"] },
  username: { ids: ["username"], labels: ["username"], types: ["STRING"] },
  address: { ids: ["address"], labels: ["address"], types: ["ADDRESS", "STRING"] },
};

const trimmedText = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const isText = (value: unknown) => trimmedText(value) !== undefined;

const findIdentityField = (
  fields: ReadonlyArray<IdentityField>,
  { ids, labels, types }: (typeof IDENTITY_FIELDS)[keyof typeof IDENTITY_FIELDS],
  accepts: (value: unknown) => boolean = isText,
) => {
  const filled = fields.filter(
    (field) =>
      types.includes(field.type?.toUpperCase() ?? "") &&
      field.purpose?.toUpperCase() !== "PASSWORD" &&
      accepts(field.value),
  );
  for (const id of ids) {
    const found = filled.find((field) => field.id?.toLowerCase() === id);
    if (found) return found.value;
  }
  for (const label of labels) {
    const found = filled.find((field) => field.label?.trim().toLowerCase() === label);
    if (found) return found.value;
  }
  return undefined;
};

// `op` may give a DATE field as epoch seconds, as text or as a number; forms want the date.
const toBirthDate = (value: unknown) => {
  const text = trimmedText(value);
  const seconds =
    typeof value === "number"
      ? value
      : text !== undefined && /^-?\d+$/.test(text)
        ? Number(text)
        : undefined;
  if (seconds === undefined) return text;
  return Option.getOrUndefined(
    DateTime.make(seconds * 1000).pipe(
      Option.map(DateTime.formatIsoDateUtc),
      Option.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)),
    ),
  );
};

/**
 * How `op` prints an Identity's ADDRESS field is unverified. Parts come only from an object; a
 * string stays whole, on one line, because splitting one assigned the wrong parts. Parsing a
 * string can return once its format is checked against a real item.
 */
const parseAddress = (
  value: unknown,
): Partial<Record<AddressField | "address", string | undefined>> => {
  if (typeof value === "string") {
    const parts = value.split(/[\n,]/).map((part) => part.trim());
    return { address: parts.filter((part) => part.length > 0).join(", ") };
  }
  if (typeof value !== "object" || value === null) return {};
  const address = Option.getOrUndefined(decodeAddressObject(value));
  return address === undefined
    ? {}
    : {
        street: address.street,
        city: address.city,
        state: address.state,
        postalCode: address.zip,
        country: address.country,
      };
};

/** Picks an Identity's values out of `op item get --format json`, by field id, then label. */
const parseIdentityValues = (stdout: string): SecretProviderIdentityValues | undefined => {
  const item = Option.getOrUndefined(decodeIdentityItem(stdout));
  if (item === undefined) return undefined;
  const fields = item.fields ?? [];
  const values: SecretProviderIdentityValues = {};
  const set = (field: SecretProviderIdentityField, value: string | undefined) => {
    const text = value?.trim();
    if (text) values[field] = text;
  };
  for (const field of [
    "firstName",
    "middleInitial",
    "lastName",
    "email",
    "phone",
    "company",
    "jobTitle",
    "username",
  ] as const) {
    set(field, trimmedText(findIdentityField(fields, IDENTITY_FIELDS[field])));
  }
  set(
    "birthDate",
    toBirthDate(
      findIdentityField(
        fields,
        IDENTITY_FIELDS.birthDate,
        (value) => isText(value) || Number.isFinite(value),
      ),
    ),
  );
  const address = parseAddress(
    findIdentityField(
      fields,
      IDENTITY_FIELDS.address,
      (value) => isText(value) || (typeof value === "object" && value !== null),
    ),
  );
  for (const field of ["address", "street", "city", "state", "postalCode", "country"] as const) {
    set(field, address[field]);
  }
  return values;
};

type ItemCategory = "Login" | "Identity";

const listItems = Effect.fn("OnePasswordDriver.listItems")(function* (
  config: OnePasswordSecretProviderConfig,
  category: ItemCategory,
  vaultId: string | undefined,
) {
  const result = yield* runOnePassword(config, "item", [
    "list",
    ...(vaultId === undefined ? [] : [`--vault=${vaultId}`]),
    `--categories=${category}`,
    "--format=json",
  ]);
  const items =
    result.code === 0 ? Option.getOrUndefined(decodeListedItems(result.stdout)) : undefined;
  if (items === undefined) {
    yield* Effect.logWarning("Could not list 1Password items", { category, exitCode: result.code });
    return undefined;
  }
  return items.map((item): ListedVaultItem => ({ item, vaultId }));
});

const listVaults = Effect.fn("OnePasswordDriver.listVaults")(function* (
  config: OnePasswordSecretProviderConfig,
) {
  const result = yield* runOnePassword(config, "vault", ["list", "--format=json"]);
  const vaults = result.code === 0 ? Option.getOrUndefined(decodeVaults(result.stdout)) : undefined;
  if (vaults === undefined) {
    yield* Effect.logWarning("Could not list 1Password vaults", { exitCode: result.code });
  }
  return vaults;
});

// A service account must name a vault once it sees more than one, so it lists each vault it was
// given. Its reads are rate limited: one call for the vaults, then one per vault, two at a time.
const listCategory = Effect.fn("OnePasswordDriver.listCategory")(function* (
  config: OnePasswordSecretProviderConfig,
  category: ItemCategory,
) {
  const stage = category === "Login" ? "login" : "identity";
  if (!config.serviceAccountToken) {
    return yield* boundedItem(stage, listItems(config, category, undefined));
  }
  const vaults = yield* boundedItem(stage, listVaults(config));
  if (vaults === undefined) return undefined;
  const listed = yield* Effect.forEach(
    vaults.filter((vault) => !vault.id.startsWith("-")),
    (vault) => boundedItem(stage, listItems(config, category, vault.id)),
    { concurrency: 2 },
  );
  // A vault that cannot be listed hides only its own items.
  const usable = listed.filter(Predicate.isNotUndefined);
  return listed.length > 0 && usable.length === 0 ? undefined : usable.flat();
});

// An item id is unique in an account. A service account must also name its vault, by id, which
// keeps vault names out of the arguments.
const itemGetArgs = (
  item: { readonly id: string; readonly vaultId?: string | undefined },
  reveal: boolean,
) =>
  item.id.startsWith("-") || item.vaultId?.startsWith("-")
    ? undefined
    : [
        "get",
        item.id,
        ...(item.vaultId === undefined ? [] : [`--vault=${item.vaultId}`]),
        ...(reveal ? ["--reveal"] : []),
        "--format=json",
      ];

const readLogin = Effect.fn("OnePasswordDriver.readLogin")(function* (
  config: OnePasswordSecretProviderConfig,
  login: SecretProviderLogin,
  fields: ReadonlyArray<SecretProviderLoginField>,
) {
  const args = itemGetArgs(login, true);
  if (args === undefined) return undefined;
  const result = yield* runOnePassword(config, "item", args);
  const values = result.code === 0 ? parseLoginValues(result.stdout, fields) : undefined;
  if (values === undefined) {
    yield* Effect.logWarning("Could not read 1Password login", { exitCode: result.code });
  }
  return values;
});

// What `op item create` and `op item edit` print: the saved item.
const SavedItem = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  vault: Schema.optional(
    Schema.Struct({ id: Schema.optional(Schema.String), name: Schema.optional(Schema.String) }),
  ),
  urls: Schema.optional(Schema.Array(Schema.Struct({ href: Schema.String }))),
});
const decodeSavedItem = Schema.decodeUnknownOption(Schema.fromJsonString(SavedItem));

const recipeArgument = ({ length, digits, symbols }: SecretProviderPasswordRecipe) =>
  ["letters", ...(digits ? ["digits"] : []), ...(symbols ? ["symbols"] : []), String(length)].join(
    ",",
  );

/**
 * The generated password, when a saved item's output shows one. Whether `op` prints it or a
 * concealment hint is unverified, so only a value the recipe could have made is taken.
 */
const printedPassword = (printed: string, recipe: SecretProviderPasswordRecipe) => {
  const shown = parseLoginValues(printed, ["password"])?.password;
  return shown !== undefined && shown.length === recipe.length && !/\s/.test(shown)
    ? shown
    : undefined;
};

// Every value goes in `--flag=value` or a `field=value` assignment, so none can read as an option.
const saveLogin = Effect.fn("OnePasswordDriver.saveLogin")(function* (
  config: OnePasswordSecretProviderConfig,
  login: SecretProviderNewLogin,
) {
  const result = yield* runOnePassword(config, "item", [
    "create",
    "--category=login",
    `--vault=${login.vault}`,
    `--title=${login.title}`,
    `--url=${login.url}`,
    `--generate-password=${recipeArgument(login.recipe)}`,
    "--tags=T3 Code",
    "--format=json",
    `username=${login.username}`,
    `notesPlain=${login.notes}`,
  ]);
  const item =
    result.code === 0 ? Option.getOrUndefined(decodeSavedItem(result.stdout)) : undefined;
  if (item === undefined) {
    yield* Effect.logWarning("Could not create 1Password login", { exitCode: result.code });
    return undefined;
  }
  const vault = item.vault?.name;
  const vaultId = item.vault?.id;
  const urls = (item.urls ?? []).map((url) => url.href).filter((href) => href.length > 0);
  const saved: SecretProviderLogin = {
    id: item.id,
    title: item.title ?? login.title,
    ...(vault ? { vault } : {}),
    ...(vaultId === undefined ? {} : { vaultId }),
    urls: urls.length > 0 ? urls : [login.url],
  };
  return { login: saved, printed: result.stdout };
});

const editPassword = Effect.fn("OnePasswordDriver.editPassword")(function* (
  config: OnePasswordSecretProviderConfig,
  login: SecretProviderLogin,
  recipe: SecretProviderPasswordRecipe,
) {
  if (login.id.startsWith("-") || login.vaultId?.startsWith("-")) return undefined;
  const result = yield* runOnePassword(config, "item", [
    "edit",
    login.id,
    ...(login.vaultId === undefined ? [] : [`--vault=${login.vaultId}`]),
    `--generate-password=${recipeArgument(recipe)}`,
    "--format=json",
  ]);
  if (result.code !== 0) {
    yield* Effect.logWarning("Could not generate a new 1Password password", {
      exitCode: result.code,
    });
    return undefined;
  }
  return result.stdout;
});

// What `op item get` prints without `--reveal`: enough to name the item, never its secrets.
const ReferencedItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  category: Schema.optional(Schema.String),
  vault: Schema.optional(
    Schema.Struct({ id: Schema.optional(Schema.String), name: Schema.optional(Schema.String) }),
  ),
  urls: Schema.optional(Schema.Array(Schema.Struct({ href: Schema.String }))),
});
const decodeReferencedItem = Schema.decodeUnknownOption(Schema.fromJsonString(ReferencedItem));

const ITEM_REFERENCE = /^op:\/\/([^/]+)\/([^/]+)(?:\/.*)?$/;

/** The vault and item of `op://Vault/Item`; anything after the item, such as a field, is ignored. */
const parseItemReference = (reference: string) => {
  const [, vault, item] = ITEM_REFERENCE.exec(reference) ?? [];
  // The item is a positional argument, so neither name may read as a flag.
  return vault === undefined || item === undefined || vault.startsWith("-") || item.startsWith("-")
    ? undefined
    : { vault, item };
};

/** The item a reference names, if it is of `category`; its vault id lets later reads name it. */
const lookupItem = Effect.fn("OnePasswordDriver.lookupItem")(function* (
  config: OnePasswordSecretProviderConfig,
  reference: string,
  category: "LOGIN" | "IDENTITY",
) {
  const target = parseItemReference(reference);
  if (target === undefined) return undefined;
  const result = yield* runOnePassword(config, "item", [
    "get",
    target.item,
    `--vault=${target.vault}`,
    "--format=json",
  ]);
  const item =
    result.code === 0 ? Option.getOrUndefined(decodeReferencedItem(result.stdout)) : undefined;
  if (item === undefined) {
    yield* Effect.logWarning("Could not look up a 1Password item", { exitCode: result.code });
    return undefined;
  }
  if (item.category?.toUpperCase() !== category) return undefined;
  const vault = item.vault?.name;
  const vaultId = item.vault?.id;
  // An identity is a login without websites.
  const named: SecretProviderIdentity = {
    id: item.id,
    title: item.title,
    ...(vault ? { vault } : {}),
    ...(vaultId ? { vaultId } : {}),
  };
  return { named, urls: (item.urls ?? []).map((url) => url.href).filter((href) => href) };
});

const readIdentity = Effect.fn("OnePasswordDriver.readIdentity")(function* (
  config: OnePasswordSecretProviderConfig,
  identity: SecretProviderIdentity,
) {
  // Identity values are never secret fields, so any concealed one is left concealed.
  const args = itemGetArgs(identity, false);
  if (args === undefined) return undefined;
  const result = yield* runOnePassword(config, "item", args);
  const values = result.code === 0 ? parseIdentityValues(result.stdout) : undefined;
  if (values === undefined) {
    yield* Effect.logWarning("Could not read 1Password identity", { exitCode: result.code });
  }
  return values;
});

export const driver = defineSecretProviderDriver({
  kind: definition.kind,
  definition,
  unattended: (config) => Boolean(config.serviceAccountToken),
  read: Effect.fn("OnePasswordDriver.read")(function* (config, references) {
    if (references.length > 1) {
      const together = yield* bounded("inject", readTogether(config, references));
      // Reading one by one after a timeout would only wait that long again for each reference.
      if (Option.isNone(together)) return references.map(() => undefined);
      if (together.value !== undefined) return together.value;
    }
    return yield* Effect.forEach(references, (reference) =>
      bounded("read", readOne(config, reference)).pipe(Effect.map(Option.getOrUndefined)),
    );
  }),
  logins: {
    list: (config) =>
      listCategory(config, "Login").pipe(
        Effect.map((listed) => (listed === undefined ? undefined : toLogins(listed))),
      ),
    read: (config, login, fields) => boundedItem("login", readLogin(config, login, fields)),
    lookup: (config, reference) =>
      boundedItem("login", lookupItem(config, reference, "LOGIN")).pipe(
        Effect.map((found) => found && { ...found.named, urls: found.urls }),
      ),
    create: Effect.fn("OnePasswordDriver.create")(function* (config, login) {
      const saved = yield* boundedItem("login", saveLogin(config, login));
      if (saved === undefined) return undefined;
      return { login: saved.login, password: printedPassword(saved.printed, login.recipe) };
    }),
    regeneratePassword: Effect.fn("OnePasswordDriver.regeneratePassword")(
      function* (config, login, recipe) {
        const printed = yield* boundedItem("login", editPassword(config, login, recipe));
        return printed === undefined ? undefined : { password: printedPassword(printed, recipe) };
      },
    ),
  },
  identities: {
    list: (config) =>
      listCategory(config, "Identity").pipe(
        Effect.map((listed) => (listed === undefined ? undefined : toIdentities(listed))),
      ),
    read: (config, identity) => boundedItem("identity", readIdentity(config, identity)),
    lookup: (config, reference) =>
      boundedItem("identity", lookupItem(config, reference, "IDENTITY")).pipe(
        Effect.map((found) => found?.named),
      ),
  },
});
