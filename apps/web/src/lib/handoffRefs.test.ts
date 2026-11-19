import { describe, expect, it } from "vite-plus/test";

import { readAllRefPages } from "./handoffRefs";

describe("readAllRefPages", () => {
  it("follows the cursor to the last page", async () => {
    const pages = [
      { refs: ["a", "b"], nextCursor: 2 },
      { refs: ["c"], nextCursor: 3 },
      { refs: ["d"], nextCursor: null },
    ];
    const cursors: Array<number | undefined> = [];
    const all = await readAllRefPages(async (cursor) => {
      cursors.push(cursor);
      return pages.shift()!;
    });
    expect(all).toEqual(["a", "b", "c", "d"]);
    expect(cursors).toEqual([undefined, 2, 3]);
  });

  it("fails when a page cannot be read, rather than return what it has", async () => {
    let page = 0;
    await expect(
      readAllRefPages(async () => {
        if (page++ === 1) throw new Error("offline");
        return { refs: ["a"], nextCursor: 1 };
      }),
    ).rejects.toThrow("offline");
  });

  it("fails on a list that never ends", async () => {
    await expect(readAllRefPages(async () => ({ refs: ["a"], nextCursor: 1 }))).rejects.toThrow(
      "too many branches",
    );
  });
});
