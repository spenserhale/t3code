import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => () => Promise.resolve(AsyncResult.success(undefined))) as never,
}));

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useComposerSelection } from "./useComposerSelection";

const environmentId = EnvironmentId.make("environment-local");
const codex = ProviderInstanceId.make("codex");
const low = createModelSelection(codex, "gpt-5.5", [{ id: "reasoningEffort", value: "low" }]);
const high = createModelSelection(codex, "gpt-5.5", [{ id: "reasoningEffort", value: "high" }]);

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: codex,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  },
];

function StepPicker(props: { thread: EnvironmentThreadShell }) {
  const { onProviderModelSelectStable } = useComposerSelection({
    environmentId,
    composerDraftTarget: scopeThreadRef(environmentId, props.thread.id),
    draftThread: null,
    activeThread: props.thread,
    activeRuntime: null,
    activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
    settings: DEFAULT_UNIFIED_SETTINGS,
    providerStatuses: providers,
    lockedProvider: null,
    supportsProviderSwitchingViaHandoff: true,
    multipleModelSelections: null,
    runtimeMode: "full-access",
    isLocalDraftThread: true,
    canOverrideServerThreadEnvMode: false,
    setPendingServerThreadEnvModeEntry: () => {},
    setPendingServerThreadStartFromOriginByThreadId: () => {},
    scheduleComposerFocus: () => {},
  });
  return (
    <button
      type="button"
      onClick={() =>
        onProviderModelSelectStable(high.instanceId, high.model, {
          focusComposer: false,
          modelOptions: high.options ?? [],
        })
      }
    >
      Pick the step
    </button>
  );
}

it("applies a slider step's effort to the model already shown", async () => {
  // The hook reads only the thread's identity and stored selection.
  const thread = {
    environmentId,
    id: ThreadId.make("thread-slider-step"),
    modelSelection: low,
  } as EnvironmentThreadShell;
  await using _screen = await render(<StepPicker thread={thread} />);
  await page.getByRole("button", { name: "Pick the step" }).click();

  await vi.waitFor(() => {
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(environmentId, thread.id));
    expect(draft?.modelSelectionByProvider[codex]).toEqual(high);
  });
});
