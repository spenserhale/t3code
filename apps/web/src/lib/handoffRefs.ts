const MAX_PAGES = 25;

/**
 * Every item of a paged list. A page that cannot be read fails the whole read, and so does a list
 * too long to finish: a decision made on part of the refs could pick a name that is taken.
 */
export async function readAllRefPages<T>(
  readPage: (
    cursor: number | undefined,
  ) => Promise<{ readonly refs: ReadonlyArray<T>; readonly nextCursor: number | null }>,
): Promise<ReadonlyArray<T>> {
  const all: Array<T> = [];
  let cursor: number | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await readPage(cursor);
    all.push(...result.refs);
    if (result.nextCursor === null) return all;
    cursor = result.nextCursor;
  }
  throw new Error("This repository has too many branches to check them all.");
}
