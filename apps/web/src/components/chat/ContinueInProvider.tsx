import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { newThreadId } from "~/lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { threadContinueInProvider } from "../../state/threadContinuation";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForStartedServerThread } from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ProviderModelPicker } from "./ProviderModelPicker";

/**
 * "Continue in…" for a thread whose provider ran out of usage. Picking a model
 * starts a new thread on it with the conversation copied over, then opens it.
 */
export const ContinueInProviderPicker = memo(function ContinueInProviderPicker(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  currentInstanceId: ProviderInstanceId;
  providers: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
}) {
  const navigate = useNavigate();
  const continueInProvider = useAtomCommand(threadContinueInProvider, { reportFailure: false });
  const [pending, setPending] = useState(false);
  // The user may leave the thread while the server works; the new thread then waits in the sidebar.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(props.providers),
          props.settings,
        ),
      ),
    [props.providers, props.settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(props.settings, props.providers),
    [props.providers, props.settings],
  );
  // Start the picker on another provider; the current one is the one that is spent.
  const initialEntry =
    instanceEntries.find(
      (entry) => entry.instanceId !== props.currentInstanceId && entry.enabled && entry.isAvailable,
    ) ?? instanceEntries[0];
  if (!initialEntry) return null;
  const initialModel = modelOptionsByInstance.get(initialEntry.instanceId)?.[0]?.slug ?? "";

  const onSelect = async (instanceId: ProviderInstanceId, model: string) => {
    if (pending) return;
    setPending(true);
    try {
      const threadId = newThreadId();
      const result = await continueInProvider({
        environmentId: props.environmentId,
        input: {
          sourceThreadId: props.threadId,
          threadId,
          modelSelection: createModelSelection(instanceId, model),
        },
      });
      if (result._tag === "Success") {
        await waitForStartedServerThread(scopeThreadRef(props.environmentId, threadId));
        if (mountedRef.current) {
          await navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: props.environmentId, threadId },
          });
        }
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not continue in another provider",
            description: error instanceof Error ? error.message : "The new thread did not start.",
          }),
        );
      }
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };

  return (
    <ProviderModelPicker
      activeInstanceId={initialEntry.instanceId}
      model={initialModel}
      lockedProvider={null}
      instanceEntries={instanceEntries}
      modelOptionsByInstance={modelOptionsByInstance}
      size="sm"
      triggerVariant="outline"
      triggerLabel={pending ? "Starting…" : "Continue in…"}
      triggerAriaLabel="Continue this thread in another provider"
      disabled={pending}
      getModelDisabledReason={(instanceId) =>
        instanceId === props.currentInstanceId ? "This thread already uses this provider." : null
      }
      onInstanceModelChange={(instanceId, model) => {
        void onSelect(instanceId, model);
      }}
    />
  );
});
