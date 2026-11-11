import {
  createSecretRelayAtoms,
  secretRelayEnvironmentIds,
} from "@t3tools/client-runtime/state/secret-relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentSession } from "./session";

const secretRelay = createSecretRelayAtoms(connectionAtomRuntime);

interface SecretRelayTargets {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}

const secretRelayTargetsAtom = Atom.make((get): SecretRelayTargets => {
  const primaryEnvironmentId = get(primaryEnvironmentIdAtom);
  const presentations = get(environmentPresentations.presentationsAtom);
  const environmentIds = secretRelayEnvironmentIds({
    primaryEnvironmentId,
    environments: [...presentations].map(([environmentId, presentation]) => ({
      environmentId,
      connected: presentation.connection.phase === "connected",
      config: presentation.serverConfig,
      connection: () =>
        Option.getOrNull(get(environmentSession.preparedConnectionValueAtom(environmentId))),
      session: () => {
        const result = get(environmentSession.sessionStateAtom(environmentId));
        return result._tag === "Failure" ? null : AsyncResult.getOrElse(result, () => null);
      },
    })),
  });
  const previous = Option.getOrNull(get.self<SecretRelayTargets>());
  return previous !== null &&
    previous.primaryEnvironmentId === primaryEnvironmentId &&
    previous.environmentIds.length === environmentIds.length &&
    environmentIds.every((id, index) => id === previous.environmentIds[index])
    ? previous
    : { primaryEnvironmentId, environmentIds };
}).pipe(Atom.withLabel("secret-relay-targets"));

/**
 * Answers the secret requests the user's other environments relay to this device, by having the
 * primary environment ask in this desktop app. An environment is answered while it qualifies;
 * when it stops, requests still being resolved for it are interrupted.
 */
export function startSecretRelay(): () => void {
  const mounted = new Map<string, () => void>();
  const sync = ({ primaryEnvironmentId, environmentIds }: SecretRelayTargets) => {
    const wanted = new Map<string, Atom.Atom<unknown>>();
    if (primaryEnvironmentId !== null) {
      const relays = secretRelay.relay(primaryEnvironmentId);
      for (const environmentId of environmentIds) {
        wanted.set(`${primaryEnvironmentId}\n${environmentId}`, relays(environmentId));
      }
    }
    for (const [key, release] of mounted) {
      if (wanted.has(key)) continue;
      release();
      mounted.delete(key);
    }
    for (const [key, relay] of wanted) {
      if (!mounted.has(key)) mounted.set(key, appAtomRegistry.mount(relay));
    }
  };
  const unsubscribe = appAtomRegistry.subscribe(secretRelayTargetsAtom, sync, { immediate: true });
  return () => {
    unsubscribe();
    for (const release of mounted.values()) release();
    mounted.clear();
  };
}
