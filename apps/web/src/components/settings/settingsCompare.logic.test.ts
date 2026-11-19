import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import {
  type CompareEnvironment,
  compareWithSource,
  describeDifferences,
  missingSliderItem,
  planSettingsCopy,
} from "./settingsCompare.logic";

const codex = ProviderInstanceId.make("codex");
const openCodeInstance = ProviderInstanceId.make("opencode");
const openCode = ProviderDriverKind.make("opencode");
const high = [{ id: "reasoningEffort", value: "high" }];
const low = [{ id: "reasoningEffort", value: "low" }];
const slider: ModelSelection[] = [
  { instanceId: codex, model: "luna", options: low },
  { instanceId: codex, model: "sol", options: high },
];
const openCodeSlider: ModelSelection[] = [
  { instanceId: openCodeInstance, model: "open", options: low },
  { instanceId: openCodeInstance, model: "open", options: high },
];
const supported = { effortSlider: true, providerEffortSliders: true };

function environment(
  label: string,
  settings: Partial<ServerSettings>,
  capabilities: CompareEnvironment["capabilities"] = supported,
): CompareEnvironment {
  return {
    environmentId: EnvironmentId.make(`env-${label}`),
    label,
    settings: { ...DEFAULT_SERVER_SETTINGS, favorites: [], ...settings },
    capabilities,
  };
}

const differences = (source: CompareEnvironment, others: CompareEnvironment[]) =>
  compareWithSource(source, others).map(({ label, source, differing, same }) => ({
    label,
    source: source.text,
    differing: differing.map((row) => [row.environment.label, row.summary.text]),
    same: same.map((other) => other.label),
  }));

const linkPro = environment("LinkPro", {
  favorites: [{ provider: codex, model: "sol", options: high }],
  effortSlider: slider,
  providerEffortSliders: { [openCode]: openCodeSlider },
});

describe("comparing environments with a source", () => {
  it("names what differs from the source and what matches it", () => {
    const torrent = environment("Torrent", {
      favorites: linkPro.settings.favorites,
      effortSlider: slider,
    });
    const rw = environment("RW", {
      favorites: [{ provider: codex, model: "luna" }],
      effortSlider: slider,
      providerEffortSliders: { [openCode]: openCodeSlider },
    });
    expect(differences(linkPro, [torrent, rw])).toEqual([
      {
        label: "Favorite models",
        source: "1 model",
        differing: [["RW", "1 model"]],
        same: ["Torrent"],
      },
      { label: "Favorites slider", source: "2 steps", differing: [], same: ["Torrent", "RW"] },
      {
        label: "OpenCode slider",
        source: "2 steps",
        differing: [["Torrent", "Uses Favorites slider"]],
        same: ["RW"],
      },
    ]);
    expect(describeDifferences(linkPro, [torrent, rw])).toBe(
      "Torrent and RW differ from LinkPro on Favorite models and OpenCode slider.",
    );
    expect(compareWithSource(linkPro, [torrent])[2]?.source.detail).toBe("open · low, open · high");
    expect(
      describeDifferences(linkPro, [
        torrent,
        rw,
        environment("Mini", {}),
        environment("Air", { favorites: null }),
      ]),
    ).toBe("Torrent, RW and 2 more differ from LinkPro on 3 settings.");
    expect(describeDifferences(linkPro, [rw])).toBe("RW differs from LinkPro on Favorite models.");
  });

  it("reads lists the way the picker does", () => {
    const source = environment("LinkPro", {
      favorites: [{ provider: codex, model: "sol", options: [] }],
      effortSlider: [...slider, ...openCodeSlider, ...slider, slider[0]!],
      providerEffortSliders: { [openCode]: [] },
    });
    const other = environment("Torrent", {
      favorites: [{ provider: codex, model: "sol" }],
      effortSlider: [...slider, ...openCodeSlider, ...slider],
    });

    // An empty effort opens at what was used last, readers stop at six steps, and an empty
    // provider slider shows no slider, while a missing one falls back to the Favorites slider.
    expect(differences(source, [other])).toEqual([
      { label: "Favorite models", source: "1 model", differing: [], same: ["Torrent"] },
      { label: "Favorites slider", source: "6 steps", differing: [], same: ["Torrent"] },
      {
        label: "OpenCode slider",
        source: "None",
        differing: [["Torrent", "Uses Favorites slider"]],
        same: [],
      },
    ]);
  });
});

