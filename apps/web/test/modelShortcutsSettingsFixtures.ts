import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
  type ServerProviders,
} from "@t3tools/contracts";

export const codexInstanceId = ProviderInstanceId.make("codex");
export const openCodeInstanceId = ProviderInstanceId.make("opencode");
export const lowEffort = [{ id: "reasoningEffort", value: "low" }];
export const highEffort = [{ id: "reasoningEffort", value: "high" }];

const withLevels = (slug: string, name: string): ServerProviderModel => ({
  slug,
  name,
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning effort",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ],
  },
});

const readyProvider = {
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  slashCommands: [],
  skills: [],
} as const;

export const modelShortcutProviders: ServerProviders = [
  {
    ...readyProvider,
    instanceId: codexInstanceId,
    driver: ProviderDriverKind.make("codex"),
    models: [withLevels("luna", "Luna"), withLevels("sol", "Sol")],
  },
  {
    ...readyProvider,
    instanceId: openCodeInstanceId,
    driver: ProviderDriverKind.make("opencode"),
    models: [withLevels("open", "OpenCode model")],
  },
];

export const modelShortcutSteps: ModelSelection[] = [
  {
    instanceId: codexInstanceId,
    model: "luna",
    options: lowEffort,
  },
  { instanceId: codexInstanceId, model: "sol", options: highEffort },
];
