import {
  EnvironmentId,
  MAX_EFFORT_SLIDER_STEPS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  currentEffortOf,
  effortSliderAddDisabledReason,
  findActiveComposerEffortStep,
  modelShortcutsSettingsSearch,
  resolveComposerEffortSteps,
} from "./composerEffortSlider.logic";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");
const levels = (ids: ReadonlyArray<string>, defaultId: string) => ({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning effort",
      type: "select" as const,
      options: ids.map((id) => ({
        id,
        label: id[0]!.toUpperCase() + id.slice(1),
        ...(id === defaultId ? { isDefault: true } : {}),
      })),
    },
  ],
});
const model = (
  slug: string,
  capabilities: ServerProviderModel["capabilities"],
  aliases?: string[],
) => ({
  slug,
  name: `${slug} model`,
  isCustom: false,
  capabilities,
  ...(aliases ? { aliases } : {}),
});
const provider = (
  instanceId: ProviderInstanceId,
  driver: string,
  models: ServerProviderModel[],
) => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready" as const,
  auth: { status: "authenticated" as const },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
});
const instanceEntries = deriveProviderInstanceEntries([
  provider(codex, "codex", [
    model("sol", levels(["low", "medium", "high"], "medium"), ["sol-latest"]),
    model("plain", null),
  ]),
  provider(claude, "claudeAgent", [model("opus", levels(["low", "high"], "high"))]),
]);
const modelOptionsByInstance = new Map(
  instanceEntries.map((entry) => [
    entry.instanceId,
    entry.models.map((m) => ({
      slug: m.slug,
      name: m.name,
      ...(m.aliases ? { aliases: m.aliases } : {}),
    })),
  ]),
);
const context = {
  instanceEntries,
  modelOptionsByInstance,
  lockedProvider: null,
  lockedContinuationGroupKey: null,
  getModelDisabledReason: () => null,
};
const step = (instanceId: ProviderInstanceId, slug: string, effort?: string): ModelSelection =>
  createModelSelection(
    instanceId,
    slug,
    effort ? [{ id: "reasoningEffort", value: effort }] : undefined,
  );

describe("resolveComposerEffortSteps", () => {
  it("labels each step by its short model name and effort", () => {
    const [first] = resolveComposerEffortSteps([step(codex, "sol", "high")], context);
    expect(first).toMatchObject({
      modelLabel: "sol model",
      effort: "high",
      effortLabel: "High",
      unusableReason: null,
    });
    const [plain] = resolveComposerEffortSteps([step(codex, "plain")], context);
    expect(plain).toMatchObject({ effort: null, effortLabel: null, unusableReason: null });
  });

  it("opens a step saved under an alias as the model it names", () => {
    const [aliased] = resolveComposerEffortSteps([step(codex, "sol-latest", "low")], context);
    expect(aliased?.selection.model).toBe("sol");
    expect(aliased?.unusableReason).toBeNull();
  });

  it("marks a step it cannot apply, with the reason, instead of dropping it", () => {
    const steps = resolveComposerEffortSteps(
      [
        step(ProviderInstanceId.make("gone"), "sol", "low"),
        step(codex, "retired", "low"),
        step(claude, "opus", "high"),
        step(codex, "sol", "high"),
      ],
      {
        ...context,
        lockedProvider: ProviderDriverKind.make("codex"),
        getModelDisabledReason: (_, slug) => (slug === "sol" ? "Start a new thread" : null),
      },
    );
    expect(steps.map((entry) => entry.unusableReason)).toEqual([
      "This provider is not available",
      "This model is not available",
      "Claude is unavailable in this thread",
      "Start a new thread",
    ]);
  });
});

