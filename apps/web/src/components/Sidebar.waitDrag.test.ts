import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadWaitDrag } from "./Sidebar.waitDrag";

const env = EnvironmentId.make("env");

function thread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    environmentId: env,
    id: ThreadId.make(id),
    title: id,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    lineage: { relationshipToParent: null, sideChat: false },
    ...overrides,
  } as unknown as NonNullable<Parameters<typeof resolveThreadWaitDrag>[0]["source"]>;
}

const base = {
  modifierHeld: true,
  insideList: true,
  supported: true,
  source: thread("a"),
  target: thread("b"),
  waits: [],
};

describe("resolveThreadWaitDrag", () => {
  it("links only while the modifier is held over the list on a supporting server", () => {
    expect(resolveThreadWaitDrag(base)?.target?.id).toBe("b");
    expect(resolveThreadWaitDrag({ ...base, modifierHeld: false })).toBeNull();
    expect(resolveThreadWaitDrag({ ...base, insideList: false })).toBeNull();
    expect(resolveThreadWaitDrag({ ...base, supported: false })).toBeNull();
  });

  it.each([
    ["no row", { target: undefined }],
    ["itself", { target: thread("a") }],
    ["a settled row", { target: thread("b", { settledOverride: "settled" }) }],
    ["an archived row", { target: thread("b", { archivedAt: "2026-11-07T00:00:00Z" }) }],
    ["another environment", { target: thread("b", { environmentId: EnvironmentId.make("x") }) }],
    ["a settled source", { source: thread("a", { settledOverride: "settled" }) }],
    ["a cycle", { waits: [{ threadId: ThreadId.make("b"), blockerThreadId: ThreadId.make("a") }] }],
  ])("stays in link mode with no target over %s", (_name, overrides) => {
    expect(resolveThreadWaitDrag({ ...base, ...overrides })).toEqual({ target: null });
  });
});
