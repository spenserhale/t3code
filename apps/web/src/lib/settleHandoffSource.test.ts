import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  EnvironmentResourceNotFoundError,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Shell = { settledOverride: "settled" | "active" | null } | null;

const script = vi.hoisted(() => ({
  /** What each read of the source's shell returns; the last one stays. */
  shells: [] as Shell[],
  waitedFor: false,
  results: new Map<string, unknown>(),
  calls: [] as string[],
  toasts: [] as string[],
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: async (_registry: unknown, command: string) => {
    script.calls.push(command);
    return script.results.get(command) ?? { _tag: "Success", value: {} };
  },
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (result: { error: unknown }) => result.error,
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/entities", () => ({
  readThreadShell: () => (script.shells.length > 1 ? script.shells.shift()! : script.shells[0]),
  waitForThreadShell: async () => script.waitedFor,
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: { settle: "settle", unsettle: "unsettle" },
}));
vi.mock("../state/orchestration", () => ({
  orchestrationEnvironment: { threadTranscript: "transcript" },
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: (toast: { title: string }) => script.toasts.push(toast.title) },
}));

import { settleHandoffSource } from "./settleHandoffSource";

const pending = {
  source: scopeThreadRef(EnvironmentId.make("laptop"), ThreadId.make("thread-source")),
  title: "Fix the flaky login test",
  sourceLabel: "Laptop",
  targetLabel: "Server",
  target: scopeThreadRef(EnvironmentId.make("server"), ThreadId.make("thread-new")),
  createdAt: "2026-11-02T00:00:00.000Z",
};
const failure = (error: unknown) => ({ _tag: "Failure", error });
const serverSaysNotFound = failure(
  new EnvironmentResourceNotFoundError({
    code: "not_found",
    reason: "thread_not_found",
    traceId: TrimmedNonEmptyString.make("trace"),
  }),
);

describe("settleHandoffSource", () => {
  beforeEach(() => {
    script.shells = [{ settledOverride: null }];
    script.waitedFor = true;
    script.results.clear();
    script.calls.length = 0;
    script.toasts.length = 0;
  });

  it("settles the source and offers to take it back", async () => {
    expect(await settleHandoffSource(pending)).toBe("settled");
    expect(script.calls).toEqual(["settle"]);
    expect(script.toasts).toEqual(["Settled “Fix the flaky login test”"]);
  });

  describe("a source thread the client does not have", () => {
    beforeEach(() => {
      script.shells = [null];
      script.waitedFor = false;
    });

    it("is kept for later while the server still has it, as after a slow reconnect", async () => {
      expect(await settleHandoffSource(pending)).toBe("retry");
      expect(script.calls).toEqual(["transcript"]);
    });

    it("is kept for later while the server cannot be asked", async () => {
      script.results.set("transcript", failure(new Error("offline")));
      expect(await settleHandoffSource(pending)).toBe("retry");
    });

    it("is let go once the server says the thread does not exist", async () => {
      script.results.set("transcript", serverSaysNotFound);
      expect(await settleHandoffSource(pending)).toBe("gone");
      expect(script.calls).toEqual(["transcript"]);
    });
  });

  describe("a settle the server refuses", () => {
    beforeEach(() => {
      script.results.set("settle", failure(new Error("The thread is still working.")));
    });

    it("is tried again, with one toast however often it fails", async () => {
      expect(await settleHandoffSource(pending)).toBe("retry");
      expect(await settleHandoffSource(pending)).toBe("retry");
      expect(script.toasts).toEqual(["Could not settle “Fix the flaky login test” on Laptop"]);
    });

    it("counts as done when the thread was settled meanwhile", async () => {
      script.results.set("settle", failure(new Error("already")));
      script.shells = [{ settledOverride: null }, { settledOverride: "settled" }];
      expect(await settleHandoffSource(pending)).toBe("settled");
    });

    it("is let go only if the server says the thread is gone, not because the client lost it", async () => {
      // The shell was there for the first read and gone for the second.
      script.results.set("transcript", failure(new Error("offline")));
      script.shells = [{ settledOverride: null }, null];
      expect(await settleHandoffSource(pending)).toBe("retry");

      script.results.set("transcript", serverSaysNotFound);
      script.shells = [{ settledOverride: null }, null];
      expect(await settleHandoffSource(pending)).toBe("gone");
    });
  });
});
