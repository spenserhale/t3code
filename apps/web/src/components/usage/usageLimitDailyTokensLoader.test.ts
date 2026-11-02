import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { loadEnvironmentDailyTokens, readyUsageEnvironments } from "./usageLimitDailyTokensLoader";

vi.mock("@t3tools/client-runtime/state/runtime", () => ({ executeAtomQuery: vi.fn() }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: "presentations" },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { usageSummary: vi.fn((target: unknown) => target) },
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: vi.fn() }));

const desk = EnvironmentId.make("desk");

const summary: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-07T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: "2026-05-10" as UsageDay,
  untilDay: "2026-08-07" as UsageDay,
  buckets: [
    {
      day: "2026-08-07" as UsageDay,
      provider: "claude",
      model: "claude-fable-5",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 1000,
        cacheCreationTokens: 10,
        outputTokens: 50,
        reasoningTokens: 0,
      },
      costUsd: 10,
      cacheSavingsUsd: 2,
      costSource: "modelPriced",
      records: 5,
      unpricedRecords: 0,
      sessions: 1,
    },
  ],
  sources: [
    {
      fingerprint: {
        hostId: "desk",
        provider: "claude",
        resolvedHomePath: "/home/me/.claude",
        volumeId: "vol",
      },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    },
  ],
  pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
  scanDurationMs: 1,
};

beforeEach(() => {
  vi.mocked(executeAtomQuery).mockReset();
  vi.mocked(serverEnvironment.usageSummary).mockClear();
  vi.mocked(readEnvironmentScope).mockReset();
});

describe("reading token totals from the environments", () => {
  it("asks the connected environments that let this client read usage", () => {
    vi.mocked(readEnvironmentScope).mockImplementation((id) => id !== "locked");
    const presentation = (phase: string, label: string) => ({
      connection: { phase },
      entry: { target: { label } },
    });
    const registry = {
      get: () =>
        new Map([
          ["desk", presentation("connected", "Desk")],
          ["away", presentation("connecting", "Away")],
          ["locked", presentation("connected", "Locked")],
        ]),
    };
    expect(readyUsageEnvironments(registry as never)).toEqual([
      { environmentId: "desk", label: "Desk" },
    ]);
  });

  it("makes one request for the 90 days, having the server wait for slow sources", async () => {
    vi.mocked(executeAtomQuery).mockResolvedValue({ _tag: "Success", value: summary } as never);
    const daily = await loadEnvironmentDailyTokens({} as never, {
      environmentId: desk,
      label: "Desk",
    });
    expect(executeAtomQuery).toHaveBeenCalledTimes(1);
    expect(serverEnvironment.usageSummary).toHaveBeenCalledTimes(1);
    expect(serverEnvironment.usageSummary).toHaveBeenCalledWith({
      environmentId: desk,
      input: expect.objectContaining({ resolution: "day", awaitRefresh: true }),
    });
    expect(vi.mocked(executeAtomQuery).mock.calls[0]![2]).toMatchObject({
      reportFailure: false,
      signal: expect.any(AbortSignal),
    });
    expect(daily?.map((entry) => [entry.day, entry.byProvider.get("claude")?.totalTokens])).toEqual(
      [["2026-08-07", 1160]],
    );
  });

  it("gives nothing when the environment does not answer", async () => {
    vi.mocked(executeAtomQuery).mockResolvedValue({ _tag: "Failure" } as never);
    expect(
      await loadEnvironmentDailyTokens({} as never, { environmentId: desk, label: "Desk" }),
    ).toBeNull();
  });
});
