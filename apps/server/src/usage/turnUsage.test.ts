import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  UsageDay,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  priceTurn,
  recordedTurns,
  threadTotals,
  threadWorkedMs,
  turnUsageToTotals,
  usageModelId,
  usageWindow,
  type ThreadUsageRecords,
} from "./turnUsage.ts";
import { createOverrideRateTable, parseRateTable } from "./usagePricing.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const opencode = ProviderDriverKind.make("opencode");

const selection = (model: string) => ({ instanceId: ProviderInstanceId.make("instance"), model });

const usage = (
  inputTokens: number,
  outputTokens: number,
  extra: {
    readonly cachedInputTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly reasoningTokens?: number;
    readonly hasSubagents?: boolean;
  } = {},
): TurnTokenUsage => ({
  usageStatus: "complete",
  usageScope: "main_agent",
  hasSubagents: false,
  inputTokens,
  outputTokens,
  ...extra,
});

const at = (iso: string) => DateTime.makeUnsafe(iso);

/** One provider thread on `driver`; turns default to it. */
const records = (
  input: Partial<ThreadUsageRecords> & Pick<ThreadUsageRecords, "providerTurns">,
  driver = claude,
): ThreadUsageRecords => ({
  thread: { modelSelection: selection("thread-model") },
  runs: [],
  attempts: [],
  providerThreads: [{ id: ProviderThreadId.make("provider-thread"), driver, nativeMetadata: null }],
  ...input,
});

const providerTurn = (
  id: string,
  runAttemptId: string | null,
  completedAt: string | null,
  turnTokenUsage?: TurnTokenUsage,
): ThreadUsageRecords["providerTurns"][number] => ({
  id: ProviderTurnId.make(id),
  providerThreadId: ProviderThreadId.make("provider-thread"),
  runAttemptId: runAttemptId === null ? null : RunAttemptId.make(runAttemptId),
  nativeTurnRef: null,
  completedAt: completedAt === null ? null : at(completedAt),
  ...(turnTokenUsage === undefined ? {} : { turnTokenUsage }),
});

