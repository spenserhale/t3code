// Reads secrets that settings point at through a configured secret provider. Each read, including
// a failed one, is held for the server's life so rebuilds never re-prompt an unlock; `invalidate`
// (the Settings refresh) and a `fresh` read are the only ways to read again.
import type { SecretReference, ServerSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  type SecretProviderDriver,
  type SecretProviderDriverServices,
  withSecretProviderVaults,
} from "./driver.ts";

export class SecretResolver extends Context.Service<
  SecretResolver,
  {
    /**
     * Values in input order; `undefined` marks a reference that could not be read. `fresh` asks the
     * provider again and returns what it answered, but an unreadable or empty answer does not
     * replace a value that is already held.
     */
    readonly read: (
      references: ReadonlyArray<SecretReference>,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<ReadonlyArray<string | undefined>>;
    /** Forgets the given references, or every reference, so the next read asks the provider again. */
    readonly invalidate: (references?: ReadonlyArray<SecretReference>) => Effect.Effect<void>;
    /** The name the user gave a secret provider, or its id when it has none or is gone. */
    readonly label: (provider: SecretReference["provider"]) => Effect.Effect<string>;
  }
>()("@t3tools/secret-provider-core/server/SecretResolver") {}

const cacheKey = (reference: SecretReference) =>
  `${reference.provider}\u0000${reference.reference}`;

interface CachedSecret {
  // A provider whose config changed, such as another account, reads again.
  readonly config: string;
  readonly value: string | undefined;
}

const decodeConfigWith = Schema.decodeUnknownOption<Schema.Codec<unknown, unknown>>;

interface ReadablePlan {
  readonly driver: SecretProviderDriver;
  readonly config: unknown;
  readonly configKey: string;
}

type VaultLimits = (provider: SecretReference["provider"]) => ReadonlyArray<string> | undefined;

const EVERY_VAULT: Effect.Effect<VaultLimits> = Effect.succeed(() => undefined);

export const make = Effect.fn("SecretResolver.make")(function* (options: {
  readonly drivers: ReadonlyArray<SecretProviderDriver>;
  readonly secretProviders: Effect.Effect<ServerSettings["secretProviders"]>;
  /**
   * The vault ids each provider may open, read with the providers; `undefined` opens every vault.
   * Without it, every provider opens every vault.
   */
  readonly vaults?: Effect.Effect<VaultLimits>;
}) {
  const context = yield* Effect.context<SecretProviderDriverServices>();
  const driversByKind = new Map(
    options.drivers.map((driver) => [
      driver.kind,
      { driver, decodeConfig: decodeConfigWith(driver.definition.configSchema) },
    ]),
  );
  const cache = new Map<string, CachedSecret>();
  const semaphore = yield* Semaphore.make(1);

  // Only a provider this build can read is cached; anything else fails fast and is checked again
  // on the next read.
  const planFor = (
    providers: ServerSettings["secretProviders"],
    vaults: VaultLimits,
    reference: SecretReference,
  ): ReadablePlan | undefined => {
    const provider = providers[reference.provider];
    const entry = provider === undefined ? undefined : driversByKind.get(provider.kind);
    if (provider === undefined || entry === undefined) return undefined;
    const { driver, decodeConfig } = entry;
    if (!driver.definition.isReference(reference.reference)) return undefined;
    const decoded = decodeConfig(provider.config);
    if (Option.isNone(decoded)) return undefined;
    // Limited after decoding, so a changed limit is a changed config and reads again.
    const config = withSecretProviderVaults(decoded.value, vaults(reference.provider));
    return { driver, config, configKey: JSON.stringify(config) };
  };

  const isCached = (reference: SecretReference, plan: ReadablePlan) =>
    cache.get(cacheKey(reference))?.config === plan.configKey;

  const answer = (
    references: ReadonlyArray<SecretReference>,
    plans: ReadonlyArray<ReadablePlan | undefined>,
  ) =>
    references.map((reference, index) => {
      const plan = plans[index];
      return plan !== undefined && isCached(reference, plan)
        ? cache.get(cacheKey(reference))?.value
        : undefined;
    });

  const plansNow = Effect.fn("SecretResolver.plansNow")(function* (
    references: ReadonlyArray<SecretReference>,
  ) {
    const providers = yield* options.secretProviders;
    const vaults = yield* options.vaults ?? EVERY_VAULT;
    return references.map((reference) => planFor(providers, vaults, reference));
  });

  // Cache hits answer without the lock, so a read waiting on an unlock never stalls a cached one.
  const read: SecretResolver["Service"]["read"] = Effect.fn("SecretResolver.read")(function* (
    references,
    readOptions,
  ) {
    const fresh = readOptions?.fresh === true;
    const isMissing = (reference: SecretReference, plan: ReadablePlan | undefined) =>
      plan !== undefined && (fresh || !isCached(reference, plan));
    const plans = yield* plansNow(references);
    if (!references.some((reference, index) => isMissing(reference, plans[index]))) {
      return answer(references, plans);
    }

    return yield* semaphore.withPermits(1)(
      Effect.gen(function* () {
        // Planned again under the lock: a read queued behind an unlock must not use a config or
        // vault limit from before it waited.
        const locked = yield* plansNow(references);
        const wanted = new Map<
          string,
          {
            readonly plan: ReadablePlan;
            readonly byReference: Map<string, Array<SecretReference>>;
          }
        >();
        references.forEach((reference, index) => {
          const plan = locked[index];
          if (plan === undefined || !isMissing(reference, plan)) return;
          const group = wanted.get(reference.provider) ?? { plan, byReference: new Map() };
          group.byReference.set(reference.reference, [
            ...(group.byReference.get(reference.reference) ?? []),
            reference,
          ]);
          wanted.set(reference.provider, group);
        });
        const results: Array<{
          readonly reference: SecretReference;
          readonly configKey: string;
          readonly value: string | undefined;
        }> = [];
        for (const { plan, byReference } of wanted.values()) {
          const values = yield* plan.driver.read(plan.config, [...byReference.keys()]);
          [...byReference.values()].forEach((sameReference, index) => {
            for (const reference of sameReference) {
              results.push({ reference, configKey: plan.configKey, value: values[index] });
            }
          });
        }
        // A config or limit that changed during the read, such as a vault taken away while
        // 1Password waited to unlock, discards what was read under the old one.
        const after = yield* plansNow(references);
        const answered = new Map<string, string | undefined>();
        for (const { reference, configKey, value } of results) {
          const current = after[references.indexOf(reference)];
          if (current?.configKey !== configKey) continue;
          answered.set(cacheKey(reference), value);
          const readable = value !== undefined && value.trim() !== "";
          if (!fresh || readable || !isCached(reference, current)) {
            cache.set(cacheKey(reference), { config: configKey, value });
          }
        }
        return fresh
          ? references.map((reference) => answered.get(cacheKey(reference)))
          : answer(references, after);
      }),
    );
  }, Effect.provideContext(context));

  const invalidate: SecretResolver["Service"]["invalidate"] = (references) =>
    semaphore.withPermits(1)(
      Effect.sync(() => {
        if (references === undefined) cache.clear();
        else for (const reference of references) cache.delete(cacheKey(reference));
      }),
    );

  const label: SecretResolver["Service"]["label"] = (provider) =>
    options.secretProviders.pipe(
      Effect.map(
        (providers) =>
          (Object.hasOwn(providers, provider) ? providers[provider]?.label.trim() : undefined) ||
          provider,
      ),
    );

  return SecretResolver.of({ read, invalidate, label });
});

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(SecretResolver, make(options));
