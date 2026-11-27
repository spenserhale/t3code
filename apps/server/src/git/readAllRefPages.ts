import type { VcsListRefsResult, VcsRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const MAX_REF_PAGES = 25;

/**
 * Every ref a listing matches. Null when the list is too long to finish: a decision made on part
 * of the refs could pick a name that is taken.
 */
export const readAllRefPages = Effect.fn("git.readAllRefPages")(function* <E>(
  readPage: (cursor: number | undefined) => Effect.Effect<VcsListRefsResult, E>,
) {
  const all: Array<VcsRef> = [];
  let cursor: number | undefined;
  for (let page = 0; page < MAX_REF_PAGES; page += 1) {
    const result = yield* readPage(cursor);
    all.push(...result.refs);
    if (result.nextCursor === null) return all;
    cursor = result.nextCursor;
  }
  return null;
});