describe("copying from a source", () => {
  it("writes each destination only what differs, and then nothing differs", () => {
    const torrent = environment("Torrent", { favorites: linkPro.settings.favorites });
    const rw = environment("RW", {
      favorites: null,
      effortSlider: slider,
      providerEffortSliders: { [openCode]: openCodeSlider },
    });
    const items = compareWithSource(linkPro, [torrent, rw]).map(({ item }) => item);
    const plan = planSettingsCopy(linkPro, [linkPro, torrent, rw], items);

    expect(plan.unavailableReason).toBeNull();
    expect(plan.serverWrites.map(({ environmentId, patch }) => [environmentId, patch])).toEqual([
      [
        torrent.environmentId,
        {
          effortSlider: slider,
          setProviderEffortSliders: [{ driver: openCode, steps: openCodeSlider }],
        },
      ],
      [rw.environmentId, { favorites: [{ provider: codex, model: "sol", options: high }] }],
    ]);
    const copied = [torrent, rw].map((destination) => ({
      ...destination,
      settings: applyServerSettingsPatch(
        destination.settings,
        plan.serverWrites.find((write) => write.environmentId === destination.environmentId)!.patch,
      ),
    }));
    expect(describeDifferences(linkPro, copied)).toBeNull();
  });

  it("clears a provider slider the source does not keep, so the tab uses Favorites", () => {
    const source = environment("LinkPro", { effortSlider: slider });
    const destination = environment("Torrent", {
      effortSlider: slider,
      providerEffortSliders: { [openCode]: openCodeSlider },
    });
    const plan = planSettingsCopy(
      source,
      [destination],
      compareWithSource(source, [destination]).map(({ item }) => item),
    );

    expect(plan.serverWrites.map(({ patch }) => patch)).toEqual([
      { setProviderEffortSliders: [{ driver: openCode, steps: null }] },
    ]);
    const after = applyServerSettingsPatch(destination.settings, plan.serverWrites[0]!.patch);
    expect(after.providerEffortSliders).toBeUndefined();
  });

  it("blocks what a destination cannot store and a source without saved favorites", () => {
    const source = environment("LinkPro", {
      favorites: null,
      effortSlider: slider,
      providerEffortSliders: { [openCode]: openCodeSlider },
    });
    const older = environment(
      "RW",
      { favorites: [{ provider: codex, model: "sol" }] },
      { effortSlider: true },
    );
    const oldest = environment("Torrent", {}, {});
    const comparisons = compareWithSource(source, [older, oldest]);

    expect(
      comparisons.map(({ label, differing }) => [
        label,
        differing.map(({ environment, blockedReason }) => [environment.label, blockedReason]),
      ]),
    ).toEqual([
      [
        "Favorite models",
        [
          ["RW", "LinkPro has not saved its favorites yet."],
          ["Torrent", "LinkPro has not saved its favorites yet."],
        ],
      ],
      [
        "Favorites slider",
        [
          ["RW", null],
          ["Torrent", "Torrent runs a version without effort sliders."],
        ],
      ],
      [
        "OpenCode slider",
        [
          ["RW", "RW runs a version without provider sliders."],
          ["Torrent", "Torrent runs a version without effort sliders."],
        ],
      ],
    ]);
    const items = comparisons.map(({ item }) => item);
    expect(planSettingsCopy(source, [oldest], items)).toMatchObject({
      serverWrites: [],
      unavailableReason: "LinkPro has not saved its favorites yet.",
    });
    expect(planSettingsCopy(source, [older], items).serverWrites.map(({ patch }) => patch)).toEqual(
      [{ effortSlider: slider }],
    );
  });

  it("matches favorites without efforts on a destination that cannot keep them", () => {
    const older = environment(
      "RW",
      { favorites: [{ provider: codex, model: "sol" }] },
      { providerEffortSliders: false },
    );
    expect(compareWithSource(linkPro, [older])[0]?.same).toEqual([older]);
  });
});

describe("the slider a tab is missing", () => {
  const torrent = environment("Torrent", {});

  it("offers the source's provider slider, else its Favorites slider", () => {
    expect(missingSliderItem(linkPro, torrent, openCode)).toEqual({
      kind: "providerSlider",
      driver: openCode,
    });
    expect(missingSliderItem(linkPro, torrent, ProviderDriverKind.make("codex"))).toEqual({
      kind: "effortSlider",
    });
    expect(missingSliderItem(linkPro, torrent, null)).toEqual({ kind: "effortSlider" });
  });

  it("offers nothing where the destination keeps its own slider or the source has no usable one", () => {
    const own = environment("Torrent", { providerEffortSliders: { [openCode]: [] } });
    expect(missingSliderItem(linkPro, own, openCode)).toBeNull();
    const withFavorites = environment("Torrent", { effortSlider: slider });
    expect(missingSliderItem(linkPro, withFavorites, null)).toBeNull();
    const oneStep = environment("LinkPro", {
      providerEffortSliders: { [openCode]: [openCodeSlider[0]!] },
      effortSlider: slider,
    });
    expect(missingSliderItem(oneStep, torrent, openCode)).toBeNull();
    const older = environment("Torrent", {}, { effortSlider: true });
    expect(missingSliderItem(linkPro, older, openCode)).toBeNull();
  });
});