describe("findActiveComposerEffortStep", () => {
  const steps = resolveComposerEffortSteps(
    [step(codex, "sol", "low"), step(codex, "plain"), step(claude, "opus", "high")],
    context,
  );

  it("follows the effort the selection runs at, explicit or the model's default", () => {
    expect(findActiveComposerEffortStep(steps, step(codex, "sol", "low"), instanceEntries)).toBe(0);
    // No effort chosen yet: the model runs at its default, which no step names.
    expect(findActiveComposerEffortStep(steps, step(codex, "sol"), instanceEntries)).toBeNull();
    // Claude's default is high, so a selection that never chose is on the high step.
    expect(findActiveComposerEffortStep(steps, step(claude, "opus"), instanceEntries)).toBe(2);
    expect(findActiveComposerEffortStep(steps, step(codex, "plain"), instanceEntries)).toBe(1);
  });
});

describe("a thread whose provider reports the effort it runs at", () => {
  const steps = resolveComposerEffortSteps(
    [step(codex, "sol", "medium"), step(codex, "sol", "high")],
    context,
  );

  it("puts the thumb where the effort control shows the reported level", () => {
    // Sol defaults to medium, but the provider says this thread runs at high.
    const reported = step(codex, "sol", "high");
    expect(findActiveComposerEffortStep(steps, step(codex, "sol"), instanceEntries, reported)).toBe(
      1,
    );
    expect(findActiveComposerEffortStep(steps, step(codex, "sol"), instanceEntries)).toBe(0);
  });

  it("prefers what was chosen over what was reported, and ignores a report about another model", () => {
    const reported = step(codex, "sol", "high");
    expect(
      findActiveComposerEffortStep(steps, step(codex, "sol", "medium"), instanceEntries, reported),
    ).toBe(0);
    expect(
      findActiveComposerEffortStep(
        steps,
        step(codex, "sol"),
        instanceEntries,
        step(codex, "plain", "high"),
      ),
    ).toBe(0);
  });

  it("offers the reported level to Add to slider as the one the model is on", () => {
    const reported = step(codex, "sol", "high");
    expect(currentEffortOf(step(codex, "sol"), instanceEntries, reported).effort?.value).toBe(
      "high",
    );
  });
});

describe("effortSliderAddDisabledReason", () => {
  it("allows a new step only while there is room and the model is known", () => {
    const open = { stepCount: 2, activeIndex: null, selectedModelKnown: true };
    expect(effortSliderAddDisabledReason(open)).toBeNull();
    expect(effortSliderAddDisabledReason({ ...open, stepCount: MAX_EFFORT_SLIDER_STEPS })).toMatch(
      /up to 6/,
    );
    expect(effortSliderAddDisabledReason({ ...open, activeIndex: 0 })).toMatch(/Already/);
    expect(effortSliderAddDisabledReason({ ...open, selectedModelKnown: false })).toMatch(
      /not available/,
    );
  });
});

describe("the link from the model picker", () => {
  const environmentId = EnvironmentId.make("env-a");
  const projectId = ProjectId.make("project-a");
  const groups = [
    {
      projectKey: "repo",
      memberProjects: [
        {
          id: ProjectId.make("project-b"),
          environmentId: EnvironmentId.make("env-b"),
          physicalProjectKey: "env-b:/repo",
        },
        { id: projectId, environmentId, physicalProjectKey: "env-a:/repo" },
      ],
    },
  ];

  it("opens the environment unless the project keeps a list of its own", () => {
    expect(
      modelShortcutsSettingsSearch({ environmentId, projectId, projectOverrides: false }, groups),
    ).toEqual({ machine: environmentId });
    expect(
      modelShortcutsSettingsSearch(
        { environmentId, projectId: null, projectOverrides: true },
        groups,
      ),
    ).toEqual({ machine: environmentId });
  });

  it("opens the checkout whose own list is in use, so edits there reach that list", () => {
    expect(
      modelShortcutsSettingsSearch({ environmentId, projectId, projectOverrides: true }, groups),
    ).toEqual({ project: "repo", machine: environmentId, checkout: "env-a:/repo" });
  });

  it("falls back to the environment when the project is in no group", () => {
    expect(
      modelShortcutsSettingsSearch({ environmentId, projectId, projectOverrides: true }, []),
    ).toEqual({ machine: environmentId });
  });
});