describe("usageModelId", () => {
  it("names a selected model the way the usage breakdown records it", () => {
    expect(usageModelId(claude, "claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(usageModelId(opencode, "zai-coding-plan/glm-5")).toBe("glm-5");
    // Codex custom providers keep their slash, as Codex's history does.
    expect(usageModelId(codex, "openrouter/gpt-5.4")).toBe("openrouter/gpt-5.4");
    expect(usageModelId(codex, "5.4")).toBe("gpt-5.4");
    expect(usageModelId(undefined, " some-model ")).toBe("some-model");
  });
});

describe("turnUsageToTotals", () => {
  it("separates cache reads and writes from the input they are counted in", () => {
    expect(
      turnUsageToTotals(
        usage(150, 20, { cachedInputTokens: 40, cacheCreationTokens: 10, reasoningTokens: 25 }),
      ),
    ).toEqual({
      uncachedInputTokens: 100,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
      outputTokens: 20,
      reasoningTokens: 20,
    });
  });

  it("keeps what a partial turn did report and drops turns with nothing", () => {
    expect(
      turnUsageToTotals({
        usageStatus: "partial",
        usageScope: "main_agent",
        hasSubagents: false,
        outputTokens: 7,
      }),
    ).toMatchObject({ uncachedInputTokens: 0, outputTokens: 7 });
    expect(
      turnUsageToTotals({
        usageStatus: "unavailable",
        usageScope: "main_agent",
        hasSubagents: false,
      }),
    ).toBeNull();
    expect(turnUsageToTotals(usage(0, 0))).toBeNull();
  });
});

describe("recordedTurns", () => {
  it("adds up the provider turns of one run under the model that run selected", () => {
    const turns = recordedTurns(
      records({
        runs: [
          { id: RunId.make("run-1"), modelSelection: selection("claude-opus-5-5[1m]") },
          { id: RunId.make("run-2"), modelSelection: selection("claude-haiku-4-5") },
        ],
        attempts: [
          { id: RunAttemptId.make("attempt-1a"), runId: RunId.make("run-1") },
          // A steer restarts the run's provider turn; both attempts spent tokens.
          { id: RunAttemptId.make("attempt-1b"), runId: RunId.make("run-1") },
          { id: RunAttemptId.make("attempt-2"), runId: RunId.make("run-2") },
        ],
        providerTurns: [
          providerTurn("turn-2", "attempt-2", "2026-10-05T12:00:00.000Z", usage(10, 1)),
          providerTurn(
            "turn-1a",
            "attempt-1a",
            "2026-10-05T10:00:00.000Z",
            usage(100, 10, { hasSubagents: true }),
          ),
          providerTurn("turn-1b", "attempt-1b", "2026-10-05T10:05:00.000Z", usage(50, 5)),
        ],
      }),
    );

    expect(turns).toEqual([
      {
        runId: "run-1",
        completedAtMs: Date.parse("2026-10-05T10:05:00.000Z"),
        hasSubagents: true,
        models: [
          {
            model: "claude-opus-5-5",
            totals: {
              uncachedInputTokens: 150,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 15,
              reasoningTokens: 0,
            },
          },
        ],
      },
      expect.objectContaining({
        runId: "run-2",
        models: [expect.objectContaining({ model: "claude-haiku-4-5" })],
      }),
    ]);
  });

  it("skips turns that are still running or reported no usage", () => {
    expect(
      recordedTurns(
        records({
          providerTurns: [
            providerTurn("running", null, null, usage(10, 1)),
            providerTurn("silent", null, "2026-10-05T10:00:00.000Z"),
            providerTurn("unavailable", null, "2026-10-05T10:00:00.000Z", {
              usageStatus: "unavailable",
              usageScope: "main_agent",
              hasSubagents: false,
            }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("counts a turn outside any run on its own, under the provider thread's model", () => {
    const subagentTurns = [
      providerTurn("subagent-1", null, "2026-10-05T10:00:00.000Z", usage(10, 1)),
      providerTurn("subagent-2", null, "2026-10-05T11:00:00.000Z", usage(20, 2)),
    ];
    const reported = recordedTurns({
      ...records({ providerTurns: subagentTurns }),
      providerThreads: [
        {
          id: ProviderThreadId.make("provider-thread"),
          driver: opencode,
          nativeMetadata: { modelSelection: selection("zai-coding-plan/glm-5") },
        },
      ],
    });
    expect(reported.map((turn) => [turn.runId, turn.models[0]?.model])).toEqual([
      [null, "glm-5"],
      [null, "glm-5"],
    ]);
    // OpenCode's selection names its provider; a driver that does not qualify its models has none.
    expect(reported.map((turn) => turn.models[0]?.qualifiedModel)).toEqual([
      "zai-coding-plan/glm-5",
      "zai-coding-plan/glm-5",
    ]);

    // Without a provider-reported model, the thread's own selection prices it.
    const fallback = recordedTurns(records({ providerTurns: subagentTurns }));
    expect(fallback.map((turn) => turn.models[0]?.model)).toEqual(["thread-model", "thread-model"]);
    expect(fallback.map((turn) => turn.models[0]?.qualifiedModel)).toEqual([undefined, undefined]);
  });
});

describe("priceTurn", () => {
  const table = parseRateTable({
    "priced-model": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
    "mapped-target": { input_cost_per_token: 2e-6, output_cost_per_token: 2e-6 },
    "shared-model": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
    "acme/shared-model": { input_cost_per_token: 2e-6, output_cost_per_token: 2e-6 },
  });
  const noRates = { table, overrides: new Map(), aliases: new Map() };
  const turn = (model: string, driver = claude) =>
    recordedTurns(
      records(
        {
          runs: [{ id: RunId.make("run"), modelSelection: selection(model) }],
          attempts: [{ id: RunAttemptId.make("attempt"), runId: RunId.make("run") }],
          providerTurns: [
            providerTurn(
              "turn",
              "attempt",
              "2026-10-05T10:00:00.000Z",
              usage(1_000_000, 1_000_000),
            ),
          ],
        },
        driver,
      ),
    )[0]!;

  it("prices at the published rate and reports when it finished", () => {
    expect(priceTurn(turn("priced-model"), noRates)).toEqual({
      runId: "run",
      completedAt: "2026-10-05T10:00:00.000Z",
      totalTokens: 2_000_000,
      costUsd: 6,
      hasSubagents: false,
      models: [
        {
          model: "priced-model",
          totalTokens: 2_000_000,
          costUsd: 6,
          costSource: "modelPriced",
          customPrice: false,
        },
      ],
    });
  });

  it("applies a custom price saved after the turn ran", () => {
    const overrides = createOverrideRateTable({
      "priced-model": { inputCostPerMillionTokens: 10, outputCostPerMillionTokens: 10 },
    });
    expect(priceTurn(turn("priced-model"), { ...noRates, overrides }).models).toEqual([
      expect.objectContaining({ costUsd: 20, costSource: "modelPriced", customPrice: true }),
    ]);
  });

  it("reports a model with no known price as unpriced, not free", () => {
    expect(priceTurn(turn("unknown-model"), noRates).models).toEqual([
      expect.objectContaining({ totalTokens: 2_000_000, costUsd: 0, costSource: "unpriced" }),
    ]);
  });

  it("prices an OpenCode turn by its provider-qualified model when the rates have one", () => {
    const opencodeModels = (selected: string, rates: Parameters<typeof priceTurn>[1] = noRates) =>
      priceTurn(turn(selected, opencode), rates).models;

    // The rates price acme's shared-model apart from the bare name, so the row is acme's.
    expect(opencodeModels("acme/shared-model")).toEqual([
      expect.objectContaining({
        model: "acme/shared-model",
        costUsd: 4,
        costSource: "modelPriced",
      }),
    ]);
    // A custom price and a mapping are keyed by the id the row reports.
    const overrides = createOverrideRateTable({
      "acme/shared-model": { inputCostPerMillionTokens: 10, outputCostPerMillionTokens: 10 },
    });
    expect(opencodeModels("acme/shared-model", { ...noRates, overrides })).toEqual([
      expect.objectContaining({ costUsd: 20, customPrice: true }),
    ]);
    const aliases = new Map([["acme/shared-model", "priced-model"]]);
    expect(opencodeModels("acme/shared-model", { ...noRates, aliases })).toEqual([
      expect.objectContaining({ model: "priced-model", costUsd: 6 }),
    ]);
  });

  it("prices an OpenCode turn as the bare model when the rates know its provider's model by no name", () => {
    const opencodeModels = (selected: string) =>
      priceTurn(turn(selected, opencode), noRates).models;
    expect(opencodeModels("other/shared-model")).toEqual([
      expect.objectContaining({ model: "shared-model", costUsd: 6, costSource: "modelPriced" }),
    ]);
    expect(opencodeModels("other/unknown-model")).toEqual([
      expect.objectContaining({ model: "unknown-model", costUsd: 0, costSource: "unpriced" }),
    ]);
    // A model that names no provider is its own bare id.
    expect(opencodeModels("shared-model")).toEqual([
      expect.objectContaining({ model: "shared-model", costUsd: 6 }),
    ]);
  });

  it("keeps the provider-qualified model when a run's provider turns add up", () => {
    // A steer or a retry makes a second provider turn of the same run.
    const turns = recordedTurns(
      records(
        {
          runs: [{ id: RunId.make("run"), modelSelection: selection("acme/shared-model") }],
          attempts: [{ id: RunAttemptId.make("attempt"), runId: RunId.make("run") }],
          providerTurns: [
            providerTurn(
              "turn-1",
              "attempt",
              "2026-10-05T10:00:00.000Z",
              usage(1_000_000, 1_000_000),
            ),
            providerTurn(
              "turn-2",
              "attempt",
              "2026-10-05T10:05:00.000Z",
              usage(1_000_000, 1_000_000),
            ),
          ],
        },
        opencode,
      ),
    );
    expect(turns).toHaveLength(1);
    expect(priceTurn(turns[0]!, noRates).models).toEqual([
      expect.objectContaining({ model: "acme/shared-model", costUsd: 8, totalTokens: 4_000_000 }),
    ]);
  });

  it("keeps two providers' models of one name apart as a run's provider turns add up", () => {
    const thread = (id: string, model: string) => ({
      id: ProviderThreadId.make(id),
      driver: opencode,
      nativeMetadata: { modelSelection: selection(model) },
    });
    const turns = recordedTurns(
      records(
        {
          attempts: [{ id: RunAttemptId.make("attempt"), runId: RunId.make("run") }],
          providerThreads: [
            thread("provider-thread", "acme/shared-model"),
            thread("other-thread", "other/shared-model"),
          ],
          providerTurns: [
            providerTurn(
              "turn-1",
              "attempt",
              "2026-10-05T10:00:00.000Z",
              usage(1_000_000, 1_000_000),
            ),
            {
              ...providerTurn(
                "turn-2",
                "attempt",
                "2026-10-05T10:05:00.000Z",
                usage(1_000_000, 1_000_000),
              ),
              providerThreadId: ProviderThreadId.make("other-thread"),
            },
          ],
        },
        opencode,
      ),
    );
    expect(turns).toHaveLength(1);
    // acme's is priced apart; other's has no price of its own, so it is the bare model.
    expect(priceTurn(turns[0]!, noRates).models).toEqual([
      expect.objectContaining({ model: "acme/shared-model", costUsd: 4 }),
      expect.objectContaining({ model: "shared-model", costUsd: 6 }),
    ]);
  });

  it("honours a custom price or a mapping saved for a qualified model the rates do not list", () => {
    const unlisted = (rates: Parameters<typeof priceTurn>[1]) =>
      priceTurn(turn("ollama-cloud/unlisted-model", opencode), rates).models;
    const overrides = createOverrideRateTable({
      "ollama-cloud/unlisted-model": {
        inputCostPerMillionTokens: 1.5,
        outputCostPerMillionTokens: 1.5,
      },
    });
    expect(unlisted({ ...noRates, overrides })).toEqual([
      expect.objectContaining({
        model: "ollama-cloud/unlisted-model",
        costUsd: 3,
        costSource: "modelPriced",
        customPrice: true,
      }),
    ]);
    const aliases = new Map([["ollama-cloud/unlisted-model", "mapped-target"]]);
    expect(unlisted({ ...noRates, aliases })).toEqual([
      expect.objectContaining({ model: "mapped-target", costUsd: 4 }),
    ]);
    // Neither saved: the bare model, which the rates do not list either.
    expect(unlisted(noRates)).toEqual([
      expect.objectContaining({ model: "unlisted-model", costSource: "unpriced" }),
    ]);
  });

  it("leaves a driver that does not qualify its models as it was", () => {
    // Claude and Codex keep their ids whole, so the rates see the id they always saw.
    for (const driver of [claude, codex]) {
      expect(priceTurn(turn("acme/shared-model", driver), noRates).models).toEqual([
        expect.objectContaining({ model: "acme/shared-model", costUsd: 4 }),
      ]);
    }
    expect(priceTurn(turn("shared-model"), noRates).models).toEqual([
      expect.objectContaining({ model: "shared-model", costUsd: 6 }),
    ]);
  });

  it("reports and prices a mapped model as its target", () => {
    const aliases = new Map([["unknown-model", "mapped-target"]]);
    expect(priceTurn(turn("unknown-model"), { ...noRates, aliases }).models).toEqual([
      expect.objectContaining({ model: "mapped-target", costUsd: 4, costSource: "modelPriced" }),
    ]);
  });
});

describe("threadWorkedMs", () => {
  const run = (id: string, startedAt: string | null, completedAt: string | null) => ({
    id: RunId.make(id),
    modelSelection: selection("model"),
    startedAt: startedAt === null ? null : at(startedAt),
    completedAt: completedAt === null ? null : at(completedAt),
  });

  it("adds up finished runs and leaves out the waits between them", () => {
    // An hour of work, three hours away, another hour: two hours worked.
    expect(
      threadWorkedMs({
        runs: [
          run("first", "2026-11-04T09:00:00.000Z", "2026-11-04T10:00:00.000Z"),
          run("second", "2026-11-04T13:00:00.000Z", "2026-11-04T14:00:00.000Z"),
        ],
      }),
    ).toBe(2 * 60 * 60 * 1000);
  });

  it("counts overlapping runs once and skips runs that never started or are still going", () => {
    expect(
      threadWorkedMs({
        runs: [
          run("outer", "2026-11-04T09:00:00.000Z", "2026-11-04T09:30:00.000Z"),
          run("inside", "2026-11-04T09:10:00.000Z", "2026-11-04T09:20:00.000Z"),
          run("overlapping", "2026-11-04T09:20:00.000Z", "2026-11-04T09:40:00.000Z"),
          run("queued", null, null),
          run("running", "2026-11-04T10:00:00.000Z", null),
        ],
      }),
    ).toBe(40 * 60 * 1000);
  });
});

describe("threadTotals", () => {
  it("sums turns and counts the ones no price reached", () => {
    const table = parseRateTable({
      "priced-model": { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
    });
    const rates = { table, overrides: new Map(), aliases: new Map() };
    const priced = recordedTurns(
      records({
        runs: [
          { id: RunId.make("run-1"), modelSelection: selection("priced-model") },
          { id: RunId.make("run-2"), modelSelection: selection("unknown-model") },
        ],
        attempts: [
          { id: RunAttemptId.make("attempt-1"), runId: RunId.make("run-1") },
          { id: RunAttemptId.make("attempt-2"), runId: RunId.make("run-2") },
        ],
        providerTurns: [
          providerTurn("turn-1", "attempt-1", "2026-10-05T10:00:00.000Z", usage(500_000, 500_000)),
          providerTurn("turn-2", "attempt-2", "2026-10-05T11:00:00.000Z", usage(1_000, 0)),
        ],
      }),
    ).map((turn) => priceTurn(turn, rates));

    expect(threadTotals(ThreadId.make("thread"), priced)).toEqual({
      threadId: "thread",
      totalTokens: 1_001_000,
      costUsd: 1,
      turns: 2,
      unpricedTurns: 1,
      lastTurnAt: "2026-10-05T11:00:00.000Z",
      models: ["priced-model", "unknown-model"],
    });
    expect(threadTotals(ThreadId.make("thread"), [])).toBeNull();
  });
});

describe("usageWindow", () => {
  const day = UsageDay.make("2026-10-05");

  it("admits turns by day in the window's zone", () => {
    const window = usageWindow({ sinceDay: day, untilDay: day, timeZone: "America/Los_Angeles" })!;
    // 06:30 UTC on the 5th is still the 4th in Los Angeles.
    expect(window.contains(Date.parse("2026-10-05T06:30:00.000Z"))).toBe(false);
    expect(window.contains(Date.parse("2026-10-05T07:30:00.000Z"))).toBe(true);
    // 06:30 UTC on the 6th is still the 5th there.
    expect(window.contains(Date.parse("2026-10-06T06:30:00.000Z"))).toBe(true);
    expect(window.contains(Date.parse("2026-10-06T07:30:00.000Z"))).toBe(false);
    expect(window.lowerMs).toBeLessThanOrEqual(Date.parse("2026-10-05T07:00:00.000Z"));
    expect(window.upperMs).toBeGreaterThan(Date.parse("2026-10-06T07:00:00.000Z"));
  });

  it("admits turns by instant for an hourly window", () => {
    const window = usageWindow({
      sinceDay: day,
      untilDay: day,
      timeZone: "UTC",
      resolution: "hour",
      sinceTime: "2026-10-05T10:00:00.000Z",
      untilTime: "2026-10-05T12:00:00.000Z",
    })!;
    expect(window.contains(Date.parse("2026-10-05T09:59:59.999Z"))).toBe(false);
    expect(window.contains(Date.parse("2026-10-05T10:00:00.000Z"))).toBe(true);
    expect(window.contains(Date.parse("2026-10-05T12:00:00.000Z"))).toBe(false);
  });

  it("rejects an hourly window without its instants", () => {
    expect(
      usageWindow({ sinceDay: day, untilDay: day, timeZone: "UTC", resolution: "hour" }),
    ).toBeNull();
  });
});
