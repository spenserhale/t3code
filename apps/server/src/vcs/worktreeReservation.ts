// @effect-diagnostics-next-line nodeBuiltinImport:off - rmdir refuses a folder with anything in it, and stat can give ids too big for a number; Effect's FileSystem offers neither.
import * as NodeFSP from "node:fs/promises";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

export type WorktreeRelease =
  | { readonly released: true }
  | { readonly released: false; readonly reason: string };

/** A folder made for a worktree by the call that holds this, and nobody else's. */
export interface WorktreeReservation {
  readonly path: string;
  /**
   * Takes the folder back, if it is still the one that was made and nothing in it would be lost:
   * an empty folder goes, and a worktree goes only if `git worktree remove` takes it without
   * `--force`. Anything else is left as it is, and the reason says why.
   */
  readonly release: Effect.Effect<WorktreeRelease>;
}

class WorktreeReservationError extends Data.TaggedError("WorktreeReservationError")<{
  /** The path was there already, empty or not. */
  readonly taken: boolean;
  readonly cause: unknown;
}> {}

interface FolderIoError {
  readonly code: string | undefined;
}

const folderIoError = (cause: unknown): FolderIoError => ({
  code:
    typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined,
});

/** The device and inode, which tell a folder from another that took its path. */
const identityOf = (folder: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.stat(folder, { bigint: true }),
    catch: folderIoError,
  }).pipe(Effect.map((info) => `${info.dev}:${info.ino}`));

/**
 * Makes the folder for a worktree before git is asked for it. mkdir fails if the path is there,
 * and git accepts an empty folder, so a folder that is there afterwards is known to be this
 * call's; nothing short of making it proves that.
 */
export const reserveWorktreeFolder = Effect.fn("WorktreeReservation.reserve")(function* (
  folder: string,
  parent: string,
  removeWorktree: Effect.Effect<void, { readonly message: string }>,
) {
  yield* Effect.tryPromise({
    try: () => NodeFSP.mkdir(parent, { recursive: true }),
    catch: (cause) => new WorktreeReservationError({ taken: false, cause }),
  });
  yield* Effect.tryPromise({
    try: () => NodeFSP.mkdir(folder),
    catch: (cause) =>
      new WorktreeReservationError({ taken: folderIoError(cause).code === "EEXIST", cause }),
  });
  const identity = yield* identityOf(folder).pipe(
    Effect.tapError(() => Effect.tryPromise(() => NodeFSP.rmdir(folder)).pipe(Effect.ignore)),
    Effect.mapError((cause) => new WorktreeReservationError({ taken: false, cause })),
  );

  const kept = (reason: string): WorktreeRelease => ({ released: false, reason });
  const release = Effect.gen(function* () {
    const seen = yield* identityOf(folder).pipe(Effect.result);
    if (Result.isFailure(seen)) {
      return seen.failure.code === "ENOENT"
        ? ({ released: true } as const)
        : kept(`${folder} could not be read, so it was left as it is.`);
    }
    if (seen.success !== identity) {
      return kept(`${folder} is not the folder this call made any more, so it was left as it is.`);
    }
    // rmdir refuses a folder with anything in it, so what is added meanwhile is never deleted.
    const emptied = yield* Effect.tryPromise({
      try: () => NodeFSP.rmdir(folder),
      catch: folderIoError,
    }).pipe(Effect.result);
    if (Result.isSuccess(emptied)) return { released: true } as const;
    const { code } = emptied.failure;
    if (code === "ENOENT") return { released: true } as const;
    if (code !== "ENOTEMPTY" && code !== "EEXIST") {
      return kept(`${folder} could not be removed, so it was left as it is.`);
    }
    const removed = yield* removeWorktree.pipe(Effect.result);
    return Result.isSuccess(removed)
      ? ({ released: true } as const)
      : kept(
          `${folder} was left as it is: git would not remove it without deleting changes in it, or it is not a worktree.`,
        );
  });
  return { path: folder, release } satisfies WorktreeReservation;
});
